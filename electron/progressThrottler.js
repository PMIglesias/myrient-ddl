/**
 * @fileoverview ProgressThrottler - Throttler de actualizaciones de progreso por IPC
 * @module progressThrottler
 *
 * Limita la frecuencia de actualizaciones de progreso enviadas por IPC al proceso
 * de renderizado para evitar saturar la comunicación. Agrupa múltiples actualizaciones
 * y las envía en lotes con un intervalo mínimo configurable.
 *
 * Características:
 * - Throttling automático de actualizaciones
 * - Envío inmediato para estados críticos
 * - Cancelación de actualizaciones pendientes
 * - Agrupación inteligente de actualizaciones
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} ProgressInfo
 * @property {number} id - ID de la descarga
 * @property {string} state - Estado actual
 * @property {number} [percent] - Progreso (0.0 - 1.0)
 * @property {number} [speed] - Velocidad en MB/s
 * @property {number} [totalBytes] - Tamaño total en bytes
 * @property {number} [downloadedBytes] - Bytes descargados
 * @property {number} [remainingTime] - Tiempo restante en segundos
 */

const config = require('./config');
const { logger } = require('./utils');
const { sendBatchDownloadProgress } = require('./utils/ipcHelpers');

const log = logger.child('ProgressThrottler');

/**
 * Clase para throttling de actualizaciones de progreso por IPC
 *
 * Agrupa actualizaciones de progreso y las envía al proceso de renderizado
 * con un intervalo mínimo para evitar saturar la comunicación IPC.
 *
 * @class ProgressThrottler
 *
 * @example
 * const throttler = new ProgressThrottler(200); // Mínimo 200ms entre envíos
 * throttler.setMainWindow(mainWindow);
 *
 * // Encolar actualizaciones (se enviarán automáticamente cada 200ms)
 * throttler.queueUpdate({ id: 12345, state: 'progressing', percent: 0.5 });
 * throttler.queueUpdate({ id: 12345, state: 'progressing', percent: 0.6 });
 * // Solo se enviará la última actualización
 *
 * // Enviar inmediatamente estados críticos
 * throttler.sendImmediate({ id: 12345, state: 'completed' });
 *
 * // Limpiar recursos
 * throttler.destroy();
 */
class ProgressThrottler {
  /**
   * Crea una nueva instancia de ProgressThrottler
   *
   * @constructor
   * @param {number} [minInterval=config.ui.progressThrottle] - Tiempo mínimo en ms entre cada lote de actualizaciones
   */
  constructor(minInterval = config.ui.progressThrottle) {
    this.minInterval = minInterval;
    this.pendingUpdates = new Map();
    this.lastGlobalSend = 0;
    this.sendTimeout = null;
    this.mainWindow = null;
  }

  /**
   * Establece la referencia a la ventana principal para enviar actualizaciones
   *
   * Debe llamarse antes de usar queueUpdate() o sendImmediate(). La ventana se usa
   * para enviar eventos IPC al proceso de renderizado.
   *
   * @param {Electron.BrowserWindow} window - Instancia de BrowserWindow donde se enviarán los eventos
   * @returns {void}
   *
   * @example
   * throttler.setMainWindow(mainWindow);
   * // Ahora se pueden enviar actualizaciones
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Encola una actualización de progreso para envío throttled
   *
   * Agrega una actualización a la cola. Si ya existe una actualización pendiente
   * para la misma descarga, se sobrescribe. Las actualizaciones se envían en lotes
   * respetando el intervalo mínimo configurado.
   *
   * @param {ProgressInfo} progressInfo - Objeto con información de progreso
   * @returns {void}
   *
   * @example
   * // Encolar actualización (se enviará automáticamente)
   * throttler.queueUpdate({
   *   id: 12345,
   *   state: 'progressing',
   *   percent: 0.5,
   *   speed: 5.2,
   *   totalBytes: 100000000,
   *   downloadedBytes: 50000000
   * });
   */
  queueUpdate(progressInfo) {
    this.pendingUpdates.set(progressInfo.id, progressInfo);
    this._scheduleSend();
  }

  /**
   * Envía una actualización inmediatamente sin aplicar throttling
   *
   * Útil para estados finales críticos (completed, cancelled, interrupted)
   * que deben mostrarse sin retraso. Bypasa la cola de throttling y envía
   * directamente al proceso de renderizado.
   *
   * @param {ProgressInfo} progressInfo - Objeto con información de progreso a enviar
   * @returns {void}
   *
   * @example
   * // Enviar estado final inmediatamente
   * throttler.sendImmediate({
   *   id: 12345,
   *   state: 'completed',
   *   percent: 1.0,
   *   savePath: 'C:/Downloads/archivo.zip'
   * });
   */
  sendImmediate(progressInfo) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('download-progress', progressInfo);
    }
  }

  /**
   * Cancela actualizaciones pendientes para una descarga específica
   *
   * Debe llamarse antes de enviar estados finales (completed, cancelled, etc.)
   * para evitar que una actualización pendiente sobrescriba el estado final.
   *
   * @param {number} downloadId - ID de la descarga cuyas actualizaciones se cancelan
   * @returns {void}
   *
   * @example
   * // Cancelar actualizaciones pendientes antes de enviar estado final
   * throttler.cancelPending(12345);
   * throttler.sendImmediate({ id: 12345, state: 'completed' });
   */
  cancelPending(downloadId) {
    if (this.pendingUpdates.has(downloadId)) {
      this.pendingUpdates.delete(downloadId);
      log.debug(`Actualizaciones pendientes canceladas para descarga ${downloadId}`);
    }
  }

  /**
   * Programa el próximo envío de actualizaciones respetando el intervalo mínimo
   *
   * Calcula el delay necesario para cumplir con minInterval desde el último envío.
   * Si ya hay un timeout programado, no hace nada (evita múltiples timers).
   *
   * @private
   * @returns {void}
   */
  _scheduleSend() {
    if (this.sendTimeout) return;

    const now = Date.now();
    const timeSinceLastSend = now - this.lastGlobalSend;
    const delay = Math.max(0, this.minInterval - timeSinceLastSend);

    this.sendTimeout = setTimeout(() => {
      this._flush();
    }, delay);
  }

  /**
   * Envía todas las actualizaciones pendientes acumuladas a la ventana principal
   *
   * Itera sobre todas las actualizaciones pendientes y las envía por IPC al proceso
   * de renderizado. Limpia el Map de actualizaciones después del envío para preparar
   * la próxima ronda de throttling.
   *
   * @private
   * @returns {void}
   */
  _flush() {
    this.sendTimeout = null;
    this.lastGlobalSend = Date.now();

    if (this.pendingUpdates.size === 0) return;

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      this.pendingUpdates.clear();
      return;
    }

    const updateCount = this.pendingUpdates.size;
    
    // REFACTORIZADO FASE 2: Usar envío por lotes (Batching)
    // Convertimos el Map de actualizaciones a un array y lo enviamos en un solo mensaje IPC
    const updatesArray = Array.from(this.pendingUpdates.values());
    sendBatchDownloadProgress(this.mainWindow, updatesArray);

    log.debug(`Enviado lote de ${updateCount} actualizaciones en un solo mensaje IPC`);
    this.pendingUpdates.clear();
  }

  /**
   * Limpia todos los recursos y cancela timers pendientes
   *
   * Debe llamarse cuando la instancia ya no se necesite para evitar memory leaks.
   * Cancela el timeout pendiente y limpia todas las actualizaciones en cola.
   *
   * @returns {void}
   *
   * @example
   * // Limpiar recursos al cerrar la aplicación
   * throttler.destroy();
   */
  destroy() {
    if (this.sendTimeout) {
      clearTimeout(this.sendTimeout);
      this.sendTimeout = null;
    }
    this.pendingUpdates.clear();
    this.mainWindow = null;
  }
}

module.exports = ProgressThrottler;
