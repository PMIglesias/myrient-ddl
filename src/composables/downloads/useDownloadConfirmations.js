/**
 * useDownloadConfirmations - Confirmaciones de sobrescritura
 * 
 * Maneja las confirmaciones cuando un archivo ya existe
 */

import { pendingConfirmations, selectedDownloads, downloadQueue, downloads } from './useDownloadState';

/**
 * Composable de confirmaciones
 * @param {Function} processDownloadQueueFn - Función para procesar la cola
 * @param {Function} saveDownloadHistoryFn - Función para guardar historial
 */
export function useDownloadConfirmations(processDownloadQueueFn, saveDownloadHistoryFn) {
    
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
            // Resetear completamente la descarga
            const dl = downloads.value[downloadId];
            dl.state = 'queued';
            dl.percent = 0;
            dl.downloadedBytes = 0;
            delete dl.error;
            delete dl.speed;
            delete dl.eta;
            
            console.log(`[confirmOverwrite] Descarga ${downloadId} reiniciada para sobrescritura`);
        }

        if (processDownloadQueueFn) processDownloadQueueFn();
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
