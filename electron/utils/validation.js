// Módulo de validación centralizado que integra validaciones básicas y schemas de Zod
// Proporciona funciones para validar parámetros de entrada, URLs, IDs, y términos de búsqueda
// Usa Zod cuando está disponible para validación robusta, con fallback a validación básica

const config = require('../config');
const { logger } = require('./logger');

const log = logger.child('Validation');

// Intentar cargar schemas de validación de Zod si están disponibles
// Los schemas de Zod proporcionan validación más robusta y mensajes de error detallados
let schemas = null;
try {
    schemas = require('./schemas');
} catch (error) {
    log.warn('Zod schemas no disponibles, usando validación básica');
}

// Valida que una URL sea segura y pertenezca a la lista de hosts permitidos
// Verifica que use protocolo HTTPS y que el dominio esté en la whitelist de seguridad
// urlString: URL a validar en formato de string
// Retorna: true si la URL es válida y segura, false en caso contrario
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

// Escapa caracteres especiales en términos de búsqueda para uso seguro en consultas LIKE de SQLite
// Previene inyección SQL escapando caracteres que tienen significado especial en LIKE (%, _)
// Usa el carácter '|' como escape, que debe estar configurado en la consulta SQL con ESCAPE '|'
// term: Término de búsqueda que puede contener caracteres especiales
// Retorna: Término escapado seguro para usar en consultas LIKE
function escapeLikeTerm(term) {
    return term
        .replace(/\|/g, '||')
        .replace(/%/g, '|%')
        .replace(/_/g, '|_');
}

// Valida los parámetros requeridos para iniciar una descarga de archivo
// Usa schemas de Zod si están disponibles para validación robusta, sino usa validación básica
// params: Objeto con propiedades id (número), title (string), y opcionales adicionales
// Retorna: Objeto con valid (boolean), data (parámetros validados), y error (mensaje si inválido)
function validateDownloadParams(params) {
    // Intentar usar validación de Zod si los schemas están disponibles
    if (schemas && schemas.validateDownloadParams) {
        const result = schemas.validateDownloadParams(params);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
        };
    }
    
    // Validación básica de fallback cuando Zod no está disponible
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

// Valida un término de búsqueda asegurando que cumpla con los requisitos mínimos
// Verifica que sea un string no vacío con longitud apropiada
// searchTerm: String que contiene el término de búsqueda a validar
// Retorna: Objeto con valid (boolean), data (término trimmeado), y error (mensaje si inválido)
function validateSearchTerm(searchTerm) {
    if (schemas && schemas.validateSearch) {
        const result = schemas.validateSearch(searchTerm);
        return {
            valid: result.success,
            data: result.data?.searchTerm,
            error: result.error
        };
    }
    
    // Validación básica: verificar tipo, longitud mínima y máxima
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

// Valida que un ID de nodo sea un número entero positivo válido
// nodeId: Valor a validar como ID de nodo
// Retorna: Objeto con valid (boolean), data (ID validado), y error (mensaje si inválido)
function validateNodeId(nodeId) {
    if (schemas && schemas.validateNodeId) {
        const result = schemas.validateNodeId(nodeId);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
        };
    }
    
    // Validación básica: debe ser número entero positivo
    if (typeof nodeId !== 'number' || !Number.isInteger(nodeId) || nodeId <= 0) {
        return { valid: false, error: 'ID de nodo inválido' };
    }
    
    return { valid: true, data: nodeId };
}

// Valida que un ID de descarga sea un número entero positivo válido
// downloadId: Valor a validar como ID de descarga
// Retorna: Objeto con valid (boolean), data (ID validado), y error (mensaje si inválido)
function validateDownloadId(downloadId) {
    if (schemas && schemas.validateDownloadId) {
        const result = schemas.validateDownloadId(downloadId);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
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
            error: result.error
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
    if (schemas && schemas.validateDownloadFolderParams) {
        const result = schemas.validateDownloadFolderParams(params);
        return {
            valid: result.success,
            data: result.data,
            error: result.error
        };
    }
    
    // Validación básica: verificar que los parámetros existan y el folderId sea válido
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

// Convierte códigos de error de red técnicos a mensajes de error comprensibles para el usuario
// Facilita el debugging y la experiencia del usuario al mostrar errores en lenguaje natural
// error: Objeto Error que contiene un código de error de red (error.code)
// Retorna: Mensaje de error traducido o el mensaje original si no hay traducción disponible
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
