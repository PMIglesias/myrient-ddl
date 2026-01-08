/**
 * useDownloadReconciliation - Reconciliación con backend y eventos
 * 
 * Maneja la sincronización con el backend y los eventos de progreso
 */

import { downloads, downloadQueue, speedStats, pendingConfirmations, startingDownloads, currentDownloadIndex, timeoutManager } from './useDownloadState';
import * as api from '../../services/api';

/**
 * Composable de reconciliación
 * @param {Function} processDownloadQueueFn - Función para procesar la cola
 * @param {Function} saveDownloadHistoryFn - Función para guardar historial
 * @param {Function} limitHistoryInMemoryFn - Función para limitar historial
 * @param {Function} getCurrentLimitsFn - Función para obtener límites
 * @param {Object} settings - Configuración desde useSettings
 */
export function useDownloadReconciliation(processDownloadQueueFn, saveDownloadHistoryFn, limitHistoryInMemoryFn, getCurrentLimitsFn, settings = null) {
    const showNotifications = settings?.showNotifications || { value: true };
    
    // Helper para obtener el valor de showNotifications
    const getShowNotifications = () => {
        return showNotifications?.value ?? true;
    };

    // Estado para optimización
    let lastReconcileState = null;
    let reconcileIntervalMs = 5000; // Intervalo base
    const RECONCILE_ACTIVE_INTERVAL = 5000;   // 5s cuando hay actividad
    const RECONCILE_IDLE_INTERVAL = 15000;    // 15s cuando no hay actividad

    // Intervalos
    let reconciliationInterval = null;
    let rotationInterval = null;
    let removeProgressListener = null;
    let removeHistoryListener = null;
    let removeRestoredListener = null;

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

    /**
     * Maneja eventos de progreso desde el backend
     */
    const handleProgressEvent = (info) => {
        if (!timeoutManager.isMounted || !downloads.value) return;

        startingDownloads.delete(info.id);

        let dl = downloads.value[info.id] || {
            id: info.id,
            title: info.title || `Descarga ${info.id}`,
            addedAt: Date.now()
        };

        dl.id = info.id;
        if (info.title) dl.title = info.title;

        switch (info.state) {
            case 'starting':
                dl.state = 'starting';
                dl.percent = 0;
                delete dl.error;
                break;

            case 'progressing':
                dl.state = 'progressing';
                dl.percent = info.percent;
                delete dl.error;
                speedStats.value.set(info.id, {
                    speed: info.speed || 0,
                    totalBytes: info.totalBytes || 0,
                    downloadedBytes: info.downloadedBytes || 0,
                    remainingTime: info.remainingTime || 0
                });
                break;

            case 'completed':
                dl.state = 'completed';
                dl.percent = 1;
                dl.completedAt = Date.now();
                dl.savePath = info.savePath;
                speedStats.value.delete(info.id);
                downloadQueue.value = downloadQueue.value.filter(d => d.id !== info.id);
                if (saveDownloadHistoryFn) saveDownloadHistoryFn();
                timeoutManager.safeSetTimeout(() => {
                    if (processDownloadQueueFn) processDownloadQueueFn();
                }, 100);
                break;

            case 'interrupted':
            case 'cancelled':
                dl.state = info.state;
                dl.error = info.error || 'Descarga interrumpida';
                speedStats.value.delete(info.id);
                downloadQueue.value = downloadQueue.value.filter(d => d.id !== info.id);
                if (saveDownloadHistoryFn) saveDownloadHistoryFn();
                timeoutManager.safeSetTimeout(() => {
                    if (processDownloadQueueFn) processDownloadQueueFn();
                }, 100);
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
                        showNotification: getShowNotifications()
                    });
                }
                break;

            case 'queued':
                dl.state = 'queued';
                if (info.position) dl.queuePosition = info.position;
                break;
        }

        downloads.value[info.id] = dl;
        
        // Limitar historial en memoria después de actualizar
        // Solo si la descarga se completó o falló (para no hacerlo en cada actualización de progreso)
        if (['completed', 'interrupted', 'cancelled'].includes(info.state)) {
            if (limitHistoryInMemoryFn && getCurrentLimitsFn) {
                limitHistoryInMemoryFn(getCurrentLimitsFn());
            }
        }
    };

    /**
     * Maneja el evento de descargas restauradas desde la base de datos
     */
    const handleDownloadsRestored = (allDownloads) => {
        if (!timeoutManager.isMounted || !downloads.value || !Array.isArray(allDownloads)) return;

        console.log(`[useDownloads] Restaurando ${allDownloads.length} descargas desde BD...`);

        // Procesar cada descarga restaurada
        allDownloads.forEach((dbDownload) => {
            // Mapear el estado de la BD al estado del frontend
            let state = dbDownload.state || 'completed';
            
            // Los timestamps de la BD son números (milisegundos desde epoch)
            const createdAt = typeof dbDownload.createdAt === 'number' 
                ? dbDownload.createdAt 
                : (dbDownload.createdAt ? new Date(dbDownload.createdAt).getTime() : Date.now());
            
            const completedAt = dbDownload.completedAt 
                ? (typeof dbDownload.completedAt === 'number' 
                    ? dbDownload.completedAt 
                    : new Date(dbDownload.completedAt).getTime())
                : null;
            
            // Crear o actualizar la descarga en el estado del frontend
            const dl = downloads.value[dbDownload.id] || {
                id: dbDownload.id,
                title: dbDownload.title || `Descarga ${dbDownload.id}`,
                addedAt: createdAt
            };

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

            // Guardar en el estado
            downloads.value[dbDownload.id] = dl;
        });

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
        const hasActiveWork = activeCount > 0 || 
                              downloadQueue.value.some(d => d.status === 'queued');
        
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
                if (['progressing', 'starting'].includes(dl.state) &&
                    !activeIds.has(dl.id) &&
                    !queuedIds.has(dl.id) &&
                    !startingDownloads.has(dl.id)) {
                    
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
            if (Math.random() < 0.2 && limitHistoryInMemoryFn && getCurrentLimitsFn) { // 20% de probabilidad = ~cada 5 reconciliaciones
                limitHistoryInMemoryFn(getCurrentLimitsFn());
            }
        }, reconcileIntervalMs);

        // Escuchar eventos de progreso
        removeProgressListener = api.onDownloadProgress(handleProgressEvent);
        
        // Escuchar eventos de limpieza de historial desde el backend
        removeHistoryListener = api.onHistoryCleaned((data) => {
            if (showNotifications.value && data.count > 0) {
                console.log(`[useDownloads] Historial limpiado en BD: ${data.count} registros antiguos eliminados`);
                // Emitir evento para mostrar notificación (se manejará en App.vue)
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('history-cleaned', { 
                        detail: { count: data.count } 
                    }));
                }
            }
        });
        
        // Escuchar eventos de descargas restauradas desde el backend
        removeRestoredListener = api.onDownloadsRestored(handleDownloadsRestored);
    };

    /**
     * Detiene la reconciliación y limpia listeners
     */
    const stopReconciliation = () => {
        // Limpiar intervalos
        if (rotationInterval) {
            clearInterval(rotationInterval);
            rotationInterval = null;
        }

        if (reconciliationInterval) {
            clearInterval(reconciliationInterval);
            reconciliationInterval = null;
        }

        // Remover listeners
        if (removeProgressListener) {
            removeProgressListener();
            removeProgressListener = null;
        }
        
        if (removeHistoryListener) {
            removeHistoryListener();
            removeHistoryListener = null;
        }
        
        if (removeRestoredListener) {
            removeRestoredListener();
            removeRestoredListener = null;
        }

        // Resetear estado de reconciliación
        lastReconcileState = null;
        reconcileIntervalMs = RECONCILE_ACTIVE_INTERVAL;
    };

    return {
        handleProgressEvent,
        handleDownloadsRestored,
        reconcileWithBackend,
        startReconciliation,
        stopReconciliation
    };
}

export default useDownloadReconciliation;
