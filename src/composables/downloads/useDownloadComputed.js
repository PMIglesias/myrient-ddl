/**
 * useDownloadComputed - Computed properties y estadísticas de descargas
 * 
 * Maneja todas las propiedades computadas optimizadas para rendimiento
 */

import { computed, ref } from 'vue';
import { downloads, speedStats, currentDownloadIndex } from './useDownloadState';

/**
 * Composable de computed properties
 */
export function useDownloadComputed() {
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
            case 'cancelled':
                return 'cancelled';
            case 'interrupted':
                return 'error';
            default:
                return 'completed';
        }
    };

    /**
     * Orden de prioridad para el sorting
     */
    const QUEUE_ORDER = { downloading: 0, queued: 1, paused: 2, cancelled: 3, completed: 4, error: 5 };

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

    return {
        allDownloads,
        activeDownloads,
        queuedDownloads,
        completedDownloads,
        failedDownloads,
        downloadCounts,
        activeDownloadCount,
        averageDownloadSpeed,
        currentDownloadName
    };
}

export default useDownloadComputed;
