/**
 * Sistema de Logging Centralizado para Frontend
 *
 * Envía logs al backend vía IPC y mantiene logs en memoria para visualización
 * en consola dentro de la aplicación.
 *
 * Características:
 * - Logs centralizados en backend (electron-log)
 * - Almacenamiento en memoria para consola frontend
 * - Separación de logs dev/prod
 * - Exportación de logs a archivo
 * - Soporte de scopes (ej: [API], [Queue])
 */

// Detectar si estamos en modo desarrollo
const isDev = import.meta.env.DEV || import.meta.env.MODE === 'development';

// Almacenamiento de logs en memoria (limitado a 1000 entradas)
const MAX_LOG_ENTRIES = 1000;
const logs = [];
const logListeners = new Set();

// Suscribirse a logs del backend cuando esté disponible
let backendLogUnsubscribe = null;
function setupBackendLogListener() {
  try {
    const api = window.api;
    if (api && api.on && !backendLogUnsubscribe) {
      backendLogUnsubscribe = api.on('backend-log', logEntry => {
        // Agregar el log del backend al almacenamiento
        addToMemory(logEntry);
      });
    }
  } catch (error) {
    // Si falla, simplemente no se reciben logs del backend
    console.warn('[Logger] No se pudo configurar listener de logs del backend:', error);
  }
}

// Configurar listener de logs del backend cuando la API esté disponible
// Usamos un intervalo corto para verificar cuando esté lista
if (typeof window !== 'undefined') {
  const checkApi = setInterval(() => {
    if (window.api && window.api.on) {
      setupBackendLogListener();
      clearInterval(checkApi);
    }
  }, 100);

  // Limpiar después de 10 segundos si no está disponible
  setTimeout(() => clearInterval(checkApi), 10000);
}

// Niveles de log
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// Nivel mínimo de log según modo (dev muestra más, prod menos)
const MIN_LOG_LEVEL = isDev ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

/**
 * Formatea un log entry para enviarlo o almacenarlo
 */
function formatLogEntry(level, scope, args) {
  const timestamp = new Date().toISOString();
  const message = args.map(arg => {
    if (arg instanceof Error) {
      return {
        type: 'error',
        message: arg.message,
        stack: arg.stack,
      };
    }
    if (typeof arg === 'object') {
      try {
        return JSON.parse(JSON.stringify(arg));
      } catch {
        return String(arg);
      }
    }
    return arg;
  });

  return {
    timestamp,
    level,
    scope: scope || 'App',
    message,
    mode: isDev ? 'development' : 'production',
  };
}

/**
 * Agrega un log al almacenamiento en memoria
 */
function addToMemory(entry) {
  logs.push(entry);

  // Limitar tamaño del array
  if (logs.length > MAX_LOG_ENTRIES) {
    logs.shift();
  }

  // Notificar a los listeners (consola UI)
  logListeners.forEach(listener => {
    try {
      listener(entry);
    } catch (error) {
      // Ignorar errores en listeners
    }
  });
}

/**
 * Envía log al backend vía IPC
 */
async function sendToBackend(entry) {
  try {
    const api = window.api;
    if (api && api.log) {
      await api.log(entry);
    }
  } catch (error) {
    // Si falla el IPC, al menos mostrar en consola nativa
    console.error('[Logger] Error enviando log al backend:', error);
  }
}

/**
 * Procesa un log (envía al backend y almacena en memoria)
 */
function processLog(level, levelName, scope, args) {
  // Filtrar por nivel mínimo según modo
  if (level < MIN_LOG_LEVEL) {
    return;
  }

  const entry = formatLogEntry(levelName, scope, args);

  // Almacenar en memoria
  addToMemory(entry);

  // Enviar al backend (no esperar para no bloquear)
  sendToBackend(entry).catch(() => {
    // Error ya manejado en sendToBackend
  });

  // En desarrollo, también mostrar en consola nativa para debugging rápido
  if (isDev) {
    const consoleMethod =
      {
        DEBUG: console.debug,
        INFO: console.log,
        WARN: console.warn,
        ERROR: console.error,
      }[levelName] || console.log;

    const prefix = scope ? `[${scope}]` : '';
    consoleMethod(`[${levelName}]${prefix}`, ...args);
  }
}

/**
 * Crea un logger con scope específico
 */
function createScopedLogger(scope) {
  return {
    debug: (...args) => processLog(LOG_LEVELS.DEBUG, 'DEBUG', scope, args),
    info: (...args) => processLog(LOG_LEVELS.INFO, 'INFO', scope, args),
    warn: (...args) => processLog(LOG_LEVELS.WARN, 'WARN', scope, args),
    error: (...args) => processLog(LOG_LEVELS.ERROR, 'ERROR', scope, args),
    log: (...args) => processLog(LOG_LEVELS.INFO, 'INFO', scope, args), // Alias para compatibilidad
    child: subScope => createScopedLogger(scope ? `${scope}:${subScope}` : subScope),
  };
}

/**
 * Logger principal
 */
const logger = {
  debug: (...args) => processLog(LOG_LEVELS.DEBUG, 'DEBUG', null, args),
  info: (...args) => processLog(LOG_LEVELS.INFO, 'INFO', null, args),
  warn: (...args) => processLog(LOG_LEVELS.WARN, 'WARN', null, args),
  error: (...args) => processLog(LOG_LEVELS.ERROR, 'ERROR', null, args),
  log: (...args) => processLog(LOG_LEVELS.INFO, 'INFO', null, args), // Alias para compatibilidad
  child: scope => createScopedLogger(scope),

  /**
   * Obtiene todos los logs almacenados en memoria
   * @param {Object} options - Opciones de filtrado
   * @param {string} options.level - Filtrar por nivel (DEBUG, INFO, WARN, ERROR)
   * @param {string} options.scope - Filtrar por scope
   * @param {number} options.limit - Límite de resultados
   * @returns {Array} Array de logs
   */
  getLogs: (options = {}) => {
    let filtered = [...logs];

    if (options.level) {
      filtered = filtered.filter(log => log.level === options.level.toUpperCase());
    }

    if (options.scope) {
      filtered = filtered.filter(log => log.scope === options.scope);
    }

    if (options.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  },

  /**
   * Limpia los logs almacenados en memoria
   */
  clearLogs: () => {
    logs.length = 0;
  },

  /**
   * Suscribe a nuevos logs (para la consola UI)
   * @param {Function} callback - Función que se llamará con cada nuevo log
   * @returns {Function} Función para desuscribirse
   */
  onLog: callback => {
    logListeners.add(callback);
    return () => logListeners.delete(callback);
  },

  /**
   * Exporta logs a formato de texto
   * @param {Object} options - Opciones de exportación
   * @returns {string} Logs formateados como texto
   */
  exportLogs: (options = {}) => {
    const filtered = logger.getLogs(options);

    const lines = filtered.map(entry => {
      const time = new Date(entry.timestamp).toLocaleString();
      const level = entry.level.padEnd(5);
      const scope = entry.scope ? `[${entry.scope}]` : '';

      // Formatear mensaje
      const messageStr = entry.message
        .map(msg => {
          if (typeof msg === 'object') {
            if (msg.type === 'error') {
              return `${msg.message}\n${msg.stack || ''}`;
            }
            return JSON.stringify(msg, null, 2);
          }
          return String(msg);
        })
        .join(' ');

      return `[${time}] [${entry.mode}] [${level}] ${scope} ${messageStr}`;
    });

    const header =
      `=== Logs Exportados ===\n` +
      `Modo: ${isDev ? 'Desarrollo' : 'Producción'}\n` +
      `Fecha: ${new Date().toLocaleString()}\n` +
      `Total de entradas: ${filtered.length}\n` +
      `=======================\n\n`;

    return header + lines.join('\n');
  },

  /**
   * Guarda logs en un archivo usando la API del backend
   * @param {Object} options - Opciones de exportación
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveLogsToFile: async (options = {}) => {
    try {
      const api = window.api;
      if (!api || !api.saveLogsToFile) {
        // Usar constantes importadas dinámicamente o valores por defecto
        const errors = await import('../constants/errors');
        return { success: false, error: errors.API_ERRORS.NOT_AVAILABLE };
      }

      const logText = logger.exportLogs(options);
      return await api.saveLogsToFile(logText);
    } catch (error) {
      const errors = await import('../constants/errors');
      return { success: false, error: error.message || errors.GENERAL_ERRORS.UNKNOWN };
    }
  },

  /**
   * Inicializa el listener de logs del backend
   * Se puede llamar manualmente si la API no estaba disponible al cargar el módulo
   */
  initBackendListener: () => {
    setupBackendLogListener();
  },
};

export default logger;
