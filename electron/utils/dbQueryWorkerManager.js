/**
 * @fileoverview Manager para Worker Thread de queries SQL pesadas
 * @module dbQueryWorkerManager
 *
 * Gestiona la comunicación con el worker thread que ejecuta queries SQL pesadas
 * para no bloquear el main thread de Electron. Soporta operaciones asíncronas
 * con timeouts y manejo de errores robusto.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

const { Worker } = require('worker_threads');
const path = require('path');
const { logger } = require('./logger');
const log = logger.child('DBQueryWorker');

/**
 * Manager para el worker thread de queries SQL
 */
class DBQueryWorkerManager {
  /**
   * Crea una nueva instancia del manager
   */
  constructor() {
    this.worker = null;
    this.isInitialized = false;
    this.pendingRequests = new Map(); // Map<requestId, {resolve, reject, timeout}>
    this.requestIdCounter = 0;
    this.workerPath = path.join(__dirname, '../workers/dbQueryWorker.js');
    this.initTimeout = 5000; // 5 segundos para inicializar
    this.requestTimeout = 30000; // 30 segundos para queries
  }

  /**
   * Inicializa el worker thread
   * @param {string} dbPath - Ruta a la base de datos
   * @param {string} [dbType='queue'] - Tipo de base de datos: 'queue' o 'catalog'
   * @returns {Promise<boolean>} true si se inicializó correctamente
   */
  async initialize(dbPath, dbType = 'queue') {
    if (this.isInitialized && this.worker) {
      log.debug('Worker ya está inicializado');
      return true;
    }

    try {
      log.info('Inicializando worker thread para queries SQL...');

      // Crear worker
      this.worker = new Worker(this.workerPath);

      // Configurar listeners
      this.worker.on('message', (message) => {
        this._handleWorkerMessage(message);
      });

      this.worker.on('error', (error) => {
        log.error('Error en worker thread:', error);
        this._rejectAllPending('Worker error: ' + error.message);
      });

      this.worker.on('exit', (code) => {
        if (code !== 0) {
          log.error(`Worker thread terminó con código ${code}`);
        } else {
          log.debug('Worker thread terminado normalmente');
        }
        this.isInitialized = false;
        this.worker = null;
        this._rejectAllPending('Worker thread terminado');
      });

      // Inicializar worker con ruta de DB y tipo
      const initResult = await this._sendRequest('init', { dbPath, dbType }, this.initTimeout);

      if (initResult.success) {
        this.isInitialized = true;
        log.info('Worker thread inicializado correctamente');
        return true;
      } else {
        log.error('Error inicializando worker:', initResult.error);
        this._cleanup();
        return false;
      }
    } catch (error) {
      log.error('Error creando worker thread:', error);
      this._cleanup();
      return false;
    }
  }

  /**
   * Envía una petición al worker y espera la respuesta
   * @private
   */
  _sendRequest(type, data, timeout = this.requestTimeout) {
    return new Promise((resolve, reject) => {
      // Permitir 'init' incluso si el worker no está completamente inicializado
      if (!this.worker) {
        reject(new Error('Worker no está inicializado'));
        return;
      }
      
      // Para otros tipos de peticiones, verificar que esté inicializado
      if (type !== 'init' && !this.isInitialized) {
        reject(new Error('Worker no está inicializado'));
        return;
      }

      const requestId = ++this.requestIdCounter;
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Timeout esperando respuesta del worker (${timeout}ms)`));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      });

      try {
        this.worker.postMessage({
          id: requestId,
          type,
          ...data,
        });
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Maneja mensajes del worker
   * @private
   */
  _handleWorkerMessage(message) {
    const request = this.pendingRequests.get(message.id);
    if (!request) {
      log.warn(`Respuesta del worker sin request pendiente: ${message.id}`);
      return;
    }

    this.pendingRequests.delete(message.id);

    if (message.success) {
      request.resolve(message);
    } else {
      request.reject(new Error(message.error || 'Error desconocido en worker'));
    }
  }

  /**
   * Rechaza todas las peticiones pendientes
   * @private
   */
  _rejectAllPending(reason) {
    for (const [id, request] of this.pendingRequests.entries()) {
      request.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /**
   * Ejecuta batch de actualizaciones de progreso en el worker
   * @param {Array<Object>} updates - Array de actualizaciones
   * @returns {Promise<Object>} Resultado de la operación
   */
  async batchUpdateProgress(updates) {
    if (!this.isInitialized) {
      throw new Error('Worker no está inicializado');
    }

    try {
      const result = await this._sendRequest('batchUpdateProgress', { updates });
      return result;
    } catch (error) {
      log.error('Error en batchUpdateProgress:', error);
      throw error;
    }
  }

  /**
   * Ejecuta búsqueda FTS en el worker
   * @param {string} searchTerm - Término de búsqueda
   * @param {Object} options - Opciones de búsqueda
   * @param {string} ftsTable - Nombre de la tabla FTS
   * @param {string} ftsType - Tipo de FTS ('fts5' o 'fts4')
   * @returns {Promise<Object>} Resultados de la búsqueda
   */
  async searchFTS(searchTerm, options, ftsTable, ftsType) {
    if (!this.isInitialized) {
      throw new Error('Worker no está inicializado');
    }

    try {
      const result = await this._sendRequest('searchFTS', {
        searchTerm,
        options,
        ftsTable,
        ftsType,
      });
      return result;
    } catch (error) {
      log.error('Error en searchFTS:', error);
      throw error;
    }
  }

  /**
   * Verifica si el worker está disponible
   * @returns {Promise<boolean>} true si el worker responde
   */
  async ping() {
    if (!this.isInitialized) {
      return false;
    }

    try {
      const result = await this._sendRequest('ping', {}, 5000);
      return result.success === true;
    } catch (error) {
      log.warn('Worker no responde al ping:', error.message);
      return false;
    }
  }

  /**
   * Limpia recursos del worker
   */
  _cleanup() {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (error) {
        log.debug('Error terminando worker:', error.message);
      }
      this.worker = null;
    }
    this.isInitialized = false;
    this._rejectAllPending('Worker cleanup');
  }

  /**
   * Destruye el worker y limpia recursos
   */
  destroy() {
    log.info('Destruyendo worker thread...');
    this._cleanup();
  }
}

// Singleton instance
let workerManagerInstance = null;

/**
 * Obtiene la instancia singleton del manager
 * @returns {DBQueryWorkerManager}
 */
function getWorkerManager() {
  if (!workerManagerInstance) {
    workerManagerInstance = new DBQueryWorkerManager();
  }
  return workerManagerInstance;
}

module.exports = {
  getWorkerManager,
  DBQueryWorkerManager,
};
