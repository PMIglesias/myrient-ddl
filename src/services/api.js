/**
 * Servicio API - Wrapper centralizado de window.api
 * 
 * Centraliza todas las llamadas a la API expuesta por preload.js
 * Facilita:
 * - Testing (se puede mockear fácilmente)
 * - Manejo de errores consistente
 * - Logging centralizado
 * - Tipado futuro con TypeScript
 */

// Verificar que la API está disponible
const getApi = () => {
    if (typeof window === 'undefined' || !window.api) {
        console.warn('[API] window.api no disponible');
        return null;
    }
    return window.api;
};

// =====================
// BASE DE DATOS
// =====================

/**
 * Busca en la base de datos
 * @param {string} term - Término de búsqueda
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
export const search = async (term) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.search(term);
    } catch (error) {
        console.error('[API] Error en búsqueda:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Obtiene hijos de un nodo
 * @param {number} parentId - ID del nodo padre
 */
export const getChildren = async (parentId) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.getChildren(parentId);
    } catch (error) {
        console.error('[API] Error obteniendo hijos:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Obtiene ancestros de un nodo (para breadcrumb)
 * @param {number} nodeId - ID del nodo
 */
export const getAncestors = async (nodeId) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.getAncestors(nodeId);
    } catch (error) {
        console.error('[API] Error obteniendo ancestros:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Obtiene información de un nodo específico
 * @param {number} nodeId - ID del nodo
 */
export const getNodeInfo = async (nodeId) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.getNodeInfo(nodeId);
    } catch (error) {
        console.error('[API] Error obteniendo info de nodo:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Obtiene la fecha de última actualización de la DB
 */
export const getDbUpdateDate = async () => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.getDbUpdateDate();
    } catch (error) {
        console.error('[API] Error obteniendo fecha de actualización:', error);
        return { success: false, error: error.message };
    }
};

// =====================
// DESCARGAS
// =====================

/**
 * Inicia una descarga
 * @param {Object} params - Parámetros de descarga
 * @param {number} params.id - ID del archivo
 * @param {string} params.title - Título del archivo
 * @param {string} params.downloadPath - Ruta de descarga
 * @param {boolean} params.preserveStructure - Mantener estructura de carpetas
 * @param {boolean} params.forceOverwrite - Forzar sobrescritura
 */
export const download = async (params) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.download(params);
    } catch (error) {
        console.error('[API] Error iniciando descarga:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Pausa una descarga
 * @param {number} downloadId - ID de la descarga
 */
export const pauseDownload = async (downloadId) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.pauseDownload(downloadId);
    } catch (error) {
        console.error('[API] Error pausando descarga:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Cancela una descarga
 * @param {number} downloadId - ID de la descarga
 */
export const cancelDownload = async (downloadId) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.cancelDownload(downloadId);
    } catch (error) {
        console.error('[API] Error cancelando descarga:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Obtiene estadísticas de descargas
 */
export const getDownloadStats = async () => {
    const api = getApi();
    if (!api) return null;
    
    try {
        return await api.getDownloadStats();
    } catch (error) {
        console.error('[API] Error obteniendo estadísticas:', error);
        return null;
    }
};

// =====================
// CONFIGURACIÓN
// =====================

/**
 * Lee un archivo de configuración JSON
 * @param {string} filename - Nombre del archivo (ej: 'favorites.json')
 */
export const readConfigFile = async (filename) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.readConfigFile(filename);
    } catch (error) {
        console.error(`[API] Error leyendo ${filename}:`, error);
        return { success: false, error: error.message };
    }
};

/**
 * Escribe un archivo de configuración JSON
 * @param {string} filename - Nombre del archivo
 * @param {Object} data - Datos a guardar
 */
export const writeConfigFile = async (filename, data) => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.writeConfigFile(filename, data);
    } catch (error) {
        console.error(`[API] Error escribiendo ${filename}:`, error);
        return { success: false, error: error.message };
    }
};

// =====================
// VENTANA
// =====================

/**
 * Minimiza la ventana
 */
export const minimizeWindow = () => {
    const api = getApi();
    if (api) api.minimizeWindow();
};

/**
 * Maximiza/restaura la ventana
 */
export const maximizeWindow = () => {
    const api = getApi();
    if (api) api.maximizeWindow();
};

/**
 * Cierra la ventana
 */
export const closeWindow = () => {
    const api = getApi();
    if (api) api.closeWindow();
};

/**
 * Abre diálogo para seleccionar carpeta
 */
export const selectFolder = async () => {
    const api = getApi();
    if (!api) return { success: false, error: 'API no disponible' };
    
    try {
        return await api.selectFolder();
    } catch (error) {
        console.error('[API] Error seleccionando carpeta:', error);
        return { success: false, error: error.message };
    }
};

// =====================
// EVENTOS
// =====================

/**
 * Suscribe a eventos de progreso de descarga
 * @param {Function} callback - Función a ejecutar cuando hay progreso
 * @returns {Function} Función para desuscribirse
 */
export const onDownloadProgress = (callback) => {
    const api = getApi();
    if (!api) {
        console.warn('[API] No se puede suscribir a eventos: API no disponible');
        return () => {};
    }
    
    return api.on('download-progress', callback);
};

// =====================
// EXPORT DEFAULT
// =====================

export default {
    // Base de datos
    search,
    getChildren,
    getAncestors,
    getNodeInfo,
    getDbUpdateDate,
    
    // Descargas
    download,
    pauseDownload,
    cancelDownload,
    getDownloadStats,
    
    // Configuración
    readConfigFile,
    writeConfigFile,
    
    // Ventana
    minimizeWindow,
    maximizeWindow,
    closeWindow,
    selectFolder,
    
    // Eventos
    onDownloadProgress
};
