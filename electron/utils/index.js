/**
 * Índice de utilidades esta wea principalmente exporta todas las utilidades desde un solo punto para que todo sea mas modular
 */

const { 
    logger, 
    log,
    configureLogger, 
    createScopedLogger,
    getLogFilePath,
    getLogDirectory,
    cleanOldLogs,
    formatObject,
    electronLog
} = require('./logger');

const fileHelpers = require('./fileHelpers');
const validation = require('./validation');

// Intentar cargar schemas de Zod (opcional)
let schemas = null;
try {
    schemas = require('./schemas');
} catch (error) {
    // Zod schemas no disponibles, usar validación básica
}

module.exports = {
    // Logger principal
    logger,
    log,
    
    // Funciones de logger
    configureLogger,
    createScopedLogger,
    getLogFilePath,
    getLogDirectory,
    cleanOldLogs,
    formatObject,
    electronLog,

    // File helpers
    ...fileHelpers,

    // Validation
    ...validation,
    
    // Schemas solo si están disponibles
    schemas
};
