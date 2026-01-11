/**
 * @fileoverview Servicio API - Wrapper centralizado de window.api
 * @module api
 *
 * Centraliza todas las llamadas a la API expuesta por preload.js entre el proceso
 * principal (Electron main) y el proceso de renderizado (Vue frontend).
 *
 * Facilita:
 * - Testing (se puede mockear fácilmente)
 * - Manejo de errores consistente
 * - Logging centralizado de todas las llamadas API
 * - Tipado futuro con TypeScript
 *
 * Todas las funciones retornan objetos con formato { success: boolean, data?: *, error?: string }
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} APIResponse
 * @property {boolean} success - Si la operación fue exitosa
 * @property {*} [data] - Datos de respuesta (si success es true)
 * @property {string} [error] - Mensaje de error (si success es false)
 * @property {number} [total] - Total de resultados (para búsquedas paginadas)
 */

/**
 * @typedef {Object} DownloadParams
 * @property {number} id - ID único del archivo (desde Myrient DB)
 * @property {string} title - Nombre del archivo
 * @property {string} [downloadPath] - Ruta base de descarga
 * @property {boolean} [preserveStructure=true] - Si mantener estructura de carpetas
 * @property {boolean} [forceOverwrite=false] - Si sobrescribir sin preguntar
 */

/**
 * @typedef {Object} FolderDownloadParams
 * @property {number} folderId - ID de la carpeta a descargar
 * @property {string} [downloadPath] - Ruta base de descarga
 * @property {boolean} [preserveStructure=true] - Si mantener estructura de carpetas
 * @property {boolean} [forceOverwrite=false] - Si sobrescribir sin preguntar
 */

import logger from '../utils/logger';
import { API_ERRORS, GENERAL_ERRORS } from '../constants/errors';

const apiLogger = logger.child('API');

// Verificar que la API está disponible
const getApi = () => {
  if (typeof window === 'undefined' || !window.api) {
    apiLogger.warn('window.api no disponible');
    return null;
  }
  return window.api;
};

// =====================
// BASE DE DATOS
// =====================

/**
 * Busca archivos y carpetas en la base de datos de Myrient
 *
 * Realiza una búsqueda Full-Text Search (FTS) o LIKE según la configuración
 * del servidor. Los resultados se ordenan por relevancia y pueden estar paginados.
 *
 * @param {string} term - Término de búsqueda (mínimo 2 caracteres)
 * @returns {Promise<APIResponse>} Resultado de la búsqueda con array de resultados
 * @returns {boolean} returns.success - Si la búsqueda fue exitosa
 * @returns {Array} [returns.data] - Array de resultados encontrados
 * @returns {number} [returns.total] - Total de resultados (para paginación)
 * @returns {string} [returns.error] - Mensaje de error si falló
 *
 * @example
 * // Buscar archivos
 * const result = await search('archivo zip');
 * if (result.success) {
 *   console.log(`Encontrados ${result.total || result.data.length} resultados`);
 *   result.data.forEach(item => {
 *     console.log(`- ${item.title} (${item.type})`);
 *   });
 * } else {
 *   console.error('Error en búsqueda:', result.error);
 * }
 *
 * // Buscar con paginación (si está soportada)
 * const result2 = await search('archivo', { limit: 50, offset: 0 });
 * // result2.data contiene hasta 50 resultados
 * // result2.total contiene el total para calcular páginas
 */
export const search = async term => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.search(term);
  } catch (error) {
    apiLogger.error('Error en búsqueda:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Obtiene los hijos (archivos y subcarpetas) de un nodo
 *
 * Retorna todos los elementos contenidos en una carpeta específica.
 * Útil para navegar por la estructura del catálogo de Myrient.
 *
 * @param {number} parentId - ID único del nodo padre (carpeta)
 * @returns {Promise<APIResponse>} Resultado con array de hijos del nodo
 *
 * @example
 * // Obtener contenido de una carpeta
 * const result = await getChildren(123);
 * if (result.success && result.data) {
 *   result.data.forEach(child => {
 *     if (child.type === 'folder') {
 *       console.log(`📁 ${child.title}`);
 *     } else {
 *       console.log(`📄 ${child.title} (${formatBytes(child.size)})`);
 *     }
 *   });
 * }
 */
export const getChildren = async parentId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.getChildren(parentId);
  } catch (error) {
    apiLogger.error('Error obteniendo hijos:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Obtiene ancestros de un nodo (para breadcrumb)
 * @param {number} nodeId - ID del nodo
 */
export const getAncestors = async nodeId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.getAncestors(nodeId);
  } catch (error) {
    apiLogger.error('Error obteniendo ancestros:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Obtiene información de un nodo específico
 * @param {number} nodeId - ID del nodo
 */
export const getNodeInfo = async nodeId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.getNodeInfo(nodeId);
  } catch (error) {
    apiLogger.error('Error obteniendo info de nodo:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Obtiene la fecha de última actualización de la DB
 */
export const getDbUpdateDate = async () => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.getDbUpdateDate();
  } catch (error) {
    apiLogger.error('Error obteniendo fecha de actualización:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

// =====================
// DESCARGAS
// =====================

/**
 * Inicia una descarga de archivo individual
 *
 * Envía una solicitud al proceso principal para iniciar la descarga de un archivo.
 * El archivo se agregará a la cola de descargas y se procesará según los límites
 * de concurrencia. Si el archivo existe y no se fuerza sobrescritura, se solicitará
 * confirmación al usuario.
 *
 * @param {DownloadParams} params - Parámetros de la descarga
 * @returns {Promise<APIResponse>} Resultado de la operación
 * @returns {boolean} returns.success - Si la descarga se agregó correctamente
 * @returns {number} [returns.position] - Posición en la cola (1-based)
 * @returns {string} [returns.message] - Mensaje descriptivo
 * @returns {string} [returns.error] - Mensaje de error si falló
 *
 * @example
 * // Descargar archivo individual
 * const result = await download({
 *   id: 12345,
 *   title: 'archivo.zip',
 *   downloadPath: 'C:/Downloads',
 *   preserveStructure: true,
 *   forceOverwrite: false
 * });
 *
 * if (result.success) {
 *   console.log(`Descarga agregada en posición ${result.position}`);
 *   // El archivo se descargará automáticamente cuando haya slots disponibles
 * } else if (result.error === 'awaiting-confirmation') {
 *   console.log('Esperando confirmación del usuario para sobrescribir');
 * } else {
 *   console.error('Error:', result.error);
 * }
 */
export const download = async params => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.download(params);
  } catch (error) {
    apiLogger.error('Error iniciando descarga:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Descarga todos los archivos de una carpeta recursivamente
 *
 * Envía una solicitud al proceso principal para descargar todos los archivos
 * contenidos en una carpeta y sus subcarpetas. El backend recorre la estructura
 * recursivamente y agrega cada archivo a la cola de descargas.
 *
 * @param {FolderDownloadParams} params - Parámetros de descarga de carpeta
 * @returns {Promise<APIResponse>} Resultado de la operación con estadísticas
 * @returns {boolean} returns.success - Si la operación fue exitosa
 * @returns {number} [returns.totalFiles] - Total de archivos encontrados en la carpeta
 * @returns {number} [returns.added] - Archivos agregados a la cola
 * @returns {number} [returns.skipped] - Archivos omitidos (duplicados o ya en cola)
 * @returns {string} [returns.folderTitle] - Título de la carpeta descargada
 * @returns {string} [returns.error] - Mensaje de error si falló
 *
 * @example
 * // Descargar carpeta completa
 * const result = await downloadFolder({
 *   folderId: 67890,
 *   downloadPath: 'C:/Downloads',
 *   preserveStructure: true,
 *   forceOverwrite: false
 * });
 *
 * if (result.success) {
 *   console.log(`Carpeta: ${result.folderTitle}`);
 *   console.log(`Total: ${result.totalFiles} archivos`);
 *   console.log(`Agregados: ${result.added} a la cola`);
 *   console.log(`Omitidos: ${result.skipped} (duplicados)`);
 * } else {
 *   console.error('Error descargando carpeta:', result.error);
 * }
 */
export const downloadFolder = async params => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.downloadFolder(params);
  } catch (error) {
    apiLogger.error('Error iniciando descarga de carpeta:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Pausa una descarga
 * @param {number} downloadId - ID de la descarga
 */
export const pauseDownload = async downloadId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.pauseDownload(downloadId);
  } catch (error) {
    apiLogger.error('Error pausando descarga:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Reanuda una descarga pausada
 * @param {number} downloadId - ID de la descarga
 */
export const resumeDownload = async downloadId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.resumeDownload(downloadId);
  } catch (error) {
    apiLogger.error('Error reanudando descarga:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Cancela una descarga
 * @param {number} downloadId - ID de la descarga
 */
export const cancelDownload = async downloadId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.cancelDownload(downloadId);
  } catch (error) {
    apiLogger.error('Error cancelando descarga:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Reinicia una descarga cancelada o fallida
 * @param {number} downloadId - ID de la descarga
 */
export const retryDownload = async downloadId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.retryDownload(downloadId);
  } catch (error) {
    apiLogger.error('Error reiniciando descarga:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Confirma sobrescritura de un archivo existente
 * @param {number} downloadId - ID de la descarga
 */
export const confirmOverwrite = async downloadId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.confirmOverwrite(downloadId);
  } catch (error) {
    apiLogger.error('Error confirmando sobrescritura:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Elimina una descarga de la base de datos
 * @param {number} downloadId - ID de la descarga
 */
export const deleteDownload = async downloadId => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.deleteDownload(downloadId);
  } catch (error) {
    apiLogger.error('Error eliminando descarga:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
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
    apiLogger.error('Error obteniendo estadísticas:', error);
    return null;
  }
};

/**
 * Limpia el historial de descargas manualmente
 * @param {number} daysOld - Días de antigüedad (default: 30)
 */
export const cleanHistory = async (daysOld = 30) => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.cleanHistory(daysOld);
  } catch (error) {
    apiLogger.error('Error limpiando historial:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

// =====================
// CONFIGURACIÓN
// =====================

/**
 * Lee un archivo de configuración JSON
 * @param {string} filename - Nombre del archivo (ej: 'favorites.json')
 */
export const readConfigFile = async filename => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.readConfigFile(filename);
  } catch (error) {
    apiLogger.error(`Error leyendo ${filename}:`, error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
  }
};

/**
 * Escribe un archivo de configuración JSON
 * @param {string} filename - Nombre del archivo
 * @param {Object} data - Datos a guardar
 */
export const writeConfigFile = async (filename, data) => {
  const api = getApi();
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.writeConfigFile(filename, data);
  } catch (error) {
    apiLogger.error(`Error escribiendo ${filename}:`, error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
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
  if (!api) return { success: false, error: API_ERRORS.NOT_AVAILABLE };

  try {
    return await api.selectFolder();
  } catch (error) {
    apiLogger.error('Error seleccionando carpeta:', error);
    return { success: false, error: error.message || GENERAL_ERRORS.UNKNOWN };
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
export const onDownloadProgress = callback => {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }

  return api.on('download-progress', callback);
};

/**
 * Suscribe a eventos de limpieza de historial
 * @param {Function} callback - Función a ejecutar cuando se limpia el historial
 * @returns {Function} Función para desuscribirse
 */
export const onHistoryCleaned = callback => {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }

  return api.on('history-cleaned', callback);
};

/**
 * Suscribe a eventos de descargas restauradas
 * @param {Function} callback - Función a ejecutar cuando se restauran descargas
 * @returns {Function} Función para desuscribirse
 */
export const onDownloadsRestored = callback => {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos: API no disponible');
    return () => {};
  }

  return api.on('downloads-restored', callback);
};

/**
 * Suscribe a notificaciones de error del proceso principal
 * @param {Function} callback - Función a ejecutar cuando hay un error
 * @returns {Function} Función para desuscribirse
 */
export const onErrorNotification = callback => {
  const api = getApi();
  if (!api) {
    apiLogger.warn('No se puede suscribir a eventos de error: API no disponible');
    return () => {};
  }

  return api.on('error-notification', callback);
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
  downloadFolder,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  retryDownload,
  confirmOverwrite,
  deleteDownload,
  getDownloadStats,
  cleanHistory,

  // Configuración
  readConfigFile,
  writeConfigFile,

  // Ventana
  minimizeWindow,
  maximizeWindow,
  closeWindow,
  selectFolder,

  // Eventos
  onDownloadProgress,
  onHistoryCleaned,
  onDownloadsRestored,
  onErrorNotification,
};
