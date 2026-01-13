/**
 * Constantes de Mensajes de Éxito e Información - Frontend
 *
 * Centraliza todos los mensajes de éxito, información y confirmaciones
 * mostrados al usuario en el frontend.
 * Facilita la internacionalización futura y mantiene consistencia en los mensajes.
 */

// =====================
// MENSAJES DE ÉXITO
// =====================

export const SUCCESS_MESSAGES = {
  HISTORY_CLEANED: 'Historial limpiado',
  MEMORY_OPTIMIZED: 'Memoria optimizada',
  LOGS_EXPORTED: 'Logs exportados exitosamente',
  DOWNLOAD_COMPLETED: 'Descarga completada',
};

// =====================
// MENSAJES INFORMATIVOS
// =====================

export const INFO_MESSAGES = {
  CARPETA_ACTUAL: 'Carpeta actual',
};

// =====================
// FUNCIONES PARA MENSAJES DINÁMICOS
// =====================

/**
 * Formatea mensaje de historial limpiado con cantidad de registros
 * @param {number} count - Cantidad de registros eliminados
 * @returns {string} Mensaje formateado
 */
export const formatHistoryCleaned = count => {
  return `${count} registro(s) eliminado(s) de la base de datos`;
};

/**
 * Formatea mensaje de historial limpiado (versión antigua)
 * @param {number} count - Cantidad de registros antiguos eliminados
 * @returns {string} Mensaje formateado
 */
export const formatHistoryCleanedOld = count => {
  return `${count} registro(s) antiguo(s) eliminado(s) de la base de datos`;
};

/**
 * Formatea mensaje de memoria optimizada
 * @param {number} removed - Cantidad de descargas removidas
 * @param {number} kept - Cantidad de descargas mantenidas
 * @returns {string} Mensaje formateado
 */
export const formatMemoryOptimized = (removed, kept) => {
  return `${removed} descarga(s) antigua(s) removida(s). ${kept} mantenida(s) en memoria.`;
};

/**
 * Formatea mensaje de logs exportados
 * @param {string} path - Ruta del archivo exportado
 * @returns {string} Mensaje formateado
 */
export const formatLogsExported = path => {
  return `Logs exportados exitosamente a:\n${path}`;
};

// =====================
// EXPORTACIÓN CONVENIENTE
// =====================

export const MESSAGES = {
  SUCCESS: SUCCESS_MESSAGES,
  INFO: INFO_MESSAGES,
};

export default MESSAGES;
