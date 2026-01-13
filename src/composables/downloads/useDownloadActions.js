/**
 * @fileoverview useDownloadActions - Acciones de descarga
 * @module useDownloadActions
 *
 * Maneja todas las acciones relacionadas con descargas:
 * - Iniciar descarga de archivo individual
 * - Descargar carpeta completa recursivamente
 * - Pausar, reanudar, cancelar descargas
 * - Reintentar descargas fallidas
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} DownloadSettings
 * @property {string} downloadPath - Ruta base de descarga
 * @property {boolean} preserveStructure - Si mantener estructura de carpetas
 * @property {number} maxParallelDownloads - Máximo de descargas concurrentes
 */

/**
 * @typedef {Object} FileInfo
 * @property {number} id - ID único del archivo
 * @property {string} title - Nombre del archivo
 * @property {string} [type] - Tipo: 'file' | 'folder'
 */

/**
 * @typedef {Object} FolderDownloadResult
 * @property {boolean} success - Si la operación fue exitosa
 * @property {number} [totalFiles] - Total de archivos en la carpeta
 * @property {number} [added] - Archivos agregados a la cola
 * @property {number} [skipped] - Archivos omitidos (duplicados)
 * @property {string} [folderTitle] - Título de la carpeta
 * @property {string} [error] - Mensaje de error si falló
 */

import { downloads, downloadQueue, startingDownloads, triggerRef } from './useDownloadState';
import * as api from '../../services/api';

/**
 * Composable para acciones de descarga
 *
 * Proporciona métodos para iniciar, pausar, reanudar, cancelar y reintentar descargas.
 * Coordina con el backend mediante IPC y gestiona el estado local de descargas.
 *
 * @param {Function} processDownloadQueueFn - Función para procesar la cola de descargas
 * @param {Function} [limitHistoryInMemoryFn=null] - Función para limitar historial en memoria (opcional)
 * @param {Function} [getCurrentLimitsFn=null] - Función para obtener límites actuales (opcional)
 * @param {DownloadSettings} [settings=null] - Configuración desde useSettings
 * @returns {Object} Objeto con métodos de acciones de descarga
 * @returns {Function} returns.download - Agrega archivo a la cola de descargas
 * @returns {Function} returns.downloadFolder - Descarga carpeta completa recursivamente
 * @returns {Function} returns.pauseDownload - Pausa una descarga activa
 * @returns {Function} returns.resumeDownload - Reanuda una descarga pausada
 * @returns {Function} returns.cancelDownload - Cancela una descarga
 * @returns {Function} returns.retryDownload - Reintenta una descarga fallida
 *
 * @example
 * const {
 *   download,
 *   downloadFolder,
 *   pauseDownload,
 *   resumeDownload,
 *   cancelDownload
 * } = useDownloadActions(processQueue, limitHistory, getLimits, settings);
 *
 * // Descargar archivo individual
 * download({ id: 12345, title: 'archivo.zip' });
 *
 * // Descargar carpeta completa
 * const result = await downloadFolder({ id: 67890, title: 'Carpeta' });
 * if (result.success) {
 *   console.log(`Agregados ${result.added} archivos a la cola`);
 * }
 *
 * // Pausar descarga
 * await pauseDownload(12345);
 */
export function useDownloadActions(
  processDownloadQueueFn,
  limitHistoryInMemoryFn = null,
  getCurrentLimitsFn = null,
  settings = null
) {
  const downloadPath = settings?.downloadPath || { value: '' };
  const preserveStructure = settings?.preserveStructure || { value: true };

  /**
   * Agrega un archivo a la cola de descargas
   *
   * Verifica que el archivo no esté ya en proceso o en cola antes de agregarlo.
   * Si el historial es muy grande, lo limita antes de procesar la cola.
   *
   * @param {FileInfo} file - Información del archivo a descargar
   * @param {number} file.id - ID único del archivo
   * @param {string} file.title - Nombre del archivo
   * @returns {void}
   *
   * @example
   * // Descargar archivo individual
   * download({ id: 12345, title: 'archivo.zip' });
   *
   * // El archivo se agregará a la cola y se procesará automáticamente
   * // si hay slots disponibles
   */
  const download = file => {
    if (!file || !file.id) return;

    // Verificar si ya existe en descargas activas o en cola
    const existing = downloads.value[file.id];
    const isInQueue = downloadQueue.value.some(d => d.id === file.id);

    if (existing) {
      if (['progressing', 'starting', 'queued', 'merging', 'waiting'].includes(existing.state)) {
        console.log('[useDownloads] Ya en proceso o cola:', file.title, '(estado:', existing.state, ')');
        return;
      }
    }

    if (isInQueue) {
      console.log('[useDownloads] Ya en cola:', file.title);
      return;
    }

    // Actualizar estado de descargas reemplazando el objeto para asegurar reactividad en componentes hijos
    downloads.value = {
      ...downloads.value,
      [file.id]: {
        id: file.id,
        title: file.title,
        state: 'queued',
        percent: 0,
        addedAt: Date.now(),
      }
    };

    // Agregar a la cola de procesamiento
    if (!downloadQueue.value.some(d => d.id === file.id)) {
      downloadQueue.value.push({
        id: file.id,
        title: file.title,
        status: 'queued',
        addedAt: Date.now(),
      });
    }

    // Limitar historial antes de procesar
    if (limitHistoryInMemoryFn && getCurrentLimitsFn) {
      limitHistoryInMemoryFn(getCurrentLimitsFn());
    }

    if (processDownloadQueueFn) processDownloadQueueFn();
  };

  /**
   * Descarga todos los archivos de una carpeta recursivamente
   *
   * Envía una solicitud al backend para descargar todos los archivos contenidos
   * en una carpeta y sus subcarpetas. El backend se encarga de recorrer la estructura
   * recursivamente y agregar cada archivo a la cola de descargas.
   *
   * @param {Object} folder - Objeto con información de la carpeta
   * @param {number} folder.id - ID único de la carpeta en la base de datos
   * @param {string} [folder.title] - Título de la carpeta (opcional, usado para logging)
   * @returns {Promise<FolderDownloadResult>} Resultado de la operación con estadísticas
   *
   * @example
   * // Descargar carpeta completa
   * const result = await downloadFolder({ id: 67890, title: 'Sistema/Software' });
   *
   * if (result.success) {
   *   console.log(`Carpeta "${result.folderTitle}"`);
   *   console.log(`Total: ${result.totalFiles} archivos`);
   *   console.log(`Agregados: ${result.added} a la cola`);
   *   console.log(`Omitidos: ${result.skipped} (duplicados)`);
   * } else {
   *   console.error('Error:', result.error);
   * }
   */
  const downloadFolder = async folder => {
    if (!folder || !folder.id) {
      console.error('[useDownloads] downloadFolder: Parámetros inválidos');
      return;
    }

    try {
      const result = await api.downloadFolder({
        folderId: folder.id,
        downloadPath: downloadPath.value,
        preserveStructure: preserveStructure.value,
        forceOverwrite: false,
      });

      if (result.success) {
        console.log(
          `[useDownloads] Descarga de carpeta iniciada: ${result.added} archivos agregados`
        );

        // El backend ya agregó los archivos a la cola y envió eventos de progreso
        // Solo necesitamos procesar la cola
        if (processDownloadQueueFn) processDownloadQueueFn();

        return {
          success: true,
          totalFiles: result.totalFiles,
          added: result.added,
          skipped: result.skipped,
          folderTitle: result.folderTitle,
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
   * Pausa una descarga activa
   *
   * Envía una solicitud al backend para pausar una descarga en progreso.
   * El backend mantendrá los archivos parciales para permitir reanudación.
   *
   * @param {number} downloadId - ID de la descarga a pausar
   * @returns {Promise<void>}
   *
   * @example
   * // Pausar descarga activa
   * await pauseDownload(12345);
   * // La descarga se pausará y los archivos parciales se mantendrán
   */
  const pauseDownload = async downloadId => {
    try {
      await api.pauseDownload(downloadId);
    } catch (error) {
      console.error('[useDownloads] Error pausando:', error);
    }
  };

  /**
   * Reanuda una descarga pausada
   *
   * Verifica que la descarga esté en estado 'paused' y no esté ya iniciándose
   * o en cola. Si todo es correcto, envía una solicitud al backend para reanudar
   * la descarga desde donde se quedó.
   *
   * @param {number} downloadId - ID de la descarga a reanudar
   * @returns {Promise<void>}
   *
   * @example
   * // Reanudar descarga pausada
   * await resumeDownload(12345);
   * // La descarga continuará desde los bytes ya descargados
   * // Se agregará a la cola y se procesará automáticamente
   */
  const resumeDownload = async downloadId => {
    const dl = downloads.value[downloadId];
    if (!dl) return;

    // Verificar que realmente está pausada
    if (dl.state !== 'paused') {
      console.debug(
        `[useDownloads] No se puede reanudar descarga ${downloadId}: estado ${dl.state}`
      );
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
        // Actualizar estado local reemplazando el objeto para reactividad
        const dlCopy = { ...dl, state: 'queued' };
        delete dlCopy.error;

        downloads.value = {
          ...downloads.value,
          [downloadId]: dlCopy
        };

        downloadQueue.value.push({
          id: downloadId,
          title: dl.title,
          status: 'queued',
          addedAt: Date.now(),
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
    const paused = Object.values(downloads.value).filter(d => d.state === 'paused');

    await Promise.allSettled(paused.map(dl => resumeDownload(dl.id)));
  };

  /**
   * Cancela una descarga
   */
  const cancelDownload = async downloadId => {
    try {
      await api.cancelDownload(downloadId);
    } catch (error) {
      console.error('[useDownloads] Error cancelando:', error);
    }
  };

  /**
   * Reintenta una descarga fallida o cancelada
   */
  const retryDownload = async downloadId => {
    const dl = downloads.value[downloadId];
    if (!dl) {
      console.debug(`[useDownloads] No se puede reiniciar descarga ${downloadId}: no encontrada`);
      return;
    }

    // Verificar que está en un estado válido para reiniciar
    // NO permitir reiniciar descargas completadas
    if (dl.state === 'completed' || dl.queueStatus === 'completed') {
      console.debug(
        `[useDownloads] No se puede reiniciar descarga ${downloadId}: ya está completada`
      );
      return;
    }

    const validStates = ['cancelled', 'interrupted', 'failed', 'waiting'];
    const validQueueStatuses = ['error', 'cancelled'];
    // Permitir reiniciar descargas en estado 'queued' si tienen un error
    const isQueuedWithError = (dl.state === 'queued' || dl.queueStatus === 'queued') && dl.error;
    if (!validStates.includes(dl.state) && !validQueueStatuses.includes(dl.queueStatus) && !isQueuedWithError) {
      console.debug(
        `[useDownloads] No se puede reiniciar descarga ${downloadId}: estado ${dl.state || dl.queueStatus}`
      );
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
      const result = await api.retryDownload(downloadId);
      if (result.success) {
        // Actualizar estado local reemplazando el objeto para reactividad
        const dlCopy = { 
          ...dl, 
          state: 'queued',
          percent: 0,
          downloadedBytes: 0
        };
        delete dlCopy.error;

        downloads.value = {
          ...downloads.value,
          [downloadId]: dlCopy
        };

        // Asegurarse de que está en la cola
        if (!downloadQueue.value.some(d => d.id === downloadId)) {
          downloadQueue.value.push({
            id: downloadId,
            title: dl.title,
            status: 'queued',
            addedAt: Date.now(),
          });
        }

        if (processDownloadQueueFn) processDownloadQueueFn();
      } else {
        console.error(`[useDownloads] Error reiniciando descarga ${downloadId}:`, result.error);
      }
    } catch (error) {
      console.error('[useDownloads] Error reiniciando descarga:', error);
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
    retryDownload,
  };
}

export default useDownloadActions;
