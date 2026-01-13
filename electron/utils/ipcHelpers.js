/**
 * @fileoverview Utilidades para optimización de comunicación IPC
 * @module ipcHelpers
 *
 * Proporciona funciones helper para reducir el tamaño de payloads IPC
 * y prevenir bloqueos del main thread durante serialización JSON.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

const { logger } = require('./logger');

const log = logger.child('IPCHelpers');

/**
 * Tamaño máximo permitido para payloads IPC (100KB)
 * Payloads más grandes pueden causar bloqueos durante serialización
 */
const MAX_PAYLOAD_SIZE = 100 * 1024;

/**
 * Envía actualización de progreso de descarga optimizada al renderer
 *
 * Solo incluye campos necesarios y limita el tamaño del payload para prevenir
 * bloqueos durante serialización JSON. Limita arrays grandes como chunkProgress.
 *
 * @param {Object} mainWindow - Ventana principal de Electron
 * @param {Object} download - Objeto de descarga con información de progreso
 * @param {Object} [options={}] - Opciones de envío
 * @param {boolean} [options.includeChunks=false] - Si incluir información de chunks
 * @param {boolean} [options.includeMetadata=false] - Si incluir metadatos completos
 * @returns {void}
 *
 * @example
 * // Enviar progreso básico (payload pequeño)
 * sendDownloadProgress(mainWindow, {
 *   id: 12345,
 *   state: 'progressing',
 *   progress: 0.5,
 *   downloadedBytes: 50000000,
 *   totalBytes: 100000000
 * });
 *
 * // Enviar con chunks (solo chunks activos)
 * sendDownloadProgress(mainWindow, download, {
 *   includeChunks: true
 * });
 */
function sendDownloadProgress(mainWindow, download, options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const { includeChunks = false, includeMetadata = false } = options;

  // Payload mínimo con solo campos esenciales
  const payload = {
    id: download.id,
    state: download.state || 'queued',
    progress: download.progress ?? 0,
    downloadedBytes: download.downloadedBytes ?? 0,
    totalBytes: download.totalBytes ?? 0,
  };

  // Incluir campos adicionales solo si son necesarios
  if (includeMetadata) {
    if (download.title) payload.title = download.title;
    if (download.savePath) payload.savePath = download.savePath;
    if (download.speed !== undefined) payload.speed = download.speed;
    if (download.remainingTime !== undefined) payload.remainingTime = download.remainingTime;
  }

  // Incluir información de chunks solo si es necesario y limitar tamaño
  if (includeChunks && download.chunkProgress && Array.isArray(download.chunkProgress)) {
    // Limitar a solo chunks activos o completados recientemente (máximo 10)
    const relevantChunks = download.chunkProgress
      .filter(chunk => chunk.state === 'active' || chunk.state === 'completed')
      .slice(0, 10)
      .map(chunk => ({
        index: chunk.index,
        progress: chunk.progress,
        state: chunk.state,
        // No incluir downloadedBytes/totalBytes para reducir tamaño
      }));

    if (relevantChunks.length > 0) {
      payload.chunkProgress = relevantChunks;
      payload.activeChunks = download.activeChunks ?? 0;
      payload.completedChunks = download.completedChunks ?? 0;
      payload.totalChunks = download.totalChunks ?? 0;
    }
  }

  // Validar tamaño del payload antes de enviar
  const payloadSize = JSON.stringify(payload).length;
  if (payloadSize > MAX_PAYLOAD_SIZE) {
    log.warn(
      `Payload IPC demasiado grande: ${payloadSize} bytes (límite: ${MAX_PAYLOAD_SIZE}), truncando`
    );

    // Eliminar campos opcionales para reducir tamaño
    delete payload.chunkProgress;
    delete payload.title;
    delete payload.savePath;

    const reducedSize = JSON.stringify(payload).length;
    if (reducedSize > MAX_PAYLOAD_SIZE) {
      log.error(
        `Payload aún demasiado grande después de truncar: ${reducedSize} bytes, omitiendo envío`
      );
      return;
    }
  }

  try {
    mainWindow.webContents.send('download-progress', payload);
  } catch (error) {
    log.error('Error enviando progreso IPC:', error);
  }
}

/**
 * Envía múltiples actualizaciones de descarga en un solo mensaje batch
 *
 * Agrupa múltiples actualizaciones para reducir overhead de IPC cuando hay
 * muchas descargas actualizándose simultáneamente.
 *
 * @param {Object} mainWindow - Ventana principal de Electron
 * @param {Array<Object>} downloads - Array de objetos de descarga
 * @param {boolean} [includeMetadata=true] - Si incluir títulos y metadatos básicos
 * @returns {void}
 */
function sendBatchDownloadProgress(mainWindow, downloads, includeMetadata = true) {
  if (!mainWindow || mainWindow.isDestroyed() || !Array.isArray(downloads)) {
    return;
  }

  // Limitar número de descargas en batch para prevenir payloads grandes
  const MAX_BATCH_SIZE = 50;
  const batch = downloads.slice(0, MAX_BATCH_SIZE).map(download => {
    const item = {
      id: download.id,
      state: download.state || 'queued',
      progress: download.progress ?? 0,
      downloadedBytes: download.downloadedBytes ?? 0,
      totalBytes: download.totalBytes ?? 0,
    };

    if (includeMetadata && download.title) {
      item.title = download.title;
    }

    return item;
  });

  const payload = { type: 'batch', downloads: batch };
  const payloadSize = JSON.stringify(payload).length;

  if (payloadSize > MAX_PAYLOAD_SIZE) {
    log.warn(`Batch IPC demasiado grande: ${payloadSize} bytes, dividiendo`);
    // Dividir en chunks más pequeños
    const chunkSize = Math.floor(MAX_BATCH_SIZE / 2);
    for (let i = 0; i < batch.length; i += chunkSize) {
      const chunk = batch.slice(i, i + chunkSize);
      sendBatchDownloadProgress(mainWindow, chunk, includeMetadata);
    }
    return;
  }

  try {
    mainWindow.webContents.send('download-progress-batch', payload);
  } catch (error) {
    log.error('Error enviando batch IPC:', error);
  }
}

module.exports = {
  sendDownloadProgress,
  sendBatchDownloadProgress,
  MAX_PAYLOAD_SIZE,
};
