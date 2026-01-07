/**
 * Preload script - Bridge seguro entre la capa culiada de main y renderer
 * 
 * Este script se ejecuta en un contexto aislado y expone
 * una API limitada y segura al proceso renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Canales IPC permitidos para eventos (one-way, main -> renderer)
const validEventChannels = [
    'download-progress'
];

// Canales IPC permitidos para invocaciones (two-way, renderer <-> main)
const validInvokeChannels = [
    'search-db',
    'get-children',
    'get-ancestors',
    'get-node-info',
    'get-db-update-date',
    'download-file',
    'cancel-download',
    'get-download-stats',
    'read-config-file',
    'write-config-file',
    'window-minimize',
    'window-maximize',
    'window-close',
    'select-folder'
];

/**
 * API expuesta al renderer process
 */
const api = {
    // =====================
    // EVENTOS (Escuchar)
    // =====================

    /**
     * Suscribe a un canal de eventos
     */
    on: (channel, callback) => {
        if (!validEventChannels.includes(channel)) {
            console.warn(`[Preload] Canal no válido: ${channel}`);
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
    },

    // =====================
    // BASE DE DATOS
    // =====================

    /**
     * Busca en la base de datos
     */
    search: (term) => ipcRenderer.invoke('search-db', term),

    /**
     * Obtiene hijos de un nodo
     */
    getChildren: (parentId) => ipcRenderer.invoke('get-children', parentId),

    /**
     * Obtiene ancestros de un nodo (para breadcrumb)
     */
    getAncestors: (nodeId) => ipcRenderer.invoke('get-ancestors', nodeId),

    /**
     * Obtiene información de un nodo específico
     */
    getNodeInfo: (nodeId) => ipcRenderer.invoke('get-node-info', nodeId),

    /**
     * Obtiene la fecha de última actualización de la DB
     */
    getDbUpdateDate: () => ipcRenderer.invoke('get-db-update-date'),

    // =====================
    // DESCARGAS
    // =====================

    /**
     * Inicia una descarga
     */
    download: (file) => ipcRenderer.invoke('download-file', file),

    /**
     * Pausa una descarga (preserva archivos .part)
     */
    pauseDownload: (downloadId) => ipcRenderer.invoke('pause-download', downloadId),

    /**
     * Cancela una descarga (elimina archivos)
     */
    cancelDownload: (downloadId) => ipcRenderer.invoke('cancel-download', downloadId),

    /**
     * Obtiene estadísticas de descargas
     */
    getDownloadStats: () => ipcRenderer.invoke('get-download-stats'),

    // =====================
    // CONFIGURACIÓN
    // =====================

    /**
     * Lee un archivo de configuración
     */
    readConfigFile: (filename) => ipcRenderer.invoke('read-config-file', filename),

    /**
     * Escribe un archivo de configuración
     */
    writeConfigFile: (filename, data) => ipcRenderer.invoke('write-config-file', filename, data),

    // =====================
    // VENTANA
    // =====================

    /**
     * Minimiza la ventana
     */
    minimizeWindow: () => ipcRenderer.invoke('window-minimize'),

    /**
     * Maximiza o restaura la ventana
     */
    maximizeWindow: () => ipcRenderer.invoke('window-maximize'),

    /**
     * Cierra la ventana
     */
    closeWindow: () => ipcRenderer.invoke('window-close'),

    // =====================
    // DIÁLOGOS
    // =====================

    /**
     * Abre el cuadro de diálogo para seleccionar la carpeta
     */
    selectFolder: () => ipcRenderer.invoke('select-folder')
};

// Exponer API al renderer de forma segura
contextBridge.exposeInMainWorld('api', api);

console.log('[Preload] API expuesta correctamente');
