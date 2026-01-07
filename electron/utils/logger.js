/**
 * 
 * Ubicación de logs:
 * - Windows: %USERPROFILE%\AppData\Roaming\{app}\logs\
 * - macOS: ~/Library/Logs/{app}/
 * - Linux: ~/.config/{app}/logs/
 *
 */

const log = require('electron-log');
const path = require('path');

// =====================
// CONFIGURACIÓN
// =====================

/**
 * Para configura el logger con las opciones deseadas
 * Este debe llamarse una vez al inicio de la aplicación si o si
 */
function configureLogger(options = {}) {
    const {
        // Nivel de log para archivo (en producción)
        fileLevel = 'info',
        // Nivel de log para consola (en desarrollo)
        consoleLevel = 'debug',
        // Tamaño máximo del archivo de log (10MB por defecto)
        maxSize = 10 * 1024 * 1024,
        // Formato de fecha para el nombre del archivo
        fileNameFormat = '{app}-{date}',
        // Si estamos en modo desarrollo
        isDev = process.env.NODE_ENV === 'development' || !require('electron').app?.isPackaged
    } = options;

    // --- Configuración del transporte de archivo 
    log.transports.file.level = fileLevel;
    log.transports.file.maxSize = maxSize;
    
    // Rotación de archivos: mantener últimos 5 archivos
    log.transports.file.archiveLogFn = (oldLogFile) => {
        const info = path.parse(oldLogFile.path);
        const timestamp = new Date().toISOString().split('T')[0];
        return path.join(info.dir, `${info.name}-${timestamp}${info.ext}`);
    };

    // Formato del archivo de log
    log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}';

    // --- Configuración del transporte de consola ---
    log.transports.console.level = isDev ? consoleLevel : 'warn';
    log.transports.console.format = '[{h}:{i}:{s}] [{level}]{scope} {text}';

    // Usar colores en consola
    log.transports.console.useStyles = true;

    // --- Configuración global ---
    
    // Capturar errores no manejados
    log.errorHandler.startCatching({
        showDialog: false,
        onError: (error) => {
            log.error('Error no capturado:', error);
        }
    });

    // Log inicial
    log.info('='.repeat(50));
    log.info('Logger inicializado');
    log.info(`Modo: ${isDev ? 'Desarrollo' : 'Producción'}`);
    log.info(`Archivo de log: ${log.transports.file.getFile()?.path || 'No disponible'}`);
    log.info('='.repeat(50));

    return log;
}

// =====================
// CHILD LOGGERS (SCOPES)
// =====================

/**
 * Cache de child loggers para evitar recrearlos
 */
const childLoggers = new Map();

/**
 * Crea o recupera un logger con scope específico
 * El scope aparece en los logs como [scope]
 * 
 * Esta función extiende el "child" logger con métodos adicionales
 * como startOperation, object, separator para mantener consistencia con el logger principal
 * 
 * const dbLog = createScopedLogger('Database');
 * dbLog.info('Conectado'); esto muestra [2024-01-05 12:00:00] [info] [Database] Conectado
 * const end = dbLog.startOperation('Query'); esto muestra Inicia operación
 * end('exitoso'); esto muestra Termina operación con duración
 */
function createScopedLogger(scope) {
    if (childLoggers.has(scope)) {
        return childLoggers.get(scope);
    }

    // Crear el child logger base usando el poderisisisisimo electron-log
    const baseChildLog = log.scope(scope);
    
    // Esto permite extender con métodos adicionales que no vienen por defecto y te muestra mas cositas
    const extendedChildLog = {
        // Métodos estándar del child logger
        error: (...args) => baseChildLog.error(...args),
        warn: (...args) => baseChildLog.warn(...args),
        info: (...args) => baseChildLog.info(...args),
        verbose: (...args) => baseChildLog.verbose(...args),
        debug: (...args) => baseChildLog.debug(...args),
        silly: (...args) => baseChildLog.silly(...args),
        log: (...args) => baseChildLog.info(...args),
        
        /**
         * Log de inicio de operación esto es super útil para medir tiempos de ejecucion
         */
        startOperation: (operation) => {
            const start = Date.now();
            baseChildLog.info(`▶ Iniciando: ${operation}`);
            
            return (result = 'completado') => {
                const duration = Date.now() - start;
                baseChildLog.info(`✓ ${operation}: ${result} (${duration}ms)`);
            };
        },
        
        /**
         * Log de objeto formateado
         */
        object: (label, obj) => {
            baseChildLog.info(`${label}:\n${formatObject(obj)}`);
        },
        
        /**
         * Log de separador visual
         */
        separator: (title = '') => {
            if (title) {
                baseChildLog.info(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
            } else {
                baseChildLog.info('='.repeat(50));
            }
        },
        
        /**
         * Crea un sub-child logger (nested scope)
         */
        child: (subScope) => createScopedLogger(`${scope}:${subScope}`),
        
        // Acceso al child logger original de electron-log
        _raw: baseChildLog
    };
    
    childLoggers.set(scope, extendedChildLog);
    return extendedChildLog;
}

// =====================
// UTILIDADES
// =====================

/**
 * Obtiene la ruta del archivo de log actual
 */
function getLogFilePath() {
    const file = log.transports.file.getFile();
    return file?.path || null;
}

/**
 * Obtiene el directorio de logs
 */
function getLogDirectory() {
    const filePath = getLogFilePath();
    return filePath ? path.dirname(filePath) : null;
}

/**
 * Limpia logs antiguos (más de X días)
 */
async function cleanOldLogs(daysToKeep = 30) {
    const fs = require('fs').promises;
    const logDir = getLogDirectory();
    
    if (!logDir) {
        log.warn('No se pudo obtener el directorio de logs');
        return;
    }

    try {
        const files = await fs.readdir(logDir);
        const now = Date.now();
        const maxAge = daysToKeep * 24 * 60 * 60 * 1000;

        for (const file of files) {
            if (!file.endsWith('.log')) continue;
            
            const filePath = path.join(logDir, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                await fs.unlink(filePath);
                log.info(`Log antiguo eliminado: ${file}`);
            }
        }
    } catch (error) {
        log.error('Error limpiando logs antiguos:', error);
    }
}

/**
 * Formatea un objeto para que sea compatible con el log evita los casos odiosos de [object Object]
 */
function formatObject(obj) {
    if (obj === null) return 'null';
    if (obj === undefined) return 'undefined';
    if (typeof obj === 'string') return obj;
    if (obj instanceof Error) {
        return `${obj.message}\n${obj.stack}`;
    }
    try {
        return JSON.stringify(obj, null, 2);
    } catch {
        return String(obj);
    }
}

// =====================
// LOG PRINCIPAL CON MÉTODOS ADICIONALES
// =====================

/**
 * Logger principal extendido con métodos útiles utiles y que se usan arto
 */
const logger = {
    // Métodos estándar que te da el poderossisisimo electron-log
    error: (...args) => log.error(...args),
    warn: (...args) => log.warn(...args),
    info: (...args) => log.info(...args),
    verbose: (...args) => log.verbose(...args),
    debug: (...args) => log.debug(...args),
    silly: (...args) => log.silly(...args),
    
    // Alias para compatibilidad
    log: (...args) => log.info(...args),
    
    /**
     * Crea un child logger con scope
     */
    child: (scope) => createScopedLogger(scope),
    
    startOperation: (operation) => {
        const start = Date.now();
        log.info(`▶ Iniciando: ${operation}`);
        
        return (result = 'completado') => {
            const duration = Date.now() - start;
            log.info(`✓ ${operation}: ${result} (${duration}ms)`);
        };
    },
    
    /**
     * Log de objeto formateado
     */
    object: (label, obj) => {
        log.info(`${label}:\n${formatObject(obj)}`);
    },
    
    /**
     * Log de separador visual para que la pantalla no te quede lleno de weas 
     */
    separator: (title = '') => {
        if (title) {
            log.info(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
        } else {
            log.info('='.repeat(50));
        }
    },
    
    // Utilidades
    getFilePath: getLogFilePath,
    getDirectory: getLogDirectory,
    cleanOldLogs: cleanOldLogs,
    configure: configureLogger,
    
    // Acceso al log original de electron-log
    _raw: log
};

// =====================
// EXPORTACIONES
// =====================

module.exports = {
    // Logger principal
    logger,
    log: logger,
    
    // Funciones de configuración
    configureLogger,
    createScopedLogger,
    
    // Utilidades
    getLogFilePath,
    getLogDirectory,
    cleanOldLogs,
    formatObject,
    
    // Para acceso directo a electron-log si es necesario
    electronLog: log
};
