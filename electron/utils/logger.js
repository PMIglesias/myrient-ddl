// Sistema de logging centralizado basado en electron-log
// Proporciona logging estructurado con niveles, scopes, y rotación automática de archivos
//
// Ubicación de archivos de log según plataforma:
// - Windows: %USERPROFILE%\AppData\Roaming\{app}\logs\
// - macOS: ~/Library/Logs/{app}/
// - Linux: ~/.config/{app}/logs/

const log = require('electron-log');
const path = require('path');

// Referencia a la función para obtener la ventana principal (se configura después)
let getMainWindowFn = null;

// Función para configurar la referencia a la ventana principal
// Se llama desde main.js después de crear la ventana
function setMainWindowGetter(fn) {
  getMainWindowFn = fn;
}

// Configura el logger global con las opciones especificadas
// Debe llamarse una vez al inicio de la aplicación, preferiblemente antes que cualquier otra operación
// options: Objeto con opciones de configuración (fileLevel, consoleLevel, maxSize, isDev, etc.)
function configureLogger(options = {}) {
  const {
    // Nivel mínimo de log que se escribirá al archivo (en producción normalmente 'info')
    fileLevel = 'info',
    // Nivel mínimo de log que se mostrará en consola (en desarrollo normalmente 'debug')
    consoleLevel = 'debug',
    // Tamaño máximo en bytes del archivo de log antes de rotar (10 MB por defecto)
    maxSize = 10 * 1024 * 1024,
    // Formato de nombre para archivos de log archivados (no usado actualmente pero disponible)
    fileNameFormat = '{app}-{date}',
    // Determina si la aplicación está en modo desarrollo o producción
    isDev = process.env.NODE_ENV === 'development' || !require('electron').app?.isPackaged,
  } = options;

  // Configuración del transporte de escritura a archivo
  // Los logs se escriben a un archivo persistente que sobrevive entre sesiones
  log.transports.file.level = fileLevel;
  log.transports.file.maxSize = maxSize;

  // Función que define cómo se nombran los archivos de log cuando se rotan (archivan)
  // Agrega un timestamp al nombre del archivo para mantener un historial
  log.transports.file.archiveLogFn = oldLogFile => {
    const info = path.parse(oldLogFile.path);
    const timestamp = new Date().toISOString().split('T')[0];
    return path.join(info.dir, `${info.name}-${timestamp}${info.ext}`);
  };

  // Formato de cada línea de log en el archivo con timestamp completo y nivel
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}';

  // Configuración del transporte de consola para desarrollo
  // En producción solo muestra warnings y errores, en desarrollo muestra todo según consoleLevel
  log.transports.console.level = isDev ? consoleLevel : 'warn';
  log.transports.console.format = '[{h}:{i}:{s}] [{level}]{scope} {text}';

  // Habilitar colores en la consola para mejor legibilidad durante desarrollo
  log.transports.console.useStyles = true;

  // Transporte personalizado para enviar logs al frontend vía IPC
  // Solo se activa si hay una ventana disponible
  const ipcTransport = (info) => {
    try {
      // Evitar bucles: No enviar al frontend logs que ya vienen del propio frontend
      if (info.scope && info.scope.startsWith('Frontend')) {
        return;
      }

      if (getMainWindowFn) {
        const mainWindow = getMainWindowFn();
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
          // Formatear el log para enviarlo al frontend
          const logEntry = {
            timestamp: new Date().toISOString(),
            level: info.level.toUpperCase(),
            scope: info.scope || null,
            message: info.data || [info.text],
            mode: isDev ? 'development' : 'production',
            source: 'backend',
          };
          mainWindow.webContents.send('backend-log', logEntry);
        }
      }
    } catch (error) {
      // Silenciar errores al enviar logs para evitar bucles infinitos
    }
  };

  // Configurar nivel y formato del transporte IPC
  ipcTransport.level = isDev ? 'debug' : 'info';
  log.transports.ipc = ipcTransport;

  // Configuración global del logger

  // Iniciar captura automática de errores no manejados
  // Previene que errores críticos pasen desapercibidos
  log.errorHandler.startCatching({
    showDialog: false,
    onError: error => {
      log.error('Error no capturado:', error);
    },
  });

  // Mensajes iniciales de confirmación que confirman que el logger está configurado correctamente
  log.info('='.repeat(50));
  log.info('Logger inicializado');
  log.info(`Modo: ${isDev ? 'Desarrollo' : 'Producción'}`);
  log.info(`Archivo de log: ${log.transports.file.getFile()?.path || 'No disponible'}`);
  log.info('='.repeat(50));

  return log;
}

// Sistema de loggers con scope (child loggers)
// Permite crear loggers específicos para diferentes módulos que incluyen el scope en cada mensaje
// Ejemplo: logger.child('Database').info('mensaje') muestra [info] [Database] mensaje

// Cache de child loggers para evitar recrear instancias innecesariamente
// Mejora el rendimiento reutilizando loggers ya creados
const childLoggers = new Map();

// Crea o recupera un logger con un scope específico que aparece en todos los mensajes
// El scope ayuda a identificar de qué módulo proviene cada mensaje de log
// Extiende el logger base de electron-log con métodos adicionales útiles
//
// Ejemplo de uso:
//   const dbLog = createScopedLogger('Database');
//   dbLog.info('Conectado'); // Muestra: [info] [Database] Conectado
//   const end = dbLog.startOperation('Query');
//   end('exitoso'); // Muestra: ✓ Query: exitoso (150ms)
//
// scope: Nombre del scope que aparecerá en todos los logs de este logger
// Retorna: Logger extendido con métodos adicionales (startOperation, object, separator, child)
function createScopedLogger(scope) {
  if (childLoggers.has(scope)) {
    return childLoggers.get(scope);
  }

  // Crear el child logger base usando electron-log que agrega automáticamente el scope
  const baseChildLog = log.scope(scope);

  // Extender el logger base con métodos adicionales que facilitan logging estructurado
  const extendedChildLog = {
    // Métodos estándar del logger que soportan logging estructurado
    // Si el primer argumento es un string y el segundo es un objeto, se formatea como estructurado
    error: (...args) => {
      if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        baseChildLog.error(`${args[0]}`, formatObject(args[1]));
      } else {
        baseChildLog.error(...args);
      }
    },
    warn: (...args) => {
      if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        baseChildLog.warn(`${args[0]}`, formatObject(args[1]));
      } else {
        baseChildLog.warn(...args);
      }
    },
    info: (...args) => {
      if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        baseChildLog.info(`${args[0]}`, formatObject(args[1]));
      } else {
        baseChildLog.info(...args);
      }
    },
    verbose: (...args) => {
      if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        baseChildLog.verbose(`${args[0]}`, formatObject(args[1]));
      } else {
        baseChildLog.verbose(...args);
      }
    },
    debug: (...args) => {
      if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        baseChildLog.debug(`${args[0]}`, formatObject(args[1]));
      } else {
        baseChildLog.debug(...args);
      }
    },
    silly: (...args) => {
      if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        baseChildLog.silly(`${args[0]}`, formatObject(args[1]));
      } else {
        baseChildLog.silly(...args);
      }
    },
    log: (...args) => {
      if (args.length === 2 && typeof args[0] === 'string' && typeof args[1] === 'object' && args[1] !== null) {
        baseChildLog.info(`${args[0]}`, formatObject(args[1]));
      } else {
        baseChildLog.info(...args);
      }
    },

    // Inicia una operación y retorna una función para finalizarla con medición de tiempo
    // Útil para medir tiempos de ejecución de operaciones y debugging de rendimiento
    // operation: Nombre descriptivo de la operación que se está iniciando
    // Retorna: Función que debe llamarse cuando la operación termine, acepta un mensaje de resultado opcional
    startOperation: operation => {
      const start = Date.now();
      baseChildLog.info(`▶ Iniciando: ${operation}`);

      return (result = 'completado') => {
        const duration = Date.now() - start;
        baseChildLog.info(`✓ ${operation}: ${result} (${duration}ms)`);
      };
    },

    // Registra un objeto formateado como JSON para mejor legibilidad
    // label: Etiqueta descriptiva que identifica el objeto
    // obj: Objeto a formatear y mostrar en el log
    object: (label, obj) => {
      baseChildLog.info(`${label}:\n${formatObject(obj)}`);
    },

    // Crea un separador visual en los logs para organizar secciones
    // title: Título opcional que aparecerá en el centro del separador
    separator: (title = '') => {
      if (title) {
        baseChildLog.info(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
      } else {
        baseChildLog.info('='.repeat(50));
      }
    },

    // Crea un sub-logger con scope anidado (ej: 'Database:Query')
    // Permite tener jerarquías de scopes para mejor organización
    // subScope: Nombre del sub-scope que se agregará al scope actual
    child: subScope => createScopedLogger(`${scope}:${subScope}`),

    // Acceso al logger original de electron-log para casos especiales
    _raw: baseChildLog,
  };

  childLoggers.set(scope, extendedChildLog);
  return extendedChildLog;
}

// Utilidades auxiliares para gestión de archivos de log y formateo

// Retorna la ruta completa del archivo de log actual donde se están escribiendo los logs
// Retorna null si no hay archivo de log configurado
function getLogFilePath() {
  const file = log.transports.file.getFile();
  return file?.path || null;
}

// Retorna la ruta del directorio donde se almacenan los archivos de log
// Útil para operaciones de limpieza o listado de logs
// Retorna null si no se puede determinar el directorio
function getLogDirectory() {
  const filePath = getLogFilePath();
  return filePath ? path.dirname(filePath) : null;
}

// Elimina archivos de log más antiguos que el número de días especificado
// Previene que los logs ocupen demasiado espacio en disco con el tiempo
// daysToKeep: Número de días de logs a mantener, archivos más antiguos se eliminan
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

    // Iterar sobre todos los archivos .log en el directorio
    for (const file of files) {
      if (!file.endsWith('.log')) continue;

      const filePath = path.join(logDir, file);
      const stats = await fs.stat(filePath);

      // Eliminar archivos más antiguos que el umbral especificado
      if (now - stats.mtime.getTime() > maxAge) {
        await fs.unlink(filePath);
        log.info(`Log antiguo eliminado: ${file}`);
      }
    }
  } catch (error) {
    log.error('Error limpiando logs antiguos:', error);
  }
}

// Formatea un objeto para mostrarlo de forma legible en los logs
// Evita el problema común de que los objetos se muestren como "[object Object]"
// Maneja casos especiales como null, undefined, strings, errores, y objetos complejos
// obj: Objeto, string, null, undefined, o Error a formatear
// Retorna: String formateado representando el objeto
function formatObject(obj) {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  if (typeof obj === 'string') return obj;
  if (obj instanceof Error) {
    return `${obj.message}\n${obj.stack}`;
  }
  try {
    // Intentar serializar como JSON con indentación para mejor legibilidad
    return JSON.stringify(obj, null, 2);
  } catch {
    // Si falla la serialización (referencias circulares, etc.), usar conversión básica
    return String(obj);
  }
}

/**
 * Logger principal de la aplicación extendido con métodos útiles adicionales
 *
 * Proporciona una API consistente para logging con métodos estándar de electron-log
 * y extensiones personalizadas para perfilar operaciones, formatear objetos, y crear
 * loggers con scope específico.
 *
 * @namespace logger
 * @example
 * const { logger } = require('./utils/logger');
 *
 * // Logging básico
 * logger.info('Mensaje informativo');
 * logger.error('Error:', error);
 *
 * // Crear logger con scope
 * const dbLogger = logger.child('Database');
 * dbLogger.info('Mensaje con scope Database');
 *
 * // Perfilar operación
 * const endOp = logger.startOperation('Carga de datos');
 * // ... operación ...
 * endOp('cargados correctamente');
 */
const logger = {
  /**
   * Registra un mensaje de error
   * @method error
   * @param {...*} args - Argumentos a formatear y registrar
   * @returns {void}
   */
  error: (...args) => log.error(...args),

  /**
   * Registra un mensaje de advertencia
   * @method warn
   * @param {...*} args - Argumentos a formatear y registrar
   * @returns {void}
   */
  warn: (...args) => log.warn(...args),

  /**
   * Registra un mensaje informativo
   * @method info
   * @param {...*} args - Argumentos a formatear y registrar
   * @returns {void}
   */
  info: (...args) => log.info(...args),

  /**
   * Registra un mensaje verbose
   * @method verbose
   * @param {...*} args - Argumentos a formatear y registrar
   * @returns {void}
   */
  verbose: (...args) => log.verbose(...args),

  /**
   * Registra un mensaje de debug
   * @method debug
   * @param {...*} args - Argumentos a formatear y registrar
   * @returns {void}
   */
  debug: (...args) => log.debug(...args),

  /**
   * Registra un mensaje silly (muy detallado)
   * @method silly
   * @param {...*} args - Argumentos a formatear y registrar
   * @returns {void}
   */
  silly: (...args) => log.silly(...args),

  /**
   * Alias de info para compatibilidad con otros sistemas de logging
   * @method log
   * @param {...*} args - Argumentos a formatear y registrar
   * @returns {void}
   */
  log: (...args) => log.info(...args),

  /**
   * Crea un child logger con scope específico para un módulo o componente
   *
   * Todos los mensajes del logger hijo incluirán el scope en el prefijo.
   * Útil para filtrar logs por módulo o componente específico.
   *
   * @method child
   * @param {string} scope - Nombre del scope que aparecerá en todos los mensajes del logger hijo
   * @returns {Object} Logger con scope específico
   *
   * @example
   * const dbLogger = logger.child('Database');
   * dbLogger.info('Conectando...');
   * // Output: [Database] Conectando...
   */
  child: scope => createScopedLogger(scope),

  /**
   * Inicia una operación y retorna función para finalizarla con medición de tiempo
   *
   * Útil para perfilar operaciones y medir tiempos de ejecución. Registra el inicio
   * y al llamar la función retornada, registra el fin con la duración en milisegundos.
   *
   * @method startOperation
   * @param {string} operation - Nombre descriptivo de la operación
   * @returns {Function} Función para finalizar la operación: (result?: string) => void
   *
   * @example
   * const endOp = logger.startOperation('Carga de base de datos');
   * // ... código de carga ...
   * endOp('cargada correctamente');
   * // Output:
   * // ▶ Iniciando: Carga de base de datos
   * // ✓ Carga de base de datos: cargada correctamente (1250ms)
   */
  startOperation: operation => {
    const start = Date.now();
    log.info(`▶ Iniciando: ${operation}`);

    return (result = 'completado') => {
      const duration = Date.now() - start;
      log.info(`✓ ${operation}: ${result} (${duration}ms)`);
    };
  },

  // Registra un objeto formateado como JSON indentado para mejor legibilidad
  // label: Etiqueta que identifica el objeto en el log
  // obj: Objeto a formatear y mostrar
  object: (label, obj) => {
    log.info(`${label}:\n${formatObject(obj)}`);
  },

  // Crea un separador visual en los logs para organizar secciones y mejorar legibilidad
  // title: Título opcional que aparecerá centrado en el separador
  separator: (title = '') => {
    if (title) {
      log.info(`${'='.repeat(20)} ${title} ${'='.repeat(20)}`);
    } else {
      log.info('='.repeat(50));
    }
  },

  // Funciones de utilidad expuestas para acceso directo
  getFilePath: getLogFilePath,
  getDirectory: getLogDirectory,
  cleanOldLogs: cleanOldLogs,
  configure: configureLogger,

  // Acceso al logger original de electron-log para casos que requieren funcionalidad avanzada
  _raw: log,
};

// Exportar todas las funciones y objetos del módulo de logging
module.exports = {
  // Logger principal extendido con métodos adicionales
  logger,
  log: logger,

  // Funciones de configuración del sistema de logging
  configureLogger,
  createScopedLogger,
  setMainWindowGetter,

  // Utilidades para gestión de archivos de log
  getLogFilePath,
  getLogDirectory,
  cleanOldLogs,
  formatObject,

  // Acceso directo al logger original de electron-log para funcionalidad avanzada
  electronLog: log,
};
