/**
 * @fileoverview useDownloadReconciliation - Reconciliación con backend y eventos
 * @module useDownloadReconciliation
 *
 * Maneja la sincronización con el backend y los eventos de progreso de descargas.
 * Escucha eventos IPC del proceso principal, actualiza el estado local, y realiza
 * reconciliación periódica para detectar descargas perdidas o desincronizadas.
 *
 * Características:
 * - Escucha eventos de progreso en tiempo real
 * - Reconciliación optimizada con el backend
 * - Intervalos adaptativos según actividad
 * - Restauración de descargas desde base de datos
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} ProgressEventInfo
 * @property {number} id - ID de la descarga
 * @property {string} title - Título del archivo
 * @property {string} state - Estado: 'starting' | 'progressing' | 'merging' | 'completed' | 'interrupted' | 'paused' | 'awaiting-confirmation' | 'queued'
 * @property {number} [percent] - Progreso (0.0 - 1.0)
 * @property {number} [speed] - Velocidad en MB/s
 * @property {number} [totalBytes] - Tamaño total en bytes
 * @property {number} [downloadedBytes] - Bytes descargados
 * @property {number} [remainingTime] - Tiempo restante en segundos
 * @property {string} [savePath] - Ruta donde se guarda
 * @property {string} [error] - Mensaje de error
 * @property {boolean} [chunked] - Si es descarga fragmentada
 * @property {number} [activeChunks] - Chunks activos
 * @property {number} [completedChunks] - Chunks completados
 * @property {number} [totalChunks] - Total de chunks
 * @property {Array} [chunkProgress] - Progreso de cada chunk
 */

import {
  downloads,
  downloadQueue,
  speedStats,
  pendingConfirmations,
  startingDownloads,
  currentDownloadIndex,
  timeoutManager,
  triggerRef,
} from './useDownloadState';
import * as api from '../../services/api';

/**
 * Composable para reconciliación con backend y eventos
 *
 * Gestiona la sincronización entre el estado del frontend y el backend,
 * escuchando eventos de progreso y realizando reconciliación periódica
 * para mantener consistencia.
 *
 * @param {Function} processDownloadQueueFn - Función para procesar la cola
 * @param {Function} saveDownloadHistoryFn - Función para guardar historial
 * @param {Function} limitHistoryInMemoryFn - Función para limitar historial
 * @param {Function} getCurrentLimitsFn - Función para obtener límites actuales
 * @param {Object} [settings=null] - Configuración desde useSettings
 * @param {Object} [settings.showNotifications] - Ref con si mostrar notificaciones
 * @returns {Object} Objeto con funciones de reconciliación
 * @returns {Function} returns.handleProgressEvent - Maneja eventos de progreso
 * @returns {Function} returns.handleDownloadsRestored - Maneja descargas restauradas
 * @returns {Function} returns.reconcileWithBackend - Reconciliación manual con backend
 * @returns {Function} returns.startReconciliation - Inicia listeners y reconciliación
 * @returns {Function} returns.stopReconciliation - Detiene listeners y reconciliación
 *
 * @example
 * const {
 *   handleProgressEvent,
 *   startReconciliation,
 *   stopReconciliation
 * } = useDownloadReconciliation(
 *   processQueue,
 *   saveHistory,
 *   limitHistory,
 *   getLimits,
 *   settings
 * );
 *
 * // Iniciar reconciliación al montar componente
 * startReconciliation();
 *
 * // Detener al desmontar
 * onUnmounted(() => {
 *   stopReconciliation();
 * });
 */
export function useDownloadReconciliation(
  processDownloadQueueFn,
  saveDownloadHistoryFn,
  limitHistoryInMemoryFn,
  getCurrentLimitsFn,
  settings = null
) {
  const showNotifications = settings?.showNotifications || { value: true };

  // CRÍTICO: Flag para prevenir memory leaks y doble limpieza
  let isCleaned = false;

  // Helper para obtener el valor de showNotifications
  const getShowNotifications = () => {
    return showNotifications?.value ?? true;
  };

  // Estado para optimización
  let lastReconcileState = null;
  let reconcileIntervalMs = 5000; // Intervalo base
  const RECONCILE_ACTIVE_INTERVAL = 5000; // 5s cuando hay actividad
  const RECONCILE_IDLE_INTERVAL = 15000; // 15s cuando no hay actividad

  // Intervalos
  let reconciliationInterval = null;
  let rotationInterval = null;
  let removeProgressListener = null;
  let removeBatchProgressListener = null;
  let removeHistoryListener = null;
  let removeRestoredListener = null;

  const uiUpdateQueue = new Map();
  let rafId = null;

  const processUIUpdateQueue = () => {
    if (uiUpdateQueue.size === 0) {
      rafId = null;
      return;
    }

    const updates = Array.from(uiUpdateQueue.values());
    uiUpdateQueue.clear();
    rafId = null;

    const newDownloads = { ...downloads.value };
    let hasChanges = false;

    updates.forEach(info => {
      const updatedDl = _mapProgressToDownload(newDownloads[info.id], info);
      if (updatedDl) {
        newDownloads[info.id] = updatedDl;
        hasChanges = true;
      }
    });

    if (hasChanges) {
      downloads.value = newDownloads;
    }
  };

  const _mapProgressToDownload = (currentDl, info) => {
    if (!info) return null;

    let dl = currentDl ? { ...currentDl } : {
      id: info.id,
      title: info.title || `Descarga ${info.id}`,
      addedAt: Date.now(),
    };

    if (info.title) dl.title = info.title;

    switch (info.state) {
      case 'starting':
        dl.state = 'starting';
        dl.percent = 0;
        delete dl.error;
        if (info.chunked || info.numChunks) {
          dl.chunked = true;
          dl.totalChunks = info.numChunks || info.totalChunks || 0;
          dl.activeChunks = 0;
          dl.completedChunks = 0;
          if (!dl.chunkProgress) dl.chunkProgress = [];
        }
        break;

      case 'progressing':
        dl.state = 'progressing';
        dl.percent = info.percent ?? dl.percent ?? 0;
        delete dl.error;
        
        if (info.chunked) {
          dl.chunked = true;
          if (info.chunkProgress !== undefined && info.chunkProgress !== null) {
            dl.chunkProgress = Array.isArray(info.chunkProgress) ? info.chunkProgress : [];
          }
          if (info.activeChunks !== undefined) dl.activeChunks = info.activeChunks;
          if (info.completedChunks !== undefined) dl.completedChunks = info.completedChunks;
          if (info.totalChunks !== undefined) dl.totalChunks = info.totalChunks;
        }

        if (info.remainingTime !== undefined && isFinite(info.remainingTime)) {
          dl.remainingTime = info.remainingTime;
        }

        speedStats.value.set(info.id, {
          speed: info.speed || 0,
          totalBytes: info.totalBytes || 0,
          downloadedBytes: info.downloadedBytes || 0,
          remainingTime: info.remainingTime || 0,
        });
        break;

      case 'merging':
        dl.state = 'merging';
        dl.percent = info.percent || info.mergeProgress || 0;
        dl.merging = true;
        dl.mergeProgress = info.mergeProgress || info.percent || 0;
        dl.mergeSpeed = info.mergeSpeed || info.speed || 0;
        dl.currentChunk = info.currentChunk;
        dl.bytesProcessed = info.bytesProcessed;
        break;

      case 'completed':
        // Detectar si es un cambio de estado (no una descarga que ya estaba completada)
        const wasCompleted = currentDl?.state === 'completed';
        dl.state = 'completed';
        dl.percent = 1;
        dl.completedAt = Date.now();
        dl.savePath = info.savePath;
        // Preservar mergeProgress al 100% si venía de un merge para que la UI lo muestre
        // Se eliminará después de un breve delay para limpiar el estado
        if (dl.merging || dl.mergeProgress !== undefined) {
          dl.mergeProgress = 1.0; // Asegurar que esté al 100%
        }
        delete dl.merging;
        speedStats.value.delete(info.id);
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== info.id);
        
        // Emitir evento solo si acaba de completarse (no estaba completada antes)
        if (!wasCompleted && getShowNotifications()) {
          if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(
              new CustomEvent('download-completed', {
                detail: {
                  id: info.id,
                  title: info.title || dl.title || `Descarga ${info.id}`,
                  savePath: info.savePath,
                },
              })
            );
          }
        }
        break;

      case 'interrupted':
      case 'cancelled':
        dl.state = info.state;
        dl.error = info.error || 'Descarga interrumpida';
        speedStats.value.delete(info.id);
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== info.id);
        break;

      case 'paused':
        dl.state = 'paused';
        dl.percent = info.percent || dl.percent;
        speedStats.value.delete(info.id);
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== info.id);
        break;

      case 'awaiting-confirmation':
        dl.state = 'waiting';
        dl.savePath = info.savePath;
        if (!pendingConfirmations.value.some(c => c.id === info.id)) {
          pendingConfirmations.value.push({
            id: info.id,
            title: info.title,
            savePath: info.savePath,
            existingSize: info.fileCheck?.existingSize,
            expectedSize: info.fileCheck?.expectedSize,
            showNotification: getShowNotifications(),
          });
        }
        break;

      case 'queued':
        dl.state = 'queued';
        if (info.position) dl.queuePosition = info.position;
        break;
    }

    return dl;
  };

  /**
   * Calcula un hash simple del estado actual para detectar cambios
   */
  const getStateHash = () => {
    // Necesitamos acceso a activeDownloads, pero está en otro composable
    // Por ahora, calculamos directamente
    const activeCount = Object.values(downloads.value).filter(
      d => d.state === 'progressing' || d.state === 'starting'
    ).length;
    const queueCount = downloadQueue.value.length;
    const speedCount = speedStats.value.size;
    return `${activeCount}-${queueCount}-${speedCount}`;
  };

  // Throttling de actualizaciones de progreso para evitar re-renders innecesarios
  const PROGRESS_THROTTLE_MS = 100; // Actualizar máximo cada 100ms
  const PROGRESS_CHANGE_THRESHOLD = 0.001; // Solo actualizar si cambio > 0.1%
  const lastProgressUpdate = new Map(); // Map<id, timestamp>
  const lastProgressValue = new Map(); // Map<id, progress>

  /**
   * Maneja eventos de progreso desde el backend
   * Optimizado con throttling y filtrado de cambios insignificantes
   */
  const handleProgressEvent = info => {
    if (!timeoutManager.isMounted || !downloads.value) return;

    startingDownloads.delete(info.id);

    // Encolar actualización para el siguiente frame
    uiUpdateQueue.set(info.id, info);

    // Si no hay un frame programado, solicitar uno
    if (!rafId) {
      rafId = requestAnimationFrame(processUIUpdateQueue);
    }

    // Lógica secundaria (fuera de la UI crítica)
    if (['completed', 'interrupted', 'cancelled'].includes(info.state)) {
      if (saveDownloadHistoryFn) saveDownloadHistoryFn();
      timeoutManager.safeSetTimeout(() => {
        if (processDownloadQueueFn) processDownloadQueueFn();
      }, 100);
      
      if (limitHistoryInMemoryFn && getCurrentLimitsFn) {
        limitHistoryInMemoryFn(getCurrentLimitsFn());
      }
    }
  };

  /**
   * Maneja el evento de descargas restauradas desde la base de datos
   */
  const handleDownloadsRestored = allDownloads => {
    if (!timeoutManager.isMounted || !downloads.value || !Array.isArray(allDownloads)) return;

    console.log(`[useDownloads] Restaurando ${allDownloads.length} descargas desde BD...`);

    const newDownloads = { ...downloads.value };

    // Procesar cada descarga restaurada
    allDownloads.forEach(dbDownload => {
      // Mapear el estado de la BD al estado del frontend
      let state = dbDownload.state || 'completed';

      // Los timestamps de la BD son números (milisegundos desde epoch)
      const createdAt =
        typeof dbDownload.createdAt === 'number'
          ? dbDownload.createdAt
          : dbDownload.createdAt
            ? new Date(dbDownload.createdAt).getTime()
            : Date.now();

      const completedAt = dbDownload.completedAt
        ? typeof dbDownload.completedAt === 'number'
          ? dbDownload.completedAt
          : new Date(dbDownload.completedAt).getTime()
        : null;

      // Crear o actualizar la descarga en el estado del frontend
      const dl = { ...(newDownloads[dbDownload.id] || {
        id: dbDownload.id,
        title: dbDownload.title || `Descarga ${dbDownload.id}`,
        addedAt: createdAt,
      }) };

      // Actualizar información básica
      dl.id = dbDownload.id;
      if (dbDownload.title) dl.title = dbDownload.title;
      if (dbDownload.savePath) dl.savePath = dbDownload.savePath;
      if (dbDownload.progress !== undefined && dbDownload.progress !== null) {
        dl.percent = dbDownload.progress;
      }
      if (completedAt) dl.completedAt = completedAt;

      // Mapear estados de la BD a estados del frontend
      switch (state) {
        case 'queued':
          dl.state = 'queued';
          if (dbDownload.queuePosition !== undefined && dbDownload.queuePosition !== null) {
            dl.queuePosition = dbDownload.queuePosition;
          }
          break;
        case 'paused':
          dl.state = 'paused';
          break;
        case 'starting':
        case 'progressing':
        case 'downloading':
          dl.state = state === 'downloading' ? 'progressing' : state;
          break;
        case 'completed':
          dl.state = 'completed';
          dl.percent = 1;
          break;
        case 'cancelled':
        case 'interrupted':
        case 'failed':
          dl.state = state === 'failed' ? 'interrupted' : state;
          dl.error = dbDownload.lastError || 'Descarga interrumpida';
          break;
        default:
          // Si el estado no es reconocido, asumir completada
          dl.state = 'completed';
          dl.percent = 1;
      }

      // Guardar en el nuevo objeto
      newDownloads[dbDownload.id] = dl;
    });

    // Actualizar el shallowRef con el nuevo objeto para asegurar reactividad
    downloads.value = newDownloads;

    console.log(`[useDownloads] ${allDownloads.length} descargas restauradas correctamente`);

    // Limitar historial después de restaurar
    if (limitHistoryInMemoryFn && getCurrentLimitsFn) {
      limitHistoryInMemoryFn(getCurrentLimitsFn());
    }

    // Guardar historial actualizado
    if (saveDownloadHistoryFn) saveDownloadHistoryFn();
  };

  /**
   * Reconciliación optimizada con el backend
   * Solo se ejecuta cuando es necesario
   */
  const reconcileWithBackend = async () => {
    // Skip 1: No hay descargas activas ni en cola
    const activeCount = Object.values(downloads.value).filter(
      d => d.state === 'progressing' || d.state === 'starting'
    ).length;
    const hasActiveWork = activeCount > 0 || downloadQueue.value.some(d => d.status === 'queued');

    if (!hasActiveWork) {
      // Limpiar speedStats huérfanas sin llamar al backend
      if (speedStats.value.size > 0) {
        speedStats.value.clear();
        console.debug('[Reconcile] Limpiadas speedStats (sin descargas activas)');
      }
      return;
    }

    // Skip 2: Estado no ha cambiado desde última reconciliación
    const currentHash = getStateHash();
    if (currentHash === lastReconcileState) {
      console.debug('[Reconcile] Skip - estado sin cambios');
      return;
    }

    try {
      const stats = await api.getDownloadStats();
      if (!stats || !timeoutManager.isMounted) return;

      const activeIds = new Set(stats.activeIds || []);
      const queuedIds = new Set(stats.queuedIds || []);
      let changes = 0;

      // Reconciliar solo descargas activas/starting (no todas)
      const activeDls = Object.values(downloads.value).filter(
        d => d.state === 'progressing' || d.state === 'starting'
      );

      for (const dl of activeDls) {
        if (
          ['progressing', 'starting'].includes(dl.state) &&
          !activeIds.has(dl.id) &&
          !queuedIds.has(dl.id) &&
          !startingDownloads.has(dl.id)
        ) {
          dl.state = 'interrupted';
          dl.error = 'Conexión perdida';
          speedStats.value.delete(dl.id);
          changes++;
          console.warn(`[Reconcile] Descarga ${dl.id} perdida en backend`);
        }
      }

      // Limpiar speedStats huérfanas
      speedStats.value.forEach((_, id) => {
        const dl = downloads.value[id];
        if (!dl || !['progressing', 'starting'].includes(dl.state)) {
          speedStats.value.delete(id);
          changes++;
        }
      });

      // Actualizar estado para próxima comparación
      lastReconcileState = getStateHash();

      if (changes > 0) {
        console.debug(`[Reconcile] ${changes} cambios aplicados`);
        if (saveDownloadHistoryFn) saveDownloadHistoryFn();
      }
    } catch (error) {
      console.debug('[Reconcile] Error:', error.message);
    }
  };

  /**
   * Ajusta el intervalo de reconciliación según la actividad
   */
  const adjustReconcileInterval = () => {
    const activeCount = Object.values(downloads.value).filter(
      d => d.state === 'progressing' || d.state === 'starting'
    ).length;
    const hasActiveWork = activeCount > 0;
    const newInterval = hasActiveWork ? RECONCILE_ACTIVE_INTERVAL : RECONCILE_IDLE_INTERVAL;

    if (newInterval !== reconcileIntervalMs) {
      reconcileIntervalMs = newInterval;

      // Reiniciar intervalo con nuevo timing
      if (reconciliationInterval) {
        clearInterval(reconciliationInterval);
        reconciliationInterval = setInterval(async () => {
          if (!timeoutManager.isMounted) return;
          adjustReconcileInterval(); // Auto-ajustar en cada tick
          await reconcileWithBackend();
        }, reconcileIntervalMs);
      }

      console.debug(`[Reconcile] Intervalo ajustado a ${reconcileIntervalMs}ms`);
    }
  };

  /**
   * Inicia la reconciliación y los listeners
   */
  const startReconciliation = () => {
    // Resetear flag de limpieza si se reinicia
    isCleaned = false;
    // Intervalo de rotación de nombre de descarga
    rotationInterval = setInterval(() => {
      if (!timeoutManager.isMounted) return;
      if (speedStats.value.size > 0) {
        currentDownloadIndex.value = (currentDownloadIndex.value + 1) % speedStats.value.size;
      }
    }, 5000);

    // Iniciar reconciliación con intervalo adaptativo
    reconciliationInterval = setInterval(async () => {
      if (!timeoutManager.isMounted) return;
      adjustReconcileInterval();
      await reconcileWithBackend();
      // Limpiar historial periódicamente (cada 5 reconciliaciones aprox)
      if (Math.random() < 0.2 && limitHistoryInMemoryFn && getCurrentLimitsFn) {
        // 20% de probabilidad = ~cada 5 reconciliaciones
        limitHistoryInMemoryFn(getCurrentLimitsFn());
      }
    }, reconcileIntervalMs);

    // Escuchar eventos de progreso individual
    removeProgressListener = api.onDownloadProgress(handleProgressEvent);

    // NUEVO FASE 2: Escuchar eventos de progreso por lotes (Batch)
    removeBatchProgressListener = api.onDownloadProgressBatch(payload => {
      if (payload && payload.downloads && Array.isArray(payload.downloads)) {
        payload.downloads.forEach(info => handleProgressEvent(info));
      }
    });

    // Escuchar eventos de limpieza de historial desde el backend
    removeHistoryListener = api.onHistoryCleaned(data => {
      if (showNotifications.value && data.count > 0) {
        console.log(
          `[useDownloads] Historial limpiado en BD: ${data.count} registros antiguos eliminados`
        );
        // Emitir evento para mostrar notificación (se manejará en App.vue)
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(
            new CustomEvent('history-cleaned', {
              detail: { count: data.count },
            })
          );
        }
      }
    });

    // Escuchar eventos de descargas restauradas desde el backend
    removeRestoredListener = api.onDownloadsRestored(handleDownloadsRestored);
  };

  /**
   * Detiene la reconciliación y limpia listeners
   * CRÍTICO: Previene memory leaks limpiando todos los event listeners IPC
   */
  const stopReconciliation = () => {
    // Flag para prevenir doble limpieza
    if (isCleaned) {
      log.warn('[Reconcile] Intento de limpieza duplicada, ignorando');
      return;
    }
    isCleaned = true;

    // Limpiar intervalos
    if (rotationInterval) {
      clearInterval(rotationInterval);
      rotationInterval = null;
    }

    if (reconciliationInterval) {
      clearInterval(reconciliationInterval);
      reconciliationInterval = null;
    }

    // NUEVO FASE 3: Limpiar requestAnimationFrame
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    uiUpdateQueue.clear();

    // CRÍTICO: Limpiar todos los listeners IPC con manejo de errores
    try {
      if (removeProgressListener && typeof removeProgressListener === 'function') {
        removeProgressListener();
        removeProgressListener = null;
        log.debug('[Reconcile] Progress listener limpiado');
      }
    } catch (error) {
      log.error('[Reconcile] Error limpiando progress listener:', error);
    }

    // NUEVO FASE 2: Limpiar batch listener
    try {
      if (removeBatchProgressListener && typeof removeBatchProgressListener === 'function') {
        removeBatchProgressListener();
        removeBatchProgressListener = null;
        log.debug('[Reconcile] Batch progress listener limpiado');
      }
    } catch (error) {
      log.error('[Reconcile] Error limpiando batch progress listener:', error);
    }

    try {
      if (removeHistoryListener && typeof removeHistoryListener === 'function') {
        removeHistoryListener();
        removeHistoryListener = null;
        log.debug('[Reconcile] History listener limpiado');
      }
    } catch (error) {
      log.error('[Reconcile] Error limpiando history listener:', error);
    }

    try {
      if (removeRestoredListener && typeof removeRestoredListener === 'function') {
        removeRestoredListener();
        removeRestoredListener = null;
        log.debug('[Reconcile] Restored listener limpiado');
      }
    } catch (error) {
      log.error('[Reconcile] Error limpiando restored listener:', error);
    }

    // Resetear estado de reconciliación
    lastReconcileState = null;
    reconcileIntervalMs = RECONCILE_ACTIVE_INTERVAL;
    
    log.debug('[Reconcile] Todos los listeners y recursos limpiados');
  };

  return {
    handleProgressEvent,
    handleDownloadsRestored,
    reconcileWithBackend,
    startReconciliation,
    stopReconciliation,
  };
}

export default useDownloadReconciliation;
