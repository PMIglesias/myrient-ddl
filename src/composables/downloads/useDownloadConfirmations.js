/**
 * useDownloadConfirmations - Confirmaciones de sobrescritura
 * 
 * Maneja las confirmaciones cuando un archivo ya existe
 */

import { pendingConfirmations, selectedDownloads, downloadQueue, downloads } from './useDownloadState';
import * as api from '../../services/api';

/**
 * Composable de confirmaciones
 * @param {Function} processDownloadQueueFn - Función para procesar la cola
 * @param {Function} saveDownloadHistoryFn - Función para guardar historial
 */
export function useDownloadConfirmations(processDownloadQueueFn, saveDownloadHistoryFn) {
    
    const confirmOverwrite = async (downloadId) => {
        const conf = pendingConfirmations.value.find(c => c.id === downloadId);
        if (!conf) {
            console.debug(`[confirmOverwrite] No se encontró confirmación para descarga ${downloadId}, pero intentando confirmar de todas formas`);
            // Continuar aunque no haya confirmación pendiente, puede que el estado ya haya cambiado
        }

        try {
            // Llamar al backend para confirmar sobrescritura
            let result = await api.confirmOverwrite(downloadId);
            let usedFallback = false;
            
            if (!result.success) {
                console.error(`[confirmOverwrite] Error confirmando sobrescritura:`, result.error);
                // Si falla porque el estado es 'queued', intentar usar retryDownload como fallback
                if (result.error && (result.error.includes('estado queued') || result.error.includes('estado completed'))) {
                    console.log(`[confirmOverwrite] Estado problemático, intentando reiniciar con forceOverwrite`);
                    result = await api.retryDownload(downloadId);
                    usedFallback = true;
                    if (!result.success) {
                        console.error(`[confirmOverwrite] Error reiniciando descarga:`, result.error);
                        return;
                    }
                } else {
                    return;
                }
            }

            // Actualizar estado local
            pendingConfirmations.value = pendingConfirmations.value.filter(c => c.id !== downloadId);
            selectedDownloads.value.delete(downloadId);

            const inQueue = downloadQueue.value.find(d => d.id === downloadId);
            if (inQueue) {
                inQueue.forceOverwrite = true;
                inQueue.status = 'queued';
            } else {
                const downloadTitle = conf?.title || downloads.value[downloadId]?.title || 'Descarga';
                downloadQueue.value.push({
                    id: downloadId,
                    title: downloadTitle,
                    status: 'queued',
                    forceOverwrite: true,
                    addedAt: Date.now()
                });
            }

            if (downloads.value[downloadId]) {
                // Resetear completamente la descarga
                const dl = downloads.value[downloadId];
                dl.state = 'queued';
                dl.percent = 0;
                dl.downloadedBytes = 0;
                delete dl.error;
                delete dl.speed;
                delete dl.eta;
                
                console.log(`[confirmOverwrite] Descarga ${downloadId} confirmada para sobrescritura${usedFallback ? ' (usando fallback)' : ''}`);
            }

            // El backend ya procesa la cola, pero por si acaso también lo hacemos aquí
            if (processDownloadQueueFn) processDownloadQueueFn();
        } catch (error) {
            console.error('[confirmOverwrite] Error confirmando sobrescritura:', error);
        }
    };

    const cancelOverwrite = (downloadId) => {
        pendingConfirmations.value = pendingConfirmations.value.filter(c => c.id !== downloadId);
        selectedDownloads.value.delete(downloadId);

        if (downloads.value[downloadId]) {
            downloads.value[downloadId].state = 'cancelled';
            downloads.value[downloadId].error = 'Cancelado por el usuario';
            if (saveDownloadHistoryFn) saveDownloadHistoryFn();
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

    return {
        confirmOverwrite,
        cancelOverwrite,
        confirmOverwriteAll,
        cancelOverwriteAll
    };
}

export default useDownloadConfirmations;
