/**
 * Valida todo por aqui este es el validin validon
 * Integra validaciones con Zod schemas
 */

const config = require('../config');
const { logger } = require('./logger');

const log = logger.child('Validation');

// Importar schemas de Zod (si está disponible)
let schemas = null;
try {
    schemas = require('./schemas');
} catch (error) {
    log.warn('Zod schemas no disponibles, usando validación básica');
}

/**
 * Valida si una URL es segura y pertenece a hosts permitidos
 */
function isValidUrl(urlString) {
    try {
        const url = new URL(urlString);

        // Solo permitir HTTPS
        if (url.protocol !== 'https:') {
            log.warn('URL rechazada: protocolo no es HTTPS', urlString);
            return false;
        }

        // Verificar que el host esté en la lista permitida
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
 * Escapa términos que dejan la caga para consultas LIKE en SQLite y que no te inyecten weas
 * Usa '|' como carácter de escape (configurado en la consulta SQL)
 */
function escapeLikeTerm(term) {
    return term
        .replace(/\|/g, '||')  // Escapar el carácter de escape primero
        .replace(/%/g, '|%')   // Escapar %
        .replace(/_/g, '|_');  // Escapar _
}

/**
 * Valida parámetros de descarga
 * Usa Zod si está disponible, sino validación básica
 */
function validateDownloadParams(params) {
    // Usar Zod si está disponible
    if (schemas && schemas.validateDownloadParams) {
        const result = schemas.validateDownloadParams(params);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
        };
    }
    
    // Validación básica de fallback
    if (!params) {
        return { valid: false, error: 'Parámetros no proporcionados' };
    }

    if (!params.id || typeof params.id !== 'number') {
        return { valid: false, error: 'ID inválido' };
    }

    if (!params.title || typeof params.title !== 'string' || params.title.trim().length === 0) {
        return { valid: false, error: 'Título inválido' };
    }

    if (params.title.length > 500) {
        return { valid: false, error: 'Título demasiado largo' };
    }

    return { valid: true, data: params };
}

/**
 * Valida término de búsqueda
 */
function validateSearchTerm(searchTerm) {
    if (schemas && schemas.validateSearch) {
        const result = schemas.validateSearch(searchTerm);
        return {
            valid: result.success,
            data: result.data?.searchTerm,
            error: result.error
        };
    }
    
    // Validación básica
    if (!searchTerm || typeof searchTerm !== 'string') {
        return { valid: false, error: 'Término de búsqueda inválido' };
    }
    
    const trimmed = searchTerm.trim();
    if (trimmed.length < 2) {
        return { valid: false, error: 'El término debe tener al menos 2 caracteres' };
    }
    
    if (trimmed.length > 100) {
        return { valid: false, error: 'El término es demasiado largo' };
    }
    
    return { valid: true, data: trimmed };
}

/**
 * Valida ID de nodo
 */
function validateNodeId(nodeId) {
    if (schemas && schemas.validateNodeId) {
        const result = schemas.validateNodeId(nodeId);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
        };
    }
    
    // Validación básica
    if (typeof nodeId !== 'number' || !Number.isInteger(nodeId) || nodeId <= 0) {
        return { valid: false, error: 'ID de nodo inválido' };
    }
    
    return { valid: true, data: nodeId };
}

/**
 * Valida ID de descarga
 */
function validateDownloadId(downloadId) {
    if (schemas && schemas.validateDownloadId) {
        const result = schemas.validateDownloadId(downloadId);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
        };
    }
    
    // Validación básica
    if (typeof downloadId !== 'number' || !Number.isInteger(downloadId) || downloadId <= 0) {
        return { valid: false, error: 'ID de descarga inválido' };
    }
    
    return { valid: true, data: downloadId };
}

/**
 * Valida nombre de archivo de configuración
 */
function validateConfigFilename(filename) {
    if (schemas && schemas.validateConfigFilename) {
        const result = schemas.validateConfigFilename(filename);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
        };
    }
    
    // Validación básica
    if (!filename || typeof filename !== 'string') {
        return { valid: false, error: 'Nombre de archivo inválido' };
    }
    
    if (!filename.endsWith('.json')) {
        return { valid: false, error: 'El archivo debe ser .json' };
    }
    
    // Prevenir path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return { valid: false, error: 'Nombre de archivo no permitido' };
    }
    
    return { valid: true, data: filename };
}

/**
 * Valida parámetros para descargar una carpeta
 */
function validateDownloadFolderParams(params) {
    if (schemas && schemas.validateDownloadFolderParams) {
        const result = schemas.validateDownloadFolderParams(params);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
        };
    }
    
    // Validación básica
    if (!params) {
        return { valid: false, error: 'Parámetros no proporcionados' };
    }

    if (!params.folderId || typeof params.folderId !== 'number') {
        return { valid: false, error: 'ID de carpeta inválido' };
    }

    if (params.folderId <= 0) {
        return { valid: false, error: 'ID de carpeta debe ser mayor a 0' };
    }

    return { valid: true, data: params };
}

/**
 * Traduce códigos de error de red a mensajes para que cualquiera pueda entenderlo
 */
function getNetworkErrorMessage(error) {
    const errorMessages = {
        'ENOTFOUND': 'No se pudo conectar al servidor',
        'ETIMEDOUT': 'Tiempo de espera agotado',
        'ECONNREFUSED': 'Conexión rechazada por el servidor',
        'ECONNRESET': 'Conexión reiniciada por el servidor',
        'EPIPE': 'Conexión cerrada inesperadamente',
        'EHOSTUNREACH': 'Servidor no alcanzable'
    };

    return errorMessages[error.code] || error.message;
}

module.exports = {
    isValidUrl,
    escapeLikeTerm,
    validateDownloadParams,
    validateSearchTerm,
    validateNodeId,
    validateDownloadId,
    validateConfigFilename,
    validateDownloadFolderParams,
    getNetworkErrorMessage
};
