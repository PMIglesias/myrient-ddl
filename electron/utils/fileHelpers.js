/**
 * @fileoverview Utilidades para operaciones con archivos y sanitización de nombres
 * @module fileHelpers
 *
 * Proporciona funciones para validar, leer, escribir y limpiar archivos de forma segura.
 * Incluye sanitización de nombres de archivo, verificación de permisos, y manejo
 * robusto de errores para operaciones de archivos.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} FileCheckResult
 * @property {boolean} exists - Si el archivo existe
 * @property {number} [existingSize] - Tamaño actual del archivo en bytes
 * @property {number} [expectedSize] - Tamaño esperado en bytes
 * @property {number} [sizeDifference] - Diferencia entre tamaños
 * @property {boolean} [similarSize] - Si los tamaños son similares (dentro del margen)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { logger } = require('./logger');

const log = logger.child('FileUtils');

/**
 * Sanitiza un nombre de archivo reemplazando caracteres inválidos por guiones bajos
 *
 * Elimina caracteres que Windows y otros sistemas operativos no permiten en nombres
 * de archivo (< > : " | ? * / \). También remueve espacios al inicio y final.
 *
 * @param {string} filename - Nombre de archivo original a sanitizar
 * @returns {string} Nombre de archivo sanitizado seguro para usar en sistemas de archivos
 *
 * @example
 * // Sanitizar nombre con caracteres inválidos
 * sanitizeFilename('archivo:nombre|test.zip');
 * // Resultado: 'archivo_nombre_test.zip'
 *
 * // Sanitizar nombre con espacios
 * sanitizeFilename('  archivo con espacios  .zip');
 * // Resultado: 'archivo con espacios  .zip' (trim)
 *
 * // Sanitizar nombre con barras
 * sanitizeFilename('archivo/sub/carpeta.zip');
 * // Resultado: 'archivo_sub_carpeta.zip'
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\\/g, '_')
    .replace(/\//g, '_')
    .trim();
}

// Sanitiza una ruta completa aplicando sanitización a cada segmento individualmente
// Útil para rutas que contienen múltiples niveles de directorios
// pathStr: Ruta completa a sanitizar (ej: "folder/subfolder/file.txt")
// Retorna: Ruta sanitizada donde cada segmento ha sido procesado
function sanitizePath(pathStr) {
  return pathStr
    .split(path.sep)
    .map(part => sanitizeFilename(part))
    .join(path.sep);
}

/**
 * Verifica si un archivo existe y compara su tamaño con el esperado
 *
 * Útil para detectar archivos incompletos, determinar si se debe sobrescribir,
 * o verificar si una descarga previa está completa. Compara tamaños con un margen
 * configurado para considerar archivos "similares" (permite diferencias menores).
 *
 * @param {string} filePath - Ruta completa del archivo a verificar
 * @param {number} expectedSize - Tamaño esperado en bytes que debería tener el archivo
 * @returns {FileCheckResult} Información sobre existencia y tamaños del archivo
 *
 * @example
 * // Verificar archivo existente con tamaño correcto
 * const result = checkFileExists('C:/Downloads/archivo.zip', 1048576);
 * // result.exists = true
 * // result.existingSize = 1048576
 * // result.similarSize = true (si la diferencia <= sizeMarginBytes)
 *
 * // Verificar archivo que no existe
 * const notFound = checkFileExists('C:/Downloads/inexistente.zip', 1048576);
 * // notFound.exists = false
 */
function checkFileExists(filePath, expectedSize) {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const existingSize = stats.size;
      const sizeDifference = Math.abs(existingSize - expectedSize);

      return {
        exists: true,
        existingSize,
        expectedSize,
        sizeDifference,
        similarSize: sizeDifference <= config.files.sizeMarginBytes,
      };
    }
    return { exists: false };
  } catch (error) {
    log.error('Error al verificar archivo:', error);
    return { exists: false };
  }
}

// Lee y parsea un archivo JSON desde el directorio de configuración
// filename: Nombre del archivo JSON (puede incluir o no la extensión .json)
// Retorna: Objeto parseado del JSON o null si el archivo no existe o hay error
function readJSONFile(filename) {
  const filePath = path.join(config.paths.configPath, filename);
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(data);
    }
    return null;
  } catch (error) {
    log.error(`Error leyendo ${filename}:`, error);
    return null;
  }
}

// Escribe un objeto JavaScript como archivo JSON en el directorio de configuración
// filename: Nombre del archivo JSON donde se guardará (puede incluir o no extensión .json)
// data: Objeto JavaScript que se serializará a JSON con indentación de 2 espacios
// Retorna: true si la escritura fue exitosa, false si hubo algún error
function writeJSONFile(filename, data) {
  const filePath = path.join(config.paths.configPath, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    log.error(`Error escribiendo ${filename}:`, error);
    return false;
  }
}

// Asegura que un directorio existe, creándolo recursivamente si no existe
// Útil antes de escribir archivos para evitar errores de directorio no encontrado
// dirPath: Ruta completa del directorio que debe existir
// Retorna: true si el directorio existe o se creó exitosamente, false si hubo error
function ensureDirectoryExists(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      log.debug('Directorio creado:', dirPath);
    }
    return true;
  } catch (error) {
    log.error('Error creando directorio:', error);
    return false;
  }
}

// Verifica si la aplicación tiene permisos de escritura en un directorio específico
// Útil para validar rutas de descarga antes de intentar escribir archivos
// dirPath: Ruta del directorio donde se quiere verificar permisos
// Retorna: true si tiene permisos de escritura, false si no
function hasWritePermission(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Elimina un archivo de forma asíncrona con manejo de errores y reintentos automáticos
 *
 * Maneja casos donde el archivo está en uso temporalmente (EBUSY, EPERM) reintentando
 * automáticamente después de un delay. Útil para eliminar archivos que pueden estar
 * siendo usados por otros procesos (descargas en progreso, streams abiertos, etc.).
 *
 * @param {string} filePath - Ruta completa del archivo a eliminar
 * @param {number} [retryDelay=1000] - Tiempo en milisegundos a esperar antes de reintentar
 * @returns {void}
 *
 * @example
 * // Eliminar archivo (con reintento automático si está en uso)
 * safeUnlink('C:/Downloads/archivo.zip');
 *
 * // Eliminar con delay personalizado para reintento
 * safeUnlink('C:/Downloads/archivo.zip', 2000); // Espera 2 segundos antes de reintentar
 */
function safeUnlink(filePath, retryDelay = 1000) {
  if (!filePath || !fs.existsSync(filePath)) return;

  fs.unlink(filePath, err => {
    if (err) {
      log.error('Error eliminando archivo:', {
        path: filePath,
        error: err.message,
        code: err.code,
      });

      // Reintentar automáticamente si el archivo está temporalmente en uso
      // Esto puede ocurrir cuando otro proceso tiene el archivo abierto
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        log.warn('Archivo en uso, reintentando en', retryDelay, 'ms');
        setTimeout(() => {
          fs.unlink(filePath, retryErr => {
            if (retryErr) {
              log.error('Reintento fallido:', retryErr.message);
            } else {
              log.debug('Archivo eliminado en segundo intento:', filePath);
            }
          });
        }, retryDelay);
      }
    } else {
      log.debug('Archivo eliminado:', filePath);
    }
  });
}

module.exports = {
  sanitizeFilename,
  sanitizePath,
  checkFileExists,
  readJSONFile,
  writeJSONFile,
  ensureDirectoryExists,
  hasWritePermission,
  safeUnlink,
};
