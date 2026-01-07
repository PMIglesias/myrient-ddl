/**
 * Throttler / regulador para actualizaciones de progreso
 * Evita saturar el IPC con actualizaciones muy frecuentes
 */

const config = require('./config');
const { logger } = require('./utils');

const log = logger.child('ProgressThrottler');

class ProgressThrottler {
    /**
     * {number} minInterval - Intervalo mínimo entre envíos (ms)
     */
    constructor(minInterval = config.ui.progressThrottle) {
        this.minInterval = minInterval;
        this.pendingUpdates = new Map();
        this.lastGlobalSend = 0;
        this.sendTimeout = null;
        this.mainWindow = null;
    }

    /**
     * Establece la referencia a la ventana principal
     */
    setMainWindow(window) {
        this.mainWindow = window;
    }

    /**
     * Encola una actualización de progreso
     */
    queueUpdate(progressInfo) {
        this.pendingUpdates.set(progressInfo.id, progressInfo);
        this._scheduleSend();
    }

    /**
     * Envía una actualización inmediata sin throttle
     */
    sendImmediate(progressInfo) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('download-progress', progressInfo);
        }
    }

    /**
     * Cancela actualizaciones pendientes para una descarga específica
     * Esto es importante llamarlo ANTES de enviar un estado final (completed, cancelled, etc.)
     * para evitar que una actualización de progreso pendiente sobrescriba el estado final
     */
    cancelPending(downloadId) {
        if (this.pendingUpdates.has(downloadId)) {
            this.pendingUpdates.delete(downloadId);
            log.debug(`Actualizaciones pendientes canceladas para descarga ${downloadId}`);
        }
    }

    /**
     * Programa el envío de actualizaciones pendientes
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
     * Envía todas las actualizaciones pendientes
     */
    _flush() {
        this.sendTimeout = null;
        this.lastGlobalSend = Date.now();

        if (this.pendingUpdates.size === 0) return;

        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            this.pendingUpdates.clear();
            return;
        }

        this.pendingUpdates.forEach((progressInfo) => {
            this.mainWindow.webContents.send('download-progress', progressInfo);
        });

        this.pendingUpdates.clear();
    }

    /**
     * Limpia recursos al destruir la instancia
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
