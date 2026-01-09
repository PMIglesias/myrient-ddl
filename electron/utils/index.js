// Módulo índice que centraliza todas las utilidades en un solo punto de exportación
// Facilita la importación de utilidades desde otros módulos sin necesidad de conocer la estructura interna
// Proporciona una API unificada para logger, helpers de archivos, validación, y schemas de Zod

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

// Intentar cargar schemas de validación de Zod si están disponibles
// Los schemas son opcionales y se pueden usar para validación más robusta cuando están disponibles
let schemas = null;
try {
    schemas = require('./schemas');
} catch (error) {
    // Si los schemas de Zod no están disponibles, se usa validación básica en su lugar
}

module.exports = {
    // Logger principal y funciones relacionadas
    logger,
    log,
    configureLogger,
    createScopedLogger,
    getLogFilePath,
    getLogDirectory,
    cleanOldLogs,
    formatObject,
    electronLog,

    // Funciones auxiliares para operaciones con archivos (sanitización, validación de rutas, etc.)
    ...fileHelpers,

    // Funciones de validación para parámetros y datos de entrada
    ...validation,
    
    // Schemas de Zod para validación avanzada (null si no están disponibles)
    schemas
};
