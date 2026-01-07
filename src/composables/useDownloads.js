/**
 * useDownloads - Composable para gestión de descargas
 * 
 * Maneja:
 * - Cola de descargas con prioridad
 * - Estados de descarga (queued, downloading, completed, etc.)
 * - Progreso y velocidad
 * - Confirmaciones de sobrescritura
 * - Reconciliación con el backend
 * - Persistencia del historial
 * 
 * IMPORTANTE: Este composable maneja race conditions con un sistema
 * de locks y tracking de descargas "en tránsito"
 */

import { ref, computed } from 'vue';
import * as api from '../services/api';
import { useSettings } from './useSettings';

// =====================
// ESTADO GLOBAL (SINGLETON)
// =====================

const downloads = ref({});
const downloadQueue = ref([]);
const speedStats = ref(new Map());
const pendingConfirmations = ref([]);
const showingDownloads = ref(false);
const selectedDownloads = ref(new Set());
const selectedHistoryDownloads = ref(new Set());
const currentDownloadIndex = ref(0);

// Control de race conditions
const startingDownloads = new Set();
let queueProcessPromise = null;
let queueProcessTimeout = null;

// Timeouts seguros
const activeTimeouts = new Set();
let isMounted = false;

const safeSetTimeout = (callback, delay) => {
    const timeoutId = setTimeout(() => {
        activeTimeouts.delete(timeoutId);
        if (isMounted) callback();
    }, delay);
    activeTimeouts.add(timeoutId);
    return timeoutId;
};

const safeClearTimeout = (timeoutId) => {
    if (timeoutId) {
        clearTimeout(timeoutId);
        activeTimeouts.delete(timeoutId);
    }
};

const clearAllTimeouts = () => {
    activeTimeouts.forEach(id => clearTimeout(id));
    activeTimeouts.clear();
};

// Intervalos
let reconciliationInterval = null;
let rotationInterval = null;
let removeProgressListener = null;

/**
 * Composable de descargas
 */
export function useDownloads() {
    const { downloadPath, preserveStructure, maxParallelDownloads, showNotifications } = useSettings();

    // =====================
    // COMPUTED
    // =====================

    // Trigger para forzar recálculo solo cuando cambian estados (no progreso)
    const downloadStateVersion = ref(0);
    
    // Cache para evitar recálculos innecesarios
    let cachedDownloadsList = [];
    let cachedStateSignature = '';

    /**
     * Genera una firma del estado actual de las descargas
     * Solo cambia cuando cambian los estados, no el progreso
     */
    const getStateSignature = () => {
        const states = Object.values(downloads.value)
            .map(d => `${d.id}:${d.state}`)
            .sort()
            .join('|');
        return states;
    };

    /**
     * Mapea el estado de descarga a queueStatus
     * Función pura para evitar recrearla en cada computed
     */
    const getQueueStatus = (state) => {
        switch (state) {
            case 'queued':
            case 'waiting':
                return 'queued';
            case 'starting':
            case 'progressing':
                return 'downloading';
            case 'paused':
                return 'paused';
            case 'completed':
                return 'completed';
            case 'interrupted':
            case 'cancelled':
                return 'error';
            default:
                return 'completed';
        }
    };

    /**
     * Orden de prioridad para el sorting
     */
    const QUEUE_ORDER = { downloading: 0, queued: 1, paused: 2, completed: 3, error: 4 };

    /**
     * allDownloads optimizado:
     * - Solo recalcula el orden cuando cambian los estados
     * - Actualiza el progreso sin reordenar
     * - Usa cache para evitar trabajo redundante
     */
    const allDownloads = computed(() => {
        const currentSignature = getStateSignature();
        const needsResort = currentSignature !== cachedStateSignature;

        if (needsResort) {
            // Estados cambiaron: reconstruir y reordenar lista
            cachedDownloadsList = Object.values(downloads.value).map(download => ({
                ...download,
                queueStatus: getQueueStatus(download.state)
            }));

            cachedDownloadsList.sort((a, b) => {
                const diff = QUEUE_ORDER[a.queueStatus] - QUEUE_ORDER[b.queueStatus];
                if (diff !== 0) return diff;
                return (a.addedAt || 0) - (b.addedAt || 0);
            });

            cachedStateSignature = currentSignature;
            console.debug(`[allDownloads] Reordenado (${cachedDownloadsList.length} items)`);
        } else {
            // Solo actualizar progreso sin reordenar
            cachedDownloadsList.forEach(cached => {
                const current = downloads.value[cached.id];
                if (current) {
                    // Actualizar solo campos que cambian frecuentemente
                    cached.percent = current.percent;
                    cached.downloadedBytes = current.downloadedBytes;
                    cached.speed = current.speed;
                    cached.eta = current.eta;
                    cached.error = current.error;
                }
            });
        }

        // Retornar copia superficial para mantener reactividad
        return [...cachedDownloadsList];
    });

    /**
     * Computed específicos por categoría (más eficientes para casos de uso específicos)
     */
    const activeDownloads = computed(() => {
        return Object.values(downloads.value).filter(
            d => d.state === 'progressing' || d.state === 'starting'
        );
    });

    const queuedDownloads = computed(() => {
        return Object.values(downloads.value).filter(
            d => d.state === 'queued' || d.state === 'waiting'
        );
    });

    const completedDownloads = computed(() => {
        return Object.values(downloads.value).filter(
            d => d.state === 'completed'
        );
    });

    const failedDownloads = computed(() => {
        return Object.values(downloads.value).filter(
            d => d.state === 'interrupted' || d.state === 'cancelled'
        );
    });

    /**
     * Contadores optimizados (evitan iteración completa)
     */
    const downloadCounts = computed(() => ({
        active: activeDownloads.value.length,
        queued: queuedDownloads.value.length,
        completed: completedDownloads.value.length,
        failed: failedDownloads.value.length,
        total: Object.keys(downloads.value).length
    }));

    const activeDownloadCount = computed(() => speedStats.value.size);

    const averageDownloadSpeed = computed(() => {
        if (speedStats.value.size === 0) return 0;
        let total = 0;
        speedStats.value.forEach(stats => total += stats.speed || 0);
        return total;
    });

    const currentDownloadName = computed(() => {
        if (speedStats.value.size === 0) return '';
        const keys = Array.from(speedStats.value.keys());
        const index = currentDownloadIndex.value % keys.length;
        const dl = downloads.value[keys[index]];
        return dl ? dl.title : '';
    });

    // =====================
    // PERSISTENCIA
    // =====================

    const loadDownloadHistory = async () => {
        try {
            const result = await api.readConfigFile('download-history.json');
            if (result.success && result.data) {
                downloads.value = result.data;
                Object.values(downloads.value).forEach(dl => {
                    if (dl.state === 'progressing' || dl.state === 'starting') {
                        dl.state = 'interrupted';
                        dl.error = 'Descarga interrumpida al cerrar la aplicación';
                    }
                });
                await saveDownloadHistory();
            }
        } catch (error) {
            console.error('[useDownloads] Error cargando historial:', error);
        }
    };

    const saveDownloadHistory = async () => {
        try {
            const sanitized = {};
            for (const [id, dl] of Object.entries(downloads.value)) {
                sanitized[id] = {
                    id: dl.id,
                    title: dl.title,
                    state: dl.state,
                    percent: dl.percent || 0,
                    error: dl.error || null,
                    savePath: dl.savePath || null,
                    completedAt: dl.completedAt || null,
                    addedAt: dl.addedAt || null
                };
            }
            await api.writeConfigFile('download-history.json', sanitized);
        } catch (error) {
            console.error('[useDownloads] Error guardando historial:', error);
        }
    };

    // =====================
    // COLA DE DESCARGAS
    // =====================

    const download = (file) => {
        if (!file || !file.id) return;

        const existing = downloads.value[file.id];
        if (existing) {
            if (['progressing', 'starting', 'queued'].includes(existing.state)) {
                console.log('[useDownloads] Ya en proceso:', file.title);
                return;
            }
        }

        downloads.value[file.id] = {
            id: file.id,
            title: file.title,
            state: 'queued',
            percent: 0,
            addedAt: Date.now()
        };

        if (!downloadQueue.value.some(d => d.id === file.id)) {
            downloadQueue.value.push({
                id: file.id,
                title: file.title,
                status: 'queued',
                addedAt: Date.now()
            });
        }

        processDownloadQueue();
    };

    const processDownloadQueue = () => {
        if (queueProcessTimeout) safeClearTimeout(queueProcessTimeout);

        queueProcessTimeout = safeSetTimeout(async () => {
            if (queueProcessPromise) await queueProcessPromise;

            queueProcessPromise = executeQueueProcessing();
            await queueProcessPromise;
            queueProcessPromise = null;

            if (downloadQueue.value.some(d => d.status === 'queued')) {
                safeSetTimeout(() => processDownloadQueue(), 50);
            }
        }, 100);
    };

    const executeQueueProcessing = async () => {
        try {
            const activeCount = Object.values(downloads.value).filter(
                d => d.state === 'starting' || d.state === 'progressing'
            ).length;

            const totalActive = activeCount + startingDownloads.size;
            const availableSlots = maxParallelDownloads.value - totalActive;

            if (availableSlots <= 0) return;

            const queued = downloadQueue.value.filter(
                d => d.status === 'queued' && !startingDownloads.has(d.id)
            );

            const toStart = queued.slice(0, availableSlots);
            if (toStart.length === 0) return;

            for (const item of toStart) {
                if (!isMounted) break;
                if (startingDownloads.has(item.id)) continue;

                startingDownloads.add(item.id);
                item.status = 'downloading';

                try {
                    const result = await api.download({
                        id: item.id,
                        title: item.title,
                        downloadPath: downloadPath.value,
                        preserveStructure: preserveStructure.value,
                        forceOverwrite: item.forceOverwrite || false
                    });

                    if (!result.success && !result.queued) {
                        item.status = 'queued';
                        if (downloads.value[item.id]) {
                            downloads.value[item.id].state = 'interrupted';
                            downloads.value[item.id].error = result.error || 'Error al iniciar';
                        }
                    }
                } catch (error) {
                    console.error(`[Queue] Error en ${item.id}:`, error);
                    item.status = 'queued';
                } finally {
                    safeSetTimeout(() => startingDownloads.delete(item.id), 500);
                }

                await new Promise(resolve => safeSetTimeout(resolve, 50));
            }
        } catch (error) {
            console.error('[Queue] Error:', error);
        }
    };

    // =====================
    // CONTROL DE DESCARGAS
    // =====================

    const pauseDownload = async (downloadId) => {
        try {
            await api.pauseDownload(downloadId);
        } catch (error) {
            console.error('[useDownloads] Error pausando:', error);
        }
    };

    const resumeDownload = (downloadId) => {
        const dl = downloads.value[downloadId];
        if (!dl) return;
        if (['progressing', 'starting'].includes(dl.state)) return;
        if (startingDownloads.has(downloadId)) return;
        if (downloadQueue.value.some(d => d.id === downloadId && d.status === 'queued')) return;

        dl.state = 'queued';
        delete dl.error;

        downloadQueue.value.push({
            id: downloadId,
            title: dl.title,
            status: 'queued',
            addedAt: Date.now()
        });

        processDownloadQueue();
    };

    const cancelDownload = async (downloadId) => {
        try {
            const result = await api.cancelDownload(downloadId);
            if (result.success) {
                downloadQueue.value = downloadQueue.value.filter(d => d.id !== downloadId);
                speedStats.value.delete(downloadId);
            }
        } catch (error) {
            console.error('[useDownloads] Error cancelando:', error);
        }
    };

    const retryDownload = (downloadId) => {
        const dl = downloads.value[downloadId];
        if (!dl) return;

        dl.state = 'queued';
        dl.percent = 0;
        delete dl.error;

        downloadQueue.value.push({
            id: downloadId,
            title: dl.title,
            status: 'queued',
            addedAt: Date.now()
        });

        processDownloadQueue();
    };

    // =====================
    // CONFIRMACIONES
    // =====================

    const confirmOverwrite = (downloadId) => {
        const conf = pendingConfirmations.value.find(c => c.id === downloadId);
        if (!conf) return;

        pendingConfirmations.value = pendingConfirmations.value.filter(c => c.id !== downloadId);
        selectedDownloads.value.delete(downloadId);

        const inQueue = downloadQueue.value.find(d => d.id === downloadId);
        if (inQueue) {
            inQueue.forceOverwrite = true;
        } else {
            downloadQueue.value.push({
                id: conf.id,
                title: conf.title,
                status: 'queued',
                forceOverwrite: true,
                addedAt: Date.now()
            });
        }

        if (downloads.value[downloadId]) {
            downloads.value[downloadId].state = 'queued';
            delete downloads.value[downloadId].error;
        }

        processDownloadQueue();
    };

    const cancelOverwrite = (downloadId) => {
        pendingConfirmations.value = pendingConfirmations.value.filter(c => c.id !== downloadId);
        selectedDownloads.value.delete(downloadId);

        if (downloads.value[downloadId]) {
            downloads.value[downloadId].state = 'cancelled';
            downloads.value[downloadId].error = 'Cancelado por el usuario';
            saveDownloadHistory();
        }
    };

    const confirmOverwriteAll = () => {
        selectedDownloads.value.forEach(id => confirmOverwrite(id));
        selectedDownloads.value.clear();
    };

    const cancelOverwriteAll = () => {
        selectedDownloads.value.forEach(id => cancelOverwrite(id));
        selectedDownloads.value.clear();
    };

    // =====================
    // LIMPIEZA
    // =====================

    const clearDownloads = () => {
        const toKeep = {};
        Object.entries(downloads.value).forEach(([id, dl]) => {
            if (['progressing', 'starting', 'queued'].includes(dl.state)) {
                toKeep[id] = dl;
            }
        });
        downloads.value = toKeep;
        saveDownloadHistory();
    };

    const removeFromHistory = (downloadId) => {
        delete downloads.value[downloadId];
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== downloadId);
        speedStats.value.delete(downloadId);
        pendingConfirmations.value = pendingConfirmations.value.filter(c => c.id !== downloadId);
        saveDownloadHistory();
    };

    // =====================
    // SELECCIÓN
    // =====================

    const toggleSelectDownload = (id) => {
        if (selectedDownloads.value.has(id)) {
            selectedDownloads.value.delete(id);
        } else {
            selectedDownloads.value.add(id);
        }
    };

    const toggleSelectHistoryDownload = (id) => {
        if (selectedHistoryDownloads.value.has(id)) {
            selectedHistoryDownloads.value.delete(id);
        } else {
            selectedHistoryDownloads.value.add(id);
        }
    };

    const toggleSelectAllHistoryDownloads = () => {
        if (selectedHistoryDownloads.value.size === allDownloads.value.length) {
            selectedHistoryDownloads.value.clear();
        } else {
            allDownloads.value.forEach(d => selectedHistoryDownloads.value.add(d.id));
        }
    };

    // =====================
    // HELPERS
    // =====================

    const getDownloadPercentage = (dl) => Math.round((dl?.percent || 0) * 100);

    const getDownloadButtonText = (id) => {
        const dl = downloads.value[id];
        if (dl) {
            if (dl.state === 'completed') return '¡Listo!';
            if (dl.state === 'progressing') return 'Bajando...';
            if (dl.state === 'interrupted') return 'Reintentar';
        }
        return 'Descargar';
    };

    const isDownloading = (id) => {
        const dl = downloads.value[id];
        return dl && ['progressing', 'starting', 'queued'].includes(dl.state);
    };

    // =====================
    // LIFECYCLE
    // =====================

    const handleProgressEvent = (info) => {
        if (!isMounted || !downloads.value) return;

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
                saveDownloadHistory();
                safeSetTimeout(() => processDownloadQueue(), 100);
                break;

            case 'interrupted':
            case 'cancelled':
                dl.state = info.state;
                dl.error = info.error || 'Descarga interrumpida';
                speedStats.value.delete(info.id);
                downloadQueue.value = downloadQueue.value.filter(d => d.id !== info.id);
                saveDownloadHistory();
                safeSetTimeout(() => processDownloadQueue(), 100);
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
                        showNotification: showNotifications.value
                    });
                }
                break;

            case 'queued':
                dl.state = 'queued';
                if (info.position) dl.queuePosition = info.position;
                break;
        }

        downloads.value[info.id] = dl;
    };

    // =====================
    // RECONCILIACIÓN OPTIMIZADA
    // =====================

    // Estado para optimización
    let lastReconcileState = null;
    let reconcileIntervalMs = 5000; // Intervalo base
    const RECONCILE_ACTIVE_INTERVAL = 5000;   // 5s cuando hay actividad
    const RECONCILE_IDLE_INTERVAL = 15000;    // 15s cuando no hay actividad

    /**
     * Calcula un hash simple del estado actual para detectar cambios
     */
    const getStateHash = () => {
        const activeCount = activeDownloads.value.length;
        const queueCount = downloadQueue.value.length;
        const speedCount = speedStats.value.size;
        return `${activeCount}-${queueCount}-${speedCount}`;
    };

    /**
     * Reconciliación optimizada con el backend
     * Solo se ejecuta cuando es necesario
     */
    const reconcileWithBackend = async () => {
        // Skip 1: No hay descargas activas ni en cola
        const hasActiveWork = activeDownloads.value.length > 0 || 
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
            if (!stats || !isMounted) return;

            const activeIds = new Set(stats.activeIds || []);
            const queuedIds = new Set(stats.queuedIds || []);
            let changes = 0;

            // Reconciliar solo descargas activas/starting (no todas)
            for (const dl of activeDownloads.value) {
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
                saveDownloadHistory();
            }

        } catch (error) {
            console.debug('[Reconcile] Error:', error.message);
        }
    };

    /**
     * Ajusta el intervalo de reconciliación según la actividad
     */
    const adjustReconcileInterval = () => {
        const hasActiveWork = activeDownloads.value.length > 0;
        const newInterval = hasActiveWork ? RECONCILE_ACTIVE_INTERVAL : RECONCILE_IDLE_INTERVAL;
        
        if (newInterval !== reconcileIntervalMs) {
            reconcileIntervalMs = newInterval;
            
            // Reiniciar intervalo con nuevo timing
            if (reconciliationInterval) {
                clearInterval(reconciliationInterval);
                reconciliationInterval = setInterval(async () => {
                    if (!isMounted) return;
                    adjustReconcileInterval(); // Auto-ajustar en cada tick
                    await reconcileWithBackend();
                }, reconcileIntervalMs);
            }
            
            console.debug(`[Reconcile] Intervalo ajustado a ${reconcileIntervalMs}ms`);
        }
    };

    const initDownloads = () => {
        isMounted = true;
        loadDownloadHistory();

        rotationInterval = setInterval(() => {
            if (!isMounted) return;
            if (speedStats.value.size > 0) {
                currentDownloadIndex.value = (currentDownloadIndex.value + 1) % speedStats.value.size;
            }
        }, 5000);

        // Iniciar reconciliación con intervalo adaptativo
        reconciliationInterval = setInterval(async () => {
            if (!isMounted) return;
            adjustReconcileInterval();
            await reconcileWithBackend();
        }, reconcileIntervalMs);

        removeProgressListener = api.onDownloadProgress(handleProgressEvent);
    };

    const cleanup = () => {
        isMounted = false;

        if (rotationInterval) {
            clearInterval(rotationInterval);
            rotationInterval = null;
        }

        if (reconciliationInterval) {
            clearInterval(reconciliationInterval);
            reconciliationInterval = null;
        }

        if (removeProgressListener) {
            removeProgressListener();
            removeProgressListener = null;
        }

        // Resetear estado de reconciliación
        lastReconcileState = null;
        reconcileIntervalMs = RECONCILE_ACTIVE_INTERVAL;

        clearAllTimeouts();
        safeClearTimeout(queueProcessTimeout);
        queueProcessTimeout = null;
        queueProcessPromise = null;
        startingDownloads.clear();

        saveDownloadHistory();
    };

    // =====================
    // RETURN
    // =====================

    return {
        // Estado
        downloads,
        downloadQueue,
        speedStats,
        pendingConfirmations,
        showingDownloads,
        selectedDownloads,
        selectedHistoryDownloads,
        currentDownloadIndex,

        // Computed - Lista principal
        allDownloads,
        
        // Computed - Por categoría (optimizados)
        activeDownloads,
        queuedDownloads,
        completedDownloads,
        failedDownloads,
        
        // Computed - Contadores y estadísticas
        downloadCounts,
        activeDownloadCount,
        averageDownloadSpeed,
        currentDownloadName,

        // Acciones
        download,
        pauseDownload,
        resumeDownload,
        cancelDownload,
        retryDownload,

        // Confirmaciones
        confirmOverwrite,
        cancelOverwrite,
        confirmOverwriteAll,
        cancelOverwriteAll,

        // Limpieza
        clearDownloads,
        removeFromHistory,

        // Selección
        toggleSelectDownload,
        toggleSelectHistoryDownload,
        toggleSelectAllHistoryDownloads,

        // Helpers
        getDownloadPercentage,
        getDownloadButtonText,
        isDownloading,

        // Persistencia
        loadDownloadHistory,
        saveDownloadHistory,

        // Lifecycle
        initDownloads,
        cleanup
    };
}

export default useDownloads;
