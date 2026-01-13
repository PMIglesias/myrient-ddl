/**
 * @fileoverview Módulo de validación centralizado
 * @module validation
 *
 * Integra validaciones básicas y schemas de Zod para proporcionar funciones
 * de validación robustas para parámetros de entrada, URLs, IDs, y términos de búsqueda.
 * Usa Zod cuando está disponible para validación más robusta, con validación básica
 * como respaldo si Zod no está disponible.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Si la validación fue exitosa
 * @property {*} [data] - Datos validados y normalizados (si valid es true)
 * @property {string} [error] - Mensaje de error (si valid es false)
 */

const config = require('../config');
const { logger } = require('./logger');
const { VALIDATIONS } = require('../constants/validations');

const log = logger.child('Validation');

// Intentar cargar schemas de validación de Zod si están disponibles
// Los schemas de Zod proporcionan validación más robusta y mensajes de error detallados
let schemas = null;
try {
  schemas = require('./schemas');
} catch (error) {
  log.warn('Zod schemas no disponibles, usando validación básica');
}

/**
 * Valida que una URL sea segura y pertenezca a la lista de hosts permitidos
 *
 * Verifica que la URL use protocolo HTTPS y que el dominio esté en la whitelist
 * de seguridad configurada. Esto previene descargas desde servidores no autorizados
 * y garantiza conexiones cifradas.
 *
 * @param {string} urlString - URL a validar en formato string
 * @returns {boolean} true si la URL es válida y segura, false en caso contrario
 *
 * @example
 * // URL válida de host permitido
 * isValidUrl('https://myrient.erista.me/files/archivo.zip');
 * // true (si myrient.erista.me está en allowedHosts)
 *
 * // URL inválida - protocolo HTTP
 * isValidUrl('http://myrient.erista.me/files/archivo.zip');
 * // false (solo se permite HTTPS)
 *
 * // URL inválida - host no permitido
 * isValidUrl('https://malicious-site.com/file.zip');
 * // false (host no está en allowedHosts)
 */
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);

    // Requerir protocolo HTTPS para garantizar conexiones cifradas
    if (url.protocol !== 'https:') {
      log.warn('URL rechazada: protocolo no es HTTPS', urlString);
      return false;
    }

    // Verificar que el dominio del host esté explícitamente en la lista de permitidos
    // Esto previene descargas desde servidores no autorizados
    if (!config.security.allowedHosts.includes(url.hostname)) {
      log.warn(
        `URL rechazada: dominio "${url.hostname}" no está en lista permitida.`,
        `Dominios válidos: ${config.security.allowedHosts.join(', ')}`
      );
      return false;
    }

    return true;
  } catch (error) {
    log.error('URL inválida:', urlString, error.message);
    return false;
  }
}

/**
 * Escapa caracteres especiales en términos de búsqueda para uso seguro en consultas LIKE
 *
 * Previene inyección SQL escapando caracteres que tienen significado especial en LIKE (% y _).
 * Usa el carácter '|' como carácter de escape, que debe estar configurado en la consulta
 * SQL con `ESCAPE '|'`.
 *
 * @param {string} term - Término de búsqueda que puede contener caracteres especiales
 * @returns {string} Término escapado seguro para usar en consultas LIKE
 *
 * @example
 * // Escapar término con caracteres especiales
 * escapeLikeTerm('archivo_2024%test');
 * // 'archivo|_2024|%test'
 *
 * // Usar en consulta SQL
 * const escaped = escapeLikeTerm(searchTerm);
 * const query = `SELECT * FROM files WHERE title LIKE ? ESCAPE '|'`;
 * db.prepare(query).all(`%${escaped}%`);
 */
function escapeLikeTerm(term) {
  return term.replace(/\|/g, '||').replace(/%/g, '|%').replace(/_/g, '|_');
}

/**
 * Sanitiza término de búsqueda para prevenir inyección
 *
 * Remueve caracteres peligrosos y limita la longitud del término de búsqueda.
 * Mantiene funcionalidad de búsqueda útil pero previene ataques.
 *
 * @param {string} term - Término de búsqueda a sanitizar
 * @returns {string} Término sanitizado seguro
 */
function sanitizeSearchTerm(term) {
  if (typeof term !== 'string') {
    return '';
  }

  return term
    .trim()
    .slice(0, 100) // Limitar longitud
    .replace(/[<>'"\\]/g, '') // Remover caracteres peligrosos
    .replace(/\s+/g, ' '); // Normalizar espacios
}

/**
 * Valida y sanitiza ruta de descarga
 *
 * Previene path traversal y verifica que la ruta esté dentro de directorios permitidos.
 *
 * @param {string} downloadPath - Ruta de descarga a validar
 * @returns {Object} Resultado de validación: { valid: boolean, path?: string, error?: string }
 */
function validateAndSanitizeDownloadPath(downloadPath) {
  const path = require('path');
  const os = require('os');
  const { app } = require('electron');

  if (!downloadPath || typeof downloadPath !== 'string') {
    return { valid: false, error: 'Ruta de descarga no proporcionada' };
  }

  try {
    // 1. Resolver ruta absoluta y normalizar
    const resolvedPath = path.resolve(downloadPath.trim());
    
    // 2. Definir directorios base permitidos (Whitelist)
    const allowedBaseDirs = [
      os.homedir(),
      app.getPath('downloads'),
      app.getPath('desktop'),
      app.getPath('documents'),
      path.join(app.getPath('userData'), 'downloads'),
    ].map(dir => path.resolve(dir).toLowerCase());

    // 3. Verificar si la ruta resuelta empieza con alguno de los directorios permitidos
    const resolvedLower = resolvedPath.toLowerCase();
    const isAllowed = allowedBaseDirs.some(baseDir => {
      // Usar endsWith con separador para asegurar coincidencia exacta de carpeta
      const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
      return resolvedLower === baseDir || resolvedLower.startsWith(baseWithSep);
    });

    if (!isAllowed) {
      log.warn(`Intento de acceso a ruta no permitida: ${resolvedPath}`);
      return { 
        valid: false, 
        error: 'Por seguridad, las descargas solo se permiten en carpetas de usuario (Descargas, Escritorio, etc.)' 
      };
    }

    return { valid: true, path: resolvedPath };
  } catch (error) {
    log.error('Error validando ruta de descarga:', error);
    return { valid: false, error: 'Error interno validando la ruta' };
  }
}

/**
 * Sanitiza nombre de archivo de forma robusta
 *
 * Remueve caracteres peligrosos y valida longitud. Más estricto que sanitizeFilename
 * para uso en validación de inputs del usuario.
 *
 * @param {string} fileName - Nombre de archivo a sanitizar
 * @returns {string} Nombre de archivo sanitizado
 */
function sanitizeFileName(fileName) {
  if (typeof fileName !== 'string') {
    return 'unnamed';
  }

  // Usar función existente pero agregar validación adicional
  const { sanitizeFilename } = require('./fileHelpers');
  let sanitized = sanitizeFilename(fileName);

  // Verificar longitud (máximo 255 caracteres para sistemas de archivos)
  if (sanitized.length > 255) {
    sanitized = sanitized.slice(0, 255);
  }

  // Verificar caracteres peligrosos restantes
  if (/[<>:"|?*\x00-\x1f]/.test(sanitized)) {
    sanitized = sanitized.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  }

  // Asegurar que no esté vacío
  if (sanitized.trim().length === 0) {
    sanitized = 'unnamed';
  }

  return sanitized;
}

/**
 * Valida los parámetros requeridos para iniciar una descarga de archivo
 *
 * Usa schemas de Zod si están disponibles para validación robusta, sino usa validación básica.
 * Verifica que todos los parámetros requeridos estén presentes y sean válidos.
 *
 * @param {Object} params - Parámetros de descarga a validar
 * @param {number} params.id - ID único del archivo (desde base de datos)
 * @param {string} params.title - Nombre del archivo
 * @returns {ValidationResult} Resultado de validación con datos normalizados
 *
 * @example
 * // Validar parámetros correctos
 * const result = validateDownloadParams({
 *   id: 12345,
 *   title: 'archivo.zip'
 * });
 * // result.valid = true
 * // result.data = { id: 12345, title: 'archivo.zip' }
 *
 * // Validar parámetros inválidos
 * const invalid = validateDownloadParams({
 *   id: null,
 *   title: ''
 * });
 * // invalid.valid = false
 * // invalid.error = 'ID inválido' o 'Título inválido'
 */
function validateDownloadParams(params) {
  // Intentar usar validación de Zod si los schemas están disponibles
  let resultData = params;
  if (schemas && schemas.validateDownloadParams) {
    const result = schemas.validateDownloadParams(params);
    if (!result.success) {
      return { valid: false, error: result.error };
    }
    resultData = result.data;
  } else {
    // Validación básica cuando Zod no está disponible
    if (!params) {
      return { valid: false, error: 'Parámetros no proporcionados' };
    }
    if (!params.id || typeof params.id !== 'number') {
      return { valid: false, error: 'ID inválido' };
    }
    if (!params.title || typeof params.title !== 'string' || params.title.trim().length === 0) {
      return { valid: false, error: 'Título inválido' };
    }
    resultData = { ...params };
  }

  // REFUERZO FASE 4: Validar y sanitizar la ruta de descarga si se proporciona
  if (resultData.downloadPath) {
    const pathValidation = validateAndSanitizeDownloadPath(resultData.downloadPath);
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error };
    }
    resultData.downloadPath = pathValidation.path;
  }

  // REFUERZO FASE 4: Sanitizar el nombre del archivo (title)
  resultData.title = sanitizeFileName(resultData.title);

  return { valid: true, data: resultData };
}

/**
 * Valida un término de búsqueda asegurando que cumpla con los requisitos mínimos
 *
 * Verifica que sea un string no vacío con longitud apropiada (mínimo 2 caracteres,
 * máximo 100 caracteres). Si Zod está disponible, usa validación más robusta.
 *
 * @param {string} searchTerm - Término de búsqueda a validar
 * @returns {ValidationResult} Resultado de validación con término normalizado (trimmeado)
 *
 * @example
 * // Validar término correcto
 * const result = validateSearchTerm('archivo zip');
 * // result.valid = true
 * // result.data = 'archivo zip' (trimmeado)
 *
 * // Validar término muy corto
 * const short = validateSearchTerm('a');
 * // short.valid = false
 * // short.error = 'Término de búsqueda debe tener al menos 2 caracteres'
 *
 * // Validar término muy largo
 * const long = validateSearchTerm('a'.repeat(200));
 * // long.valid = false
 * // long.error = 'Término de búsqueda demasiado largo'
 */
function validateSearchTerm(searchTerm) {
  if (schemas && schemas.validateSearch) {
    const result = schemas.validateSearch(searchTerm);
    return {
      valid: result.success,
      data: result.data?.searchTerm,
      error: result.error,
    };
  }

  // Validación básica: verificar tipo, longitud mínima y máxima
  if (!searchTerm || typeof searchTerm !== 'string') {
    return { valid: false, error: 'Término de búsqueda inválido' };
  }

  // CRÍTICO: Sanitizar término antes de validar
  const sanitized = sanitizeSearchTerm(searchTerm);
  
  if (sanitized.length < 2) {
    return { valid: false, error: VALIDATIONS.SEARCH.TERM_MIN_LENGTH };
  }

  if (sanitized.length > 100) {
    return { valid: false, error: VALIDATIONS.SEARCH.TERM_MAX_LENGTH };
  }

  return { valid: true, data: sanitized };
}

/**
 * Valida que un ID de nodo sea un número entero positivo válido
 *
 * Verifica que el valor sea un número entero mayor que 0.
 * Usa Zod si está disponible para validación más robusta.
 *
 * @param {*} nodeId - Valor a validar como ID de nodo
 * @returns {ValidationResult} Resultado de validación con ID validado
 *
 * @example
 * // Validar ID correcto
 * const result = validateNodeId(12345);
 * // result.valid = true
 * // result.data = 12345
 *
 * // Validar ID inválido
 * const invalid = validateNodeId(-1);
 * // invalid.valid = false
 * // invalid.error = 'ID de nodo inválido'
 */
function validateNodeId(nodeId) {
  if (schemas && schemas.validateNodeId) {
    const result = schemas.validateNodeId(nodeId);
    return {
      valid: result.success,
      data: result.data,
      error: result.error,
    };
  }

  // Validación básica: debe ser número entero positivo
  if (typeof nodeId !== 'number' || !Number.isInteger(nodeId) || nodeId <= 0) {
    return { valid: false, error: 'ID de nodo inválido' };
  }

  return { valid: true, data: nodeId };
}

/**
 * Valida que un ID de descarga sea un número entero positivo válido
 *
 * Verifica que el valor sea un número entero mayor que 0.
 * Similar a validateNodeId() pero específico para IDs de descargas.
 *
 * @param {*} downloadId - Valor a validar como ID de descarga
 * @returns {ValidationResult} Resultado de validación con ID validado
 *
 * @example
 * // Validar ID de descarga correcto
 * const result = validateDownloadId(98765);
 * // result.valid = true
 * // result.data = 98765
 *
 * // Validar ID inválido
 * const invalid = validateDownloadId(0);
 * // invalid.valid = false
 * // invalid.error = 'ID de descarga inválido'
 */
function validateDownloadId(downloadId) {
  if (schemas && schemas.validateDownloadId) {
    const result = schemas.validateDownloadId(downloadId);
    return {
      valid: result.success,
      data: result.data,
      error: result.error,
    };
  }

  // Validación básica: debe ser número entero positivo
  if (typeof downloadId !== 'number' || !Number.isInteger(downloadId) || downloadId <= 0) {
    return { valid: false, error: 'ID de descarga inválido' };
  }

  return { valid: true, data: downloadId };
}

// Valida que un nombre de archivo de configuración sea seguro y válido
// Previene path traversal y asegura que solo se acceda a archivos JSON en el directorio de configuración
// filename: Nombre del archivo de configuración a validar
// Retorna: Objeto con valid (boolean), data (nombre validado), y error (mensaje si inválido)
function validateConfigFilename(filename) {
  if (schemas && schemas.validateConfigFilename) {
    const result = schemas.validateConfigFilename(filename);
    return {
      valid: result.success,
      data: result.data,
      error: result.error,
    };
  }

  // Validación básica de seguridad
  if (!filename || typeof filename !== 'string') {
    return { valid: false, error: 'Nombre de archivo inválido' };
  }

  if (!filename.endsWith('.json')) {
    return { valid: false, error: 'El archivo debe ser .json' };
  }

  // Prevenir ataques de path traversal que podrían acceder a archivos fuera del directorio de configuración
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { valid: false, error: 'Nombre de archivo no permitido' };
  }

  return { valid: true, data: filename };
}

// Valida los parámetros requeridos para iniciar la descarga de una carpeta completa
// Verifica que el folderId sea un número válido
// params: Objeto con folderId y opcionales como downloadPath, preserveStructure, etc.
// Retorna: Objeto con valid (boolean), data (parámetros validados), y error (mensaje si inválido)
function validateDownloadFolderParams(params) {
  let resultData = params;
  if (schemas && schemas.validateDownloadFolderParams) {
    const result = schemas.validateDownloadFolderParams(params);
    if (!result.success) {
      return { valid: false, error: result.error };
    }
    resultData = result.data;
  } else {
    // Validación básica
    if (!params) {
      return { valid: false, error: 'Parámetros no proporcionados' };
    }
    if (!params.folderId || typeof params.folderId !== 'number') {
      return { valid: false, error: 'ID de carpeta inválido' };
    }
    resultData = { ...params };
  }

  // REFUERZO FASE 4: Validar y sanitizar la ruta de descarga si se proporciona
  if (resultData.downloadPath) {
    const pathValidation = validateAndSanitizeDownloadPath(resultData.downloadPath);
    if (!pathValidation.valid) {
      return { valid: false, error: pathValidation.error };
    }
    resultData.downloadPath = pathValidation.path;
  }

  return { valid: true, data: resultData };
}

/**
 * Convierte códigos de error de red técnicos a mensajes comprensibles para el usuario
 *
 * Facilita el debugging y mejora la experiencia del usuario al mostrar errores
 * en lenguaje natural en lugar de códigos técnicos.
 *
 * @param {Error} error - Objeto Error que contiene un código de error de red (error.code)
 * @returns {string} Mensaje de error traducido o el mensaje original si no hay traducción
 *
 * @example
 * // Error de conexión
 * const error1 = new Error();
 * error1.code = 'ENOTFOUND';
 * getNetworkErrorMessage(error1);
 * // 'No se pudo conectar al servidor'
 *
 * // Error de timeout
 * const error2 = new Error();
 * error2.code = 'ETIMEDOUT';
 * getNetworkErrorMessage(error2);
 * // 'La conexión expiró. Verifica tu conexión a internet'
 *
 * // Error sin código conocido
 * const error3 = new Error('Error desconocido');
 * getNetworkErrorMessage(error3);
 * // 'Error desconocido' (mensaje original)
 */
function getNetworkErrorMessage(error) {
  const { ERRORS } = require('../constants/errors');

  const errorMessages = {
    ENOTFOUND: ERRORS.NETWORK.CONNECTION_FAILED,
    ETIMEDOUT: ERRORS.NETWORK.TIMEOUT,
    ECONNREFUSED: ERRORS.NETWORK.CONNECTION_REFUSED,
    ECONNRESET: ERRORS.NETWORK.CONNECTION_RESET,
    EPIPE: ERRORS.NETWORK.CONNECTION_CLOSED,
    EHOSTUNREACH: ERRORS.NETWORK.HOST_UNREACHABLE,
  };

  return errorMessages[error.code] || error.message;
}

module.exports = {
  isValidUrl,
  escapeLikeTerm,
  sanitizeSearchTerm,
  validateAndSanitizeDownloadPath,
  sanitizeFileName,
  validateDownloadParams,
  validateSearchTerm,
  validateNodeId,
  validateDownloadId,
  validateConfigFilename,
  validateDownloadFolderParams,
  getNetworkErrorMessage,
  VALIDATIONS,
};
