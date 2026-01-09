/**
 * useDownloadHistory - Persistencia y gestión de historial
 * 
 * Maneja la carga, guardado y limitación del historial de descargas
 */

import { downloads, downloadQueue, speedStats, pendingConfirmations, startingDownloads } from './useDownloadState';
import { MEMORY_LIMITS } from './useDownloadState';
import * as api from '../../services/api';

/**
 * Composable de historial
 * @param {Object} settings - Configuración desde useSettings (opcional)
 */
export function useDownloadHistory(settings = null) {

    /**
     * Obtiene los límites actuales desde configuración
     */
    const getCurrentLimits = () => {
        const maxHistoryInMemory = settings?.maxHistoryInMemory || { value: MEMORY_LIMITS.MAX_HISTORY_IN_MEMORY };
        const maxCompletedInMemory = settings?.maxCompletedInMemory || { value: MEMORY_LIMITS.MAX_COMPLETED_IN_MEMORY };
        const maxFailedInMemory = settings?.maxFailedInMemory || { value: MEMORY_LIMITS.MAX_FAILED_IN_MEMORY };
        
        return {
            maxHistory: maxHistoryInMemory.value || MEMORY_LIMITS.MAX_HISTORY_IN_MEMORY,
            maxCompleted: maxCompletedInMemory.value || MEMORY_LIMITS.MAX_COMPLETED_IN_MEMORY,
            maxFailed: maxFailedInMemory.value || MEMORY_LIMITS.MAX_FAILED_IN_MEMORY
        };
    };

    /**
     * Limita el historial en memoria para evitar fugas de memoria
     * Mantiene siempre:
     * - Todas las descargas activas (progressing, starting, queued, paused, waiting)
     * - Las últimas N descargas completadas
     * - Las últimas N descargas fallidas/canceladas
     */
    const limitHistoryInMemory = (customLimits = null) => {
        const limits = customLimits || getCurrentLimits();
        const maxHistory = limits.maxHistory;
        const maxCompleted = limits.maxCompleted;
        const maxFailed = limits.maxFailed;
        
        const allDownloads = Object.values(downloads.value);
        const totalCount = allDownloads.length;

        // Si no excede el límite, no hacer nada
        if (totalCount <= maxHistory) {
            return { removed: 0, kept: totalCount, total: totalCount };
        }

        // Separar descargas por estado
        const activeDownloads = [];
        const completedDownloads = [];
        const failedDownloads = [];
        const cancelledDownloads = [];

        allDownloads.forEach(dl => {
            const state = dl.state;
            if (['progressing', 'starting', 'queued', 'paused', 'waiting'].includes(state)) {
                activeDownloads.push(dl);
            } else if (state === 'completed') {
                completedDownloads.push(dl);
            } else if (state === 'interrupted' || state === 'failed') {
                failedDownloads.push(dl);
            } else if (state === 'cancelled') {
                cancelledDownloads.push(dl);
            }
        });

        // Ordenar por fecha (más recientes primero)
        completedDownloads.sort((a, b) => (b.completedAt || b.addedAt || 0) - (a.completedAt || a.addedAt || 0));
        failedDownloads.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        cancelledDownloads.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

        // Limitar descargas completadas
        const keptCompleted = completedDownloads.slice(0, maxCompleted);
        
        // Limitar descargas fallidas
        const keptFailed = failedDownloads.slice(0, maxFailed);
        
        // Limitar descargas canceladas (menos prioritarias)
        const keptCancelled = cancelledDownloads.slice(0, Math.max(0, maxFailed - keptFailed.length));

        // Reconstruir objeto de descargas
        const newDownloads = {};
        
        // Siempre mantener todas las activas
        activeDownloads.forEach(dl => {
            newDownloads[dl.id] = dl;
        });
        
        // Agregar descargas completadas limitadas
        keptCompleted.forEach(dl => {
            newDownloads[dl.id] = dl;
        });
        
        // Agregar descargas fallidas limitadas
        keptFailed.forEach(dl => {
            newDownloads[dl.id] = dl;
        });
        
        // Agregar descargas canceladas limitadas
        keptCancelled.forEach(dl => {
            newDownloads[dl.id] = dl;
        });

        const removedCount = totalCount - Object.keys(newDownloads).length;
        
        if (removedCount > 0) {
            const keptCount = Object.keys(newDownloads).length;
            console.debug(`[useDownloads] Limpieza de memoria: ${removedCount} descargas antiguas removidas (${keptCount} mantenidas)`);
            downloads.value = newDownloads;
            
            // Emitir evento con estadísticas para notificación
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('memory-cleaned', { 
                    detail: { 
                        removed: removedCount, 
                        kept: keptCount,
                        total: totalCount
                    } 
                }));
            }
        }
        
        return {
            removed: removedCount,
            kept: Object.keys(newDownloads).length,
            total: totalCount
        };
    };

    /**
     * Carga el historial desde el archivo de configuración
     */
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
                
                // Limitar historial después de cargar (puede haber muchas descargas antiguas)
                limitHistoryInMemory();
                
                await saveDownloadHistory();
            }
        } catch (error) {
            console.error('[useDownloads] Error cargando historial:', error);
        }
    };

    /**
     * Guarda el historial al archivo de configuración
     */
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

    /**
     * Limpia descargas completadas/detenidas
     */
    const clearDownloads = () => {
        const toKeep = {};
        let removedCount = 0;
        
        Object.entries(downloads.value).forEach(([id, dl]) => {
            // Mantener solo descargas activas, en cola, pausadas o en espera
            // Eliminar solo las completadas, canceladas o con error
            if (
                ['progressing', 'starting', 'queued', 'paused', 'waiting'].includes(dl.state) ||
                ['downloading', 'queued', 'paused'].includes(dl.queueStatus)
            ) {
                toKeep[id] = dl;
            } else {
                removedCount++;
            }
        });
        
        downloads.value = toKeep;
        
        if (removedCount > 0) {
            console.log(`[useDownloads] Limpiadas ${removedCount} descargas completadas/detenidas`);
        }
        
        saveDownloadHistory();
    };

    /**
     * Elimina una descarga específica del historial
     */
    const removeFromHistory = async (downloadId) => {
        try {
            // Llamar al backend para eliminar de la base de datos
            const result = await api.deleteDownload(downloadId);
            
            if (!result.success) {
                console.error(`[removeFromHistory] Error eliminando descarga ${downloadId}:`, result.error);
                // Continuar eliminando del frontend aunque falle en el backend
            }
        } catch (error) {
            console.error('[removeFromHistory] Error llamando al backend:', error);
            // Continuar eliminando del frontend aunque falle
        }
        
        // Eliminar del estado local
        delete downloads.value[downloadId];
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== downloadId);
        speedStats.value.delete(downloadId);
        pendingConfirmations.value = pendingConfirmations.value.filter(c => c.id !== downloadId);
        saveDownloadHistory();
    };

    /**
     * Cancela todas las descargas activas y en cola, luego las elimina de la lista
     */
    const cancelAllDownloads = async () => {
        try {
            // Obtener todas las descargas activas y en cola
            const downloadsToCancel = Object.values(downloads.value).filter(
                dl => 
                    ['progressing', 'starting', 'queued'].includes(dl.state) ||
                    ['downloading', 'queued'].includes(dl.queueStatus)
            );

            if (downloadsToCancel.length === 0) {
                console.debug('[useDownloads] No hay descargas activas para cancelar');
                return;
            }

            console.log(`[useDownloads] Cancelando ${downloadsToCancel.length} descargas activas...`);

            // Cancelar todas las descargas en paralelo
            await Promise.allSettled(
                downloadsToCancel.map(dl => api.cancelDownload(dl.id))
            );

            // Esperar un momento para que se completen las cancelaciones
            await new Promise(resolve => setTimeout(resolve, 300));

            // Eliminar todas las descargas canceladas de la lista
            const toKeep = {};
            Object.entries(downloads.value).forEach(([id, dl]) => {
                // Mantener solo las que no están activas o en cola
                if (
                    !['progressing', 'starting', 'queued'].includes(dl.state) &&
                    !['downloading', 'queued'].includes(dl.queueStatus)
                ) {
                    toKeep[id] = dl;
                }
            });

            downloads.value = toKeep;
            
            // Limpiar cola y estadísticas
            downloadQueue.value = [];
            speedStats.value.clear();
            startingDownloads.clear();

            console.log('[useDownloads] Todas las descargas activas canceladas y eliminadas');
            saveDownloadHistory();
        } catch (error) {
            console.error('[useDownloads] Error cancelando todas las descargas:', error);
        }
    };

    return {
        loadDownloadHistory,
        saveDownloadHistory,
        clearDownloads,
        removeFromHistory,
        cancelAllDownloads,
        limitHistoryInMemory,
        getCurrentLimits
    };
}

export default useDownloadHistory;
