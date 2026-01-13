/**
 * Constantes de Mensajes de Error - Frontend
 *
 * Centraliza todos los mensajes de error mostrados al usuario en el frontend.
 * Facilita la internacionalización futura y mantiene consistencia en los mensajes.
 */

// =====================
// ERRORES DE API
// =====================

export const API_ERRORS = {
  NOT_AVAILABLE: 'API no disponible',
  REQUEST_FAILED: 'Error en la solicitud',
  SEARCH_FAILED: 'Error en búsqueda',
  GET_CHILDREN_FAILED: 'Error obteniendo hijos',
  GET_ANCESTORS_FAILED: 'Error obteniendo ancestros',
  GET_NODE_INFO_FAILED: 'Error obteniendo info de nodo',
  GET_UPDATE_DATE_FAILED: 'Error obteniendo fecha de actualización',
  DOWNLOAD_START_FAILED: 'Error iniciando descarga',
  DOWNLOAD_FOLDER_FAILED: 'Error iniciando descarga de carpeta',
  PAUSE_FAILED: 'Error pausando descarga',
  RESUME_FAILED: 'Error reanudando descarga',
  CANCEL_FAILED: 'Error cancelando descarga',
  RETRY_FAILED: 'Error reiniciando descarga',
  CONFIRM_OVERWRITE_FAILED: 'Error confirmando sobrescritura',
  DELETE_FAILED: 'Error eliminando descarga',
  GET_STATS_FAILED: 'Error obteniendo estadísticas',
  CLEAN_HISTORY_FAILED: 'Error limpiando historial',
  READ_CONFIG_FAILED: 'Error leyendo archivo de configuración',
  WRITE_CONFIG_FAILED: 'Error escribiendo archivo de configuración',
  SELECT_FOLDER_FAILED: 'Error seleccionando carpeta',
};

// =====================
// ERRORES GENERALES
// =====================

export const GENERAL_ERRORS = {
  UNKNOWN: 'Error desconocido',
  UNEXPECTED: 'Error inesperado',
  OPERATION_FAILED: 'Error en la operación',
};

// =====================
// ERRORES DE DESCARGA
// =====================

export const DOWNLOAD_ERRORS = {
  START_FAILED: 'Error al iniciar descarga',
  FOLDER_FAILED: 'Error al descargar carpeta',
  FOLDER_PROCESSING_FAILED: 'Error al procesar la descarga de la carpeta',
  CURRENT_FOLDER_FAILED: 'Error descargando carpeta',
  PAUSE_FAILED: 'Error pausando descarga',
  RESUME_FAILED: 'Error reanudando descarga',
  CANCEL_FAILED: 'Error cancelando descarga',
  RETRY_FAILED: 'Error reiniciando descarga',
  CONFIRM_OVERWRITE_FAILED: 'Error confirmando sobrescritura',
  DELETE_FAILED: 'Error eliminando descarga',
  GET_FILES_FAILED: 'Error al obtener archivos de la carpeta',
  QUEUE_FULL: 'La cola de descargas está llena',
};

// =====================
// ERRORES DE HISTORIAL
// =====================

export const HISTORY_ERRORS = {
  CLEAN_FAILED: 'Error al limpiar historial',
  LOAD_FAILED: 'Error cargando historial',
  SAVE_FAILED: 'Error guardando historial',
  DELETE_FAILED: 'Error eliminando del historial',
  CANCEL_ALL_FAILED: 'Error cancelando todas las descargas',
};

// =====================
// ERRORES DE NAVEGACIÓN
// =====================

export const NAVIGATION_ERRORS = {
  LOAD_CHILDREN_FAILED: 'Error al cargar',
  LOAD_BREADCRUMB_FAILED: 'Error cargando breadcrumb',
  INVALID_NODE: 'Nodo inválido para navegación',
};

// =====================
// ERRORES DE CONFIGURACIÓN
// =====================

export const SETTINGS_ERRORS = {
  LOAD_FAILED: 'Error cargando configuración',
  SAVE_FAILED: 'Error guardando configuración',
  LOAD_UI_PREFERENCES_FAILED: 'Error cargando preferencias UI',
  SAVE_UI_PREFERENCES_FAILED: 'Error guardando preferencias UI',
  SELECT_FOLDER_FAILED: 'Error seleccionando carpeta',
};

// =====================
// ERRORES DE FAVORITOS
// =====================

export const FAVORITES_ERRORS = {
  LOAD_FAILED: 'Error cargando favoritos',
  SAVE_FAILED: 'Error guardando favoritos',
  INVALID_NODE: 'Nodo inválido',
};

// =====================
// ERRORES DE FILTROS
// =====================

export const FILTERS_ERRORS = {
  LOAD_PRESETS_FAILED: 'Error cargando presets',
  SAVE_PRESETS_FAILED: 'Error guardando presets',
  EMPTY_PRESET_NAME: 'Nombre de preset vacío',
};

// =====================
// ERRORES DE APP
// =====================

export const APP_ERRORS = {
  DOWNLOAD_ROOT_FAILED: 'No se puede descargar la raíz',
  NO_CURRENT_FOLDER: 'No hay carpeta actual para descargar',
  LOAD_UPDATE_DATE_FAILED: 'Error cargando fecha de actualización',
  CLEAN_HISTORY_FAILED: 'Error limpiando historial',
};

// =====================
// EXPORTACIÓN CONVENIENTE
// =====================

/**
 * Objeto que contiene todas las constantes de error organizadas por categoría
 * Útil para acceder a todos los errores de una vez o para futuras funciones de traducción
 */
export const ERRORS = {
  API: API_ERRORS,
  GENERAL: GENERAL_ERRORS,
  DOWNLOAD: DOWNLOAD_ERRORS,
  HISTORY: HISTORY_ERRORS,
  NAVIGATION: NAVIGATION_ERRORS,
  SETTINGS: SETTINGS_ERRORS,
  FAVORITES: FAVORITES_ERRORS,
  FILTERS: FILTERS_ERRORS,
  APP: APP_ERRORS,
};

export default ERRORS;
