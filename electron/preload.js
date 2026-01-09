/**
 * Preload script - Bridge seguro entre main y renderer
 * 
 * Este script se ejecuta en un contexto aislado y expone
 * una API limitada y segura al proceso renderer.
 * 
 * SEGURIDAD: Todos los canales IPC deben estar en las whitelists
 * y se validan antes de cada invocación.
 */

const { contextBridge, ipcRenderer } = require('electron');

// =====================
// WHITELISTS DE CANALES IPC
// =====================

// Canales IPC permitidos para eventos (one-way, main -> renderer)
const validEventChannels = [
    'download-progress',
    'history-cleaned',
    'downloads-restored'
];

// Canales IPC permitidos para invocaciones (two-way, renderer <-> main)
const validInvokeChannels = [
    // Base de datos
    'search-db',
    'get-children',
    'get-ancestors',
    'get-node-info',
    'get-db-update-date',
    // Descargas
    'download-file',
    'download-folder',
    'pause-download',
    'resume-download',
    'cancel-download',
    'get-download-stats',
    'get-queue-time-estimate',
    'clean-history',
    // Configuración
    'read-config-file',
    'write-config-file',
    // Ventana
    'window-minimize',
    'window-maximize',
    'window-close',
    // Diálogos
    'select-folder'
];

// =====================
// HELPERS DE SEGURIDAD
// =====================

/**
 * Invocación segura - valida el canal antes de invocar
 * @param {string} channel - Canal IPC a invocar
 * @param  {...any} args - Argumentos para el handler
 * @returns {Promise} - Resultado de la invocación
 */
const safeInvoke = (channel, ...args) => {
    if (!validInvokeChannels.includes(channel)) {
        console.error(`[Preload] ⛔ Canal IPC no autorizado: ${channel}`);
        return Promise.reject(new Error(`Canal IPC no autorizado: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
};

/**
 * Suscripción segura a eventos
 * @param {string} channel - Canal de eventos
 * @param {Function} callback - Función a ejecutar
 * @returns {Function} - Función de cleanup
 */
const safeOn = (channel, callback) => {
    if (!validEventChannels.includes(channel)) {
        console.warn(`[Preload] ⚠️ Canal de eventos no válido: ${channel}`);
        return () => {}; // Retornar función vacía
    }

    // Wrapper para el callback con manejo de errores
    const listener = (_event, ...args) => {
        try {
            callback(...args);
        } catch (error) {
            console.error(`[Preload] Error en listener de ${channel}:`, error);
        }
    };

    ipcRenderer.on(channel, listener);

    // Retornar función de cleanup
    return () => {
        try {
            ipcRenderer.removeListener(channel, listener);
            console.log(`[Preload] Listener removido: ${channel}`);
        } catch (error) {
            console.error(`[Preload] Error removiendo listener de ${channel}:`, error);
        }
    };
};

// =====================
// API EXPUESTA
// =====================

/**
 * API expuesta al renderer process
 * Todas las invocaciones pasan por safeInvoke para validación
 */
const api = {
    // =====================
    // EVENTOS (Escuchar)
    // =====================

    /**
     * Suscribe a un canal de eventos
     */
    on: safeOn,

    // =====================
    // BASE DE DATOS
    // =====================

    /**
     * Busca en la base de datos
     */
    search: (term) => safeInvoke('search-db', term),

    /**
     * Obtiene hijos de un nodo
     */
    getChildren: (parentId) => safeInvoke('get-children', parentId),

    /**
     * Obtiene ancestros de un nodo (para breadcrumb)
     */
    getAncestors: (nodeId) => safeInvoke('get-ancestors', nodeId),

    /**
     * Obtiene información de un nodo específico
     */
    getNodeInfo: (nodeId) => safeInvoke('get-node-info', nodeId),

    /**
     * Obtiene la fecha de última actualización de la DB
     */
    getDbUpdateDate: () => safeInvoke('get-db-update-date'),

    // =====================
    // DESCARGAS
    // =====================

    /**
     * Inicia una descarga
     */
    download: (file) => safeInvoke('download-file', file),

    /**
     * Descarga todos los archivos de una carpeta recursivamente
     */
    downloadFolder: (params) => safeInvoke('download-folder', params),

    /**
     * Pausa una descarga (preserva archivos .part)
     */
    pauseDownload: (downloadId) => safeInvoke('pause-download', downloadId),

    /**
     * Reanuda una descarga pausada
     */
    resumeDownload: (downloadId) => safeInvoke('resume-download', downloadId),

    /**
     * Cancela una descarga (elimina archivos)
     */
    cancelDownload: (downloadId) => safeInvoke('cancel-download', downloadId),

    /**
     * Obtiene estadísticas de descargas
     */
    getDownloadStats: () => safeInvoke('get-download-stats'),

    /**
     * Obtiene la estimación de tiempo de cola
     * @param {number|null} downloadId - ID de descarga específica (opcional)
     */
    getQueueTimeEstimate: (downloadId = null) => safeInvoke('get-queue-time-estimate', downloadId),

    /**
     * Limpia el historial de descargas
     */
    cleanHistory: (daysOld) => safeInvoke('clean-history', daysOld),

    // =====================
    // CONFIGURACIÓN
    // =====================

    /**
     * Lee un archivo de configuración
     */
    readConfigFile: (filename) => safeInvoke('read-config-file', filename),

    /**
     * Escribe un archivo de configuración
     */
    writeConfigFile: (filename, data) => safeInvoke('write-config-file', filename, data),

    // =====================
    // VENTANA
    // =====================

    /**
     * Minimiza la ventana
     */
    minimizeWindow: () => safeInvoke('window-minimize'),

    /**
     * Maximiza o restaura la ventana
     */
    maximizeWindow: () => safeInvoke('window-maximize'),

    /**
     * Cierra la ventana
     */
    closeWindow: () => safeInvoke('window-close'),

    // =====================
    // DIÁLOGOS
    // =====================

    /**
     * Abre el cuadro de diálogo para seleccionar la carpeta
     */
    selectFolder: () => safeInvoke('select-folder')
};

// Exponer API al renderer de forma segura
contextBridge.exposeInMainWorld('api', api);

console.log('[Preload] ✅ API expuesta correctamente');
console.log('[Preload] Canales de eventos:', validEventChannels.length);
console.log('[Preload] Canales de invocación:', validInvokeChannels.length);
