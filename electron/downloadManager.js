/**
 * @fileoverview Gestor de descargas principal
 * @module DownloadManager
 *
 * Maneja la cola, concurrencia, reintentos y persistencia de descargas.
 *
 * ACTUALIZADO v2.0 (Block 2):
 * - Usa queueDatabase (SQLite) para persistencia robusta
 * - Integra ChunkedDownloader para descargas fragmentadas
 * - Soporte automático de Range requests para archivos grandes
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} DownloadProgressInfo
 * @property {number} id - ID único de la descarga
 * @property {string} state - Estado actual: 'starting' | 'progressing' | 'completed' | 'paused' | 'cancelled' | 'interrupted' | 'awaiting-confirmation'
 * @property {string} [title] - Título del archivo
 * @property {number} [percent] - Porcentaje completado (0-1)
 * @property {number} [speed] - Velocidad de descarga en MB/s
 * @property {number} [totalBytes] - Tamaño total en bytes
 * @property {number} [downloadedBytes] - Bytes descargados
 * @property {number} [remainingTime] - Tiempo restante estimado en segundos
 * @property {string} [savePath] - Ruta donde se guarda el archivo
 * @property {boolean} [chunked] - Si es descarga fragmentada
 * @property {number} [numChunks] - Número de chunks (si es fragmentada)
 * @property {number} [activeChunks] - Chunks activos actualmente
 * @property {number} [completedChunks] - Chunks completados
 * @property {number} [totalChunks] - Total de chunks
 * @property {Array<Object>} [chunkProgress] - Progreso individual de cada chunk
 * @property {boolean} [resuming] - Si está reanudando descarga previa
 * @property {number} [resumeFromByte] - Byte desde donde se reanuda
 * @property {string} [error] - Mensaje de error si falló
 * @property {Object} [fileCheck] - Información del archivo existente para confirmación
 */

/**
 * @typedef {Object} DownloadParams
 * @property {number} id - ID único de la descarga (desde base de datos)
 * @property {string} title - Nombre del archivo a descargar
 * @property {string} [downloadPath] - Ruta base de descarga (opcional, se pedirá si no está)
 * @property {boolean} [preserveStructure] - Si mantener estructura de carpetas (default: true)
 * @property {boolean} [forceOverwrite] - Si sobrescribir sin preguntar (default: false)
 * @property {string} [savePath] - Ruta completa de guardado (opcional, se determina si no está)
 * @property {string} [priority] - Prioridad: 'low' | 'normal' | 'high'
 */

/**
 * @typedef {Object} DownloadInfo
 * @property {number} id - ID de la descarga
 * @property {string} title - Título del archivo
 * @property {string} state - Estado actual
 * @property {Date} startTime - Tiempo de inicio
 * @property {Date} [lastUpdate] - Última actualización
 * @property {Object} [request] - Request HTTP de Electron
 * @property {Object} [response] - Response HTTP de Electron
 * @property {Object} [fileStream] - Stream de escritura de archivo
 * @property {string} [savePath] - Ruta de guardado
 * @property {string} [partialFilePath] - Ruta del archivo parcial (.part)
 * @property {number} [percent] - Porcentaje completado (0-1)
 * @property {number} [resumeFromByte] - Byte desde donde se reanuda
 * @property {boolean} [isResuming] - Si está reanudando
 * @property {number} [expectedFileSize] - Tamaño esperado en bytes
 * @property {number} [downloadedBytes] - Bytes descargados
 * @property {number} [speed] - Velocidad en MB/s
 * @property {number} [speedBytesPerSec] - Velocidad en bytes/segundo
 */

/**
 * @typedef {Object} QueueStats
 * @property {number} total - Total de descargas en cola
 * @property {number} active - Descargas activas actualmente
 * @property {number} slotsAvailable - Slots disponibles para nuevas descargas
 * @property {number} maxConcurrent - Máximo de descargas concurrentes
 * @property {boolean} canStart - Si se puede iniciar una nueva descarga
 * @property {boolean} shouldQueue - Si una nueva descarga debe ir a cola
 * @property {Object} byPriority - Conteo por prioridad: { low: number, normal: number, high: number }
 */

/**
 * @typedef {Object} QueueTimeEstimate
 * @property {number} totalEstimatedSeconds - Tiempo total estimado en segundos
 * @property {number} totalEstimatedMinutes - Tiempo total estimado en minutos
 * @property {number} totalEstimatedHours - Tiempo total estimado en horas
 * @property {number} averageSpeedMBPerSec - Velocidad promedio en MB/s
 */

/**
 * @typedef {Object} ManagerStats
 * @property {number} activeSimple - Descargas simples activas
 * @property {number} activeChunked - Descargas fragmentadas activas
 * @property {number} queuedInMemory - Descargas en cola en memoria
 * @property {number} queuedInDB - Descargas en cola en base de datos
 * @property {number} completed - Descargas completadas
 * @property {number} failed - Descargas fallidas
 * @property {number} maxConcurrent - Máximo de descargas concurrentes
 * @property {boolean} processing - Si está procesando la cola
 * @property {boolean} locked - Si el lock está activo
 * @property {Object} chunkedConfig - Configuración de descargas fragmentadas
 * @property {Array<number>} activeIds - IDs de descargas activas
 * @property {Array<number>} queuedIds - IDs de descargas en cola
 * @property {Object} [queueStats] - Estadísticas de cola (si QueueService está disponible)
 * @property {QueueTimeEstimate} [queueTimeEstimate] - Estimación de tiempo de cola
 */

const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const config = require('./config');
const { logger, readJSONFile, writeJSONFile, sanitizeFilename, safeUnlink, validateDiskSpace, BandwidthManager } = require('./utils');
const database = require('./database');
const queueDatabase = require('./queueDatabase');
const { DownloadState, DownloadPriority } = require('./queueDatabase');
const { isValidUrl, getNetworkErrorMessage } = require('./utils/validation');
const ChunkedDownloader = require('./ChunkedDownloader');
const { CircuitBreaker } = require('./utils/circuitBreaker');
const { serviceManager } = require('./services');

const log = logger.child('DownloadManager');

/**
 * Gestor de descargas principal
 *
 * Maneja la cola de descargas, concurrencia, reintentos automáticos y persistencia.
 * Soporta descargas simples y fragmentadas según el tamaño del archivo y configuración.
 *
 * @class DownloadManager
 * @example
 * // El DownloadManager se exporta como una instancia singleton
 * const downloadManager = require('./downloadManager');
 *
 * // Inicializar antes de usar
 * await downloadManager.initialize(mainWindow, progressThrottler);
 *
 * // Agregar descarga a la cola
 * downloadManager.addToQueueWithPersist({
 *   id: 12345,
 *   title: 'archivo.zip',
 *   downloadPath: 'C:/Downloads',
 *   preserveStructure: true,
 *   priority: 'normal'
 * });
 *
 * // Procesar la cola
 * await downloadManager.processQueue();
 */
class DownloadManager {
  /**
   * Crea una nueva instancia de DownloadManager
   *
   * Inicializa todos los Maps y configuraciones necesarias para gestionar descargas.
   * Configura circuit breakers si están habilitados en la configuración.
   *
   * @constructor
   * @example
   * const manager = new DownloadManager();
   * // Los Maps se inicializan automáticamente:
   * // - activeDownloads: descargas simples activas
   * // - chunkedDownloads: descargas fragmentadas activas
   * // - downloadQueue: cola de descargas pendientes
   */
  constructor() {
    this.activeDownloads = new Map(); // Descargas activas (simples)
    this.chunkedDownloads = new Map(); // Descargas fragmentadas activas
    this.downloadQueue = []; // Cola de descargas pendientes
    this.processing = false; // Indicador de procesamiento
    this.processingLock = false; // Un bloqueo clasico para evitar los race conditions
    this.maxRetries = config.network.maxRetries;
    this.retryDelay = config.network.retryDelay;
    this.mainWindow = null;
    this.progressThrottler = null;

    // FIX MEMORY LEAK: Map para trackear handlers de cada descarga
    this.downloadHandlers = new Map();

    // Configuración de chunks
    this.chunkedConfig = config.downloads.chunked || {};

    // Circuit Breaker para errores de descarga
    if (config.circuitBreaker?.enabled) {
      const cbConfig = config.circuitBreaker.download || {};
      this.circuitBreaker = new CircuitBreaker({
        name: 'DownloadManager',
        failureThreshold: cbConfig.failureThreshold || 5,
        successThreshold: cbConfig.successThreshold || 2,
        timeout: cbConfig.timeout || 60000,
        resetTimeout: cbConfig.resetTimeout || 60000,
        onStateChange: info => {
          log.warn(`[CircuitBreaker] Estado cambiado: ${info.oldState} -> ${info.newState}`);
          if (info.newState === 'OPEN') {
            this._sendProgress({
              type: 'circuit-breaker-open',
              message:
                'Circuit breaker abierto debido a errores repetidos. Las descargas se pausarán temporalmente.',
            });
          } else if (info.newState === 'CLOSED') {
            this._sendProgress({
              type: 'circuit-breaker-closed',
              message: 'Circuit breaker cerrado. Descargas reanudadas normalmente.',
            });
          }
        },
      });
    } else {
      this.circuitBreaker = null;
    }

    // Circuit Breakers por host para aislar problemas de servidores específicos
    this.hostCircuitBreakers = new Map();

    // BandwidthManager para control de ancho de banda
    const bandwidthConfig = config.downloads.bandwidth || {};
    this.bandwidthManager = new BandwidthManager({
      maxBandwidthBytesPerSecond: bandwidthConfig.maxBandwidthBytesPerSecond || 0,
      updateInterval: bandwidthConfig.updateInterval || 100,
      enabled: bandwidthConfig.enabled !== false,
      autoDetect: bandwidthConfig.autoDetect !== false,
      distributionPercentages: bandwidthConfig.distributionPercentages || [40, 30, 30],
    });
  }

  /**
   * Inicializa el gestor de descargas con referencias necesarias
   *
   * Establece las referencias a la ventana principal y el throttler de progreso.
   * Inicializa los servicios requeridos (DownloadService, FileService, QueueService)
   * y valida que estén disponibles antes de continuar.
   *
   * @param {Object} mainWindow - Ventana principal de Electron (BrowserWindow)
   * @param {Object} progressThrottler - Instancia de ProgressThrottler para controlar actualizaciones
   * @returns {Promise<void>}
   * @throws {Error} Si los servicios críticos no están disponibles después de inicialización
   *
   * @example
   * await downloadManager.initialize(mainWindow, progressThrottler);
   * // Después de inicializar, el gestor está listo para usar
   */
  async initialize(mainWindow, progressThrottler) {
    this.mainWindow = mainWindow;
    this.progressThrottler = progressThrottler;

    // Inicializar servicios si no están inicializados
    if (!serviceManager.initialized) {
      try {
        await serviceManager.initialize();
      } catch (error) {
        log.error('[DownloadManager] Error crítico inicializando servicios:', error);
        throw new Error('No se pudieron inicializar los servicios requeridos');
      }
    }

    // Obtener referencias a servicios
    this.downloadService = serviceManager.getDownloadService();
    this.fileService = serviceManager.getFileService();
    this.queueService = serviceManager.getQueueService();

    // Validar que los servicios críticos estén disponibles
    if (!this.downloadService) {
      log.error('[DownloadManager] DownloadService no disponible después de inicialización');
      throw new Error('DownloadService no está disponible después de inicialización');
    }
    if (!this.fileService) {
      log.error('[DownloadManager] FileService no disponible después de inicialización');
      throw new Error('FileService no está disponible después de inicialización');
    }
    if (!this.queueService) {
      log.warn(
        '[DownloadManager] QueueService no está disponible, algunas funcionalidades pueden estar limitadas'
      );
    }

    log.info('[DownloadManager] Servicios inicializados correctamente:', {
      downloadService: !!this.downloadService,
      fileService: !!this.fileService,
      queueService: !!this.queueService,
    });

    // Si QueueService está disponible, actualizar maxConcurrent desde el servicio
    if (this.queueService) {
      // QueueService ya tiene maxConcurrent configurado
      log.debug('QueueService inicializado, usando lógica de negocio para gestión de cola');
    }
  }

  /**
   * Destruye el gestor y limpia todos los recursos
   *
   * Cancela todas las descargas activas (simples y fragmentadas),
   * limpia los Maps y referencias para evitar memory leaks.
   * Debe llamarse antes de cerrar la aplicación.
   *
   * @returns {void}
   *
   * @example
   * // Al cerrar la aplicación:
   * app.on('before-quit', () => {
   *   downloadManager.destroy();
   * });
   */
  destroy() {
    log.info('Destruyendo DownloadManager...');

    // Cancelar todas las descargas simples activas
    this.activeDownloads.forEach((download, id) => {
      try {
        this._cleanupDownload(id, download.savePath, true);
      } catch (e) {
        log.error(`Error limpiando descarga ${id}:`, e.message);
      }
    });

    // Destruir todas las descargas fragmentadas
    this.chunkedDownloads.forEach((chunked, id) => {
      try {
        chunked.destroy();
      } catch (e) {
        log.error(`Error destruyendo descarga fragmentada ${id}:`, e.message);
      }
    });

    // Limpiar maps
    this.activeDownloads.clear();
    this.chunkedDownloads.clear();
    this.downloadHandlers.clear();
    this.downloadQueue = [];

    // Limpiar referencias
    this.mainWindow = null;
    this.progressThrottler = null;

    // Destruir BandwidthManager
    if (this.bandwidthManager) {
      this.bandwidthManager.destroy();
      this.bandwidthManager = null;
    }

    log.info('DownloadManager destruido');
  }

  // =====================
  // GESTIÍ“N DE LOCK
  // =====================

  /**
   * Adquiere un lock con timeout para operaciones críticas
   *
   * Previene race conditions en operaciones concurrentes sobre la cola de descargas.
   * Si el lock no está disponible, espera hasta el timeout especificado.
   *
   * @param {number} [timeoutMs=config.downloads.lockTimeout] - Tiempo máximo de espera en milisegundos
   * @returns {Promise<boolean>} true si el lock se adquirió exitosamente, false si hubo timeout
   *
   * @example
   * const acquired = await downloadManager.acquireLock(5000);
   * if (acquired) {
   *   try {
   *     // Operación crítica protegida
   *     await downloadManager.processQueue();
   *   } finally {
   *     downloadManager.releaseLock();
   *   }
   * }
   */
  async acquireLock(timeoutMs = config.downloads.lockTimeout) {
    const startTime = Date.now();
    while (this.processingLock) {
      if (Date.now() - startTime > timeoutMs) {
        log.error('Timeout esperando lock de procesamiento');
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, config.downloads.lockCheckInterval));
    }
    this.processingLock = true;
    return true;
  }

  /**
   * Libera el lock adquirido anteriormente
   *
   * Debe llamarse siempre después de acquireLock() para permitir que otras
   * operaciones puedan continuar. Idealmente usar en un bloque finally.
   *
   * @returns {void}
   *
   * @example
   * await downloadManager.acquireLock();
   * try {
   *   // operación protegida
   * } finally {
   *   downloadManager.releaseLock(); // Siempre liberar
   * }
   */
  releaseLock() {
    this.processingLock = false;
  }

  // =====================
  // GESTIÍ“N DE COLA
  // =====================

  /**
   * Verifica si hay slots disponibles para iniciar una nueva descarga
   *
   * Compara el número de descargas activas (simples + fragmentadas) con el
   * máximo de descargas concurrentes configurado. Usa QueueService si está
   * disponible para consistencia con la lógica de negocio.
   *
   * @returns {boolean} true si hay slots disponibles, false si se alcanzó el límite
   *
   * @example
   * if (downloadManager.canStartDownload()) {
   *   await downloadManager.startDownload({ id: 123, title: 'archivo.zip' });
   * } else {
   *   // Agregar a cola en su lugar
   *   downloadManager.addToQueue({ id: 123, title: 'archivo.zip' });
   * }
   */
  canStartDownload() {
    const totalActive = this.activeDownloads.size + this.chunkedDownloads.size;

    // Usar QueueService si está disponible
    if (this.queueService) {
      const availability = this.queueService.checkAvailability(
        totalActive,
        this.downloadQueue.length
      );
      log.debug(
        `Verificando slots: ${availability.activeCount}/${availability.maxConcurrent} (disponibles: ${availability.slotsAvailable})`
      );
      return availability.canStart;
    }

    // Fallback: método directo
    log.debug(`Verificando slots: ${totalActive}/${config.downloads.maxConcurrent}`);
    return totalActive < config.downloads.maxConcurrent;
  }

  /**
   * Verifica si una descarga está activa o en cola
   *
   * Busca el ID en descargas simples activas, descargas fragmentadas activas
   * y en la cola de descargas pendientes.
   *
   * @param {number} downloadId - ID de la descarga a verificar
   * @returns {boolean} true si la descarga está activa o en cola, false en caso contrario
   *
   * @example
   * const isActive = downloadManager.isDownloadActive(12345);
   * if (!isActive) {
   *   // Descarga nueva, se puede agregar
   *   downloadManager.addToQueue({ id: 12345, title: 'archivo.zip' });
   * }
   */
  isDownloadActive(downloadId) {
    return (
      this.activeDownloads.has(downloadId) ||
      this.chunkedDownloads.has(downloadId) ||
      this.downloadQueue.some(d => d.id === downloadId)
    );
  }

  /**
   * Agrega múltiples descargas a la cola de una sola vez (optimizado)
   * @param {Array<DownloadParams>} downloads - Lista de descargas a agregar
   * @returns {number} Número de descargas agregadas
   */
  addManyToQueue(downloads) {
    if (!Array.isArray(downloads) || downloads.length === 0) return 0;

    const now = Date.now();
    let addedCount = 0;

    for (const download of downloads) {
      if (this.isDownloadActive(download.id)) {
        continue;
      }

      const enrichedDownload = {
        ...download,
        addedAt: now,
        createdAt: now,
        retryCount: 0,
        priority: download.priority || DownloadPriority.NORMAL,
      };

      this.downloadQueue.push(enrichedDownload);
      addedCount++;
    }

    if (addedCount > 0 && this.queueService) {
      this.downloadQueue = this.queueService.sortQueue(this.downloadQueue);
    }

    if (addedCount > 0) {
      log.info(`Agregadas ${addedCount} descargas a la cola en batch`);
    }

    return addedCount;
  }

  /**
   * Agrega una descarga a la cola en memoria
   *
   * Agrega una descarga a la cola local en memoria (no persiste en SQLite).
   * La descarga se enriquece con metadatos adicionales (fecha, reintentos, prioridad)
   * y se ordena según la prioridad usando QueueService si está disponible.
   *
   * @param {DownloadParams} download - Parámetros de la descarga a agregar
   * @returns {number} Posición en la cola (1-based) o -1 si ya estaba activa/en cola
   *
   * @example
   * const position = downloadManager.addToQueue({
   *   id: 12345,
   *   title: 'archivo.zip',
   *   downloadPath: 'C:/Downloads',
   *   preserveStructure: true,
   *   priority: 'high'
   * });
   *
   * if (position > 0) {
   *   console.log(`Descarga agregada en posición ${position}`);
   * } else {
   *   console.log('Descarga ya estaba en cola');
   * }
   */
  addToQueue(download) {
    if (this.isDownloadActive(download.id)) {
      log.warn(`Descarga ${download.id} ya está activa o en cola`);
      return -1;
    }

    const enrichedDownload = {
      ...download,
      addedAt: Date.now(),
      createdAt: Date.now(), // Para ordenamiento por fecha
      retryCount: 0,
      priority: download.priority || DownloadPriority.NORMAL,
    };

    // Agregar a la cola
    this.downloadQueue.push(enrichedDownload);

    // Ordenar cola usando QueueService si está disponible
    if (this.queueService) {
      this.downloadQueue = this.queueService.sortQueue(this.downloadQueue);
    }

    // Calcular posición final después de ordenar
    const position = this.downloadQueue.findIndex(d => d.id === download.id) + 1;

    log.info(`Descarga agregada a cola: ${download.title} (posición ${position})`);
    return position;
  }

  // =============================
  // GESTIÓN DE COLA
  // =============================

  /**
   * Pausa el procesamiento de la cola
   * Evita que se inicien nuevas descargas
   */
  pauseQueue() {
    this.processing = true; // Bloquea el inicio de nuevas descargas
    log.info('Procesamiento de cola pausado (Shutdown)');
  }

  /**
   * Reanuda el procesamiento de la cola
   */
  resumeQueue() {
    this.processing = false;
    log.info('Procesamiento de cola reanudado');
  }

  /**
   * Agrega una descarga a la cola y persiste en SQLite
   *
   * Similar a addToQueue() pero también persiste la descarga en la base de datos
   * SQLite para que sobreviva a reinicios de la aplicación. Normaliza el downloadPath
   * (convierte strings vacíos a null) antes de persistir.
   *
   * @param {DownloadParams} download - Parámetros de la descarga a agregar
   * @returns {number} Posición en la cola (1-based) o -1 si ya estaba activa/en cola
   *
   * @example
   * // Descarga que se guardará en base de datos
   * const position = downloadManager.addToQueueWithPersist({
   *   id: 12345,
   *   title: 'archivo.zip',
   *   downloadPath: 'C:/Downloads',
   *   preserveStructure: true,
   *   priority: 'high'
   * });
   *
   * // Si la app se cierra, la descarga seguirá en la base de datos
   * // y se restaurará al reiniciar con loadQueue()
   */
  addToQueueWithPersist(download) {
    // Normalizar downloadPath: convertir strings vacíos a null para evitar problemas
    const normalizedDownloadPath =
      download.downloadPath && typeof download.downloadPath === 'string'
        ? download.downloadPath.trim() || null
        : null;

    // Primero agregar a SQLite
    queueDatabase.addDownload({
      id: download.id,
      title: download.title,
      downloadPath: normalizedDownloadPath, // Normalizado: null si está vacío
      preserveStructure: download.preserveStructure,
      forceOverwrite: download.forceOverwrite,
      priority: download.priority || DownloadPriority.NORMAL,
      metadata: download.metadata || {},
    });

    // Actualizar download con la ruta normalizada antes de agregar a la cola en memoria
    const normalizedDownload = {
      ...download,
      downloadPath: normalizedDownloadPath,
    };

    // Luego a la cola en memoria
    const position = this.addToQueue(normalizedDownload);
    return position;
  }

  /**
   * Remueve una descarga de la cola
   */
  removeFromQueue(downloadId) {
    const initialLength = this.downloadQueue.length;
    this.downloadQueue = this.downloadQueue.filter(d => d.id !== downloadId);
    const removed = this.downloadQueue.length < initialLength;

    if (removed) {
      log.info(`Descarga ${downloadId} removida de la cola`);
    }

    return removed;
  }

  /**
   * Remueve de la cola y persiste
   */
  removeFromQueueWithPersist(downloadId) {
    const removed = this.removeFromQueue(downloadId);
    if (removed) {
      queueDatabase.deleteDownload(downloadId);
    }
    return removed;
  }

  // =============================
  // GESTIÍ“N DE DESCARGAS ACTIVAS
  // =============================

  getActiveDownload(id) {
    // Verificar tanto descargas simples como fragmentadas
    return this.activeDownloads.get(id) || this.chunkedDownloads.get(id);
  }

  setActiveDownload(id, data) {
    if (this.activeDownloads.has(id) || this.chunkedDownloads.has(id)) {
      log.debug(`Actualizando descarga existente: ${id}`);
    } else {
      log.debug(`Nueva descarga activa: ${id}`);
    }

    this.activeDownloads.set(id, {
      ...data,
      lastUpdate: Date.now(),
    });
  }

  deleteActiveDownload(id) {
    // Eliminar de ambos maps
    const hadSimple = this.activeDownloads.delete(id);
    const hadChunked = this.chunkedDownloads.delete(id);

    const deleted = hadSimple || hadChunked;

    if (deleted) {
      log.info(`Descarga activa eliminada: ${id} (simple: ${hadSimple}, chunked: ${hadChunked})`);
    }

    return deleted;
  }

  hasActiveDownload(id) {
    return this.activeDownloads.has(id) || this.chunkedDownloads.has(id);
  }

  // =====================
  // PROCESAMIENTO DE COLA
  // =====================

  /**
   * Procesa la cola de descargas pendientes
   *
   * Inicia descargas según slots disponibles, respetando el límite de descargas
   * concurrentes. Usa QueueService si está disponible para ordenamiento por prioridad,
   * selección inteligente de descargas y estadísticas. Procesa descargas hasta que no
   * haya más slots disponibles o la cola esté vacía.
   *
   * @returns {Promise<void>}
   *
   * @example
   * // Agregar varias descargas a la cola
   * downloadManager.addToQueue({ id: 1, title: 'archivo1.zip', priority: 'high' });
   * downloadManager.addToQueue({ id: 2, title: 'archivo2.zip', priority: 'normal' });
   * downloadManager.addToQueue({ id: 3, title: 'archivo3.zip', priority: 'low' });
   *
   * // Procesar la cola (iniciará hasta maxConcurrent descargas)
   * await downloadManager.processQueue();
   * // Las descargas de mayor prioridad se iniciarán primero
   */
  async processQueue() {
    // CRÍTICO: Doble verificación para prevenir race conditions
    if (this.processing) {
      log.debug('Ya hay un proceso de cola en ejecución, ignorando llamada duplicada');
      return;
    }

    // Adquirir lock con timeout
    const lockAcquired = await this.acquireLock(5000);
    if (!lockAcquired) {
      log.warn('[DownloadManager] No se pudo adquirir lock, reintentando más tarde');
      // Reintentar después de un delay
      setTimeout(() => this.processQueue(), 100);
      return;
    }

    // Verificar nuevamente si ya se está procesando (doble verificación)
    if (this.processing) {
      this.releaseLock();
      log.debug('[DownloadManager] Ya se está procesando la cola, ignorando llamada duplicada');
      return;
    }

    this.processing = true;

    try {
      // Calcular estadísticas usando QueueService si está disponible
      let totalActive = this.activeDownloads.size + this.chunkedDownloads.size;
      let queueStats = null;

      if (this.queueService) {
        queueStats = this.queueService.calculateQueueStats(this.downloadQueue, totalActive);
        log.debug(`=== PROCESANDO COLA ===`);
        log.debug(`En cola: ${queueStats.total}`);
        log.debug(`Activos: ${queueStats.active}`);
        log.debug(`Slots disponibles: ${queueStats.slotsAvailable}`);
        log.debug(`Max concurrent: ${queueStats.maxConcurrent}`);
        log.debug(`Por prioridad:`, queueStats.byPriority);
      } else {
        log.debug(`=== PROCESANDO COLA ===`);
        log.debug(`En cola: ${this.downloadQueue.length}`);
        log.debug(`Activos (simple): ${this.activeDownloads.size}`);
        log.debug(`Activos (chunked): ${this.chunkedDownloads.size}`);
        log.debug(`Max concurrent: ${config.downloads.maxConcurrent}`);
      }

      const startTime = Date.now();
      let processedCount = 0;

      // Ordenar cola usando QueueService si está disponible
      if (this.queueService && this.downloadQueue.length > 0) {
        this.downloadQueue = this.queueService.sortQueue(this.downloadQueue);
      }

      // Procesar descargas mientras haya slots disponibles
      while (this.downloadQueue.length > 0) {
        // Timeout de seguridad
        if (Date.now() - startTime > config.downloads.queueProcessingTimeout) {
          log.warn(`Timeout procesando cola (${config.downloads.queueProcessingTimeout}ms)`);
          break;
        }

        // Recalcular totalActive en cada iteración (puede cambiar mientras se procesan descargas)
        totalActive = this.activeDownloads.size + this.chunkedDownloads.size;

        // Verificar disponibilidad usando QueueService si está disponible
        let canStart = false;
        if (this.queueService) {
          const availability = this.queueService.checkAvailability(
            totalActive,
            this.downloadQueue.length
          );
          canStart = availability.canStart;

          if (!canStart) {
            // No hay slots disponibles, salir del loop
            log.debug(
              `No hay slots disponibles (${availability.slotsAvailable} slots, ${availability.activeCount} activas)`
            );
            break;
          }
        } else {
          // Fallback: usar método directo
          canStart = this.canStartDownload();
          if (!canStart) {
            break;
          }
        }

        // Seleccionar descargas a iniciar usando QueueService si está disponible
        // selectDownloadsToStart ya ordena la cola internamente, así que no necesitamos ordenar de nuevo
        let downloadsToStart = [];
        if (this.queueService) {
          downloadsToStart = this.queueService.selectDownloadsToStart(
            this.downloadQueue,
            totalActive
          );
        } else {
          // Fallback: tomar la primera de la cola
          if (this.downloadQueue.length > 0) {
            downloadsToStart = [this.downloadQueue[0]];
          }
        }

        // Si no hay descargas seleccionadas, salir
        if (downloadsToStart.length === 0) {
          break;
        }

        // Procesar cada descarga seleccionada
        for (const nextDownload of downloadsToStart) {
          // CRÍTICO: Verificar que no esté activa ANTES de remover de cola (doble verificación)
          if (this.activeDownloads.has(nextDownload.id) || this.chunkedDownloads.has(nextDownload.id)) {
            log.warn(`[DownloadManager] Descarga ${nextDownload.id} ya está activa, omitiendo`);
            // Remover de cola de todas formas para evitar loops infinitos
            const index = this.downloadQueue.findIndex(d => d.id === nextDownload.id);
            if (index !== -1) {
              this.downloadQueue.splice(index, 1);
            }
            continue;
          }

          // Remover de la cola ANTES de iniciar (previene duplicados)
          const index = this.downloadQueue.findIndex(d => d.id === nextDownload.id);
          if (index !== -1) {
            this.downloadQueue.splice(index, 1);
          } else {
            // Ya fue removida, continuar con la siguiente
            log.warn(`[DownloadManager] Descarga ${nextDownload.id} ya no está en cola, omitiendo`);
            continue;
          }

          // La verificación ya se hizo arriba, continuar con inicio

          // Reservar slot temporalmente
          this.setActiveDownload(nextDownload.id, {
            id: nextDownload.id,
            title: nextDownload.title,
            state: 'reserved',
            startTime: Date.now(),
            request: null,
            response: null,
            fileStream: null,
            savePath: null,
          });

          log.info(
            `Iniciando descarga desde cola: ${nextDownload.title} (prioridad: ${nextDownload.priority || DownloadPriority.NORMAL})`
          );
          processedCount++;

          // Iniciar descarga (async, no bloqueante)
          // Pasar savePath si está disponible para evitar pedir nueva ubicación
          this.startDownload({
            id: nextDownload.id,
            title: nextDownload.title,
            downloadPath: nextDownload.downloadPath,
            preserveStructure: nextDownload.preserveStructure,
            forceOverwrite: nextDownload.forceOverwrite,
            savePath: nextDownload.savePath || null,
            priority: nextDownload.priority,
          }).catch(error => {
            this._handleDownloadError(nextDownload, error);
          });
        }
      }

      // Log final con estadísticas si están disponibles
      if (queueStats) {
        log.debug(`=== FIN PROCESAMIENTO ===`);
        log.debug(`Procesadas: ${processedCount}`);
        log.debug(`Restantes: ${this.downloadQueue.length}`);
        log.debug(`Activos: ${this.activeDownloads.size + this.chunkedDownloads.size}`);
        log.debug(`Slots disponibles: ${queueStats.slotsAvailable - processedCount}`);

        // Mostrar estimación de tiempo de cola si hay descargas restantes
        if (this.downloadQueue.length > 0 && this.queueService) {
          const activeSpeeds = this.getActiveDownloadsSpeed();
          const averageSpeedBytesPerSec = this.queueService.calculateAverageSpeed(activeSpeeds);
          const timeEstimate = this.queueService.estimateQueueTime(
            this.downloadQueue,
            totalActive,
            averageSpeedBytesPerSec
          );

          if (
            timeEstimate.totalEstimatedSeconds !== null &&
            timeEstimate.totalEstimatedSeconds > 0
          ) {
            const hours = Math.floor(timeEstimate.totalEstimatedHours);
            const minutes = Math.floor(timeEstimate.totalEstimatedMinutes % 60);
            const seconds = Math.floor(timeEstimate.totalEstimatedSeconds % 60);

            if (hours > 0) {
              log.debug(`Tiempo estimado de cola: ~${hours}h ${minutes}m`);
            } else if (minutes > 0) {
              log.debug(`Tiempo estimado de cola: ~${minutes}m ${seconds}s`);
            } else {
              log.debug(`Tiempo estimado de cola: ~${seconds}s`);
            }
          }
        }
      } else {
        log.debug(`=== FIN PROCESAMIENTO ===`);
        log.debug(`Procesadas: ${processedCount}`);
        log.debug(`Restantes: ${this.downloadQueue.length}`);
      }
    } catch (error) {
      log.error('Error procesando cola:', error);
    } finally {
      this.processing = false;
      this.releaseLock();
    }
  }

  /**
   * Maneja errores de descarga con reintentos usando SQLite
   */
  /**
   * Maneja errores ocurridos durante una descarga simple
   * 
   * Actualiza el estado de la descarga en la base de datos, realiza limpieza
   * de recursos y decide si se debe reintentar la descarga según la configuración.
   * 
   * @private
   * @param {Object} download - Objeto con información de la descarga
   * @param {Error} error - Error que ocurrió durante la descarga
   * @returns {void}
   */
  _handleDownloadError(download, error) {
    log.error(`Error en descarga (${download.title}):`, error.message);

    this.deleteActiveDownload(download.id);

    // Usar SQLite para manejar reintentos
    // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
    queueDatabase.flushProgress();
    
    queueDatabase.failDownload(download.id, error.message);

    // Verificar si se va a reintentar
    const dbDownload = queueDatabase.getById(download.id);

    if (dbDownload && dbDownload.state === DownloadState.QUEUED) {
      // Se va a reintentar - agregar de vuelta a la cola en memoria
      log.info(
        `Reintentando ${download.title} (${dbDownload.retryCount}/${dbDownload.maxRetries})`
      );

      setTimeout(
        () => {
          download.retryCount = dbDownload.retryCount;
          this.downloadQueue.unshift(download);
          this.processQueue();
        },
        this.retryDelay * (dbDownload.retryCount || 1)
      );
    } else {
      // Falló definitivamente
      log.error(`Descarga ${download.title} falló después de múltiples intentos`);

      this._sendProgress({
        id: download.id,
        state: 'interrupted',
        error: 'Error después de múltiples reintentos',
      });
    }

    setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
  }

  // =====================
  // INICIO DE DESCARGA
  // =====================

  /**
   * Inicia una descarga
   *
   * Decide automáticamente si usar descarga simple o fragmentada basándose en:
   * - Tamaño del archivo (si supera el threshold configurado)
   * - Soporte de Range requests del servidor
   * - Configuración de descargas fragmentadas
   *
   * Obtiene información del archivo desde la base de datos, valida la URL,
   * determina la ruta de guardado (o solicita al usuario si no está configurada),
   * verifica archivos existentes y decide la estrategia de descarga.
   *
   * @param {Object} params - Parámetros de descarga
   * @param {number} params.id - ID único de la descarga (desde base de datos)
   * @param {string} params.title - Nombre del archivo
   * @param {string} [params.downloadPath] - Ruta base de descarga (se pedirá si no está)
   * @param {boolean} [params.preserveStructure=true] - Si mantener estructura de carpetas
   * @param {boolean} [params.forceOverwrite=false] - Si sobrescribir sin preguntar
   * @param {string} [params.savePath] - Ruta completa de guardado (si se proporciona, se usa directamente)
   * @returns {Promise<void>}
   *
   * @example
   * // Iniciar descarga con ruta configurada
   * await downloadManager.startDownload({
   *   id: 12345,
   *   title: 'archivo.zip',
   *   downloadPath: 'C:/Downloads',
   *   preserveStructure: true,
   *   forceOverwrite: false
   * });
   *
   * // Iniciar descarga reanudando desde archivo parcial existente
   * await downloadManager.startDownload({
   *   id: 12345,
   *   title: 'archivo.zip',
   *   downloadPath: 'C:/Downloads',
   *   savePath: 'C:/Downloads/archivo.zip.part' // Se detectará y reanudará
   * });
   */
  async startDownload({
    id,
    title,
    downloadPath,
    preserveStructure,
    forceOverwrite,
    savePath: providedSavePath,
  }) {
    if (!id || !title) {
      log.error('startDownload: Parámetros inválidos', { id, title });
      return;
    }

    // Normalizar downloadPath: tratar null, undefined, o string vacío como "sin ruta configurada"
    // Esto asegura consistencia incluso si se llama desde otros lugares
    const normalizedDownloadPath =
      downloadPath && typeof downloadPath === 'string' ? downloadPath.trim() || null : null;

    // Verificar que los servicios estén disponibles
    if (!this.downloadService) {
      log.warn(
        '[DownloadManager] DownloadService no está disponible en startDownload, intentando inicializar...'
      );
      // Intentar obtener el servicio nuevamente
      this.downloadService = serviceManager.getDownloadService();
      if (!this.downloadService) {
        log.error('[DownloadManager] DownloadService no disponible después de intentar obtenerlo');
      } else {
        log.info('[DownloadManager] DownloadService obtenido exitosamente');
      }
    }

    // Verificar duplicados
    const existingDownload = this.getActiveDownload(id);
    if (existingDownload && existingDownload.state !== 'reserved') {
      log.warn(`Descarga ${id} ya está activa (estado: ${existingDownload.state})`);
      return;
    }

    // Marcar como inicializando en memoria
    this.setActiveDownload(id, {
      id,
      title,
      state: 'initializing',
      startTime: existingDownload?.startTime || Date.now(),
      request: null,
      response: null,
      fileStream: null,
      savePath: null,
    });

    try {
      // Obtener información del archivo
      const fileInfo = database.getFileDownloadInfo(id);
      if (!fileInfo) {
        throw new Error('Archivo no encontrado en la base de datos');
      }

      // Construir URL
      let downloadUrl = fileInfo.url;
      if (!downloadUrl.startsWith('http')) {
        const urlParts = downloadUrl.split('/').map(part => encodeURIComponent(part));
        downloadUrl = `https://myrient.erista.me/files/${urlParts.join('/')}`;
      }

      // Validar URL usando servicio
      if (!isValidUrl(downloadUrl)) {
        throw new Error('URL de descarga inválida');
      }

      // Obtener tamaño esperado
      const expectedFileSize = await this._getFileSize(downloadUrl);
      log.info('Tamaño esperado:', expectedFileSize, 'bytes');

      // Determinar ruta de guardado usando FileService
      // Si se proporciona un savePath (por ejemplo, al reanudar), usarlo directamente
      let savePath = providedSavePath;

      if (!savePath) {
        // Si no hay savePath proporcionado, intentar obtenerlo de la base de datos
        const dbDownload = queueDatabase.getById(id);
        if (dbDownload && dbDownload.savePath) {
          savePath = dbDownload.savePath;
          log.info(`Usando savePath guardado: ${savePath}`);
        } else {
          // Si no hay savePath guardado, determinar uno nuevo usando FileService
          // Usar normalizedDownloadPath que ya fue normalizado al inicio
          savePath = await this._determineSavePath({
            id,
            title,
            downloadPath: normalizedDownloadPath,
            preserveStructure,
          });
        }
      }

      if (!savePath) {
        this.deleteActiveDownload(id);
        this._sendProgress({ id, state: 'cancelled', error: 'No se seleccionó ubicación' });
        setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
        return;
      }

      // CRÍTICO: Validar espacio disponible en disco antes de iniciar descarga
      if (expectedFileSize > 0) {
        const spaceCheck = validateDiskSpace(savePath, expectedFileSize);
        if (!spaceCheck.valid) {
          log.error(`Espacio insuficiente para descarga ${id}:`, spaceCheck.error);
          this.deleteActiveDownload(id);
          // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
          queueDatabase.flushProgress();
          queueDatabase.failDownload(id, spaceCheck.error);
          this._sendProgress({
            id,
            state: 'interrupted',
            error: spaceCheck.error,
            savePath,
          });
          setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
          return;
        }
        if (spaceCheck.warning) {
          log.warn(`No se pudo verificar espacio en disco para descarga ${id}, continuando con precaución`);
        } else {
          log.debug(
            `Espacio disponible verificado para descarga ${id}: ${(spaceCheck.available / 1024 / 1024).toFixed(2)} MB`
          );
        }
      }

      // Verificar archivo existente usando FileService
      // Para descargas fragmentadas, verificar si ya existe el archivo final completo
      if (!forceOverwrite && expectedFileSize > 0) {
        let fileCheck;

        // Usar FileService para verificar archivo existente si está disponible
        if (this.fileService) {
          fileCheck = await this.fileService.getFileCheckInfo(savePath, expectedFileSize);
        } else {
          // Fallback: usar método legacy síncrono
          log.warn(
            '[DownloadManager] FileService no disponible, usando método legacy para verificar archivo'
          );
          fileCheck = this._checkExistingFile(savePath, expectedFileSize);
        }

        // También verificar si hay un archivo parcial que podría ser confundido
        const partialFilePath = savePath + '.part';
        const hasPartialFile = fs.existsSync(partialFilePath);

        // Solo pedir confirmación si:
        // 1. El archivo final existe Y tiene tamaño similar (o shouldOverwrite es true)
        // 2. NO hay archivo parcial (para evitar confusión)
        const shouldConfirm =
          fileCheck.exists &&
          (fileCheck.shouldOverwrite || fileCheck.similarSize) &&
          !hasPartialFile;

        if (shouldConfirm) {
          log.info('Solicitando confirmación para:', title);
          this.deleteActiveDownload(id);

          // Actualizar estado en la base de datos a 'awaiting'
          queueDatabase.setState(id, 'awaiting');

          this._sendProgress({
            id,
            title,
            state: 'awaiting-confirmation',
            savePath,
            fileCheck: {
              exists: fileCheck.exists,
              existingSize: fileCheck.actualSize || fileCheck.existingSize,
              expectedSize: fileCheck.expectedSize || expectedFileSize,
              sizeDifference: fileCheck.sizeDifference || 0,
              similarSize:
                fileCheck.similarSize !== undefined
                  ? fileCheck.similarSize
                  : fileCheck.sizeDifference <= config.files?.sizeMarginBytes,
              hasPartialFile: hasPartialFile,
            },
          });
          return;
        }

        // Si hay archivo parcial pero el archivo final no existe o es diferente,
        // continuar normalmente (el archivo parcial se usará para reanudación)
        if (fileCheck.exists && !fileCheck.similarSize && !fileCheck.shouldOverwrite) {
          log.info(
            `Archivo existente tiene tamaño diferente (${fileCheck.actualSize || fileCheck.existingSize} vs ${expectedFileSize}), continuando con descarga`
          );
        }
      }

      // Preparar directorio usando FileService con fallback robusto
      let prepared;
      try {
        if (this.fileService) {
          prepared = await this.fileService.prepareDirectory(path.dirname(savePath));
        } else {
          log.warn(
            '[DownloadManager] FileService no disponible, usando método legacy para preparar directorio'
          );
          prepared = this._prepareDirectory(savePath);
        }
      } catch (error) {
        log.error('[DownloadManager] Error preparando directorio con FileService:', error);
        // Intentar con método legacy como último recurso
        try {
          log.warn('[DownloadManager] Intentando con método legacy como fallback');
          prepared = this._prepareDirectory(savePath);
        } catch (legacyError) {
          log.error('[DownloadManager] Error crítico con método legacy:', legacyError);
          throw new Error(`Error crítico preparando directorio: ${legacyError.message}`);
        }
      }

      if (!prepared || !prepared.success) {
        const errorMsg = prepared?.error || 'Error desconocido al preparar directorio';
        throw new Error(errorMsg);
      }

      // =====================================
      // DECISIÍ"N: Simple vs Fragmentada usando DownloadService
      // =====================================
      let useChunked = false;

      if (!this.downloadService) {
        log.warn('[DownloadManager] DownloadService no está disponible, usando descarga simple');
      } else {
        try {
          log.info(
            `[DownloadManager] Llamando shouldUseChunkedDownload: url=${!!downloadUrl}, size=${this._formatBytes(expectedFileSize)}`
          );
          useChunked = await this.downloadService.shouldUseChunkedDownload(
            downloadUrl,
            expectedFileSize
          );
          log.info(`[DownloadManager] Resultado de shouldUseChunkedDownload: ${useChunked}`);
        } catch (error) {
          log.error('[DownloadManager] Error al llamar shouldUseChunkedDownload:', error);
          useChunked = false;
        }
      }

      // Si DownloadService dice que debe usarse chunked, verificar soporte de Range requests
      if (useChunked) {
        const chunkedConfig = this.chunkedConfig;
        if (chunkedConfig.checkRangeSupport !== false) {
          log.info(`[DownloadManager] Verificando soporte de Range requests para: ${title}`);
          try {
            const rangeCheck = await ChunkedDownloader.checkRangeSupport(downloadUrl);

            if (!rangeCheck.supported) {
              log.warn(
                `[DownloadManager] Servidor no soporta Range requests, usando descarga simple`
              );
              log.info(`[DownloadManager] Range check result:`, rangeCheck);
              useChunked = false;
            } else {
              log.info(`[DownloadManager] Servidor soporta Range requests ✓`);
            }
          } catch (error) {
            log.warn(
              `[DownloadManager] Error verificando Range support, usando descarga simple:`,
              error.message
            );
            useChunked = false;
          }
        }
      }

      if (useChunked) {
        log.info(
          `[DownloadManager] Usando descarga FRAGMENTADA para ${title} (${this._formatBytes(expectedFileSize)})`
        );
        await this._executeChunkedDownload({
          id,
          title,
          downloadUrl,
          savePath,
          expectedFileSize,
          forceOverwrite,
        });
      } else {
        log.info(
          `[DownloadManager] Usando descarga SIMPLE para ${title} (${this._formatBytes(expectedFileSize)})`
        );
        await this._executeDownload({
          id,
          title,
          downloadUrl,
          savePath,
          expectedFileSize,
          forceOverwrite,
        });
      }
    } catch (error) {
      log.error('Error al iniciar descarga:', error);
      this.deleteActiveDownload(id);

      // Usar DownloadService para obtener mensaje de error
      const errorMessage = this.downloadService
        ? this.downloadService.getDownloadErrorMessage(error)
        : getNetworkErrorMessage(error);

      this._sendProgress({
        id,
        state: 'interrupted',
        error: errorMessage,
      });
      setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
    }
  }

  /**
   * Ejecuta una descarga fragmentada usando ChunkedDownloader
   *
   * @private
   * @param {Object} params - Parámetros de descarga fragmentada
   * @param {number} params.id - ID de la descarga
   * @param {string} params.title - Título del archivo
   * @param {string} params.downloadUrl - URL completa de descarga
   * @param {string} params.savePath - Ruta donde guardar el archivo
   * @param {number} params.expectedFileSize - Tamaño esperado en bytes
   * @param {boolean} params.forceOverwrite - Si sobrescribir archivo existente
   * @returns {Promise<void>}
   *
   * @example
   * await this._executeChunkedDownload({
   *   id: 12345,
   *   title: 'archivo.zip',
   *   downloadUrl: 'https://myrient.erista.me/files/archivo.zip',
   *   savePath: 'C:/Downloads/archivo.zip',
   *   expectedFileSize: 100000000, // 100 MB
   *   forceOverwrite: false
   * });
   */
  async _executeChunkedDownload({
    id,
    title,
    downloadUrl,
    savePath,
    expectedFileSize,
    forceOverwrite,
  }) {
    // Eliminar de descargas simples si estaba ahí
    this.activeDownloads.delete(id);

    // Registrar inicio en SQLite
    queueDatabase.startDownload(id, {
      url: downloadUrl,
      savePath,
      totalBytes: expectedFileSize,
      downloadedBytes: 0,
      isChunked: true,
    });

    // Crear instancia de ChunkedDownloader
    const chunked = new ChunkedDownloader({
      downloadId: id,
      url: downloadUrl,
      savePath,
      totalBytes: expectedFileSize,
      title,
      onProgress: info => this._onChunkedProgress(info),
      onComplete: info => this._onChunkedComplete(info),
      onError: (downloader, error) => this._onChunkedError(downloader, error),
      bandwidthManager: this.bandwidthManager, // Pasar BandwidthManager
    });

    // Guardar referencia
    this.chunkedDownloads.set(id, chunked);

    // Notificar inicio
    this._sendProgress({
      id,
      state: 'starting',
      title,
      chunked: true,
      numChunks: chunked.numChunks,
    });

    // Iniciar descarga
    await chunked.start();
  }

  /**
   * Callback de progreso para descargas fragmentadas
   */
  /**
   * Callback que se ejecuta cuando una descarga fragmentada reporta progreso
   * 
   * Actualiza la información de progreso de la descarga fragmentada y la envía
   * al frontend a través del sistema de throttling.
   * 
   * @private
   * @param {Object} info - Información de progreso de la descarga fragmentada
   * @param {number} info.downloadId - ID de la descarga
   * @param {number} info.percent - Porcentaje completado (0-1)
   * @param {number} info.downloadedBytes - Bytes descargados
   * @param {number} info.totalBytes - Tamaño total en bytes
   * @param {number} info.speed - Velocidad en MB/s
   * @param {number} [info.remainingTime] - Tiempo restante estimado en segundos
   * @param {Array<Object>} [info.chunkProgress] - Progreso individual de cada chunk
   * @returns {void}
   */
  _onChunkedProgress(info) {
    // Actualizar última actividad
    const chunked = this.chunkedDownloads.get(info.downloadId);
    if (chunked) {
      chunked.lastUpdate = Date.now();
    }

    // Preparar información de progreso
    // remainingTime ya viene calculado desde ChunkedDownloader en segundos
    // Si no viene, calcularlo como fallback
    const remainingTime =
      info.remainingTime !== undefined && info.remainingTime !== null
        ? info.remainingTime
        : info.speed > 0 && info.totalBytes && info.downloadedBytes
          ? (info.totalBytes - info.downloadedBytes) / (info.speed * 1024 * 1024)
          : 0;

    const progressInfo = {
      id: info.downloadId,
      state: info.state || 'progressing',
      percent: info.percent,
      speed: info.speed,
      totalBytes: info.totalBytes,
      downloadedBytes: info.downloadedBytes,
      remainingTime: remainingTime,
      chunked: true,
      activeChunks: info.activeChunks,
      completedChunks: info.completedChunks,
      totalChunks: info.totalChunks,
      chunkProgress: info.chunkProgress,
    };

    // IMPORTANTE: Si hay un chunk que se acaba de completar (completado > 0 y chunkProgress muestra un chunk al 100%),
    // enviar actualización inmediata para asegurar que el frontend vea el progreso actualizado
    const hasJustCompletedChunk =
      info.chunkProgress &&
      info.chunkProgress.some(chunk => chunk.state === 'completed' && chunk.progress >= 0.99);

    // CRÍTICO: Siempre enviar actualizaciones de progreso al frontend durante descargas activas
    // El ProgressThrottler manejará el throttling apropiado para evitar saturar el IPC
    if (this.progressThrottler) {
      if (hasJustCompletedChunk || info.forceImmediate) {
        // Enviar inmediatamente si hay un chunk recién completado o si se solicita explícitamente
        this.progressThrottler.sendImmediate(progressInfo);
      } else {
        // Usar throttle normal para actualizaciones de progreso durante la descarga
        // Esto programa el envío con un delay mínimo para evitar saturar el IPC
        this.progressThrottler.queueUpdate(progressInfo);
      }
    } else {
      // Fallback: si progressThrottler no está disponible, enviar directamente
      // Esto no debería pasar, pero es mejor tener un fallback que no enviar nada
      log.warn(`ProgressThrottler no disponible para descarga ${info.downloadId}, enviando directamente`);
      this._sendProgress(progressInfo);
    }
  }

  /**
   * Callback de completado para descargas fragmentadas
   */
  _onChunkedComplete(info) {
    log.info('Descarga fragmentada completada', {
      downloadId: info.downloadId,
      savePath: info.savePath,
      totalBytes: info.totalBytes,
      duration: info.duration,
      timestamp: Date.now(),
    });

    // Marcar como completada en SQLite
    // CRÍTICO: Flush progreso pendiente antes de completar
    queueDatabase.flushProgress();
    
    queueDatabase.completeDownload(info.downloadId, {
      savePath: info.savePath,
      duration: info.duration,
    });

    // Eliminar de activas
    this.chunkedDownloads.delete(info.downloadId);

    // Cancelar actualizaciones pendientes
    if (this.progressThrottler) {
      this.progressThrottler.cancelPending(info.downloadId);
    }

    // Notificar completado
    this._sendProgress({
      id: info.downloadId,
      state: 'completed',
      savePath: info.savePath,
      percent: 1,
      chunked: true,
    });

    // Procesar siguiente en cola
    setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
  }

  /**
   * Callback de error para descargas fragmentadas
   */
  /**
   * Callback que se ejecuta cuando una descarga fragmentada falla
   * 
   * Actualiza el estado de la descarga en la base de datos, realiza limpieza
   * de recursos y decide si se debe reintentar según la configuración de reintentos.
   * 
   * @private
   * @param {ChunkedDownloader} downloader - Instancia del descargador fragmentado que falló
   * @param {Error} error - Error que causó la falla de la descarga
   * @returns {void}
   */
  _onChunkedError(downloader, error) {
    log.error(`Error en descarga fragmentada ${downloader.downloadId}:`, error.message);

    // Marcar como fallida en SQLite
      // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
      queueDatabase.flushProgress();
      
      queueDatabase.failDownload(downloader.downloadId, error.message);

    // Verificar si se va a reintentar
    const dbDownload = queueDatabase.getById(downloader.downloadId);

    if (dbDownload && dbDownload.state === DownloadState.QUEUED) {
      // Se va a reintentar
      log.info(`Reintentando descarga fragmentada ${downloader.title}`);

      setTimeout(
        () => {
          // Agregar de vuelta a la cola
          this.downloadQueue.unshift({
            id: downloader.downloadId,
            title: downloader.title,
            retryCount: dbDownload.retryCount,
          });
          this.processQueue();
        },
        this.retryDelay * (dbDownload.retryCount || 1)
      );
    } else {
      // Cancelar actualizaciones pendientes
      if (this.progressThrottler) {
        this.progressThrottler.cancelPending(downloader.downloadId);
      }

      // Notificar error
      this._sendProgress({
        id: downloader.downloadId,
        state: 'interrupted',
        error: error.message,
        chunked: true,
      });
    }

    // Eliminar de activas
    this.chunkedDownloads.delete(downloader.downloadId);

    // Procesar siguiente
    setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
  }

  /**
   * Ejecuta la descarga HTTP simple (single stream)
   *
   * Realiza una descarga tradicional de un solo stream usando el módulo net de Electron.
   * Soporta reanudación automática si encuentra un archivo parcial (.part).
   * Registra el inicio en SQLite para persistencia.
   *
   * @private
   * @param {Object} params - Parámetros de descarga simple
   * @param {number} params.id - ID de la descarga
   * @param {string} params.title - Título del archivo
   * @param {string} params.downloadUrl - URL completa de descarga
   * @param {string} params.savePath - Ruta donde guardar el archivo
   * @param {number} params.expectedFileSize - Tamaño esperado en bytes
   * @param {boolean} params.forceOverwrite - Si sobrescribir archivo existente
   * @returns {Promise<void>}
   *
   * @example
   * await this._executeDownload({
   *   id: 12345,
   *   title: 'archivo.zip',
   *   downloadUrl: 'https://myrient.erista.me/files/archivo.zip',
   *   savePath: 'C:/Downloads/archivo.zip',
   *   expectedFileSize: 50000000, // 50 MB
   *   forceOverwrite: false
   * });
   */
  async _executeDownload({ id, title, downloadUrl, savePath, expectedFileSize, forceOverwrite }) {
    const partialFilePath = savePath + '.part';
    let resumeFromByte = 0;
    let isResuming = false;

    // Verificar si hay archivo parcial para reanudar
    try {
      if (fs.existsSync(partialFilePath)) {
        const partialStats = fs.statSync(partialFilePath);
        if (partialStats.size > 0 && partialStats.size < expectedFileSize) {
          resumeFromByte = partialStats.size;
          isResuming = true;
          log.info(`Reanudando desde byte ${resumeFromByte}`);
        }
      } else if (fs.existsSync(savePath) && !forceOverwrite) {
        const existingStats = fs.statSync(savePath);
        if (existingStats.size > 0 && existingStats.size < expectedFileSize) {
          fs.renameSync(savePath, partialFilePath);
          resumeFromByte = existingStats.size;
          isResuming = true;
          log.info(`Reanudando desde byte ${resumeFromByte} (archivo convertido a .part)`);
        }
      }
    } catch (err) {
      log.warn('Error verificando archivo para reanudación:', err.message);
    }

    // Registrar inicio de descarga en SQLite
    queueDatabase.startDownload(id, {
      url: downloadUrl,
      savePath,
      totalBytes: expectedFileSize,
      downloadedBytes: resumeFromByte,
      isChunked: false,
    });

    // Obtener circuit breaker apropiado
    const circuitBreaker = this._getHostCircuitBreaker(downloadUrl);

    // Crear request protegido por circuit breaker
    let request;

    if (circuitBreaker && config.circuitBreaker?.enabled) {
      try {
        request = await circuitBreaker.execute(
          async () => {
            return net.request(downloadUrl);
          },
          () => {
            // Fallback: si circuit está abierto, lanzar error
            throw new Error(
              'Circuit breaker abierto: demasiados errores en este host. Reintentando más tarde...'
            );
          }
        );
      } catch (error) {
        log.error(`[CircuitBreaker] Error al crear request para ${downloadUrl}:`, error.message);
        // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
        queueDatabase.flushProgress();
        queueDatabase.failDownload(id, error.message);
        this._cleanupDownload(id, savePath, false);
        this._sendProgress({
          id,
          state: 'interrupted',
          error: error.message,
          savePath,
          circuitBreakerOpen: circuitBreaker.isOpen(),
        });
        setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
        return;
      }
    } else {
      request = net.request(downloadUrl);
    }

    // CRÍTICO: Configurar timeout para prevenir requests colgadas indefinidamente
    const timeout = config.network?.timeout || config.network?.responseTimeout || 30000; // 30 segundos default
    let timeoutId = null;

    const clearRequestTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    // Configurar timeout para recibir respuesta
    timeoutId = setTimeout(() => {
      if (request && !request.destroyed) {
        log.warn(`Descarga ${id}: timeout después de ${timeout}ms (no se recibió respuesta)`);
        try {
          request.abort();
        } catch (e) {
          log.debug(`Error abortando request con timeout: ${e.message}`);
        }
        // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
        queueDatabase.flushProgress();
        queueDatabase.failDownload(id, `Timeout: no se recibió respuesta del servidor en ${timeout}ms`);
        this._cleanupDownload(id, savePath, false);
        this._sendProgress({
          id,
          state: 'interrupted',
          error: `Timeout: no se recibió respuesta del servidor en ${timeout}ms`,
          savePath,
        });
        this.processQueue();
      }
    }, timeout);

    this.setActiveDownload(id, {
      request,
      response: null,
      fileStream: null,
      savePath,
      partialFilePath,
      startTime: Date.now(),
      state: 'downloading',
      resumeFromByte,
      isResuming,
      percent: 0,
      timeoutId, // Guardar timeoutId para limpiarlo si se cancela
    });

    // Headers
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    request.setHeader('Referer', 'https://myrient.erista.me/');
    request.setHeader('Accept', '*/*');
    request.setHeader('Connection', 'keep-alive');

    if (isResuming && resumeFromByte > 0) {
      request.setHeader('Range', `bytes=${resumeFromByte}-`);
    }

    // Notificar inicio
    log.info('Iniciando descarga simple', {
      downloadId: id,
      title,
      url: downloadUrl,
      savePath,
      expectedFileSize,
      resuming: isResuming,
      resumeFromByte,
      timestamp: Date.now(),
    });

    this._sendProgress({
      id,
      state: 'starting',
      title,
      resuming: isResuming,
      resumeFromByte,
      chunked: false,
    });

    // Manejar respuesta
    request.on('response', response => {
      clearRequestTimeout();
      this._handleResponse({
        id,
        response,
        request,
        savePath,
        partialFilePath,
        expectedFileSize,
        resumeFromByte,
        isResuming,
      });
    });

    request.on('error', error => {
      clearRequestTimeout();
      log.error('Error en request:', error);
      // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
      queueDatabase.flushProgress();
      // Registrar error en SQLite
      queueDatabase.failDownload(id, error.message);
      this._cleanupDownload(id, savePath, false);
      this._sendProgress({ id, state: 'interrupted', error: error.message, savePath });
      this.processQueue();
    });

    request.end();
  }

  /**
   * Maneja la respuesta HTTP para descargas simples
   * FIX MEMORY LEAK: Todos los handlers son funciones nombradas
   */
  _handleResponse({
    id,
    response,
    request,
    savePath,
    partialFilePath,
    expectedFileSize,
    resumeFromByte,
    isResuming,
  }) {
    const download = this.getActiveDownload(id);
    if (download) {
      download.response = response;
      this.setActiveDownload(id, download);
    }

    // Verificar redirecciones
    if (response.statusCode >= 300 && response.statusCode < 400) {
      log.info('Redirección detectada, no soportada');
      request.abort();
      this._cleanupDownload(id, savePath, false);
      // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
      queueDatabase.flushProgress();
      queueDatabase.failDownload(id, 'Redirección no soportada');
      this._sendProgress({ id, state: 'interrupted', error: 'Redirección no soportada' });
      this.processQueue();
      return;
    }

    // Verificar código de estado
    if (response.statusCode !== 200 && response.statusCode !== 206) {
      log.error('Error HTTP:', response.statusCode);
      // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
      queueDatabase.flushProgress();
      queueDatabase.failDownload(id, `Error HTTP ${response.statusCode}`);
      this._sendProgress({
        id,
        state: 'interrupted',
        error: `Error HTTP ${response.statusCode}`,
        savePath,
      });
      this._cleanupDownload(id, savePath, false);
      this.processQueue();
      return;
    }

    // Configurar reanudación
    const serverSupportsResume = response.statusCode === 206;
    let actualResumeFromByte = 0;

    if (isResuming && serverSupportsResume) {
      actualResumeFromByte = resumeFromByte;
      log.info(`Servidor aceptó reanudación desde byte ${resumeFromByte}`);
    } else if (isResuming && !serverSupportsResume) {
      log.warn('Servidor no soporta reanudación, descargando desde inicio');
      try {
        if (fs.existsSync(partialFilePath)) {
          fs.unlinkSync(partialFilePath);
        }
      } catch (e) {
        log.warn('Error eliminando archivo parcial:', e.message);
      }
    }

    // Crear stream de escritura con buffer adaptativo
    const writeMode = serverSupportsResume && actualResumeFromByte > 0 ? 'a' : 'w';

    // Calcular highWaterMark inicial basado en tamaño de archivo y configuración
    const initialBufferSize = this._calculateOptimalBufferSize(expectedFileSize);

    const fileStream = fs.createWriteStream(partialFilePath, {
      flags: writeMode,
      highWaterMark: initialBufferSize,
    });

    // FIX MEMORY LEAK: Aumentar límite de listeners
    fileStream.setMaxListeners(15);
    response.setMaxListeners(15);

    // Tracking de backpressure
    let backpressureEvents = 0;
    let backpressureStartTime = null;
    let lastBackpressureReset = Date.now();
    let currentBufferSize = initialBufferSize;
    let drainEvents = 0;
    let writeEvents = 0;

    // Actualizar descarga activa
    const currentDownload = this.getActiveDownload(id);
    this.setActiveDownload(id, {
      ...currentDownload,
      fileStream,
      actualResumeFromByte,
    });

    // BANDWIDTH SHAPING: Registrar descarga para gestión de ancho de banda
    this.bandwidthManager.registerDownload(id, false);

    // Variables de progreso
    const contentLength = parseInt(response.headers['content-length'] || 0, 10);
    const totalBytes = actualResumeFromByte + contentLength;
    let downloadedBytes = actualResumeFromByte;
    let lastProgressUpdate = 0;
    let downloadError = false;
    let isCleanedUp = false;
    let isCompleting = false;

    // FIX MEMORY LEAK: Función de limpieza
    const cleanup = (reason = 'unknown') => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      log.debug(`Cleanup de descarga ${id}: ${reason}`);
      
      // BANDWIDTH SHAPING: Desregistrar descarga
      this.bandwidthManager.unregisterDownload(id);
      
      this._removeDownloadHandlers(id, request, response, fileStream);
    };

    // Handlers mejorados con tracking de backpressure
    const drainHandler = () => {
      if (isCleanedUp || !this.hasActiveDownload(id)) return;

      if (!fileStream.destroyed) {
        drainEvents++;

        // Resetear contador de backpressure si drenó exitosamente
        if (backpressureStartTime) {
          const backpressureDuration = Date.now() - backpressureStartTime;
          if (backpressureDuration > 100) {
            // Solo loggear si fue significativo
            log.debug(`[Backpressure] Descarga ${id} drenó después de ${backpressureDuration}ms`);
          }
          backpressureStartTime = null;
        }

        // Ajustar buffer si está habilitado
        if (
          config.downloads.adaptiveBufferSize &&
          currentBufferSize < config.downloads.maxWriteBufferSize
        ) {
          // Si no hay backpressure frecuente, aumentar buffer gradualmente
          const timeSinceLastBackpressure = Date.now() - lastBackpressureReset;
          if (timeSinceLastBackpressure > 10000 && backpressureEvents < 3) {
            const newSize = Math.min(
              Math.floor(currentBufferSize * config.downloads.bufferIncreaseFactor),
              config.downloads.maxWriteBufferSize
            );
            if (newSize > currentBufferSize) {
              log.debug(
                `[Backpressure] Aumentando buffer de ${id}: ${this._formatBytes(currentBufferSize)} -> ${this._formatBytes(newSize)}`
              );
              currentBufferSize = newSize;
              // Nota: No podemos cambiar highWaterMark en tiempo de ejecución,
              // pero podemos trackear para futuras descargas
            }
          }
        }

        response.resume();
      }
    };

    const fileStreamErrorHandler = error => {
      if (isCleanedUp) return;
      downloadError = true;
      log.error('Error en fileStream:', error.message);
      cleanup('fileStream error');

      if (this.progressThrottler) {
        this.progressThrottler.cancelPending(id);
      }

      // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
      queueDatabase.flushProgress();
      queueDatabase.failDownload(id, `Error de escritura: ${error.message}`);
      this._cleanupDownload(id, savePath, false);
      this._sendProgress({
        id,
        state: 'interrupted',
        error: `Error de escritura: ${error.message}`,
        savePath,
      });
      this.processQueue();
    };

    const responseDataHandler = chunk => {
      if (downloadError || isCleanedUp || !this.hasActiveDownload(id)) {
        if (!response.destroyed) {
          response.destroy();
        }
        return;
      }

      if (!fileStream || fileStream.destroyed) {
        downloadError = true;
        if (!response.destroyed) {
          response.destroy();
        }
        return;
      }

      // BANDWIDTH SHAPING: Obtener quota disponible
      const quota = this.bandwidthManager.getQuota(id, null, chunk.length);
      
      if (!quota.allowed || quota.bytesAllowed === 0) {
        // No hay quota disponible, pausar respuesta
        if (!response.isPaused) {
          response.pause();
        }
        
        // Reanudar cuando haya quota disponible (usar un pequeño delay)
        setTimeout(() => {
          if (!downloadError && !isCleanedUp && this.hasActiveDownload(id) && !response.destroyed) {
            const newQuota = this.bandwidthManager.getQuota(id, null, chunk.length);
            if (newQuota.allowed && newQuota.bytesAllowed > 0) {
              response.resume();
            } else {
              // Aún no hay quota, pausar de nuevo y verificar más tarde
              response.pause();
              setTimeout(() => {
                if (!downloadError && !isCleanedUp && this.hasActiveDownload(id) && !response.destroyed) {
                  response.resume();
                }
              }, 10);
            }
          }
        }, 10);
        return;
      }

      // Hay quota disponible, procesar solo los bytes permitidos
      let bytesToWrite = Math.min(chunk.length, quota.bytesAllowed);
      let remainingChunk = chunk;

      // Si el chunk es más grande que la quota, escribir solo la parte permitida
      if (chunk.length > quota.bytesAllowed) {
        remainingChunk = chunk.slice(0, quota.bytesAllowed);
        // El resto del chunk se procesará en la próxima iteración
        // Pausar respuesta temporalmente
        if (!response.isPaused) {
          response.pause();
        }
        // Reanudar después de escribir
        setImmediate(() => {
          if (!downloadError && !isCleanedUp && this.hasActiveDownload(id) && !response.destroyed) {
            response.resume();
          }
        });
      }

      // Escribir chunk con backpressure mejorado
      writeEvents++;
      const canContinue = fileStream.write(remainingChunk);
      
      // Consumir quota después de escribir
      if (bytesToWrite > 0) {
        this.bandwidthManager.consumeQuota(id, bytesToWrite);
      }

      if (!canContinue) {
        // Backpressure detectado
        backpressureEvents++;

        if (!backpressureStartTime) {
          backpressureStartTime = Date.now();
        }

        // Pausar respuesta
        response.pause();

        // Remover listener anterior si existe para evitar múltiples listeners
        fileStream.removeListener('drain', drainHandler);
        fileStream.once('drain', drainHandler);

        // Verificar si hay backpressure persistente
        const backpressureDuration = Date.now() - backpressureStartTime;
        if (backpressureDuration > config.downloads.maxBackpressureDuration) {
          log.warn(
            `[Backpressure] Descarga ${id} en backpressure por ${backpressureDuration}ms (${backpressureEvents} eventos)`
          );

          // Si hay backpressure persistente y adaptiveBufferSize está habilitado
          if (
            config.downloads.adaptiveBufferSize &&
            currentBufferSize > config.downloads.minWriteBufferSize
          ) {
            const newSize = Math.max(
              Math.floor(currentBufferSize * config.downloads.bufferReductionFactor),
              config.downloads.minWriteBufferSize
            );
            if (newSize < currentBufferSize) {
              log.info(
                `[Backpressure] Reduciendo buffer recomendado para ${id}: ${this._formatBytes(currentBufferSize)} -> ${this._formatBytes(newSize)}`
              );
              currentBufferSize = newSize;
              // Nota: El buffer actual no se puede cambiar, pero trackeamos para logging
            }
          }

          // Resetear contador para evitar spam de logs
          lastBackpressureReset = Date.now();
          if (backpressureEvents > config.downloads.backpressureEventThreshold) {
            backpressureEvents = 0;
          }
        }
      } else {
        // Sin backpressure - resetear contador periódicamente
        if (Date.now() - lastBackpressureReset > 5000) {
          if (backpressureEvents > 0) {
            log.debug(
              `[Backpressure] Descarga ${id}: ${backpressureEvents} eventos de backpressure en los últimos 5s`
            );
          }
          backpressureEvents = 0;
          lastBackpressureReset = Date.now();
        }
      }

      downloadedBytes += chunk.length;

      // Actualizar progreso (throttled)
      const now = Date.now();
      if (totalBytes > 0 && now - lastProgressUpdate > config.downloads.progressUpdateInterval) {
        lastProgressUpdate = now;

        const percent = downloadedBytes / totalBytes;
        const downloadInfo = this.getActiveDownload(id);

        if (downloadInfo) {
          downloadInfo.percent = percent;
        }

        // Actualizar progreso en SQLite
        queueDatabase.updateProgress(id, percent, downloadedBytes);

        const elapsedSeconds = (now - (downloadInfo?.startTime || now)) / 1000;
        const bytesThisSession = downloadedBytes - actualResumeFromByte;
        const speedBytesPerSec = elapsedSeconds > 0 ? bytesThisSession / elapsedSeconds : 0;
        const speedMBPerSec = speedBytesPerSec / (1024 * 1024);
        const remainingBytes = totalBytes - downloadedBytes;
        const remainingSeconds = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : 0;

        if (this.progressThrottler) {
          this.progressThrottler.queueUpdate({
            id,
            state: 'progressing',
            percent,
            speed: speedMBPerSec,
            totalBytes,
            downloadedBytes,
            remainingTime: remainingSeconds,
            resumed: actualResumeFromByte > 0,
            chunked: false,
          });
        }
      }
    };

    const responseEndHandler = () => {
      if (downloadError || isCleanedUp || !this.hasActiveDownload(id)) return;
      if (!fileStream || fileStream.destroyed) return;

      isCompleting = true;
      log.debug(`Descarga ${id}: response.end recibido, finalizando escritura...`);

      // CRÍTICO: Timeout de seguridad para detectar descargas congeladas
      // Si el callback de fileStream.end() no se ejecuta en 10 segundos,
      // forzar la finalización verificando el tamaño del archivo
      const completionTimeout = setTimeout(() => {
        if (isCleanedUp) return;
        
        log.warn(`Descarga ${id}: Timeout en finalización, verificando archivo...`);
        
        try {
          // Verificar si el archivo parcial existe y tiene el tamaño correcto
          if (fs.existsSync(partialFilePath)) {
            const stats = fs.statSync(partialFilePath);
            const fileSize = stats.size;
            
            // Si el archivo tiene el tamaño esperado o está muy cerca (99.9%),
            // considerarlo completado
            const expectedSize = totalBytes > 0 ? totalBytes : (expectedFileSize > 0 ? expectedFileSize : null);
            
            if (!expectedSize) {
              // Si no hay tamaño esperado, verificar si el progreso reportado está cerca del 100%
              const downloadInfo = this.getActiveDownload(id);
              const reportedPercent = downloadInfo?.percent || 0;
              
              if (reportedPercent >= 0.99 && fileSize > 0) {
                log.info(`Descarga ${id}: Archivo completado por timeout (sin tamaño esperado, progreso: ${(reportedPercent * 100).toFixed(1)}%, tamaño: ${fileSize} bytes)`);
                
                // Forzar cierre del stream si aún está abierto
                if (fileStream && !fileStream.destroyed) {
                  try {
                    fileStream.destroy();
                  } catch (e) {
                    log.debug(`Error cerrando stream: ${e.message}`);
                  }
                }
                
                // Finalizar descarga
                _finalizeDownload();
              } else {
                log.warn(`Descarga ${id}: Archivo incompleto (progreso: ${(reportedPercent * 100).toFixed(1)}%, tamaño: ${fileSize} bytes), manteniendo para reanudación`);
                isCompleting = false;
              }
            } else {
              const sizeDifference = Math.abs(fileSize - expectedSize);
              const sizeThreshold = expectedSize * 0.001; // 0.1% de tolerancia
              
              if (fileSize >= expectedSize || sizeDifference <= sizeThreshold) {
                log.info(`Descarga ${id}: Archivo completado por timeout (${fileSize}/${expectedSize} bytes)`);
                
                // Forzar cierre del stream si aún está abierto
                if (fileStream && !fileStream.destroyed) {
                  try {
                    fileStream.destroy();
                  } catch (e) {
                    log.debug(`Error cerrando stream: ${e.message}`);
                  }
                }
                
                // Finalizar descarga
                _finalizeDownload();
              } else {
                log.warn(`Descarga ${id}: Archivo incompleto (${fileSize}/${expectedSize} bytes), manteniendo para reanudación`);
                // No finalizar, dejar que se pueda reanudar
                isCompleting = false;
              }
            }
          } else {
            log.warn(`Descarga ${id}: Archivo parcial no existe después de timeout`);
            isCompleting = false;
          }
        } catch (err) {
          log.error(`Descarga ${id}: Error verificando archivo después de timeout:`, err.message);
          isCompleting = false;
        }
      }, 10000); // 10 segundos de timeout

      // Función auxiliar para finalizar la descarga
      const _finalizeDownload = () => {
        if (isCleanedUp) return;
        
        clearTimeout(completionTimeout);
        
        try {
          // Verificar tamaño del archivo antes de renombrar
          if (fs.existsSync(partialFilePath)) {
            const stats = fs.statSync(partialFilePath);
            const fileSize = stats.size;
            const expectedSize = totalBytes > 0 ? totalBytes : (expectedFileSize > 0 ? expectedFileSize : null);
            
            // Verificar que el archivo tenga el tamaño esperado (con pequeña tolerancia)
            if (expectedSize && fileSize < expectedSize * 0.99) {
              log.warn(`Descarga ${id}: Archivo incompleto (${fileSize}/${expectedSize} bytes), no finalizando`);
              isCompleting = false;
              return;
            }
            
            // Si no hay tamaño esperado pero el progreso reportado está cerca del 100%, continuar
            if (!expectedSize) {
              const downloadInfo = this.getActiveDownload(id);
              const reportedPercent = downloadInfo?.percent || 0;
              
              if (reportedPercent < 0.99) {
                log.warn(`Descarga ${id}: Progreso insuficiente (${(reportedPercent * 100).toFixed(1)}%), no finalizando`);
                isCompleting = false;
                return;
              }
            }
            
            if (fs.existsSync(savePath)) {
              fs.unlinkSync(savePath);
            }
            fs.renameSync(partialFilePath, savePath);
            const download = this.getActiveDownload(id);
            const downloadTitle = download?.title || path.basename(savePath);
            log.info('Descarga simple completada', {
              downloadId: id,
              title: downloadTitle,
              savePath,
              fileSize,
              totalBytes: expectedFileSize,
              duration: download ? Date.now() - download.startTime : 0,
              timestamp: Date.now(),
            });
          } else {
            log.error(`Descarga ${id}: Archivo parcial no existe al finalizar`);
            isCompleting = false;
            return;
          }
        } catch (renameErr) {
          log.error(`Descarga ${id}: Error renombrando archivo:`, renameErr.message);
          isCompleting = false;
          return;
        }

        cleanup('completed');
        this.deleteActiveDownload(id);

        if (this.progressThrottler) {
          this.progressThrottler.cancelPending(id);
        }

        // Marcar como completada en SQLite
        // CRÍTICO: Flush progreso pendiente antes de completar
        queueDatabase.flushProgress();
        
        queueDatabase.completeDownload(id, { savePath });

        this._sendProgress({
          id,
          state: 'completed',
          savePath,
          percent: 1,
          chunked: false,
        });

        this.processQueue();
      };

      // Intentar cerrar el stream normalmente
      fileStream.end(() => {
        clearTimeout(completionTimeout);
        _finalizeDownload();
      });
      
      // CRÍTICO: Si el stream ya está cerrado o destruido, finalizar inmediatamente
      if (fileStream.destroyed || fileStream.writableEnded) {
        clearTimeout(completionTimeout);
        // Dar un pequeño delay para asegurar que todos los datos se hayan escrito
        setTimeout(() => {
          _finalizeDownload();
        }, 100);
      }
    };

    const responseErrorHandler = error => {
      if (isCleanedUp) return;
      if (error.message.includes('aborted') || error.message.includes('destroyed')) {
        return;
      }
      downloadError = true;
      log.error('Error en response:', error);
      cleanup('response error');

      if (this.progressThrottler) {
        this.progressThrottler.cancelPending(id);
      }

      // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
      queueDatabase.flushProgress();
      queueDatabase.failDownload(id, error.message);
      this._cleanupDownload(id, savePath);
      this._sendProgress({ id, state: 'interrupted', error: error.message, savePath });
      this.processQueue();
    };

    const responseCloseHandler = () => {
      if (isCompleting || isCleanedUp || downloadError) {
        return;
      }

      if (this.hasActiveDownload(id)) {
        log.warn(`Response cerrado prematuramente para descarga ${id}`);
        downloadError = true;
        cleanup('response closed prematurely');

        if (this.progressThrottler) {
          this.progressThrottler.cancelPending(id);
        }

        // CRÍTICO: Flush progreso pendiente antes de marcar como fallida
        queueDatabase.flushProgress();
        queueDatabase.failDownload(id, 'Conexión cerrada prematuramente');
        this._cleanupDownload(id, savePath);
        this._sendProgress({
          id,
          state: 'interrupted',
          error: 'Conexión cerrada prematuramente',
          savePath,
        });
        this.processQueue();
      }
    };

    // FIX MEMORY LEAK: Guardar referencias a los handlers
    this.downloadHandlers.set(id, {
      drainHandler,
      fileStreamErrorHandler,
      responseDataHandler,
      responseEndHandler,
      responseErrorHandler,
      responseCloseHandler,
    });

    // Registrar los listeners
    fileStream.on('error', fileStreamErrorHandler);
    response.on('data', responseDataHandler);
    response.on('end', responseEndHandler);
    response.on('error', responseErrorHandler);
    response.on('close', responseCloseHandler);
  }

  // =====================
  // PAUSAR / CANCELAR
  // =====================

  /**
   * Pausa una descarga activa o en cola
   *
   * Detiene una descarga que está en progreso o la remueve de la cola si aún no ha iniciado.
   * Mantiene los archivos parciales para permitir reanudación posterior.
   * Actualiza el estado en SQLite para persistencia.
   *
   * @param {number} downloadId - ID de la descarga a pausar
   * @returns {Promise<Object>} Resultado de la operación: { success: boolean, source: string, error?: string }
   * @returns {boolean} returns.success - Si la pausa fue exitosa
   * @returns {string} returns.source - Origen de la descarga: 'chunked' | 'simple' | 'queue' | 'none'
   * @returns {string} [returns.error] - Mensaje de error si falló
   *
   * @example
   * // Pausar descarga activa
   * const result = await downloadManager.pauseDownload(12345);
   * if (result.success) {
   *   console.log(`Descarga pausada (tipo: ${result.source})`);
   *   // Los archivos parciales se mantienen para reanudación
   * } else {
   *   console.error(`Error al pausar: ${result.error}`);
   * }
   */
  /**
   * Pausa una descarga activa
   *
   * CRÍTICO: Flush de progreso antes de pausar para asegurar que el estado se guarde
   */
  async pauseDownload(downloadId) {
    log.info(`=== PAUSANDO DESCARGA ${downloadId} ===`);

    const lockAcquired = await this.acquireLock(2000);
    if (!lockAcquired) {
      return { success: false, error: 'Operación en progreso' };
    }

    try {
      // Verificar si es descarga fragmentada
      const chunked = this.chunkedDownloads.get(downloadId);
      if (chunked) {
        log.info('Pausando descarga fragmentada...');
        chunked.pause();
        this.chunkedDownloads.delete(downloadId);

        // Persistir pausa en SQLite
        queueDatabase.pauseDownload(downloadId);

        if (this.progressThrottler) {
          this.progressThrottler.cancelPending(downloadId);
        }

        this._sendProgress({ id: downloadId, state: 'paused', chunked: true });
        setImmediate(() => this.processQueue());
        return { success: true, source: 'chunked' };
      }

      // Descarga simple
      const download = this.activeDownloads.get(downloadId);
      if (download) {
        log.info('Pausando descarga simple...');

        const currentPercent = download.percent || 0;

        if (this.progressThrottler) {
          this.progressThrottler.cancelPending(downloadId);
        }

        // Limpiar sin eliminar archivos
        if (download.request) {
          try {
            download.request.abort();
          } catch (e) {
            log.debug(`Pause cleanup request ${downloadId}:`, e.message);
          }
        }
        if (download.fileStream) {
          try {
            download.fileStream.end();
          } catch (e) {
            log.debug(`Pause cleanup fileStream ${downloadId}:`, e.message);
          }
        }
        if (download.response) {
          try {
            download.response.removeAllListeners();
          } catch (e) {
            log.debug(`Pause cleanup response ${downloadId}:`, e.message);
          }
        }

        this.activeDownloads.delete(downloadId);

        // Persistir pausa en SQLite
        queueDatabase.pauseDownload(downloadId);

        this._sendProgress({
          id: downloadId,
          state: 'paused',
          percent: currentPercent,
          chunked: false,
        });

        setImmediate(() => this.processQueue());
        return { success: true, source: 'simple' };
      }

      // Si está en cola
      const inQueue = this.downloadQueue.some(d => d.id === downloadId);
      if (inQueue) {
        this.removeFromQueue(downloadId);
        queueDatabase.pauseDownload(downloadId);

        if (this.progressThrottler) {
          this.progressThrottler.cancelPending(downloadId);
        }

        this._sendProgress({ id: downloadId, state: 'paused' });
        return { success: true, source: 'queue' };
      }

      log.info('Descarga no encontrada');
      this._sendProgress({ id: downloadId, state: 'paused' });
      return { success: true, source: 'none' };
    } catch (error) {
      log.error('Error al pausar descarga:', error);
      return { success: false, error: error.message };
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Cancela una descarga activa o en cola
   *
   * Detiene una descarga y elimina los archivos parciales. Si la descarga está
   * en progreso, se aborta la conexión y se limpian los recursos. Si está en cola,
   * se remueve de la cola. Actualiza el estado en SQLite.
   *
   * @param {number} downloadId - ID de la descarga a cancelar
   * @returns {Promise<Object>} Resultado de la operación: { success: boolean, source: string, error?: string }
   * @returns {boolean} returns.success - Si la cancelación fue exitosa
   * @returns {string} returns.source - Origen de la descarga: 'chunked' | 'simple' | 'queue' | 'none'
   * @returns {string} [returns.error] - Mensaje de error si falló
   *
   * @example
   * // Cancelar descarga y eliminar archivos parciales
   * const result = await downloadManager.cancelDownload(12345);
   * if (result.success) {
   *   console.log(`Descarga cancelada (tipo: ${result.source})`);
   *   // Los archivos .part fueron eliminados
   * } else {
   *   console.error(`Error al cancelar: ${result.error}`);
   * }
   */
  async cancelDownload(downloadId) {
    log.info(`=== CANCELANDO DESCARGA ${downloadId} ===`);

    const lockAcquired = await this.acquireLock(2000);
    if (!lockAcquired) {
      return { success: false, error: 'Operación en progreso' };
    }

    try {
      // Verificar si es descarga fragmentada
      const chunked = this.chunkedDownloads.get(downloadId);
      if (chunked) {
        log.info('Cancelando descarga fragmentada...');
        chunked.cancel(false); // No mantener archivos
        this.chunkedDownloads.delete(downloadId);

        if (this.progressThrottler) {
          this.progressThrottler.cancelPending(downloadId);
        }

        queueDatabase.cancelDownload(downloadId);
        this._sendProgress({ id: downloadId, state: 'cancelled', chunked: true });

        setImmediate(() => this.processQueue());
        return { success: true, source: 'chunked' };
      }

      // Descarga simple
      const download = this.activeDownloads.get(downloadId);
      if (download) {
        log.info('Cancelando descarga simple...');

        if (this.progressThrottler) {
          this.progressThrottler.cancelPending(downloadId);
        }

        this._cleanupDownload(downloadId, download.savePath, false);
        queueDatabase.cancelDownload(downloadId);
        this._sendProgress({ id: downloadId, state: 'cancelled', chunked: false });

        setImmediate(() => this.processQueue());
        return { success: true, source: 'simple' };
      }

      // Si está en cola
      const inQueue = this.downloadQueue.some(d => d.id === downloadId);
      if (inQueue) {
        this.removeFromQueueWithPersist(downloadId);

        if (this.progressThrottler) {
          this.progressThrottler.cancelPending(downloadId);
        }

        this._sendProgress({ id: downloadId, state: 'cancelled' });
        return { success: true, source: 'queue' };
      }

      log.info('Descarga no encontrada');
      this._sendProgress({ id: downloadId, state: 'cancelled' });
      return { success: true, source: 'none' };
    } catch (error) {
      log.error('Error al cancelar descarga:', error);
      return { success: false, error: error.message };
    } finally {
      this.releaseLock();
    }
  }

  // =====================
  // UTILIDADES
  // =====================

  /**
   * Limpia descargas zombies
   */
  cleanupStaleDownloads(maxAgeMs = config.downloads.staleTimeout) {
    const now = Date.now();
    const staleIds = [];

    // Verificar descargas simples
    this.activeDownloads.forEach((download, id) => {
      if (now - (download.lastUpdate || download.startTime || 0) > maxAgeMs) {
        staleIds.push({ id, type: 'simple' });
      }
    });

    // Verificar descargas fragmentadas
    this.chunkedDownloads.forEach((chunked, id) => {
      const lastUpdate = chunked.lastUpdate || chunked.startTime || 0;
      const timeSinceUpdate = now - lastUpdate;
      
      // CRÍTICO: Detectar descargas fragmentadas que tienen todos los chunks completados
      // pero el merge no se inició (descargas congeladas)
      if (chunked.completedChunks >= chunked.chunks.length && 
          chunked.activeChunks.size === 0 && 
          !chunked.mergeInProgress &&
          timeSinceUpdate > 10000) { // 10 segundos sin actividad
        log.warn(`Descarga fragmentada ${id} tiene todos los chunks completados pero merge no iniciado, forzando merge...`);
        try {
          // Intentar iniciar el merge manualmente
          chunked._mergeChunks();
          return; // No marcar como zombie si logramos iniciar el merge
        } catch (error) {
          log.error(`Error forzando merge en descarga ${id}:`, error.message);
        }
      }
      
      // Verificar timeout normal
      if (timeSinceUpdate > maxAgeMs) {
        staleIds.push({ id, type: 'chunked' });
      }
    });

    staleIds.forEach(({ id, type }) => {
      log.warn(`Limpiando descarga zombie: ${id} (${type})`);

      if (type === 'chunked') {
        const chunked = this.chunkedDownloads.get(id);
        if (chunked) {
          // Antes de destruir, intentar verificar si realmente está congelada
          if (chunked.completedChunks >= chunked.chunks.length && 
              chunked.activeChunks.size === 0 && 
              !chunked.mergeInProgress) {
            log.warn(`Descarga ${id} tiene todos los chunks completados, intentando merge antes de limpiar...`);
            try {
              chunked._mergeChunks();
              // Esperar un momento para ver si el merge se inicia
              setTimeout(() => {
                if (!chunked.mergeInProgress) {
                  log.error(`Merge no se inició para descarga ${id}, limpiando como zombie`);
                  chunked.destroy();
                  this.chunkedDownloads.delete(id);
                }
              }, 2000);
              return; // No eliminar inmediatamente si intentamos iniciar merge
            } catch (error) {
              log.error(`Error iniciando merge antes de limpiar descarga ${id}:`, error.message);
            }
          }
          chunked.destroy();
        }
        this.chunkedDownloads.delete(id);
      } else {
        this.activeDownloads.delete(id);
      }
    });

    return staleIds.length;
  }

  /**
   * Sincroniza estado
   */
  saveQueue() {
    log.debug(
      `Estado sincronizado: ${this.downloadQueue.length} en cola, ${this.activeDownloads.size} simples, ${this.chunkedDownloads.size} fragmentadas`
    );
  }

  /**
   * Carga la cola desde SQLite
   */
  loadQueue() {
    try {
      const queuedDownloads = queueDatabase.getQueued();

      if (queuedDownloads.length > 0) {
        const validQueue = queuedDownloads.filter(
          d =>
            !this.activeDownloads.has(d.id) &&
            !this.chunkedDownloads.has(d.id) &&
            !this.downloadQueue.some(q => q.id === d.id)
        );

        this.downloadQueue = validQueue.map(d => ({
          id: d.id,
          title: d.title,
          downloadPath: d.downloadPath,
          preserveStructure: d.preserveStructure,
          forceOverwrite: d.forceOverwrite,
          retryCount: d.retryCount || 0,
          addedAt: d.createdAt,
          queuePosition: d.queuePosition,
          priority: d.priority,
        }));

        log.info(`Cola restaurada desde SQLite: ${this.downloadQueue.length} elementos`);
        return this.downloadQueue.length;
      }

      return 0;
    } catch (error) {
      log.error('Error cargando cola:', error);
      return 0;
    }
  }

  /**
   * Obtiene información de velocidad de todas las descargas activas
   *
   * Recolecta la velocidad actual de descarga (en MB/s y bytes/s) de todas las
   * descargas simples y fragmentadas activas. Para descargas fragmentadas, suma
   * la velocidad de todos los chunks activos.
   *
   * @returns {Array<Object>} Array de objetos con información de velocidad de cada descarga activa
   * @returns {number} returns[].id - ID de la descarga
   * @returns {number} returns[].speed - Velocidad en MB/s
   * @returns {number} returns[].speedBytesPerSec - Velocidad en bytes/segundo
   * @returns {number} returns[].totalBytes - Tamaño total en bytes
   * @returns {number} returns[].downloadedBytes - Bytes descargados
   * @returns {boolean} [returns[].chunked] - Si es descarga fragmentada
   *
   * @example
   * const speeds = downloadManager.getActiveDownloadsSpeed();
   * const totalSpeed = speeds.reduce((sum, d) => sum + d.speed, 0);
   * console.log(`Velocidad total: ${totalSpeed.toFixed(2)} MB/s`);
   *
   * // Usar para estimar tiempo de cola
   * const averageSpeed = speeds.length > 0
   *   ? speeds.reduce((sum, d) => sum + d.speedBytesPerSec, 0) / speeds.length
   *   : 0;
   */
  getActiveDownloadsSpeed() {
    const activeSpeeds = [];

    // Obtener velocidades de descargas simples
    this.activeDownloads.forEach((download, id) => {
      // Buscar información de velocidad en la descarga activa
      // La velocidad se actualiza en los handlers de progreso
      const speedMBPerSec = download.speed || download.speedMBPerSec || 0;
      const speedBytesPerSec = download.speedBytesPerSec || speedMBPerSec * 1024 * 1024;

      // Incluir todas las descargas activas, incluso si no tienen velocidad aún
      // Esto ayuda a tener información completa para las estimaciones
      activeSpeeds.push({
        id,
        speed: speedMBPerSec,
        speedBytesPerSec: speedBytesPerSec,
        totalBytes: download.totalBytes || download.expectedFileSize || 0,
        downloadedBytes: download.downloadedBytes || 0,
      });
    });

    // Obtener velocidades de descargas fragmentadas
    this.chunkedDownloads.forEach((chunked, id) => {
      // Calcular velocidad total de chunks activos
      let totalSpeedBytesPerSec = 0;
      if (chunked.activeChunks && chunked.activeChunks.size > 0) {
        for (const [chunkIndex, activeChunk] of chunked.activeChunks.entries()) {
          if (activeChunk && activeChunk.speed) {
            // La velocidad del chunk está en bytes/segundo
            totalSpeedBytesPerSec += activeChunk.speed;
          }
        }
      }

      const speedMBPerSec = totalSpeedBytesPerSec / (1024 * 1024);

      // Incluir todas las descargas fragmentadas activas
      activeSpeeds.push({
        id,
        speed: speedMBPerSec,
        speedBytesPerSec: totalSpeedBytesPerSec,
        totalBytes: chunked.totalBytes || 0,
        downloadedBytes: chunked.totalDownloadedBytes || 0,
        chunked: true,
      });
    });

    return activeSpeeds;
  }

  /**
   * Obtiene estadísticas completas del gestor de descargas
   *
   * Retorna un objeto con información detallada sobre el estado actual del gestor:
   * descargas activas, en cola, completadas, fallidas, y estimaciones de tiempo.
   * Usa QueueService si está disponible para estadísticas avanzadas de cola.
   *
   * @returns {ManagerStats} Estadísticas completas del gestor
   *
   * @example
   * const stats = downloadManager.getStats();
   * console.log(`Descargas activas: ${stats.activeSimple + stats.activeChunked}`);
   * console.log(`En cola: ${stats.queuedInMemory}`);
   * console.log(`Completadas: ${stats.completed}`);
   *
   * if (stats.queueTimeEstimate) {
   *   console.log(`Tiempo estimado de cola: ${stats.queueTimeEstimate.totalEstimatedHours.toFixed(2)} horas`);
   * }
   */
  getStats() {
    const dbStats = queueDatabase.getStats();
    const totalActive = this.activeDownloads.size + this.chunkedDownloads.size;

    // Calcular estadísticas de cola usando QueueService si está disponible
    let queueStats = null;
    let queueTimeEstimate = null;

    if (this.queueService) {
      queueStats = this.queueService.calculateQueueStats(this.downloadQueue, totalActive);

      // Calcular estimación de tiempo de cola si hay descargas en cola
      if (this.downloadQueue.length > 0) {
        // Obtener velocidades de descargas activas
        const activeSpeeds = this.getActiveDownloadsSpeed();

        // Calcular velocidad promedio
        const averageSpeedBytesPerSec = this.queueService.calculateAverageSpeed(activeSpeeds);

        // Estimar tiempo de cola
        queueTimeEstimate = this.queueService.estimateQueueTime(
          this.downloadQueue,
          totalActive,
          averageSpeedBytesPerSec
        );
      }
    }

    const baseStats = {
      activeSimple: this.activeDownloads.size,
      activeChunked: this.chunkedDownloads.size,
      queuedInMemory: this.downloadQueue.length,
      ...dbStats,
      maxConcurrent: config.downloads.maxConcurrent,
      processing: this.processing,
      locked: this.processingLock,
      chunkedConfig: {
        threshold: this.chunkedConfig.sizeThreshold,
        maxChunks: this.chunkedConfig.maxChunks,
        enabled: !this.chunkedConfig.forceSimpleDownload,
      },
      activeIds: [
        ...Array.from(this.activeDownloads.keys()),
        ...Array.from(this.chunkedDownloads.keys()),
      ],
      queuedIds: this.downloadQueue.map(d => d.id),
    };

    // Agregar estadísticas de QueueService si están disponibles
    if (queueStats) {
      baseStats.queueStats = {
        slotsAvailable: queueStats.slotsAvailable,
        byPriority: queueStats.byPriority,
        canStart: queueStats.canStart,
        shouldQueue: queueStats.shouldQueue,
      };
    }

    // Agregar estimación de tiempo de cola si está disponible
    if (queueTimeEstimate) {
      baseStats.queueTimeEstimate = queueTimeEstimate;
    }

    return baseStats;
  }

  // =====================
  // MÍ‰TODOS PRIVADOS
  // =====================

  /**
   * Obtiene o crea un CircuitBreaker por host
   */
  _getHostCircuitBreaker(url) {
    if (!config.circuitBreaker?.perHost?.enabled) {
      return this.circuitBreaker;
    }

    try {
      const host = new URL(url).hostname;
      if (!this.hostCircuitBreakers.has(host)) {
        const cbConfig = config.circuitBreaker.perHost || {};
        const cb = new CircuitBreaker({
          name: `Host-${host}`,
          failureThreshold: cbConfig.failureThreshold || 10,
          successThreshold: 2,
          timeout: cbConfig.timeout || 120000,
          resetTimeout: 60000,
          onStateChange: info => {
            log.warn(`[CircuitBreaker:Host-${host}] Estado: ${info.oldState} -> ${info.newState}`);
          },
        });
        this.hostCircuitBreakers.set(host, cb);
      }
      return this.hostCircuitBreakers.get(host);
    } catch (err) {
      log.warn('Error extrayendo host de URL, usando circuit breaker global:', err.message);
      return this.circuitBreaker;
    }
  }

  /**
   * Obtiene el tamaño de un archivo remoto mediante HEAD request
   *
   * Realiza una petición HEAD para obtener el tamaño del archivo sin descargarlo.
   * Soporta reintentos automáticos y circuit breaker para manejar errores de red.
   *
   * @private
   * @param {string} url - URL del archivo remoto
   * @param {number} [retries=config.network.maxRetries] - Número máximo de reintentos
   * @returns {Promise<number>} Tamaño del archivo en bytes, o 0 si no se pudo obtener
   *
   * @example
   * const fileSize = await this._getFileSize('https://myrient.erista.me/files/archivo.zip');
   * if (fileSize > 0) {
   *   console.log(`Tamaño del archivo: ${fileSize} bytes`);
   * } else {
   *   console.log('No se pudo obtener el tamaño del archivo');
   * }
   */
  async _getFileSize(url, retries = config.network.maxRetries) {
    // Obtener circuit breaker apropiado
    const circuitBreaker = this._getHostCircuitBreaker(url);

    // Operación protegida por circuit breaker
    const operation = async () => {
      for (let i = 0; i < retries; i++) {
        let timeoutId = null;
        let headRequest = null;

        try {
          headRequest = net.request({ method: 'HEAD', url });

          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              if (headRequest) headRequest.abort();
              reject(new Error('Timeout'));
            }, config.network.timeout);
          });

          const requestPromise = new Promise((resolve, reject) => {
            headRequest.on('response', response => {
              if (timeoutId) clearTimeout(timeoutId);
              resolve(response);
            });
            headRequest.on('error', error => {
              if (timeoutId) clearTimeout(timeoutId);
              reject(error);
            });
            headRequest.end();
          });

          const response = await Promise.race([requestPromise, timeoutPromise]);

          if (timeoutId) clearTimeout(timeoutId);

          const size = parseInt(response.headers['content-length'] || 0, 10);
          return Math.max(0, size);
        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId);

          log.error(`Intento ${i + 1}/${retries} falló:`, error.message);

          if (i === retries - 1) {
            throw error; // Re-lanzar para que circuit breaker lo capture
          }

          await new Promise(resolve =>
            setTimeout(resolve, config.network.retryDelay * Math.pow(2, i))
          );
        }
      }

      throw new Error('Todos los intentos fallaron');
    };

    // Ejecutar con circuit breaker si está habilitado
    if (circuitBreaker && config.circuitBreaker?.enabled) {
      try {
        return await circuitBreaker.execute(operation, () => {
          log.warn(`[CircuitBreaker] Request rechazado para ${url} (circuit abierto)`);
          return 0; // Fallback: retornar 0 si circuit está abierto
        });
      } catch (error) {
        // El circuit breaker ya registró el error
        log.error(`[CircuitBreaker] Error en _getFileSize para ${url}:`, error.message);
        return 0;
      }
    } else {
      // Sin circuit breaker, ejecutar directamente
      try {
        return await operation();
      } catch (error) {
        log.error(`Error en _getFileSize para ${url}:`, error.message);
        return 0;
      }
    }
  }

  /**
   * Determina la ruta completa donde se guardará el archivo
   *
   * Construye la ruta de guardado basándose en la configuración del usuario.
   * Si preserveStructure está habilitado, incluye la estructura de carpetas desde
   * la base de datos. Si no hay ruta configurada, solicita al usuario mediante diálogo.
   * Usa FileService si está disponible para validación y sanitización de nombres.
   *
   * @private
   * @param {Object} params - Parámetros para determinar ruta
   * @param {number} params.id - ID del archivo (para obtener ancestros)
   * @param {string} params.title - Nombre del archivo
   * @param {string} [params.downloadPath] - Ruta base configurada (opcional)
   * @param {boolean} [params.preserveStructure=true] - Si mantener estructura de carpetas
   * @returns {Promise<string|null>} Ruta completa de guardado, o null si el usuario canceló
   *
   * @example
   * // Con estructura de carpetas
   * const savePath = await this._determineSavePath({
   *   id: 12345,
   *   title: 'archivo.zip',
   *   downloadPath: 'C:/Downloads',
   *   preserveStructure: true
   * });
   * // Resultado: 'C:/Downloads/Sistema/Software/archivo.zip'
   *
   * // Sin estructura de carpetas
   * const savePath2 = await this._determineSavePath({
   *   id: 12345,
   *   title: 'archivo.zip',
   *   downloadPath: 'C:/Downloads',
   *   preserveStructure: false
   * });
   * // Resultado: 'C:/Downloads/archivo.zip'
   */
  async _determineSavePath({ id, title, downloadPath, preserveStructure }) {
    // Normalizar downloadPath: tratar null, undefined, o string vacío como "sin ruta configurada"
    const normalizedDownloadPath =
      downloadPath && typeof downloadPath === 'string' ? downloadPath.trim() : null;
    const hasDownloadPath = normalizedDownloadPath && normalizedDownloadPath.length > 0;

    // Si no hay ruta base configurada, pedir al usuario
    if (!hasDownloadPath) {
      const { dialog } = require('electron');
      const result = await dialog.showSaveDialog(this.mainWindow, {
        defaultPath: title,
      });
      return result.canceled ? null : result.filePath;
    }

    // Usar FileService para construir la ruta
    if (this.fileService) {
      // Obtener ruta relativa si preserveStructure está habilitado
      let relativePath = '';
      if (preserveStructure) {
        const ancestors = database.getFileAncestorPath(id);
        relativePath = ancestors
          .map(a => {
            // Validar y sanitizar cada segmento
            const validation = this.fileService.validateFilename(a.title.replace(/\/$/, ''));
            return validation.valid ? validation.data : '';
          })
          .filter(segment => segment.length > 0)
          .join(path.sep);
      }

      // Construir ruta usando FileService (usar normalizedDownloadPath que ya fue validado)
      const result = this.fileService.buildSavePath(
        normalizedDownloadPath,
        title,
        preserveStructure,
        relativePath
      );

      if (result.success) {
        return result.savePath;
      } else {
        log.error('Error construyendo ruta de guardado:', result.error);
        // Fallback a método simple (usar normalizedDownloadPath)
        return path.join(normalizedDownloadPath, sanitizeFilename(title));
      }
    }

    // Fallback: método antiguo si FileService no está disponible (usar normalizedDownloadPath)
    if (preserveStructure) {
      const ancestors = database.getFileAncestorPath(id);
      const ancestorPath = ancestors
        .map(a => sanitizeFilename(a.title.replace(/\/$/, '')))
        .join(path.sep);
      return path.join(normalizedDownloadPath, ancestorPath, sanitizeFilename(title));
    } else {
      return path.join(normalizedDownloadPath, sanitizeFilename(title));
    }
  }

  /**
   * Verifica si existe un archivo con tamaño similar (LEGACY - Fallback de emergencia)
   *
   * @deprecated Este método está mantenido SOLO como fallback de emergencia
   * cuando FileService no está disponible. Preferir siempre FileService.getFileCheckInfo()
   * que es asíncrono y más robusto.
   *
   * @private
   * @param {string} filePath - Ruta del archivo a verificar
   * @param {number} expectedSize - Tamaño esperado en bytes
   * @returns {Object} - Información sobre el archivo existente: { exists, existingSize, expectedSize, sizeDifference, similarSize, hasPartialFile }
   */
  _checkExistingFile(filePath, expectedSize) {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const sizeDiff = Math.abs(stats.size - expectedSize);
        const sizeMargin = config.files?.sizeMarginBytes || 10240;
        return {
          exists: true,
          existingSize: stats.size,
          expectedSize,
          sizeDifference: sizeDiff,
          similarSize: sizeDiff <= sizeMargin,
          hasPartialFile: false, // Se verifica separadamente en el código que llama
        };
      }
    } catch (e) {
      log.error('Error verificando archivo con método legacy:', e);
    }
    return { exists: false, hasPartialFile: false };
  }

  /**
   * Prepara el directorio de destino (LEGACY - Fallback de emergencia)
   *
   * @deprecated Este método está mantenido SOLO como fallback cuando FileService no está disponible.
   * Será eliminado en versión 2.1.0 una vez se garantice inicialización de servicios.
   * Preferir siempre FileService.prepareDirectory() que es asíncrono y más robusto.
   *
   * @private
   * @param {string} savePath - Ruta donde se guardará el archivo
   * @returns {Object} - { success: boolean, error?: string }
   */
  _prepareDirectory(savePath) {
    const fileDir = path.dirname(savePath);

    try {
      if (!fs.existsSync(fileDir)) {
        fs.mkdirSync(fileDir, { recursive: true });
      }

      fs.accessSync(fileDir, fs.constants.W_OK);
      return { success: true };
    } catch (err) {
      // Manejo de errores mejorado con mensajes descriptivos
      let errorMessage = 'Error al crear directorio';
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        errorMessage = 'Sin permisos para crear directorio';
      } else if (err.code === 'ENOSPC') {
        errorMessage = 'Sin espacio en disco';
      } else if (err.code === 'ENOENT') {
        errorMessage = 'Ruta padre no existe';
      }
      log.warn('[DownloadManager] Error en método legacy _prepareDirectory:', errorMessage);
      return { success: false, error: `${errorMessage}: ${err.message}` };
    }
  }

  /**
   * Limpia recursos de una descarga simple
   */
  _cleanupDownload(id, savePath, keepPartialFile = true) {
    const download = this.activeDownloads.get(id);
    if (!download) {
      log.debug(`Descarga ${id} ya fue limpiada o no existe`);
      return;
    }

    log.debug(`Limpiando descarga ${id} (keepPartialFile: ${keepPartialFile})`);

    // CRÍTICO: Limpiar timeout si existe
    if (download.timeoutId) {
      clearTimeout(download.timeoutId);
      download.timeoutId = null;
    }

    this.activeDownloads.delete(id);
    this._removeListeners(download.request, download.response, download.fileStream);

    if (download.fileStream) {
      try {
        if (!download.fileStream.destroyed) {
          download.fileStream.removeAllListeners();
          download.fileStream.destroy();
        }
      } catch (e) {
        log.debug(`Cleanup fileStream ${id}:`, e.message);
      }
    }

    if (download.response) {
      try {
        if (!download.response.destroyed) {
          download.response.removeAllListeners();
          download.response.destroy();
        }
      } catch (e) {
        log.debug(`Cleanup response ${id}:`, e.message);
      }
    }

    if (download.request) {
      try {
        download.request.removeAllListeners();
        download.request.abort();
      } catch (e) {
        log.debug(`Cleanup request ${id}:`, e.message);
      }
    }

    if (!keepPartialFile) {
      setTimeout(() => {
        const partialPath = download.partialFilePath || savePath + '.part';
        if (partialPath && fs.existsSync(partialPath)) {
          safeUnlink(partialPath);
        }
        if (savePath && fs.existsSync(savePath)) {
          safeUnlink(savePath);
        }
      }, config.downloads.queueProcessDelay);
    }
  }

  /**
   * Remueve handlers específicos
   */
  _removeDownloadHandlers(id, request, response, fileStream) {
    const handlers = this.downloadHandlers.get(id);

    if (handlers) {
      if (response) {
        try {
          if (handlers.responseDataHandler)
            response.removeListener('data', handlers.responseDataHandler);
          if (handlers.responseEndHandler)
            response.removeListener('end', handlers.responseEndHandler);
          if (handlers.responseErrorHandler)
            response.removeListener('error', handlers.responseErrorHandler);
          if (handlers.responseCloseHandler)
            response.removeListener('close', handlers.responseCloseHandler);
        } catch (e) {
          log.debug(`Remove response handlers ${id}:`, e.message);
        }
      }

      if (fileStream) {
        try {
          if (handlers.fileStreamErrorHandler)
            fileStream.removeListener('error', handlers.fileStreamErrorHandler);
          if (handlers.drainHandler) fileStream.removeListener('drain', handlers.drainHandler);
        } catch (e) {
          log.debug(`Remove fileStream handlers ${id}:`, e.message);
        }
      }

      this.downloadHandlers.delete(id);
    }

    this._removeListeners(request, response, fileStream);
  }

  /**
   * Remueve listeners (fallback)
   */
  _removeListeners(request, response, fileStream) {
    const events = {
      request: ['response', 'error', 'abort', 'close'],
      response: ['data', 'end', 'error', 'aborted', 'close'],
      fileStream: ['drain', 'error', 'finish', 'close'],
    };

    [
      [request, events.request],
      [response, events.response],
      [fileStream, events.fileStream],
    ].forEach(([obj, evts]) => {
      if (obj) {
        evts.forEach(evt => {
          try {
            obj.removeAllListeners(evt);
          } catch (e) {
            log.debug(`Remove listener ${evt}:`, e.message);
          }
        });
      }
    });
  }

  /**
   * Envía progreso a la ventana principal
   */
  /**
   * Envía información de progreso de descarga al frontend mediante IPC
   * 
   * Utiliza el helper centralizado sendIpcProgress para enviar actualizaciones
   * de progreso de manera optimizada al proceso renderer.
   * 
   * @private
   * @param {Object} progressInfo - Información de progreso de la descarga
   * @param {number} progressInfo.id - ID de la descarga
   * @param {string} progressInfo.state - Estado actual de la descarga
   * @param {number} [progressInfo.percent] - Porcentaje completado (0-1)
   * @param {string} [progressInfo.title] - Título del archivo
   * @param {string} [progressInfo.error] - Mensaje de error si hay
   * @returns {void}
   */
  _sendProgress(progressInfo) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (['completed', 'interrupted', 'cancelled'].includes(progressInfo.state)) {
        log.info(`Enviando estado '${progressInfo.state}' para descarga ${progressInfo.id}`);
      }
      this.mainWindow.webContents.send('download-progress', progressInfo);
    }
  }

  /**
   * Calcula el tamaño óptimo de buffer para escritura de archivos
   *
   * Determina un tamaño de buffer apropiado basándose en el tamaño del archivo
   * para balancear rendimiento y uso de memoria. Archivos grandes usan buffers
   * mayores, archivos pequeños usan buffers menores.
   *
   * @private
   * @param {number} fileSize - Tamaño del archivo en bytes
   * @returns {number} Tamaño de buffer recomendado en bytes
   *
   * @example
   * const bufferSize = this._calculateOptimalBufferSize(100000000); // 100 MB
   * // Archivo grande -> buffer más grande (hasta maxWriteBufferSize)
   *
   * const bufferSize2 = this._calculateOptimalBufferSize(5000000); // 5 MB
   * // Archivo pequeño -> buffer por defecto
   */
  _calculateOptimalBufferSize(fileSize) {
    const minSize = config.downloads.minWriteBufferSize || 256 * 1024;
    const maxSize = config.downloads.maxWriteBufferSize || 16 * 1024 * 1024;
    const defaultSize = config.downloads.writeBufferSize || 1024 * 1024;

    // REFUERZO FASE 1: Detectar si es probable que sea un SSD o sistema de alto rendimiento
    // En Windows y macOS, la mayoría de los sistemas modernos usan SSD.
    // Para HDD (o sistemas donde no estamos seguros), un buffer más pequeño evita latencia de cabezal.
    const isHighPerformanceSystem = process.platform === 'win32' || process.platform === 'darwin';
    const performanceMultiplier = isHighPerformanceSystem ? 2 : 1;

    if (!fileSize || fileSize === 0) {
      return defaultSize * performanceMultiplier;
    }

    // Para archivos pequeños, usar buffer más pequeño
    if (fileSize < 10 * 1024 * 1024) {
      // < 10MB
      return Math.min(defaultSize, maxSize);
    }

    // Para archivos grandes, usar buffer más grande (hasta el máximo)
    if (fileSize > 100 * 1024 * 1024) {
      // > 100MB
      return Math.min(maxSize, Math.max(defaultSize * performanceMultiplier, minSize));
    }

    // Archivos medianos: usar tamaño por defecto escalado
    return Math.min(maxSize, defaultSize * performanceMultiplier);
  }

  /**
   * Formatea un número de bytes en una representación legible
   *
   * Convierte bytes a la unidad más apropiada (B, KB, MB, GB, TB) con 2 decimales.
   *
   * @private
   * @param {number} bytes - Número de bytes a formatear
   * @returns {string} String formateado con unidad (ej: "1.5 MB")
   *
   * @example
   * this._formatBytes(1024); // "1 KB"
   * this._formatBytes(1048576); // "1 MB"
   * this._formatBytes(1073741824); // "1 GB"
   * this._formatBytes(0); // "0 B"
   */
  /**
   * Formatea un número de bytes en una representación legible con unidades
   * 
   * Convierte bytes a la unidad más apropiada (B, KB, MB, GB, TB) y
   * formatea el resultado con 2 decimales.
   * 
   * @private
   * @param {number} bytes - Cantidad de bytes a formatear
   * @returns {string} Representación formateada (ej: "1.5 MB", "500 KB")
   * 
   * @example
   * this._formatBytes(1536); // "1.5 KB"
   * this._formatBytes(1048576); // "1 MB"
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

// Exportar instancia única
module.exports = new DownloadManager();
