/**
 * useDownloadActions - Acciones de descarga
 * 
 * Maneja todas las acciones: download, pause, resume, cancel, retry
 */

import { downloads, downloadQueue, startingDownloads } from './useDownloadState';
import * as api from '../../services/api';

/**
 * Composable de acciones de descarga
 * @param {Function} processDownloadQueueFn - Función para procesar la cola
 * @param {Function} limitHistoryInMemoryFn - Función para limitar historial (opcional)
 * @param {Function} getCurrentLimitsFn - Función para obtener límites (opcional)
 * @param {Object} settings - Configuración desde useSettings
 */
export function useDownloadActions(processDownloadQueueFn, limitHistoryInMemoryFn = null, getCurrentLimitsFn = null, settings = null) {
    const downloadPath = settings?.downloadPath || { value: '' };
    const preserveStructure = settings?.preserveStructure || { value: true };

    /**
     * Agrega un archivo a la cola de descargas
     */
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

        // Limitar historial antes de procesar (por si hay muchas descargas)
        if (limitHistoryInMemoryFn && getCurrentLimitsFn) {
            limitHistoryInMemoryFn(getCurrentLimitsFn());
        }

        if (processDownloadQueueFn) processDownloadQueueFn();
    };

    /**
     * Descarga todos los archivos de una carpeta recursivamente
     * @param {Object} folder - Objeto con información de la carpeta
     * @param {number} folder.id - ID de la carpeta
     * @param {string} folder.title - Título de la carpeta (opcional)
     */
    const downloadFolder = async (folder) => {
        if (!folder || !folder.id) {
            console.error('[useDownloads] downloadFolder: Parámetros inválidos');
            return;
        }

        try {
            const result = await api.downloadFolder({
                folderId: folder.id,
                downloadPath: downloadPath.value,
                preserveStructure: preserveStructure.value,
                forceOverwrite: false
            });

            if (result.success) {
                console.log(`[useDownloads] Descarga de carpeta iniciada: ${result.added} archivos agregados`);
                
                // El backend ya agregó los archivos a la cola y envió eventos de progreso
                // Solo necesitamos procesar la cola
                if (processDownloadQueueFn) processDownloadQueueFn();
                
                return {
                    success: true,
                    totalFiles: result.totalFiles,
                    added: result.added,
                    skipped: result.skipped,
                    folderTitle: result.folderTitle
                };
            } else {
                console.error('[useDownloads] Error descargando carpeta:', result.error);
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[useDownloads] Excepción descargando carpeta:', error);
            return { success: false, error: error.message || 'Error al descargar carpeta' };
        }
    };

    /**
     * Pausa una descarga
     */
    const pauseDownload = async (downloadId) => {
        try {
            await api.pauseDownload(downloadId);
        } catch (error) {
            console.error('[useDownloads] Error pausando:', error);
        }
    };

    /**
     * Reanuda una descarga pausada
     */
    const resumeDownload = async (downloadId) => {
        const dl = downloads.value[downloadId];
        if (!dl) return;
        
        // Verificar que realmente está pausada
        if (dl.state !== 'paused') {
            console.debug(`[useDownloads] No se puede reanudar descarga ${downloadId}: estado ${dl.state}`);
            return;
        }
        
        // Verificar que no está en proceso de iniciarse
        if (startingDownloads.has(downloadId)) {
            console.debug(`[useDownloads] Descarga ${downloadId} ya está iniciándose`);
            return;
        }
        
        // Verificar que no está ya en cola
        if (downloadQueue.value.some(d => d.id === downloadId && d.status === 'queued')) {
            console.debug(`[useDownloads] Descarga ${downloadId} ya está en cola`);
            return;
        }

        try {
            const result = await api.resumeDownload(downloadId);
            if (result.success) {
                // Actualizar estado local
                dl.state = 'queued';
                delete dl.error;

                downloadQueue.value.push({
                    id: downloadId,
                    title: dl.title,
                    status: 'queued',
                    addedAt: Date.now()
                });

                if (processDownloadQueueFn) processDownloadQueueFn();
            }
        } catch (error) {
            console.error('[useDownloads] Error reanudando:', error);
        }
    };

    /**
     * Pausa todas las descargas activas
     */
    const pauseAllDownloads = async () => {
        const active = Object.values(downloads.value).filter(
            d => d.state === 'progressing' || d.state === 'starting'
        );

        await Promise.allSettled(active.map(dl => pauseDownload(dl.id)));
    };

    /**
     * Reanuda todas las descargas pausadas
     */
    const resumeAllDownloads = async () => {
        const paused = Object.values(downloads.value).filter(
            d => d.state === 'paused'
        );

        await Promise.allSettled(paused.map(dl => resumeDownload(dl.id)));
    };

    /**
     * Cancela una descarga
     */
    const cancelDownload = async (downloadId) => {
        try {
            await api.cancelDownload(downloadId);
        } catch (error) {
            console.error('[useDownloads] Error cancelando:', error);
        }
    };

    /**
     * Reintenta una descarga fallida o cancelada
     */
    const retryDownload = (downloadId) => {
        const dl = downloads.value[downloadId];
        if (!dl) return;

        // Solo reintentar si está en estado de error o cancelada
        if (dl.state === 'interrupted' || dl.state === 'cancelled') {
            try {
                // Actualizar estado local
                dl.state = 'queued';
                dl.percent = 0;
                delete dl.error;

                downloadQueue.value.push({
                    id: downloadId,
                    title: dl.title,
                    status: 'queued',
                    addedAt: Date.now()
                });

                if (processDownloadQueueFn) processDownloadQueueFn();
            } catch (error) {
                console.error('[useDownloads] Error reiniciando descarga:', error);
            }
        } else {
            // Para descargas con error, simplemente agregar a la cola
            dl.state = 'queued';
            dl.percent = 0;
            delete dl.error;

            downloadQueue.value.push({
                id: downloadId,
                title: dl.title,
                status: 'queued',
                addedAt: Date.now()
            });

            if (processDownloadQueueFn) processDownloadQueueFn();
        }
    };

    return {
        download,
        downloadFolder,
        pauseDownload,
        resumeDownload,
        pauseAllDownloads,
        resumeAllDownloads,
        cancelDownload,
        retryDownload
    };
}

export default useDownloadActions;
