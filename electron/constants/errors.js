/**
 * Constantes de Mensajes de Error - Backend
 *
 * Centraliza todos los mensajes de error que se envían al frontend desde el backend.
 * Facilita la internacionalización futura y mantiene consistencia en los mensajes.
 */

// =====================
// ERRORES GENERALES
// =====================

const GENERAL_ERRORS = {
  UNKNOWN: 'Error desconocido',
  INTERNAL_SERVER_ERROR: 'Error interno del servidor',
  UNEXPECTED: 'Error inesperado',
  OPERATION_FAILED: 'Error en la operación',
};

// =====================
// ERRORES DE DESCARGA
// =====================

const DOWNLOAD_ERRORS = {
  START_FAILED: 'Error al iniciar descarga',
  RESUME_FAILED: 'Error al reanudar descarga',
  RETRY_FAILED: 'Error al reiniciar descarga',
  CONFIRM_OVERWRITE_FAILED: 'Error al confirmar sobrescritura',
  DELETE_FAILED: 'Error al eliminar descarga',
  GET_FILES_FAILED: 'Error al obtener archivos de la carpeta',
  FOLDER_PROCESSING_FAILED: 'Error al procesar la descarga de la carpeta',
  GET_UPDATED_FAILED: 'Error obteniendo descarga actualizada',
  NO_LOCATION_SELECTED: 'No se seleccionó ubicación',
  CONNECTION_CLOSED: 'Conexión cerrada prematuramente',
  REDIRECTION_NOT_SUPPORTED: 'Redirección no soportada',
  CREATE_DIRECTORY_FAILED: 'Error al crear directorio',
  MULTIPLE_RETRIES_FAILED: 'Error después de múltiples reintentos',
  CIRCUIT_BREAKER_OPEN:
    'Circuit breaker abierto: demasiados errores en este host. Reintentando más tarde...',
  CIRCUIT_BREAKER_CHUNKS:
    'Circuit breaker abierto: demasiados errores en chunks. Reintentando más tarde...',
};

// =====================
// ERRORES DE RED
// =====================

const NETWORK_ERRORS = {
  CONNECTION_FAILED: 'No se pudo conectar al servidor',
  TIMEOUT: 'Tiempo de espera agotado',
  CONNECTION_REFUSED: 'Conexión rechazada por el servidor',
  CONNECTION_RESET: 'Conexión reiniciada por el servidor',
  CONNECTION_CLOSED: 'Conexión cerrada inesperadamente',
  HOST_UNREACHABLE: 'Servidor no alcanzable',
};

// =====================
// ERRORES DE BASE DE DATOS
// =====================

const DATABASE_ERRORS = {
  CONNECTION_FAILED: 'Error al conectar con la base de datos',
  EXTRACTION_FAILED: 'Error al Extraer Base de Datos',
  EXTRACTION_TITLE: 'Error de Extracción',
  QUERY_FAILED: 'Error al ejecutar consulta',
  SEARCH_FAILED: 'Error en la búsqueda',
  GET_CHILDREN_FAILED: 'Error al obtener hijos',
  GET_ANCESTORS_FAILED: 'Error al obtener ancestros',
  GET_NODE_INFO_FAILED: 'Error al obtener info del nodo',
  GET_DOWNLOAD_INFO_FAILED: 'Error al obtener info de descarga',
  GET_ANCESTOR_PATH_FAILED: 'Error al obtener ruta de ancestros',
  GET_FOLDER_FILES_FAILED: 'Error al obtener archivos de carpeta',
  GET_UPDATE_DATE_FAILED: 'Error al obtener fecha de actualización',
  FTS_FALLBACK_WARNING: 'Error en búsqueda FTS, usando fallback',
};

// =====================
// ERRORES DE COLA DE DESCARGA
// =====================

const QUEUE_ERRORS = {
  INIT_FAILED: 'Error inicializando QueueDatabase',
  ADD_FAILED: 'Error agregando descarga',
  UPDATE_FAILED: 'Error actualizando descarga',
  UPDATE_STATE_FAILED: 'Error actualizando estado',
  DELETE_FAILED: 'Error eliminando descarga',
  START_FAILED: 'Error iniciando descarga',
  COMPLETE_FAILED: 'Error completando descarga',
  MARK_FAILED_FAILED: 'Error marcando descarga como fallida',
  UPDATE_CHUNK_FAILED: 'Error actualizando chunk',
  CLEANUP_MISLABELED_FAILED: 'Error en limpieza de descargas mal etiquetadas',
  LOAD_FAILED: 'Error cargando cola',
};

// =====================
// ERRORES DE ARCHIVOS
// =====================

const FILE_ERRORS = {
  VERIFY_FAILED: 'Error al verificar archivo',
  CREATE_DIRECTORY_FAILED: 'Error creando directorio',
  DELETE_FAILED: 'Error eliminando archivo',
  READ_FAILED: 'Error leyendo archivo',
  WRITE_FAILED: 'Error escribiendo archivo',
};

// =====================
// ERRORES DE WORKERS
// =====================

const WORKER_ERRORS = {
  MERGE_FAILED: 'Error en fusión',
  MERGE_WORKER_ERROR: 'Error en worker de merge',
  THREAD_ERROR: 'Error en worker thread',
  START_MERGE_WORKER_FAILED: 'Error iniciando worker de merge',
  CLEANUP_FAILED: 'Error limpiando worker',
};

// =====================
// ERRORES DE OTROS COMPONENTES
// =====================

const OTHER_ERRORS = {
  REQUEST_ERROR: 'Error en request',
  RESPONSE_ERROR: 'Error en response',
  FILE_STREAM_ERROR: 'Error en fileStream',
  PAUSE_FAILED: 'Error al pausar descarga',
  CANCEL_FAILED: 'Error al cancelar descarga',
  PROGRESS_BATCHER_FLUSH_FAILED: 'Error en flush',
  PROGRESS_BATCHER_SCHEDULED_FLUSH_FAILED: 'Error en flush programado',
  PROGRESS_BATCHER_FINAL_FLUSH_FAILED: 'Error en flush final',
  AUTO_HISTORY_CLEANUP_FAILED: 'Error en limpieza automática de historial',
  EXTRACTION_CODE_ERROR: 'Error en extracción, código',
};

// =====================
// EXPORTACIÓN
// =====================

/**
 * Objeto que contiene todas las constantes de error organizadas por categoría
 */
const ERRORS = {
  GENERAL: GENERAL_ERRORS,
  DOWNLOAD: DOWNLOAD_ERRORS,
  NETWORK: NETWORK_ERRORS,
  DATABASE: DATABASE_ERRORS,
  QUEUE: QUEUE_ERRORS,
  FILE: FILE_ERRORS,
  WORKER: WORKER_ERRORS,
  OTHER: OTHER_ERRORS,
};

module.exports = {
  ERRORS,
  GENERAL_ERRORS,
  DOWNLOAD_ERRORS,
  NETWORK_ERRORS,
  DATABASE_ERRORS,
  QUEUE_ERRORS,
  FILE_ERRORS,
  WORKER_ERRORS,
  OTHER_ERRORS,
};
