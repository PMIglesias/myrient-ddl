// Throttler de actualizaciones de progreso de descargas
// Limita la frecuencia de actualizaciones enviadas por IPC para evitar saturar la comunicación
// Agrupa múltiples actualizaciones y las envía en lotes con un intervalo mínimo

const config = require('./config');
const { logger } = require('./utils');

const log = logger.child('ProgressThrottler');

class ProgressThrottler {
    // Inicializa el throttler con un intervalo mínimo entre envíos
    // minInterval: Tiempo mínimo en milisegundos entre cada lote de actualizaciones enviadas
    constructor(minInterval = config.ui.progressThrottle) {
        this.minInterval = minInterval;
        this.pendingUpdates = new Map();
        this.lastGlobalSend = 0;
        this.sendTimeout = null;
        this.mainWindow = null;
    }

    // Establece la referencia a la ventana principal para enviar actualizaciones
    // window: Instancia de BrowserWindow donde se enviarán los eventos
    setMainWindow(window) {
        this.mainWindow = window;
    }

    // Agrega una actualización de progreso a la cola de envío
    // progressInfo: Objeto con información de progreso (id, percent, speed, etc.)
    queueUpdate(progressInfo) {
        this.pendingUpdates.set(progressInfo.id, progressInfo);
        this._scheduleSend();
    }

    // Envía una actualización inmediatamente sin aplicar throttling
    // Útil para estados finales críticos que deben mostrarse sin retraso
    // progressInfo: Objeto con información de progreso a enviar
    sendImmediate(progressInfo) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('download-progress', progressInfo);
        }
    }

    // Elimina actualizaciones pendientes para una descarga específica
    // Debe llamarse antes de enviar estados finales (completed, cancelled, etc.)
    // para evitar que una actualización pendiente sobrescriba el estado final
    // downloadId: ID de la descarga cuyas actualizaciones se cancelan
    cancelPending(downloadId) {
        if (this.pendingUpdates.has(downloadId)) {
            this.pendingUpdates.delete(downloadId);
            log.debug(`Actualizaciones pendientes canceladas para descarga ${downloadId}`);
        }
    }

    // Programa el próximo envío de actualizaciones respetando el intervalo mínimo
    // Calcula el delay necesario para cumplir con minInterval desde el último envío
    _scheduleSend() {
        if (this.sendTimeout) return;

        const now = Date.now();
        const timeSinceLastSend = now - this.lastGlobalSend;
        const delay = Math.max(0, this.minInterval - timeSinceLastSend);

        this.sendTimeout = setTimeout(() => {
            this._flush();
        }, delay);
    }

    // Envía todas las actualizaciones pendientes acumuladas a la ventana principal
    // Limpia el Map de actualizaciones después del envío
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

    // Limpia todos los recursos y cancela timers pendientes
    // Debe llamarse cuando la instancia ya no se necesite para evitar memory leaks
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
