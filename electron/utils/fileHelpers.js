/**
 * Utilidades para manejo de archivos y sanitización
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { logger } = require('./logger');

const log = logger.child('FileUtils');

/**
 * Sanitiza un nombre de archivo eliminando caracteres inválidos para que windows no rechace
 */
function sanitizeFilename(filename) {
    return filename
        .replace(/[<>:"|?*]/g, '_')
        .replace(/\\/g, '_')
        .replace(/\//g, '_')
        .trim();
}

/**
 * Sanitiza una ruta completa aplicando sanitización a cada parte
 */
function sanitizePath(pathStr) {
    return pathStr
        .split(path.sep)
        .map(part => sanitizeFilename(part))
        .join(path.sep);
}

/**
 * Verifica si un archivo existe y compara su tamaño con el esperado
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
                similarSize: sizeDifference <= config.files.sizeMarginBytes
            };
        }
        return { exists: false };
    } catch (error) {
        log.error('Error al verificar archivo:', error);
        return { exists: false };
    }
}

/**
 * Lee un archivo JSON de configuración
 */
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

/**
 * Escribe un archivo JSON de configuración
 */
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

/**
 * Crea un directorio si no existe
 */
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

/**
 * Verifica permisos de escritura en un directorio
 */
function hasWritePermission(dirPath) {
    try {
        fs.accessSync(dirPath, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Elimina un archivo de forma segura (async)
 */
function safeUnlink(filePath, retryDelay = 1000) {
    if (!filePath || !fs.existsSync(filePath)) return;

    fs.unlink(filePath, (err) => {
        if (err) {
            log.error('Error eliminando archivo:', {
                path: filePath,
                error: err.message,
                code: err.code
            });

            // Reintentar si el archivo está en uso
            if (err.code === 'EBUSY' || err.code === 'EPERM') {
                log.warn('Archivo en uso, reintentando en', retryDelay, 'ms');
                setTimeout(() => {
                    fs.unlink(filePath, (retryErr) => {
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
    safeUnlink
};
