/**
 * @fileoverview ChunkedDownloader - Descargador Fragmentado con Range Requests
 * @module ChunkedDownloader
 *
 * Implementa descargas paralelas dividiendo archivos grandes en fragmentos (chunks)
 * que se descargan simultáneamente usando HTTP Range headers. Los chunks se descargan
 * en paralelo y luego se fusionan en un archivo completo.
 *
 * Características:
 * - Descarga paralela de múltiples chunks simultáneamente
 * - Soporte de reanudación de chunks individuales
 * - Manejo de backpressure y circuit breakers
 * - Progreso granular por chunk
 * - Fusión automática de chunks al completar
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} ChunkedDownloaderOptions
 * @property {number} downloadId - ID único de la descarga
 * @property {string} url - URL completa del archivo a descargar
 * @property {string} savePath - Ruta completa donde guardar el archivo final
 * @property {number} totalBytes - Tamaño total del archivo en bytes
 * @property {string} title - Título del archivo (para logging)
 * @property {Function} onProgress - Callback de progreso: (info) => void
 * @property {Function} onComplete - Callback de completado: (info) => void
 * @property {Function} onError - Callback de error: (downloader, error) => void
 */

/**
 * @typedef {Object} ChunkProgressInfo
 * @property {number} downloadId - ID de la descarga
 * @property {string} state - Estado actual: 'starting' | 'progressing' | 'completing' | 'completed' | 'error'
 * @property {number} percent - Porcentaje completado (0-1)
 * @property {number} speed - Velocidad de descarga en MB/s
 * @property {number} totalBytes - Tamaño total en bytes
 * @property {number} downloadedBytes - Bytes descargados
 * @property {number} remainingTime - Tiempo restante estimado en segundos
 * @property {boolean} chunked - true (indica descarga fragmentada)
 * @property {number} activeChunks - Chunks activos actualmente
 * @property {number} completedChunks - Chunks completados
 * @property {number} totalChunks - Total de chunks
 * @property {Array<Object>} chunkProgress - Progreso individual de cada chunk
 */

const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const { Worker } = require('worker_threads');
const config = require('./config');
const { logger, safeUnlink } = require('./utils');
const queueDatabase = require('./queueDatabase');
const ProgressBatcher = require('./progressBatcher');
const { CircuitBreaker } = require('./utils/circuitBreaker');
const log = logger.child('ChunkedDownloader');

// Estados de chunk
const ChunkState = Object.freeze({
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  FAILED: 'failed',
});

/**
 * Clase para manejar la descarga de un chunk individual
 *
 * Gestiona la descarga de un fragmento específico de un archivo usando HTTP Range requests.
 * Soporta reanudación automática, tracking de progreso, y manejo de backpressure.
 *
 * @class ChunkDownload
 * @private
 */
class ChunkDownload {
  /**
   * Crea una nueva instancia de ChunkDownload
   *
   * @constructor
   * @param {Object} options - Opciones de configuración del chunk
   * @param {number} options.downloadId - ID de la descarga padre
   * @param {number} options.chunkIndex - Índice del chunk (0-based)
   * @param {number} options.startByte - Byte inicial del chunk
   * @param {number} options.endByte - Byte final del chunk
   * @param {string} options.url - URL del archivo
   * @param {string} options.tempFile - Ruta del archivo temporal del chunk
   * @param {number} [options.downloadedBytes=0] - Bytes ya descargados (para reanudación)
   * @param {string} [options.state='pending'] - Estado inicial del chunk
   * @param {ChunkedDownloader} [options.chunkedDownloader] - Referencia al descargador padre
   * @param {Function} [options.onProgress] - Callback de progreso
   * @param {Function} [options.onComplete] - Callback de completado
   * @param {Function} [options.onError] - Callback de error
   */
  constructor(options) {
    this.downloadId = options.downloadId;
    this.chunkIndex = options.chunkIndex;
    this.startByte = options.startByte;
    this.endByte = options.endByte;
    this.url = options.url;
    this.tempFile = options.tempFile;
    this.downloadedBytes = options.downloadedBytes || 0;
    this.state = options.state || ChunkState.PENDING;

    // Runtime state
    this.request = null;
    this.response = null;
    this.fileStream = null;
    this.startTime = null;
    this.lastUpdate = null;
    this.speed = 0;
    this.isAborted = false;

    // Referencia al ChunkedDownloader padre (para circuit breaker)
    this.chunkedDownloader = options.chunkedDownloader || null;

    // Callbacks
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});
    this.onBackpressure = options.onBackpressure || (() => {}); // Callback para backpressure
  }

  /**
   * Inicia la descarga del chunk
   *
   * Crea una petición HTTP con header Range para descargar solo el fragmento
   * específico del archivo. Soporta reanudación automática si hay bytes ya descargados.
   * Protegido por circuit breaker si está habilitado.
   *
   * @private
   * @returns {Promise<void>}
   *
   * @example
   * // Llamado internamente por ChunkedDownloader
   * await chunk.start();
   */
  async start() {
    if (this.state === ChunkState.COMPLETED) {
      log.debug(`Chunk ${this.chunkIndex} ya completado, saltando`);
      this.onComplete(this);
      return;
    }

    this.state = ChunkState.DOWNLOADING;
    this.startTime = Date.now();
    this.lastUpdate = this.startTime;
    this.isAborted = false;

    // Calcular bytes a descargar considerando reanudación
    const actualStartByte = this.startByte + this.downloadedBytes;
    const bytesToDownload = this.endByte - actualStartByte + 1;

    if (bytesToDownload <= 0) {
      log.debug(`Chunk ${this.chunkIndex} ya tiene todos los bytes, marcando completado`);
      this.state = ChunkState.COMPLETED;
      this.onComplete(this);
      return;
    }

    log.debug(
      `Iniciando chunk ${this.chunkIndex}: bytes ${actualStartByte}-${this.endByte} (${bytesToDownload} bytes)`
    );

    try {
      // Crear directorio si no existe
      const dir = path.dirname(this.tempFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Crear request con Range header (protegido por circuit breaker si está disponible)
      const chunkedDownloader = this.chunkedDownloader;
      let request;

      if (chunkedDownloader?.circuitBreaker && config.circuitBreaker?.enabled) {
        try {
          request = await chunkedDownloader.circuitBreaker.execute(
            async () => {
              const req = net.request(this.url);
              req.setHeader(
                'User-Agent',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              );
              req.setHeader('Referer', 'https://myrient.erista.me/');
              req.setHeader('Accept', '*/*');
              req.setHeader('Connection', 'keep-alive');
              req.setHeader('Range', `bytes=${actualStartByte}-${this.endByte}`);
              return req;
            },
            () => {
              // Fallback: si circuit está abierto, lanzar error
              throw new Error(
                'Circuit breaker abierto: demasiados errores en chunks. Reintentando más tarde...'
              );
            }
          );
        } catch (error) {
          // Circuit breaker rechazó o hubo error
          this._handleError(error);
          return;
        }
      } else {
        request = net.request(this.url);
        request.setHeader(
          'User-Agent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        );
        request.setHeader('Referer', 'https://myrient.erista.me/');
        request.setHeader('Accept', '*/*');
        request.setHeader('Connection', 'keep-alive');
        request.setHeader('Range', `bytes=${actualStartByte}-${this.endByte}`);
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
          log.warn(
            `Chunk ${this.chunkIndex}: timeout después de ${timeout}ms (no se recibió respuesta)`
          );
          try {
            request.abort();
          } catch (e) {
            log.debug(`Error abortando request con timeout: ${e.message}`);
          }
          this._handleError(
            new Error(`Timeout: no se recibió respuesta del servidor en ${timeout}ms`)
          );
        }
      }, timeout);

      this.request = request;
      this.request.on('response', response => {
        clearRequestTimeout();
        this._handleResponse(response, actualStartByte);
      });
      this.request.on('error', error => {
        clearRequestTimeout();
        this._handleError(error);
      });

      this.request.end();
    } catch (error) {
      this._handleError(error);
    }
  }

  /**
   * Maneja la respuesta HTTP
   */
  /**
   * Maneja la respuesta HTTP del servidor para este chunk
   * 
   * Valida el código de estado HTTP y configura el stream de escritura
   * para guardar los datos recibidos en el archivo temporal del chunk.
   * 
   * @private
   * @param {Object} response - Objeto de respuesta HTTP de Electron
   * @param {number} actualStartByte - Byte real desde donde comenzar (puede diferir por reanudación)
   * @returns {void}
   */
  _handleResponse(response, actualStartByte) {
    this.response = response;

    // Verificar código de respuesta (206 = Partial Content)
    if (response.statusCode !== 206 && response.statusCode !== 200) {
      this._handleError(new Error(`HTTP ${response.statusCode}`));
      return;
    }

    // Verificar que el servidor soporta Range
    if (response.statusCode === 200 && actualStartByte > this.startByte) {
      log.warn(`Chunk ${this.chunkIndex}: Servidor no soporta reanudación, reiniciando`);
      this.downloadedBytes = 0;
    }

    // Crear stream de escritura
    const writeMode = this.downloadedBytes > 0 && response.statusCode === 206 ? 'a' : 'w';

    try {
      // Calcular buffer óptimo para este chunk
      const chunkSize = this.endByte - this.startByte + 1;
      const optimalBuffer = this._calculateChunkBufferSize(chunkSize);

      this.fileStream = fs.createWriteStream(this.tempFile, {
        flags: writeMode,
        highWaterMark: optimalBuffer,
      });
      this.fileStream.setMaxListeners(15);
    } catch (error) {
      this._handleError(error);
      return;
    }

    // Variables locales para este chunk
    const chunkTotalBytes = this.endByte - this.startByte + 1;
    let sessionDownloaded = 0;

    // CRÍTICO: Tracking mejorado de backpressure para este chunk
    let chunkBackpressureEvents = 0;
    let chunkBackpressureStartTime = null;
    let chunkDrainEvents = 0;
    let isPaused = false; // Flag para prevenir múltiples pausas
    let drainListener = null; // Referencia al listener para limpieza

    // Handler para errores de escritura
    this.fileStream.on('error', error => {
      log.error(`Chunk ${this.chunkIndex} error de escritura:`, error.message);
      this._handleError(error);
    });

    // CRÍTICO: Handler mejorado para datos con manejo robusto de backpressure
    response.on('data', chunk => {
      if (this.isAborted || !this.fileStream || this.fileStream.destroyed) {
        return;
      }

      // Escribir con backpressure mejorado
      const canContinue = this.fileStream.write(chunk);

      if (!canContinue && !isPaused) {
        // Backpressure detectado - pausar respuesta
        isPaused = true;
        chunkBackpressureEvents++;

        if (!chunkBackpressureStartTime) {
          chunkBackpressureStartTime = Date.now();
        }

        // Notificar al ChunkedDownloader sobre backpressure
        if (this.onBackpressure) {
          this.onBackpressure(this.chunkIndex);
        }

        // Pausar respuesta
        response.pause();

        // CRÍTICO: Crear listener de drain una sola vez si no existe
        // Usar once() en lugar de on() para auto-remover después de ejecutar
        if (!drainListener) {
          drainListener = () => {
            isPaused = false;
            chunkDrainEvents++;

            if (chunkBackpressureStartTime) {
              const duration = Date.now() - chunkBackpressureStartTime;
              if (duration > 100) {
                log.debug(`[Backpressure] Chunk ${this.chunkIndex} drenó después de ${duration}ms`);
              }
              chunkBackpressureStartTime = null;
            }

            if (!this.isAborted && !response.destroyed) {
              response.resume();
            }
          };

          // Usar once() para auto-remover después de ejecutar
          this.fileStream.once('drain', drainListener);
        }
      } else if (canContinue && isPaused) {
        // Sin backpressure - resetear flag si había
        isPaused = false;
        if (chunkBackpressureStartTime) {
          chunkBackpressureStartTime = null;
        }
      }

      // Actualizar progreso
      sessionDownloaded += chunk.length;
      this.downloadedBytes += chunk.length;
      this.lastUpdate = Date.now();

      // Calcular velocidad
      const elapsedSeconds = (this.lastUpdate - this.startTime) / 1000;
      if (elapsedSeconds > 0) {
        this.speed = sessionDownloaded / elapsedSeconds;
      }

      // Notificar progreso
      const progress = this.downloadedBytes / chunkTotalBytes;
      this.onProgress({
        chunkIndex: this.chunkIndex,
        downloadedBytes: this.downloadedBytes,
        totalBytes: chunkTotalBytes,
        progress,
        speed: this.speed,
      });
    });

    // Handler para fin
    response.on('end', () => {
      if (this.isAborted) return;

      if (this.fileStream && !this.fileStream.destroyed) {
        this.fileStream.end(() => {
          // Verificar que descargamos todos los bytes esperados
          const expectedBytes = this.endByte - this.startByte + 1;

          // IMPORTANTE: Asegurar que downloadedBytes sea exactamente igual a expectedBytes
          // Esto evita problemas de redondeo que pueden causar que el progreso muestre 96% en lugar de 100%
          if (this.downloadedBytes >= expectedBytes) {
            // Normalizar a exactamente expectedBytes para evitar problemas de progreso
            this.downloadedBytes = expectedBytes;

            // Enviar una última actualización de progreso al 100% antes de marcar como completado
            // Esto asegura que el frontend vea el chunk al 100% antes de cambiar el estado
            const progress = 1.0; // 100% exacto
            this.onProgress({
              chunkIndex: this.chunkIndex,
              downloadedBytes: this.downloadedBytes,
              totalBytes: expectedBytes,
              progress: progress,
              speed: this.speed,
            });

            log.debug(
              `Chunk ${this.chunkIndex} completado: ${this.downloadedBytes}/${expectedBytes} bytes (${(progress * 100).toFixed(2)}%)`
            );
            this.state = ChunkState.COMPLETED;
            this.onComplete(this);
          } else {
            log.warn(
              `Chunk ${this.chunkIndex} incompleto: ${this.downloadedBytes}/${expectedBytes} bytes`
            );
            this._handleError(
              new Error(`Descarga incompleta: ${this.downloadedBytes}/${expectedBytes}`)
            );
          }
        });
      }
    });

    // Handler para errores de response
    response.on('error', error => {
      if (!error.message.includes('aborted')) {
        this._handleError(error);
      }
    });

    // Handler para cierre prematuro
    response.on('close', () => {
      if (!this.isAborted && this.state === ChunkState.DOWNLOADING) {
        const expectedBytes = this.endByte - this.startByte + 1;
        if (this.downloadedBytes < expectedBytes) {
          log.warn(`Chunk ${this.chunkIndex} cerrado prematuramente`);
          // No marcar como error, mantener para reanudación
          this.state = ChunkState.PAUSED;
        }
      }
    });
  }

  /**
   * Calcula el tamaño óptimo de buffer para este chunk
   * @param {number} chunkSize - Tamaño del chunk en bytes
   * @returns {number} Tamaño de buffer recomendado
   */
  /**
   * Calcula el tamaño óptimo del buffer de escritura para un chunk específico
   * 
   * El tamaño del buffer se adapta según el tamaño del chunk para optimizar
   * el rendimiento de escritura en disco.
   * 
   * @private
   * @param {number} chunkSize - Tamaño total del chunk en bytes
   * @returns {number} Tamaño del buffer en bytes
   */
  _calculateChunkBufferSize(chunkSize) {
    const minSize = config.downloads.minWriteBufferSize || 256 * 1024;
    const maxSize = config.downloads.maxWriteBufferSize || 16 * 1024 * 1024;
    const defaultSize =
      config.downloads.chunked?.chunkWriteBufferSize ||
      config.downloads.writeBufferSize ||
      1024 * 1024;

    // Para chunks pequeños, usar buffer más pequeño
    if (chunkSize < 5 * 1024 * 1024) {
      // < 5MB
      return Math.min(defaultSize, maxSize);
    }

    // Para chunks grandes, usar buffer más grande
    if (chunkSize > 50 * 1024 * 1024) {
      // > 50MB
      return Math.min(maxSize, Math.max(defaultSize * 2, minSize));
    }

    return defaultSize;
  }

  /**
   * Maneja errores
   */
  /**
   * Maneja errores durante la descarga del chunk
   * 
   * Actualiza el estado del chunk a FAILED y realiza limpieza de recursos.
   * Notifica el error a través del callback onError.
   * 
   * @private
   * @param {Error} error - Error que ocurrió durante la descarga
   * @returns {void}
   */
  _handleError(error) {
    if (this.isAborted) return;

    log.error(`Chunk ${this.chunkIndex} error:`, error.message);

    // Nota: El circuit breaker ya registró el error en su método execute()
    // cuando el request falló. Aquí solo actualizamos el estado del chunk.
    this.state = ChunkState.FAILED;

    this._cleanup(false);
    this.onError(this, error);
  }

  /**
   * Pausa la descarga del chunk
   */
  pause() {
    if (this.state !== ChunkState.DOWNLOADING) return;

    log.debug(`Pausando chunk ${this.chunkIndex}`);
    this.isAborted = true;
    this.state = ChunkState.PAUSED;

    this._cleanup(true); // Mantener archivo temporal
  }

  /**
   * Aborta y limpia
   */
  abort(keepTempFile = false) {
    this.isAborted = true;
    this._cleanup(keepTempFile);
  }

  /**
   * Limpia recursos
   */
  /**
   * Limpia recursos utilizados por el chunk durante la descarga
   * 
   * Cierra streams, aborta requests HTTP y opcionalmente elimina el archivo temporal.
   * 
   * @private
   * @param {boolean} [keepTempFile=true] - Si mantener el archivo temporal (útil para reanudación)
   * @returns {void}
   */
  _cleanup(keepTempFile = true) {
    // Abortar request
    if (this.request) {
      try {
        this.request.abort();
      } catch (e) {
        log.debug(`Chunk ${this.chunkIndex} cleanup request: ${e.message}`);
      }
      this.request = null;
    }

    // Cerrar response
    if (this.response) {
      try {
        this.response.removeAllListeners();
        if (!this.response.destroyed) {
          this.response.destroy();
        }
      } catch (e) {
        log.debug(`Chunk ${this.chunkIndex} cleanup response: ${e.message}`);
      }
      this.response = null;
    }

    // CRÍTICO: Cerrar fileStream y limpiar listener de drain
    if (this.fileStream) {
      try {
        // Remover listener de drain si existe (previene memory leaks)
        if (this.drainListener) {
          this.fileStream.removeListener('drain', this.drainListener);
          this.drainListener = null;
        }
        this.fileStream.removeAllListeners();
        if (!this.fileStream.destroyed) {
          this.fileStream.end();
        }
      } catch (e) {
        log.debug(`Chunk ${this.chunkIndex} cleanup fileStream: ${e.message}`);
      }
      this.fileStream = null;
    }

    // Eliminar archivo temporal si se requiere
    if (!keepTempFile && this.tempFile && fs.existsSync(this.tempFile)) {
      safeUnlink(this.tempFile);
    }
  }

  /**
   * Obtiene el estado serializable
   */
  toJSON() {
    return {
      downloadId: this.downloadId,
      chunkIndex: this.chunkIndex,
      startByte: this.startByte,
      endByte: this.endByte,
      downloadedBytes: this.downloadedBytes,
      state: this.state,
      tempFile: this.tempFile,
      speed: this.speed,
    };
  }
}

/**
 * Clase principal para descargas fragmentadas
 *
 * Gestiona la descarga de archivos grandes dividiéndolos en múltiples chunks
 * que se descargan en paralelo. Coordina todos los chunks, maneja el progreso
 * agregado, y fusiona los chunks en el archivo final cuando todos completan.
 *
 * @class ChunkedDownloader
 *
 * @example
 * const downloader = new ChunkedDownloader({
 *   downloadId: 12345,
 *   url: 'https://myrient.erista.me/files/large.zip',
 *   savePath: 'C:/Downloads/large.zip',
 *   totalBytes: 1000000000, // 1GB
 *   title: 'large.zip',
 *   onProgress: (info) => {
 *     console.log(`Progreso: ${(info.percent * 100).toFixed(1)}%`);
 *     console.log(`Velocidad: ${info.speed.toFixed(2)} MB/s`);
 *     console.log(`Chunks activos: ${info.activeChunks}/${info.totalChunks}`);
 *   },
 *   onComplete: (info) => {
 *     console.log(`Descarga completada: ${info.savePath}`);
 *   },
 *   onError: (downloader, error) => {
 *     console.error('Error en descarga:', error.message);
 *   }
 * });
 *
 * // Iniciar descarga
 * await downloader.start();
 *
 * // Pausar descarga
 * downloader.pause();
 *
 * // Reanudar descarga
 * await downloader.start();
 *
 * // Cancelar descarga
 * downloader.cancel();
 */
class ChunkedDownloader {
  /**
   * Crea una nueva instancia de ChunkedDownloader
   *
   * @constructor
   * @param {ChunkedDownloaderOptions} options - Opciones de configuración
   */
  constructor(options) {
    this.downloadId = options.downloadId;
    this.url = options.url;
    this.savePath = options.savePath;
    this.totalBytes = options.totalBytes;
    this.title = options.title || path.basename(options.savePath);

    // Calcular número óptimo de chunks
    this.numChunks = options.numChunks || this._calculateOptimalChunks(options.totalBytes);

    // Estado
    this.chunks = [];
    this.activeChunks = new Map();
    this.state = 'idle'; // idle, downloading, paused, completed, failed, merging
    this.startTime = null;
    this.lastUpdate = null; // Última actualización de actividad (para detección de zombies)
    this.completedChunks = 0;
    this.totalDownloadedBytes = 0;
    this.isAborted = false;
    this.mergeInProgress = false;
    this.mergeWorker = null; // Worker thread para merge
    this.completionCheckTimeout = null; // Timeout para verificación de seguridad de completado
    this.stallCheckInterval = null; // Intervalo para detectar chunks estancados (zombies)
    this.lastStallCheck = Date.now();

    // Callbacks
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.onError = options.onError || (() => {});

    // Configuración
    this.maxConcurrentChunks = config.downloads.chunked?.maxConcurrentChunks || 4;
    this.chunkRetries = config.downloads.chunked?.chunkRetries || 3;

    // Concurrencia adaptativa
    this.adaptiveConcurrency = config.downloads.chunked?.adaptiveConcurrency || false;
    this.currentConcurrency = this.maxConcurrentChunks;
    this.backpressureCount = 0;

    // Tracking mejorado de backpressure
    this.backpressureStats = {
      totalEvents: 0,
      activeChunksWithBackpressure: new Set(),
      lastBackpressureEvent: null,
      backpressureHistory: [], // Últimos 10 eventos para análisis
    };

    // Throttling interno ligero para actualizaciones de progreso de chunks
    // El progressThrottler maneja el throttling principal (200ms), pero este
    // throttling ligero reduce las llamadas innecesarias cuando hay múltiples chunks
    this.lastProgressUpdate = 0;
    this.progressUpdateInterval = 50; // ms - actualizar cada 50ms como máximo (suficientemente frecuente)

    // Progress batcher
    this.progressBatcher = new ProgressBatcher(
      queueDatabase,
      config.downloads.chunked?.dbBatchInterval || 2000
    );

    // Circuit Breaker para errores de chunks (más tolerante que descargas simples)
    if (config.circuitBreaker?.enabled) {
      const cbConfig = config.circuitBreaker.chunk || {};
      this.circuitBreaker = new CircuitBreaker({
        name: `ChunkedDownloader-${this.downloadId}`,
        failureThreshold: cbConfig.failureThreshold || 10, // Más tolerante
        successThreshold: cbConfig.successThreshold || 3,
        timeout: cbConfig.timeout || 30000, // Más corto para chunks
        resetTimeout: cbConfig.resetTimeout || 30000,
        onStateChange: info => {
          log.warn(
            `[CircuitBreaker:Chunked-${this.downloadId}] Estado: ${info.oldState} -> ${info.newState}`
          );
          if (info.newState === 'OPEN') {
            // Notificar al callback de error si todos los chunks están fallando
            this.onError(this, new Error('Circuit breaker abierto: demasiados errores en chunks'));
          }
        },
      });
    } else {
      this.circuitBreaker = null;
    }

    log.info(
      `ChunkedDownloader creado: ${this.title} (${this._formatBytes(this.totalBytes)}, ${this.numChunks} chunks)`
    );
  }

  /**
   * Calcula el número óptimo de chunks basado en el tamaño del archivo
   */
  /**
   * Calcula el número óptimo de chunks para dividir una descarga
   * 
   * El número de chunks se ajusta según el tamaño total del archivo para
   * equilibrar el paralelismo y la sobrecarga de gestión.
   * 
   * @private
   * @param {number} totalBytes - Tamaño total del archivo en bytes
   * @returns {number} Número óptimo de chunks (entre 2 y maxChunks)
   */
  _calculateOptimalChunks(totalBytes) {
    const minChunkSize = config.downloads.chunked?.minChunkSize || 5 * 1024 * 1024; // 5 MB mínimo
    const maxChunks = config.downloads.chunked?.maxChunks || 16;
    const defaultChunks = config.downloads.chunked?.defaultChunks || 4;

    // Archivos pequeños: menos chunks
    if (totalBytes < 50 * 1024 * 1024) {
      // < 50 MB
      return 2;
    }

    // Calcular chunks para mantener tamaño mínimo
    const calculatedChunks = Math.floor(totalBytes / minChunkSize);

    // Limitar entre 2 y maxChunks
    return Math.min(Math.max(calculatedChunks, 2), maxChunks);
  }

  /**
   * Inicia el detector de chunks estancados (zombies)
   * @private
   */
  /**
   * Inicia el detector de chunks estancados (stall detector)
   * 
   * Configura un intervalo que periódicamente verifica si algún chunk activo
   * no ha reportado progreso recientemente y podría estar estancado.
   * 
   * @private
   * @returns {void}
   */
  _startStallCheck() {
    this._stopStallCheck(); // Asegurar limpieza previa

    log.debug(`[StallDetector] Iniciando detector para descarga ${this.downloadId}`);
    this.stallCheckInterval = setInterval(() => {
      this._checkStalledChunks();
    }, 10000); // Verificar cada 10 segundos
  }

  /**
   * Detiene el detector de chunks estancados
   * @private
   */
  /**
   * Detiene el detector de chunks estancados
   * 
   * Limpia el intervalo de verificación para liberar recursos.
   * 
   * @private
   * @returns {void}
   */
  _stopStallCheck() {
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
      log.debug(`[StallDetector] Detenido detector para descarga ${this.downloadId}`);
    }
  }

  /**
   * Verifica si hay chunks activos que no han reportado progreso recientemente
   * @private
   */
  /**
   * Verifica si hay chunks activos que no han reportado progreso recientemente
   * 
   * Identifica chunks que pueden estar estancados (stalled) y los reinicia
   * para recuperar la descarga. Se ejecuta periódicamente mientras la descarga está activa.
   * 
   * @private
   * @returns {void}
   */
  _checkStalledChunks() {
    // Solo verificar si estamos descargando activamente y no estamos en medio de un merge
    if (this.isAborted || this.state !== 'downloading' || this.mergeInProgress) {
      return;
    }

    const now = Date.now();
    const STALL_THRESHOLD = 20000; // 20 segundos sin actividad = estancado
    let stalledCount = 0;

    this.activeChunks.forEach((chunk, index) => {
      // Un chunk está estancado si:
      // 1. Está en la lista de activos
      // 2. Han pasado más de STALL_THRESHOLD ms desde su último progreso
      // 3. No está completado
      const lastActivity = chunk.lastUpdate || chunk.startTime || now;
      const timeSinceLastUpdate = now - lastActivity;

      if (timeSinceLastUpdate > STALL_THRESHOLD && chunk.state !== ChunkState.COMPLETED) {
        log.warn(
          `[StallDetector] Chunk ${index} estancado detectado (${(timeSinceLastUpdate / 1000).toFixed(1)}s sin actividad). Reiniciando conexión...`
        );

        stalledCount++;

        // 1. Abortar la conexión actual del chunk
        chunk.abort(true); // Mantener el archivo temporal para reanudar

        // 2. Remover de la lista de activos del manager
        this.activeChunks.delete(index);

        // 3. Marcar como pausado para que el bucle de control lo recoja
        chunk.state = ChunkState.PAUSED;
      }
    });

    if (stalledCount > 0) {
      log.info(`[StallDetector] Re-lanzando ${stalledCount} chunks estancados...`);
      this._startPendingChunks();
    }
  }

  /**
   * Ajusta la concurrencia dinámicamente basado en rendimiento y backpressure
   */
  /**
   * Ajusta dinámicamente el nivel de concurrencia basado en el rendimiento
   * 
   * Analiza el rendimiento de los chunks activos (velocidad, backpressure) y ajusta
   * el número máximo de chunks concurrentes para optimizar la velocidad de descarga.
   * 
   * @private
   * @returns {void}
   */
  _adjustConcurrency() {
    if (!this.adaptiveConcurrency) return;

    // Calcular velocidad promedio de chunks activos
    let totalSpeed = 0;
    let activeCount = 0;
    let chunksWithBackpressure = 0;

    this.activeChunks.forEach(chunk => {
      if (chunk.speed > 0) {
        totalSpeed += chunk.speed;
        activeCount++;
      }
      // Detectar chunks con backpressure activo
      // (esto se actualiza cuando un chunk reporta backpressure)
      if (this.backpressureStats.activeChunksWithBackpressure.has(chunk.chunkIndex)) {
        chunksWithBackpressure++;
      }
    });

    if (activeCount === 0) return;

    const avgSpeed = totalSpeed / activeCount;
    const targetSpeed = config.downloads.chunked?.targetSpeedPerChunk || 5 * 1024 * 1024;
    const backpressureThreshold = config.downloads.chunked?.backpressureThreshold || 5;

    // Calcular ratio de chunks con backpressure
    const backpressureRatio = activeCount > 0 ? chunksWithBackpressure / activeCount : 0;

    // Si hay muchos chunks con backpressure, reducir concurrencia más agresivamente
    if (backpressureRatio > 0.5 && this.currentConcurrency > 2) {
      // Más del 50% de chunks tienen backpressure - reducir inmediatamente
      this.currentConcurrency = Math.max(2, this.currentConcurrency - 1);
      log.info(
        `[Backpressure] Concurrencia reducida a ${this.currentConcurrency} (${Math.round(backpressureRatio * 100)}% chunks con backpressure)`
      );
      this.backpressureCount = 0;
      this.backpressureStats.activeChunksWithBackpressure.clear();
      return;
    }

    // Si velocidad es baja y no hay mucho backpressure, aumentar concurrencia
    if (
      avgSpeed < targetSpeed &&
      this.backpressureCount < backpressureThreshold &&
      backpressureRatio < 0.3
    ) {
      if (this.currentConcurrency < this.maxConcurrentChunks) {
        this.currentConcurrency = Math.min(this.currentConcurrency + 1, this.maxConcurrentChunks);
        log.debug(
          `[Backpressure] Concurrencia aumentada a ${this.currentConcurrency} (velocidad: ${this._formatBytes(avgSpeed)}/s)`
        );
      }
    }
    // Si hay backpressure moderado, reducir gradualmente
    else if (this.backpressureCount >= backpressureThreshold || backpressureRatio > 0.3) {
      if (this.currentConcurrency > 2) {
        this.currentConcurrency = Math.max(2, this.currentConcurrency - 1);
        log.info(
          `[Backpressure] Concurrencia reducida a ${this.currentConcurrency} (eventos: ${this.backpressureCount}, ratio: ${Math.round(backpressureRatio * 100)}%)`
        );
      }
      this.backpressureCount = 0; // Reset counter
      this.backpressureStats.activeChunksWithBackpressure.clear();
    }
  }

  /**
   * Calcula el tamaño óptimo de buffer para un chunk
   * @param {number} chunkSize - Tamaño del chunk en bytes
   * @returns {number} Tamaño de buffer recomendado
   */
  _calculateChunkBufferSize(chunkSize) {
    const minSize = config.downloads.minWriteBufferSize || 256 * 1024;
    const maxSize = config.downloads.maxWriteBufferSize || 16 * 1024 * 1024;
    const defaultSize = config.downloads.writeBufferSize || 1024 * 1024;

    // Para chunks pequeños, usar buffer más pequeño
    if (chunkSize < 5 * 1024 * 1024) {
      // < 5MB
      return Math.min(defaultSize, maxSize);
    }

    // Para chunks grandes, usar buffer más grande
    if (chunkSize > 50 * 1024 * 1024) {
      // > 50MB
      return Math.min(maxSize, Math.max(defaultSize * 2, minSize));
    }

    return defaultSize;
  }

  /**
   * Crea un archivo pre localizado
   */
  async _preallocateFile() {
    if (!config.downloads.chunked?.preallocateFile) return;
    if (this.totalBytes <= 0) return;

    try {
      // Solo pre-allocar si el archivo no existe
      if (!fs.existsSync(this.savePath)) {
        const fd = await fs.promises.open(this.savePath, 'w');
        await fd.truncate(this.totalBytes);
        await fd.close();
        log.info(`Pre-allocated ${this._formatBytes(this.totalBytes)} para ${this.title}`);
      }
    } catch (e) {
      log.warn('Pre-allocation falló:', e.message);
      // No es crítico, continuar sin pre-allocation
    }
  }

  /**
   * Inicia la descarga fragmentada
   *
   * Inicializa los chunks (recupera existentes de BD o crea nuevos), pre-asigna
   * espacio en disco si está habilitado, y comienza a descargar chunks pendientes
   * en paralelo. Envía progreso inicial para que el frontend vea todos los chunks.
   *
   * @returns {Promise<boolean>} true si se inició correctamente, false si ya estaba en progreso o hubo error
   *
   * @example
   * const downloader = new ChunkedDownloader({ /* opciones *\/ });
   *
   * // Iniciar descarga
   * const started = await downloader.start();
   * if (started) {
   *   console.log('Descarga fragmentada iniciada');
   *   // Los callbacks onProgress se llamarán automáticamente durante la descarga
   * }
   *
   * // Reanudar descarga pausada
   * if (downloader.state === 'paused') {
   *   await downloader.start(); // También funciona para reanudar
   * }
   */
  async start() {
    if (this.state === 'downloading') {
      log.warn('Descarga ya en progreso');
      return false;
    }

    log.info(`Iniciando descarga fragmentada: ${this.title}`);
    this.state = 'downloading';
    this.startTime = Date.now();
    this.lastUpdate = Date.now(); // Inicializar lastUpdate al iniciar
    this.isAborted = false;

    try {
      // Verificar o crear chunks en la BD
      await this._initializeChunks();

      // NUEVO: Pre-allocar espacio
      await this._preallocateFile();

      // Iniciar chunks pendientes
      await this._startPendingChunks();

      // IMPORTANTE: Enviar progreso inicial con todos los chunks
      // Esto asegura que el frontend vea todos los chunks desde el inicio
      this._sendInitialProgress();

      // INICIAR: Detector de chunks estancados (zombies)
      this._startStallCheck();

      return true;
    } catch (error) {
      log.error('Error iniciando descarga fragmentada:', error);
      this.state = 'failed';
      this.onError(this, error);
      return false;
    }
  }

  /**
   * Inicializa los chunks (crea nuevos o recupera existentes)
   */
  async _initializeChunks() {
    // Intentar recuperar chunks existentes de la BD
    const existingChunks = queueDatabase.getChunks(this.downloadId);

    if (existingChunks && existingChunks.length > 0) {
      log.info(`Recuperando ${existingChunks.length} chunks existentes`);

      this.chunks = existingChunks.map(
        dbChunk =>
          new ChunkDownload({
            downloadId: this.downloadId,
            chunkIndex: dbChunk.chunk_index,
            startByte: dbChunk.start_byte,
            endByte: dbChunk.end_byte,
            downloadedBytes: dbChunk.downloaded_bytes || 0,
            state: dbChunk.state || ChunkState.PENDING,
            tempFile: dbChunk.temp_file || this._getChunkTempFile(dbChunk.chunk_index),
            url: this.url,
            chunkedDownloader: this, // Referencia al ChunkedDownloader para circuit breaker
            onProgress: info => this._onChunkProgress(info),
            onComplete: chunk => this._onChunkComplete(chunk),
            onError: (chunk, error) => this._onChunkError(chunk, error),
            onBackpressure: chunkIndex => this._onChunkBackpressure(chunkIndex),
          })
      );

      // VALIDACIÍ“N CRÍTICA: Verificar que los chunks "completados" realmente tengan
      // el archivo temporal con el tamaño correcto.
      let chunksFixed = 0;

      // DEBUG: Log de estados antes de validación
      const statesSummary = {};
      this.chunks.forEach(c => {
        statesSummary[c.state] = (statesSummary[c.state] || 0) + 1;
      });
      log.debug(`Estados de chunks antes de validación: ${JSON.stringify(statesSummary)}`);

      for (const chunk of this.chunks) {
        // Normalizar estados que quedaron en 'downloading' de una sesión anterior
        if (chunk.state === ChunkState.DOWNLOADING || chunk.state === 'downloading') {
          log.debug(
            `Chunk ${chunk.chunkIndex}: estado 'downloading' de sesión anterior, reseteando a pending`
          );
          chunk.state = ChunkState.PENDING;

          // Sincronizar con archivo temporal si existe
          if (chunk.tempFile && fs.existsSync(chunk.tempFile)) {
            try {
              const stats = fs.statSync(chunk.tempFile);
              chunk.downloadedBytes = stats.size;
            } catch (e) {
              chunk.downloadedBytes = 0;
            }
          } else {
            chunk.downloadedBytes = 0;
          }

          queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
            downloadedBytes: chunk.downloadedBytes,
            state: ChunkState.PENDING,
          });
          chunksFixed++;
        }
        // Normalizar estado 'failed' - también debe reintentar
        else if (chunk.state === ChunkState.FAILED || chunk.state === 'failed') {
          log.debug(
            `Chunk ${chunk.chunkIndex}: estado 'failed', reseteando a pending para reintentar`
          );
          chunk.state = ChunkState.PENDING;

          // Sincronizar con archivo temporal si existe
          if (chunk.tempFile && fs.existsSync(chunk.tempFile)) {
            try {
              const stats = fs.statSync(chunk.tempFile);
              chunk.downloadedBytes = stats.size;
            } catch (e) {
              chunk.downloadedBytes = 0;
            }
          } else {
            chunk.downloadedBytes = 0;
          }

          queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
            downloadedBytes: chunk.downloadedBytes,
            state: ChunkState.PENDING,
          });
          chunksFixed++;
        } else if (chunk.state === ChunkState.COMPLETED) {
          const expectedSize = chunk.endByte - chunk.startByte + 1;

          if (!fs.existsSync(chunk.tempFile)) {
            // Archivo no existe, resetear chunk
            log.warn(
              `Chunk ${chunk.chunkIndex}: marcado como completado pero archivo no existe, reiniciando`
            );
            chunk.state = ChunkState.PENDING;
            chunk.downloadedBytes = 0;
            chunksFixed++;

            queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
              downloadedBytes: 0,
              state: ChunkState.PENDING,
            });
          } else {
            try {
              const stats = fs.statSync(chunk.tempFile);
              if (stats.size < expectedSize) {
                // Archivo incompleto, resetear chunk
                log.warn(
                  `Chunk ${chunk.chunkIndex}: archivo incompleto (${stats.size}/${expectedSize} bytes), reiniciando`
                );
                chunk.state = ChunkState.PENDING;
                chunk.downloadedBytes = stats.size;
                chunksFixed++;

                queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                  downloadedBytes: stats.size,
                  state: ChunkState.PENDING,
                });
              }
            } catch (e) {
              // Error leyendo archivo, resetear chunk
              log.warn(
                `Chunk ${chunk.chunkIndex}: error verificando archivo (${e.message}), reiniciando`
              );
              chunk.state = ChunkState.PENDING;
              chunk.downloadedBytes = 0;
              chunksFixed++;

              queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                downloadedBytes: 0,
                state: ChunkState.PENDING,
              });
            }
          }
        } else if (chunk.state === ChunkState.PENDING || chunk.state === ChunkState.PAUSED) {
          // Para chunks pendientes/pausados, sincronizar con tamaño real del archivo
          if (fs.existsSync(chunk.tempFile)) {
            try {
              const stats = fs.statSync(chunk.tempFile);
              if (stats.size !== chunk.downloadedBytes) {
                log.debug(
                  `Chunk ${chunk.chunkIndex}: sincronizando bytes (archivo: ${stats.size}, BD: ${chunk.downloadedBytes})`
                );
                chunk.downloadedBytes = stats.size;

                queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                  downloadedBytes: stats.size,
                });
              }
            } catch (e) {
              // Ignorar errores de lectura
            }
          } else if (chunk.downloadedBytes > 0) {
            // Archivo no existe pero BD dice que hay bytes descargados
            log.debug(`Chunk ${chunk.chunkIndex}: archivo no existe, reseteando downloadedBytes`);
            chunk.downloadedBytes = 0;

            queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
              downloadedBytes: 0,
            });
          }
        }
      }

      if (chunksFixed > 0) {
        log.info(`Corregidos ${chunksFixed} chunks con estado inconsistente`);
      }

      // Calcular bytes ya descargados (después de la validación)
      this.totalDownloadedBytes = this.chunks.reduce((sum, c) => sum + c.downloadedBytes, 0);
      this.completedChunks = this.chunks.filter(c => c.state === ChunkState.COMPLETED).length;

      log.info(
        `Estado recuperado: ${this.completedChunks}/${this.chunks.length} completados, ${this._formatBytes(this.totalDownloadedBytes)} descargados`
      );
    } else {
      log.info(`Creando ${this.numChunks} nuevos chunks`);

      // Crear chunks en la BD
      const dbChunks = queueDatabase.createChunks(this.downloadId, this.totalBytes, this.numChunks);

      // Crear objetos ChunkDownload
      this.chunks = dbChunks.map(
        (dbChunk, index) =>
          new ChunkDownload({
            downloadId: this.downloadId,
            chunkIndex: index,
            startByte: dbChunk.startByte,
            endByte: dbChunk.endByte,
            downloadedBytes: 0,
            state: ChunkState.PENDING,
            tempFile: this._getChunkTempFile(index),
            url: this.url,
            chunkedDownloader: this, // Referencia al ChunkedDownloader para circuit breaker
            onProgress: info => this._onChunkProgress(info),
            onComplete: chunk => this._onChunkComplete(chunk),
            onError: (chunk, error) => this._onChunkError(chunk, error),
            onBackpressure: chunkIndex => this._onChunkBackpressure(chunkIndex),
          })
      );

      // Actualizar temp_file en BD
      this.chunks.forEach(chunk => {
        queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
          tempFile: chunk.tempFile,
          state: ChunkState.PENDING,
          downloadedBytes: 0,
        });
      });
    }
  }

  /**
   * Genera la ruta del archivo temporal para un chunk
   */
  _getChunkTempFile(chunkIndex) {
    const dir = path.dirname(this.savePath);
    const base = path.basename(this.savePath);
    return path.join(dir, `.${base}.chunk${chunkIndex}`);
  }

  /**
   * Inicia los chunks pendientes respetando el límite de concurrencia
   */
  async _startPendingChunks() {
    if (this.isAborted) return;

    // Obtener chunks que necesitan descarga
    const pendingChunks = this.chunks.filter(
      c => c.state === ChunkState.PENDING || c.state === ChunkState.PAUSED
    );

    // Calcular cuántos slots disponibles hay
    const activeCount = this.activeChunks.size;
    const slotsAvailable = this.currentConcurrency - activeCount;

    if (slotsAvailable <= 0 || pendingChunks.length === 0) {
      return;
    }

    // Iniciar chunks hasta llenar los slots
    const chunksToStart = pendingChunks.slice(0, slotsAvailable);

    log.debug(
      `Iniciando ${chunksToStart.length} chunks (${activeCount} activos, ${slotsAvailable} slots)`
    );

    for (const chunk of chunksToStart) {
      if (this.isAborted) break;

      this.activeChunks.set(chunk.chunkIndex, chunk);

      // Iniciar chunk (no await para paralelismo)
      chunk.start().catch(error => {
        log.error(`Error iniciando chunk ${chunk.chunkIndex}:`, error);
      });
    }
  }

  /**
   * Callback cuando un chunk reporta backpressure
   */
  _onChunkBackpressure(chunkIndex) {
    if (this.isAborted) return;

    // Registrar backpressure para este chunk
    this.backpressureStats.activeChunksWithBackpressure.add(chunkIndex);
    this.backpressureStats.totalEvents++;
    this.backpressureStats.lastBackpressureEvent = Date.now();

    // Agregar a historial (mantener últimos 10)
    this.backpressureStats.backpressureHistory.push({
      chunkIndex,
      timestamp: Date.now(),
    });
    if (this.backpressureStats.backpressureHistory.length > 10) {
      this.backpressureStats.backpressureHistory.shift();
    }

    // Incrementar contador global
    this.backpressureCount++;

    // Ajustar concurrencia si hay mucho backpressure
    if (this.backpressureCount >= (config.downloads.chunked?.backpressureThreshold || 5)) {
      this._adjustConcurrency();
    }
  }

  /**
   * Callback cuando un chunk reporta progreso
   */
  _onChunkProgress(info) {
    if (this.isAborted) return;

    // Si el chunk está progresando, remover de backpressure activo
    // (se volverá a agregar si hay nuevo backpressure)
    if (this.backpressureStats.activeChunksWithBackpressure.has(info.chunkIndex)) {
      // Solo remover si ha pasado tiempo desde el último backpressure
      const lastEvent = this.backpressureStats.backpressureHistory
        .filter(e => e.chunkIndex === info.chunkIndex)
        .pop();
      if (lastEvent && Date.now() - lastEvent.timestamp > 2000) {
        this.backpressureStats.activeChunksWithBackpressure.delete(info.chunkIndex);
      }
    }

    // Actualizar el chunk específico que reportó progreso INMEDIATAMENTE
    // Esto asegura que cuando calculamos chunkProgress, tenga la información más actualizada
    const chunk = this.chunks.find(c => c.chunkIndex === info.chunkIndex);
    if (chunk) {
      // IMPORTANTE: Si el chunk está completado, asegurar que downloadedBytes sea exactamente igual al tamaño del chunk
      // Esto evita problemas de redondeo
      const chunkSize = chunk.endByte - chunk.startByte + 1;
      if (chunk.state === ChunkState.COMPLETED) {
        chunk.downloadedBytes = chunkSize; // Asegurar exactitud
      } else {
        // IMPORTANTE: Actualizar downloadedBytes y speed inmediatamente para que estén disponibles
        // cuando calculamos chunkProgress más abajo
        chunk.downloadedBytes = info.downloadedBytes;
        chunk.speed = info.speed || 0; // Asegurar que speed esté definido
        chunk.lastUpdate = Date.now();
      }
    }

    // Actualiza la base de datos con batcher (esto puede ser más lento, está bien)
    this.progressBatcher.queueChunkUpdate(this.downloadId, info.chunkIndex, {
      downloadedBytes: info.downloadedBytes,
      state: ChunkState.DOWNLOADING,
    });

    // Throttling interno ligero: solo enviar actualizaciones cada X ms
    // IMPORTANTE: Siempre actualizamos los datos del chunk arriba, incluso si no enviamos la actualización
    // Esto asegura que cuando calculamos chunkProgress, tenga la información más actualizada
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastProgressUpdate;
    const shouldUpdate =
      timeSinceLastUpdate >= this.progressUpdateInterval || this.lastProgressUpdate === 0;

    // Si no debemos actualizar aún, simplemente retornar
    // El progressThrottler manejará el throttling final
    // La próxima actualización incluirá todos los cambios acumulados porque los datos del chunk ya están actualizados
    if (!shouldUpdate) {
      return;
    }

    // Actualizar timestamp de última actualización
    this.lastProgressUpdate = now;

    // Llamar al método que calcula y envía el progreso
    this._sendProgressUpdate();

    // Ajustar concurrencia periódicamente
    this._adjustConcurrency();
  }

  /**
   * Calcula el progreso total de todos los chunks
   * @private
   * @returns {Object} Objeto con totalDownloaded y overallProgress
   */
  _calculateTotalProgress() {
    const totalDownloaded = this.chunks.reduce((sum, c) => sum + (c.downloadedBytes || 0), 0);
    const overallProgress = this.totalBytes > 0 ? totalDownloaded / this.totalBytes : 0;
    return { totalDownloaded, overallProgress };
  }

  /**
   * Calcula la velocidad total sumando las velocidades de todos los chunks activos
   * @private
   * @returns {number} Velocidad total en bytes/segundo
   */
  _calculateTotalSpeed() {
    let totalSpeed = 0;
    for (const [chunkIndex, activeChunk] of this.activeChunks.entries()) {
      if (activeChunk && activeChunk.speed) {
        totalSpeed += activeChunk.speed;
      }
    }
    return totalSpeed;
  }

  /**
   * Calcula el progreso individual de cada chunk y retorna un array con información detallada
   * @private
   * @returns {Array<Object>} Array con información de progreso de cada chunk
   */
  _calculateChunkProgress() {
    // IMPORTANTE: Incluir TODOS los chunks en chunkProgress, no solo los activos
    // Esto asegura que el frontend vea todos los chunks desde el inicio
    // Usar los datos ACTUALIZADOS de cada chunk
    return this.chunks.map(c => {
      const chunkSize = c.endByte - c.startByte + 1;

      // IMPORTANTE: Si el chunk está completado, el progreso debe ser exactamente 1.0 (100%)
      // Esto evita problemas de redondeo que pueden causar que muestre 96% en lugar de 100%
      let progress;
      if (c.state === ChunkState.COMPLETED) {
        // Chunk completado: progreso exacto al 100%
        progress = 1.0;
        // Asegurar que downloadedBytes sea exactamente igual al tamaño del chunk
        c.downloadedBytes = chunkSize;
      } else if (chunkSize > 0 && c.downloadedBytes !== undefined) {
        // Chunk en progreso: calcular progreso usando downloadedBytes ACTUALIZADO
        progress = Math.min(1.0, c.downloadedBytes / chunkSize);
      } else {
        progress = 0;
      }

      // Si el chunk está activo, usar su velocidad actual; si no, 0
      const isActive = this.activeChunks.has(c.chunkIndex);
      const speed = isActive && c.speed ? c.speed / (1024 * 1024) : 0; // MB/s

      return {
        index: c.chunkIndex,
        progress: progress,
        speed: speed,
        downloadedBytes: c.downloadedBytes || 0,
        totalBytes: chunkSize,
        state:
          c.state === ChunkState.COMPLETED
            ? 'completed'
            : isActive
              ? 'active'
              : c.downloadedBytes > 0
                ? 'resumed'
                : 'pending',
      };
    });
  }

  /**
   * Calcula y envía el progreso actualizado de todos los chunks
   * Este método se puede llamar directamente o desde _onChunkProgress
   */
  _sendProgressUpdate() {
    if (this.isAborted) return;

    // Calcular progreso total usando helper
    const { totalDownloaded, overallProgress } = this._calculateTotalProgress();
    this.progressBatcher.queueProgressUpdate(this.downloadId, overallProgress, totalDownloaded);

    // Calcular velocidad total usando helper
    const totalSpeed = this._calculateTotalSpeed();

    // Calcular progreso individual de chunks usando helper
    const chunkProgress = this._calculateChunkProgress();

    // Calcular tiempo restante (remainingTime)
    // totalSpeed está en bytes/segundo (suma de velocidades de chunks activos)
    const remainingBytes = this.totalBytes - totalDownloaded;
    const totalSpeedBytesPerSec = totalSpeed; // Ya está en bytes/segundo
    const remainingSeconds = totalSpeedBytesPerSec > 0 ? remainingBytes / totalSpeedBytesPerSec : 0;

    // IMPORTANTE: Notificar callback con información completa de todos los chunks
    // Esto se enviará al frontend a través del progressThrottler
    this.onProgress({
      downloadId: this.downloadId,
      state: 'progressing',
      percent: overallProgress,
      downloadedBytes: totalDownloaded,
      totalBytes: this.totalBytes,
      speed: totalSpeed / (1024 * 1024), // MB/s
      remainingTime: remainingSeconds, // Tiempo restante en segundos
      activeChunks: this.activeChunks.size,
      completedChunks: this.completedChunks,
      totalChunks: this.chunks.length,
      chunkProgress: chunkProgress, // Array completo con todos los chunks ACTUALIZADOS
      chunked: true, // Marcar explícitamente como chunked
    });
  }

  /**
   * Envía el progreso inicial con todos los chunks
   * Esto asegura que el frontend vea todos los chunks desde el inicio
   */
  _sendInitialProgress() {
    if (this.isAborted || this.chunks.length === 0) return;

    // Calcular progreso total usando helper
    const { totalDownloaded, overallProgress } = this._calculateTotalProgress();

    // Calcular velocidad total usando helper
    const totalSpeed = this._calculateTotalSpeed();

    // Calcular progreso individual de chunks usando helper
    const chunkProgress = this._calculateChunkProgress();

    // Contar chunks completados
    const completedChunks = this.chunks.filter(c => c.state === ChunkState.COMPLETED).length;

    // Notificar callback con información completa de todos los chunks
    this.onProgress({
      downloadId: this.downloadId,
      state: 'progressing',
      percent: overallProgress,
      downloadedBytes: totalDownloaded,
      totalBytes: this.totalBytes,
      speed: totalSpeed / (1024 * 1024), // MB/s
      activeChunks: this.activeChunks.size,
      completedChunks: completedChunks,
      totalChunks: this.chunks.length,
      chunkProgress: chunkProgress, // Array completo con todos los chunks
      chunked: true, // Marcar explícitamente como chunked
    });
  }

  /**
   * Callback cuando un chunk se completa
   */
  async _onChunkComplete(chunk) {
    log.info(`Chunk ${chunk.chunkIndex} completado`);

    // CRÍTICO: Actualizar lastUpdate para que el sistema de limpieza sepa que hay actividad
    this.lastUpdate = Date.now();

    // Flush pendientes de este chunk antes de marcar completado
    await this.progressBatcher.flushDownload(this.downloadId);

    // CRÍTICO: Asegurar que el estado del chunk en memoria esté actualizado
    // Esto evita condiciones de carrera donde el estado no se sincroniza correctamente
    if (chunk.state !== ChunkState.COMPLETED) {
      log.warn(`Chunk ${chunk.chunkIndex}: estado no estaba COMPLETED (era ${chunk.state}), corrigiendo...`);
      chunk.state = ChunkState.COMPLETED;
    }

    // Actualizar BD
    queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
      downloadedBytes: chunk.downloadedBytes,
      state: ChunkState.COMPLETED,
    });

    // Actualizar contadores
    this.completedChunks++;
    this.activeChunks.delete(chunk.chunkIndex);
    
    // CRÍTICO: Verificar que el chunk en this.chunks también tenga el estado correcto
    const chunkInArray = this.chunks.find(c => c.chunkIndex === chunk.chunkIndex);
    if (chunkInArray && chunkInArray.state !== ChunkState.COMPLETED) {
      log.warn(`Chunk ${chunk.chunkIndex} en array: estado no estaba COMPLETED (era ${chunkInArray.state}), corrigiendo...`);
      chunkInArray.state = ChunkState.COMPLETED;
    }
    
    // CRÍTICO: Si todos los chunks están completados según el contador, verificar inmediatamente
    if (this.completedChunks >= this.chunks.length && this.activeChunks.size === 0) {
      log.debug(`Todos los chunks completados según contador (${this.completedChunks}/${this.chunks.length}), preparando actualización final y fusión...`);
      
      // IMPORTANTE: Primero calculamos y enviamos la actualización del 100% de todos los chunks
      const totalDownloaded = this.chunks.reduce((sum, c) => sum + c.downloadedBytes, 0);
      const overallProgress = 1.0; // Forzar 100%
      
      const finalChunkProgress = this.chunks.map(c => ({
        index: c.chunkIndex,
        progress: 1.0,
        speed: 0,
        downloadedBytes: c.endByte - c.startByte + 1,
        totalBytes: c.endByte - c.startByte + 1,
        state: 'completed'
      }));

      this.onProgress({
        downloadId: this.downloadId,
        state: 'progressing',
        percent: 1.0,
        downloadedBytes: totalDownloaded,
        totalBytes: this.totalBytes,
        speed: 0,
        activeChunks: 0,
        completedChunks: this.chunks.length,
        totalChunks: this.chunks.length,
        chunkProgress: finalChunkProgress,
        chunked: true,
        forceImmediate: true, // Forzar envío inmediato
      });

      // Ahora sí, iniciamos la fusión
      setImmediate(() => {
        if (!this.isAborted && !this.mergeInProgress) {
          const allCompletedNow = this.chunks.every(c => c.state === ChunkState.COMPLETED);
          if (allCompletedNow) {
            log.info(`Iniciando fusión final (${this.completedChunks}/${this.chunks.length})`);
            this._mergeChunks();
          }
        }
      });
      return; 
    }

    // IMPORTANTE: Enviar progreso actualizado cuando un chunk se completa
    // Esto asegura que el frontend vea inmediatamente que el chunk se completó
    // Calcular progreso total usando helper
    const { totalDownloaded, overallProgress } = this._calculateTotalProgress();

    // Calcular velocidad total usando helper
    const totalSpeed = this._calculateTotalSpeed();

    // Calcular progreso individual de chunks usando helper
    const chunkProgress = this._calculateChunkProgress();

    // Enviar progreso actualizado
    // IMPORTANTE: Marcar como forceImmediate cuando un chunk se completa para asegurar
    // que el frontend vea inmediatamente el progreso actualizado
    this.onProgress({
      downloadId: this.downloadId,
      state: 'progressing',
      percent: overallProgress,
      downloadedBytes: totalDownloaded,
      totalBytes: this.totalBytes,
      speed: totalSpeed / (1024 * 1024), // MB/s
      activeChunks: this.activeChunks.size,
      completedChunks: this.completedChunks,
      totalChunks: this.chunks.length,
      chunkProgress: chunkProgress, // Array completo con todos los chunks actualizados
      chunked: true, // Marcar explícitamente como chunked
      forceImmediate: true, // Forzar envío inmediato cuando un chunk se completa
    });

    // CRÍTICO: Verificación robusta de completado de todos los chunks
    // Usar múltiples métodos para evitar condiciones de carrera
    const checkAllCompleted = () => {
      // Método 1: Verificar estado en memoria
      const allCompletedByState = this.chunks.every(c => c.state === ChunkState.COMPLETED);
      
      // Método 2: Verificar contador de chunks completados
      const allCompletedByCount = this.completedChunks >= this.chunks.length;
      
      // Método 3: Verificar que no hay chunks activos y todos están completados
      const allCompletedByActive = this.activeChunks.size === 0 && this.completedChunks >= this.chunks.length;
      
      // Método 4: Verificar archivos físicos (más confiable pero más lento)
      let allCompletedByFiles = true;
      let incompleteChunksInfo = [];
      try {
        for (const c of this.chunks) {
          const expectedSize = c.endByte - c.startByte + 1;
          if (c.tempFile && fs.existsSync(c.tempFile)) {
            const stats = fs.statSync(c.tempFile);
            if (stats.size < expectedSize * 0.99) {
              // Archivo incompleto (con tolerancia del 1%)
              allCompletedByFiles = false;
              incompleteChunksInfo.push(`chunk ${c.chunkIndex}: archivo ${stats.size}/${expectedSize} bytes`);
              break;
            }
          } else if (c.state !== ChunkState.COMPLETED) {
            // Archivo no existe y chunk no está completado
            allCompletedByFiles = false;
            incompleteChunksInfo.push(`chunk ${c.chunkIndex}: sin archivo temporal, estado=${c.state}`);
            break;
          }
        }
      } catch (e) {
        // Si hay error verificando archivos, confiar en los otros métodos
        log.debug(`Error verificando archivos de chunks: ${e.message}`);
      }
      
      // Si al menos 3 de los 4 métodos confirman que están completados, proceder
      const completionChecks = [
        allCompletedByState,
        allCompletedByCount,
        allCompletedByActive,
        allCompletedByFiles,
      ].filter(Boolean).length;
      
      // Información de depuración detallada
      const stateInfo = this.chunks.map(c => `chunk ${c.chunkIndex}: ${c.state}`).join(', ');
      log.debug(
        `Verificación de completado: estado=${allCompletedByState}, count=${allCompletedByCount} (${this.completedChunks}/${this.chunks.length}), active=${allCompletedByActive} (${this.activeChunks.size} activos), files=${allCompletedByFiles}, checks=${completionChecks}/4`
      );
      
      // Si la verificación falla, mostrar información detallada
      if (completionChecks < 3) {
        log.debug(`Estados de chunks: [${stateInfo}]`);
        if (incompleteChunksInfo.length > 0) {
          log.debug(`Chunks incompletos por archivos: ${incompleteChunksInfo.join(', ')}`);
        }
        if (!allCompletedByState) {
          const incompleteStates = this.chunks
            .filter(c => c.state !== ChunkState.COMPLETED)
            .map(c => `chunk ${c.chunkIndex}: ${c.state}`);
          log.debug(`Chunks con estado incompleto: ${incompleteStates.join(', ')}`);
        }
      }
      
      // Requerir al menos 3 de 4 verificaciones positivas para evitar falsos positivos
      // PERO: Si el contador dice que todos están completados y no hay chunks activos,
      // forzar la verificación incluso si el estado en memoria no está sincronizado
      if (allCompletedByCount && allCompletedByActive && this.completedChunks === this.chunks.length) {
        log.info(`Todos los chunks completados según contador (${this.completedChunks}/${this.chunks.length}) y sin chunks activos, forzando verificación...`);
        // Sincronizar estados de chunks que puedan estar desincronizados
        let needsSync = false;
        for (const c of this.chunks) {
          if (c.state !== ChunkState.COMPLETED) {
            log.warn(`Chunk ${c.chunkIndex}: sincronizando estado a COMPLETED (era ${c.state})`);
            c.state = ChunkState.COMPLETED;
            needsSync = true;
          }
        }
        if (needsSync) {
          // Recalcular verificación después de sincronizar
          const allCompletedByStateNow = this.chunks.every(c => c.state === ChunkState.COMPLETED);
          if (allCompletedByStateNow) {
            log.info(`Estados sincronizados, todos los chunks están COMPLETED`);
            return true;
          }
        } else {
          // Si el contador y los chunks activos confirman, proceder
          return true;
        }
      }
      
      return completionChecks >= 3;
    };

    const allCompleted = checkAllCompleted();

    if (allCompleted) {
      log.info(`Todos los chunks completados (${this.completedChunks}/${this.chunks.length}), iniciando fusión`);
      this._mergeChunks();
    } else {
      // CRÍTICO: Timeout de seguridad para detectar cuando todos los chunks están completados
      // pero la verificación inicial falló debido a condiciones de carrera
      // Usar timeout más corto (500ms) para detectar problemas más rápido
      if (!this.completionCheckTimeout) {
        this.completionCheckTimeout = setTimeout(() => {
          if (this.isAborted || this.mergeInProgress) {
            this.completionCheckTimeout = null;
            return;
          }
          
          log.debug(`Verificación de seguridad: revisando si todos los chunks están completados...`);
          const allCompletedNow = checkAllCompleted();
          
          if (allCompletedNow && !this.mergeInProgress) {
            log.info(`Todos los chunks completados detectados por timeout de seguridad (${this.completedChunks}/${this.chunks.length}), iniciando fusión`);
            this._mergeChunks();
            this.completionCheckTimeout = null;
            return;
          }
          
          // Si aún no están todos completados, verificar progreso
          const totalDownloaded = this.chunks.reduce((sum, c) => sum + (c.downloadedBytes || 0), 0);
          const progress = this.totalBytes > 0 ? totalDownloaded / this.totalBytes : 0;
          
          // CRÍTICO: Si el progreso está muy alto (99%+) y no hay chunks activos,
          // es muy probable que todos los chunks estén completados pero la verificación falló
          if (progress >= 0.99 && this.activeChunks.size === 0 && !this.mergeInProgress) {
            log.warn(`Progreso al ${(progress * 100).toFixed(1)}% sin chunks activos, forzando verificación de archivos...`);
            
            // Verificar archivos físicos más estrictamente
            let allFilesComplete = true;
            let incompleteChunks = [];
            
            for (const c of this.chunks) {
              const expectedSize = c.endByte - c.startByte + 1;
              if (c.tempFile && fs.existsSync(c.tempFile)) {
                const stats = fs.statSync(c.tempFile);
                if (stats.size < expectedSize * 0.99) {
                  allFilesComplete = false;
                  incompleteChunks.push({ index: c.chunkIndex, size: stats.size, expected: expectedSize });
                  log.warn(`Chunk ${c.chunkIndex} incompleto: ${stats.size}/${expectedSize} bytes`);
                }
              } else if (c.state !== ChunkState.COMPLETED) {
                allFilesComplete = false;
                incompleteChunks.push({ index: c.chunkIndex, reason: 'sin archivo temporal' });
                log.warn(`Chunk ${c.chunkIndex} sin archivo temporal`);
              }
            }
            
            if (allFilesComplete && !this.mergeInProgress) {
              log.info(`Todos los archivos de chunks están completos, iniciando fusión`);
              // Actualizar estados de chunks que puedan estar desincronizados
              this.chunks.forEach(c => {
                if (c.state !== ChunkState.COMPLETED) {
                  c.state = ChunkState.COMPLETED;
                  queueDatabase.updateChunk(this.downloadId, c.chunkIndex, {
                    downloadedBytes: c.endByte - c.startByte + 1,
                    state: ChunkState.COMPLETED,
                  });
                }
              });
              this.completedChunks = this.chunks.length;
              this._mergeChunks();
            } else if (incompleteChunks.length > 0) {
              log.warn(`Chunks incompletos detectados: ${incompleteChunks.map(c => c.index).join(', ')}`);
              // Reiniciar chunks incompletos
              incompleteChunks.forEach(({ index }) => {
                const chunk = this.chunks[index];
                if (chunk && chunk.state !== ChunkState.DOWNLOADING) {
                  chunk.state = ChunkState.PENDING;
                  this._startPendingChunks();
                }
              });
            }
          }
          
          // CRÍTICO: Si después de 2 segundos aún no se inició el merge y todos los chunks
          // parecen estar completados, programar otra verificación más agresiva
          if (!this.mergeInProgress && this.completedChunks >= this.chunks.length && this.activeChunks.size === 0) {
            log.warn(`Todos los chunks parecen completados pero el merge no se inició, programando verificación adicional...`);
            // Programar otra verificación más agresiva en 1 segundo adicional
            setTimeout(() => {
              if (!this.mergeInProgress && !this.isAborted) {
                const finalCheck = checkAllCompleted();
                if (finalCheck) {
                  log.warn(`Verificación final: todos los chunks completados, forzando inicio de merge`);
                  this._mergeChunks();
                } else {
                  log.error(`Verificación final falló: estado=${this.chunks.every(c => c.state === ChunkState.COMPLETED)}, count=${this.completedChunks}/${this.chunks.length}, active=${this.activeChunks.size}`);
                }
              }
            }, 1000);
          }
          
          this.completionCheckTimeout = null;
        }, 500); // Verificar después de 500ms para detectar problemas más rápido
      }
      
      // Iniciar más chunks si hay disponibles
      this._startPendingChunks();
    }
  }

  /**
   * Callback cuando un chunk tiene error
   */
  _onChunkError(chunk, error) {
    log.error(`Chunk ${chunk.chunkIndex} error:`, error.message);

    // Registrar error en circuit breaker si está habilitado
    // Nota: El circuit breaker ya registró el error en su método execute(),
    // pero aquí podemos verificar si el circuit está abierto para decidir si reintentar
    const circuitOpen = this.circuitBreaker?.isOpen() || false;
    if (circuitOpen) {
      log.warn(
        `[CircuitBreaker] Circuit abierto para descarga ${this.downloadId}, no se reintentará chunk ${chunk.chunkIndex}`
      );
    }

    this.activeChunks.delete(chunk.chunkIndex);

    // Verificar reintentos
    if (!chunk.retryCount) chunk.retryCount = 0;
    chunk.retryCount++;

    // Si el circuit breaker está abierto, no reintentar
    if (circuitOpen && this.circuitBreaker && config.circuitBreaker?.enabled) {
      log.warn(
        `[CircuitBreaker] Chunk ${chunk.chunkIndex} no se reintentará debido a circuit breaker abierto`
      );
      // Fallar toda la descarga o esperar a que el circuit se cierre
      this.state = 'failed';
      this.isAborted = true;
      this._cleanupAllChunks(true);
      this.onError(this, new Error(`Circuit breaker abierto: ${error.message}`));
      return;
    }

    if (chunk.retryCount < this.chunkRetries) {
      log.info(`Reintentando chunk ${chunk.chunkIndex} (${chunk.retryCount}/${this.chunkRetries})`);

      // Resetear estado para reintento
      chunk.state = ChunkState.PENDING;
      chunk.isAborted = false;

      // IMPORTANTE: Si el archivo temporal fue eliminado, resetear downloadedBytes
      if (!fs.existsSync(chunk.tempFile)) {
        log.debug(
          `Chunk ${chunk.chunkIndex}: archivo temporal eliminado, reiniciando desde byte ${chunk.startByte}`
        );
        chunk.downloadedBytes = 0;

        // Actualizar BD
        queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
          downloadedBytes: 0,
          state: ChunkState.PENDING,
        });
      } else {
        // Si el archivo existe, verificar su tamaño real y sincronizar
        try {
          const stats = fs.statSync(chunk.tempFile);
          if (stats.size !== chunk.downloadedBytes) {
            log.debug(
              `Chunk ${chunk.chunkIndex}: sincronizando bytes (archivo: ${stats.size}, memoria: ${chunk.downloadedBytes})`
            );
            chunk.downloadedBytes = stats.size;

            queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
              downloadedBytes: stats.size,
              state: ChunkState.PENDING,
            });
          }
        } catch (e) {
          // Si hay error leyendo el archivo, resetear
          log.debug(`Chunk ${chunk.chunkIndex}: error leyendo archivo temporal, reiniciando`);
          chunk.downloadedBytes = 0;
          queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
            downloadedBytes: 0,
            state: ChunkState.PENDING,
          });
        }
      }

      // Reintentar después de un delay exponencial
      const delay = Math.min(1000 * Math.pow(2, chunk.retryCount), 10000);
      setTimeout(() => {
        if (!this.isAborted) {
          this._startPendingChunks();
        }
      }, delay);
    } else {
      log.error(`Chunk ${chunk.chunkIndex} falló después de ${this.chunkRetries} reintentos`);

      // Actualizar BD con estado fallido
      queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
        downloadedBytes: chunk.downloadedBytes,
        state: ChunkState.FAILED,
      });

      // Fallar toda la descarga
      this.state = 'failed';
      this.isAborted = true;
      this._cleanupAllChunks(true); // Mantener archivos para posible reanudación

      this.onError(this, new Error(`Chunk ${chunk.chunkIndex} falló: ${error.message}`));
    }
  }

  /**
   * Fusiona todos los chunks en el archivo final usando Worker Thread
   * Esto evita bloquear el event loop del main thread
   */
  async _mergeChunks() {
    if (this.mergeInProgress) return;
    
    // CRÍTICO: Limpiar timeout de verificación de completado antes de iniciar merge
    if (this.completionCheckTimeout) {
      clearTimeout(this.completionCheckTimeout);
      this.completionCheckTimeout = null;
    }
    
    this.mergeInProgress = true;
    this.state = 'merging';

    log.info(`Iniciando fusión con Worker Thread de ${this.chunks.length} chunks`);

    // Verificar si usar worker thread está habilitado
    const useWorkerThread = config.downloads.chunked?.useWorkerThread !== false; // Default: true

    if (useWorkerThread) {
      await this._mergeChunksWithWorker();
    } else {
      // Fallback a merge en main thread (versión antigua)
      await this._mergeChunksInMainThread();
    }
  }

  /**
   * Fusiona chunks usando Worker Thread (no bloquea main thread)
   */
  async _mergeChunksWithWorker() {
    return new Promise((resolve, reject) => {
      try {
        // Preparar datos de chunks para el worker
        const chunksData = this.chunks.map(chunk => ({
          tempFile: chunk.tempFile,
          startByte: chunk.startByte,
          endByte: chunk.endByte,
          chunkIndex: chunk.chunkIndex,
        }));

        // Crear worker thread
        // Nota: Worker threads no pueden cargar desde app.asar directamente
        // Usamos __dirname que en Electron apunta al directorio correcto
        // IMPORTANTE: Worker requiere ruta absoluta
        let workerPath = path.resolve(__dirname, 'workers', 'chunkMerger.js');

        // Si no existe, intentar rutas alternativas
        if (!fs.existsSync(workerPath)) {
          // En modo empaquetado, puede estar en app.asar.unpacked
          if (process.resourcesPath) {
            const altPath = path.resolve(
              process.resourcesPath,
              'app.asar.unpacked',
              'electron',
              'workers',
              'chunkMerger.js'
            );
            if (fs.existsSync(altPath)) {
              workerPath = altPath;
              log.debug(`Worker encontrado en app.asar.unpacked: ${workerPath}`);
            } else {
              // Último intento: usar ruta relativa desde el ejecutable
              const execPath = process.execPath;
              const execDir = path.dirname(execPath);
              const relPath = path.resolve(
                execDir,
                'resources',
                'app.asar.unpacked',
                'electron',
                'workers',
                'chunkMerger.js'
              );
              if (fs.existsSync(relPath)) {
                workerPath = relPath;
                log.debug(`Worker encontrado en ruta relativa: ${workerPath}`);
              }
            }
          }
        }

        // Si aún no existe, usar fallback a main thread
        if (!fs.existsSync(workerPath)) {
          log.warn(`Worker no encontrado en ${workerPath}, usando merge en main thread`);
          log.warn(`Rutas probadas: ${path.resolve(__dirname, 'workers', 'chunkMerger.js')}`);
          if (process.resourcesPath) {
            log.warn(
              `También probado: ${path.resolve(process.resourcesPath, 'app.asar.unpacked', 'electron', 'workers', 'chunkMerger.js')}`
            );
          }
          this.mergeInProgress = false;
          return this._mergeChunksInMainThread();
        }

        log.info(`Usando worker thread: ${workerPath}`);

        this.mergeWorker = new Worker(workerPath, {
          workerData: null, // No necesitamos workerData, usamos mensajes
        });

        // Manejar mensajes del worker
        this.mergeWorker.on('message', message => {
          switch (message.type) {
            case 'progress':
              // Actualizar progreso de merge
              const mergeSpeedMBps = message.speed ? message.speed / (1024 * 1024) : 0;
              this.onProgress({
                downloadId: this.downloadId,
                state: 'merging',
                percent: message.progress,
                mergeProgress: message.progress,
                currentChunk: message.currentChunk,
                totalChunks: message.totalChunks,
                bytesProcessed: message.bytesProcessed,
                totalBytes: message.totalBytes,
                mergeSpeed: mergeSpeedMBps, // MB/s para el componente
                speed: mergeSpeedMBps, // MB/s para estadísticas
              });
              break;

            case 'complete':
              clearWorkerTimeout();
              log.info('Fusión de chunks completada', {
                downloadId: this.downloadId,
                savePath: this.savePath,
                totalBytes: message.totalBytes,
                formatBytes: message.formatBytes,
                duration: message.duration.toFixed(2),
                formatSpeed: message.formatSpeed,
                totalChunks: message.totalChunks || this.chunks.length,
                timestamp: Date.now(),
              });

              // IMPORTANTE: Enviar actualización final al 100% antes de cambiar el estado
              // Esto asegura que el frontend vea el progreso completo antes de 'completed'
              // El worker ya envió un mensaje de progreso al 100% antes del 'complete',
              // pero enviamos uno adicional aquí para garantizar que llegue
              this.onProgress({
                downloadId: this.downloadId,
                state: 'merging',
                percent: 1.0, // 100%
                mergeProgress: 1.0, // 100%
                currentChunk: message.totalChunks || this.chunks.length,
                totalChunks: message.totalChunks || this.chunks.length,
                bytesProcessed: message.totalBytes || this.totalBytes,
                totalBytes: message.totalBytes || this.totalBytes,
                mergeSpeed: message.speed ? message.speed / (1024 * 1024) : 0, // MB/s
                speed: message.speed ? message.speed / (1024 * 1024) : 0, // MB/s
                chunked: true,
                activeChunks: 0,
                completedChunks: this.chunks.length,
              });

              // Usar setTimeout para dar tiempo al frontend de procesar el update al 100%
              // antes de cambiar el estado a 'completed'
              setTimeout(() => {
                // Marcar que el merge ya no está en progreso antes de limpiar
                this.mergeInProgress = false;

                // Limpiar worker (sin enviar cancel ya que se completó exitosamente)
                if (this.mergeWorker) {
                  const worker = this.mergeWorker;
                  this.mergeWorker = null;

                  try {
                    // Remover listeners para evitar mensajes adicionales
                    worker.removeAllListeners('message');
                    worker.removeAllListeners('error');
                    worker.removeAllListeners('exit');

                    // Terminar worker directamente sin enviar cancel
                    setTimeout(() => {
                      try {
                        if (worker.threadId !== undefined) {
                          worker.terminate();
                        }
                      } catch (e) {
                        // Ignorar errores al terminar
                      }
                    }, 500);
                  } catch (e) {
                    log.debug('Error limpiando worker:', e.message);
                  }
                }

                // Actualizar BD en batch
                this._updateChunksInDB()
                  .then(() => {
                    this.state = 'completed';

                    // Notificar completado (esto cambiará el estado a 'completed' en el frontend)
                    this.onComplete({
                      downloadId: this.downloadId,
                      savePath: this.savePath,
                      totalBytes: this.totalBytes,
                      duration: message.duration,
                    });

                    resolve();
                  })
                  .catch(reject);
              }, 200); // 200ms de delay para asegurar que el frontend procese el 100%
              break;

            case 'error':
              clearWorkerTimeout();
              log.error('Error en worker de merge', {
                downloadId: this.downloadId,
                savePath: this.savePath,
                error: message.error?.message || 'Error desconocido',
                stack: message.error?.stack,
                code: message.error?.code,
                totalBytes: this.totalBytes,
                chunksCount: this.chunks.length,
                timestamp: Date.now(),
              });
              this._cleanupMergeWorker();
              this.state = 'failed';
              this.mergeInProgress = false;

              const error = new Error(message.error?.message || 'Error desconocido en worker de merge');
              if (message.error?.stack) {
                error.stack = message.error.stack;
              }
              if (message.error?.code) {
                error.code = message.error.code;
              }
              this.onError(this, error);
              reject(error);
              break;

            case 'warning':
              log.warn(`[Worker] ${message.message}`);
              break;

            case 'cancelled':
              log.debug('Merge cancelado por worker');
              // No hacer nada aquí si ya se limpió en el caso 'complete'
              if (this.mergeWorker && this.mergeInProgress) {
                this._cleanupMergeWorker();
              }
              this.mergeInProgress = false;
              // Solo resolver si el merge no se completó exitosamente
              if (this.state !== 'completed') {
                resolve();
              }
              break;
          }
        });

        // CRÍTICO: Manejar errores del worker con timeout de seguridad
        let workerErrorTimeout = null;
        const WORKER_ERROR_TIMEOUT_MS = 30000; // 30 segundos

        // Timeout de seguridad: si el worker no responde en 30 segundos, considerarlo fallido
        workerErrorTimeout = setTimeout(() => {
          if (this.mergeInProgress && this.mergeWorker) {
            log.error('Worker de merge no responde después de 30 segundos, forzando fallo', {
              downloadId: this.downloadId,
              savePath: this.savePath,
              totalBytes: this.totalBytes,
              chunksCount: this.chunks.length,
            });
            this._cleanupMergeWorker();
            this.state = 'failed';
            this.mergeInProgress = false;
            const timeoutError = new Error('Worker de merge no respondió en el tiempo esperado (timeout de 30s)');
            this.onError(this, timeoutError);
            reject(timeoutError);
          }
        }, WORKER_ERROR_TIMEOUT_MS);

        // Limpiar timeout cuando se recibe respuesta exitosa
        const clearWorkerTimeout = () => {
          if (workerErrorTimeout) {
            clearTimeout(workerErrorTimeout);
            workerErrorTimeout = null;
          }
        };

        // Manejar errores del worker
        this.mergeWorker.on('error', error => {
          clearWorkerTimeout();
          log.error('Error en worker thread de merge', {
            downloadId: this.downloadId,
            error: error.message,
            stack: error.stack,
            code: error.code,
            savePath: this.savePath,
          });
          this._cleanupMergeWorker();
          this.state = 'failed';
          this.mergeInProgress = false;
          this.onError(this, error);
          reject(error);
        });

        // Manejar salida del worker
        this.mergeWorker.on('exit', code => {
          clearWorkerTimeout();
          if (code !== 0 && this.mergeInProgress) {
            log.error('Worker de merge terminó con código de error', {
              downloadId: this.downloadId,
              exitCode: code,
              savePath: this.savePath,
              mergeInProgress: this.mergeInProgress,
            });
            this._cleanupMergeWorker();
            this.state = 'failed';
            this.mergeInProgress = false;

            const error = new Error(`Worker terminó inesperadamente con código ${code}`);
            this.onError(this, error);
            reject(error);
          } else if (code === 0 && this.mergeInProgress) {
            // Worker terminó exitosamente pero el merge aún está marcado como en progreso
            // Esto puede indicar que el mensaje 'complete' no se recibió
            log.warn('Worker terminó exitosamente pero merge aún en progreso', {
              downloadId: this.downloadId,
              savePath: this.savePath,
            });
          }
        });

        // Enviar comando de merge al worker
        this.mergeWorker.postMessage({
          type: 'merge',
          chunks: chunksData,
          savePath: this.savePath,
          totalBytes: this.totalBytes,
          downloadId: this.downloadId,
        });
      } catch (error) {
        clearWorkerTimeout();
        log.error('Error iniciando worker de merge', {
          downloadId: this.downloadId,
          savePath: this.savePath,
          error: error.message,
          stack: error.stack,
          code: error.code,
          totalBytes: this.totalBytes,
          chunksCount: this.chunks.length,
          timestamp: Date.now(),
        });
        this._cleanupMergeWorker();
        this.state = 'failed';
        this.mergeInProgress = false;
        this.onError(this, error);
        reject(error);
      }
    });
  }

  /**
   * Actualiza chunks en BD después del merge (en batch)
   */
  async _updateChunksInDB() {
    const chunkUpdatePromises = this.chunks.map(chunk => {
      return queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
        state: ChunkState.COMPLETED,
        downloadedBytes: chunk.endByte - chunk.startByte + 1,
      });
    });

    // Ejecutar actualizaciones en lotes para no bloquear
    const BATCH_UPDATE_SIZE = 5;
    for (let i = 0; i < chunkUpdatePromises.length; i += BATCH_UPDATE_SIZE) {
      const batch = chunkUpdatePromises.slice(i, i + BATCH_UPDATE_SIZE);
      await Promise.all(batch);

      // Ceder control entre lotes
      if (i + BATCH_UPDATE_SIZE < chunkUpdatePromises.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  /**
   * Limpia el worker de merge
   */
  _cleanupMergeWorker() {
    if (!this.mergeWorker) return;

    const worker = this.mergeWorker;
    this.mergeWorker = null; // Marcar como null inmediatamente para evitar múltiples limpiezas

    try {
      // Remover todos los listeners primero para evitar múltiples respuestas
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');

      // Solo enviar cancel si el merge aún está en progreso
      // Si ya se completó, el worker ya terminó y no necesita cancel
      if (this.mergeInProgress) {
        try {
          worker.postMessage({ type: 'cancel' });
        } catch (e) {
          // Ignorar si el worker ya terminó
        }
      }

      // Terminar el worker después de un breve delay
      setTimeout(() => {
        try {
          if (worker.threadId !== undefined) {
            worker.terminate();
          }
        } catch (e) {
          // Ignorar errores al terminar (worker ya terminado)
        }
      }, 500);
    } catch (e) {
      log.debug('Error limpiando worker:', e.message);
    }
  }

  /**
   * Fusiona chunks en main thread (fallback, versión antigua)
   * Mantenida para compatibilidad si worker threads no están disponibles
   */
  async _mergeChunksInMainThread() {
    log.warn('Usando merge en main thread (worker threads deshabilitados)');

    const BUFFER_SIZE = config.downloads.chunked?.mergeBufferSize || 16 * 1024 * 1024;
    const BATCH_SIZE = config.downloads.chunked?.mergeBatchSize || 8 * 1024 * 1024;
    const YIELD_INTERVAL = config.downloads.chunked?.mergeYieldInterval || 10;

    try {
      const finalHandle = await fs.promises.open(this.savePath, 'w');
      let position = 0;
      let operationCount = 0;

      const yieldToEventLoop = () => {
        return new Promise(resolve => setImmediate(resolve));
      };

      for (let i = 0; i < this.chunks.length; i++) {
        const chunk = this.chunks[i];
        const chunkSize = chunk.endByte - chunk.startByte + 1;

        const chunkHandle = await fs.promises.open(chunk.tempFile, 'r');
        const buffer = Buffer.allocUnsafe(Math.min(BUFFER_SIZE, chunkSize));

        try {
          let bytesProcessed = 0;

          while (bytesProcessed < chunkSize) {
            if (operationCount > 0 && operationCount % YIELD_INTERVAL === 0) {
              await yieldToEventLoop();
            }

            const toRead = Math.min(
              Math.min(buffer.length, BATCH_SIZE),
              chunkSize - bytesProcessed
            );

            const { bytesRead } = await chunkHandle.read(buffer, 0, toRead, bytesProcessed);

            if (bytesRead === 0) break;

            await finalHandle.write(buffer, 0, bytesRead, position);
            position += bytesRead;
            bytesProcessed += bytesRead;
            operationCount++;

            if (operationCount % 5 === 0) {
              const chunkProgress = bytesProcessed / chunkSize;
              const overallProgress = (i + chunkProgress) / this.chunks.length;

              this.onProgress({
                downloadId: this.downloadId,
                state: 'merging',
                mergeProgress: overallProgress,
                currentChunk: i + 1,
                totalChunks: this.chunks.length,
              });
            }
          }
        } finally {
          await chunkHandle.close();
        }

        await yieldToEventLoop();

        try {
          await fs.promises.unlink(chunk.tempFile);
        } catch (e) {
          log.warn(`Error eliminando temp ${chunk.tempFile}:`, e.message);
        }

        this.onProgress({
          downloadId: this.downloadId,
          state: 'merging',
          mergeProgress: (i + 1) / this.chunks.length,
          currentChunk: i + 1,
          totalChunks: this.chunks.length,
        });
      }

      await finalHandle.close();
      await yieldToEventLoop();

      const finalStats = await fs.promises.stat(this.savePath);
      if (finalStats.size !== this.totalBytes) {
        throw new Error(`Tamaño final incorrecto: ${finalStats.size}/${this.totalBytes}`);
      }

      log.info(`Fusión completada: ${this._formatBytes(finalStats.size)}`);

      await this._updateChunksInDB();

      this.state = 'completed';
      this.mergeInProgress = false;

      this.onComplete({
        downloadId: this.downloadId,
        savePath: this.savePath,
        totalBytes: this.totalBytes,
        duration: (Date.now() - this.startTime) / 1000,
      });
    } catch (error) {
      log.error('Error en fusión:', error);
      this.state = 'failed';
      this.mergeInProgress = false;
      this.onError(this, error);
    }
  }

  /**
   * Pausa la descarga fragmentada
   *
   * Detiene todos los chunks activos y actualiza su estado en la base de datos.
   * Los archivos temporales de los chunks se mantienen para permitir reanudación.
   *
   * @returns {boolean} true si se pausó correctamente, false si no estaba descargando
   *
   * @example
   * // Pausar descarga activa
   * const paused = downloader.pause();
   * if (paused) {
   *   console.log('Descarga pausada');
   *   // Los archivos temporales de chunks se mantienen
   *   // Se puede reanudar con resume() o start()
   * }
   */
  pause() {
    if (this.state !== 'downloading') {
      log.warn('No se puede pausar: no está descargando');
      return false;
    }

    log.info(`Pausando descarga fragmentada: ${this.title}`);
    this.isAborted = true;
    this.state = 'paused';

    // Detener detector de estancamiento
    this._stopStallCheck();

    // CRÍTICO: Limpiar timeout de verificación de completado
    if (this.completionCheckTimeout) {
      clearTimeout(this.completionCheckTimeout);
      this.completionCheckTimeout = null;
    }

    // Pausar todos los chunks activos
    this.activeChunks.forEach(chunk => {
      chunk.pause();

      // Guardar estado en BD
      queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
        downloadedBytes: chunk.downloadedBytes,
        state: ChunkState.PAUSED,
      });
    });

    this.activeChunks.clear();

    return true;
  }

  /**
   * Reanuda la descarga pausada o fallida
   *
   * Verifica que la descarga esté en estado 'paused' o 'failed' y la reanuda
   * desde donde se quedó. Equivale a llamar start() después de verificar el estado.
   *
   * @returns {Promise<boolean>} true si se reanudó correctamente, false si el estado no permite reanudar
   *
   * @example
   * // Reanudar descarga pausada
   * if (downloader.state === 'paused') {
   *   const resumed = await downloader.resume();
   *   if (resumed) {
   *     console.log('Descarga reanudada');
   *     // Los chunks continuarán desde donde se quedaron
   *   }
   * }
   *
   * // Reanudar descarga fallida (para reintentar)
   * if (downloader.state === 'failed') {
   *   await downloader.resume(); // Reintentará desde chunks no completados
   * }
   */
  async resume() {
    if (this.state !== 'paused' && this.state !== 'failed') {
      log.warn('No se puede reanudar: estado actual', this.state);
      return false;
    }

    log.info(`Reanudando descarga fragmentada: ${this.title}`);
    return this.start();
  }

  /**
   * Cancela la descarga y limpia todos los recursos
   *
   * Detiene todos los chunks activos, cancela la fusión si está en progreso,
   * y elimina los archivos temporales de chunks. Si keepFiles es true, mantiene
   * los archivos temporales (útil para inspección o recuperación manual).
   *
   * @param {boolean} [keepFiles=false] - Si mantener archivos temporales de chunks
   * @returns {void}
   *
   * @example
   * // Cancelar y eliminar archivos temporales
   * downloader.cancel();
   * // Todos los chunks y archivos temporales se eliminan
   *
   * // Cancelar pero mantener archivos (para debug)
   * downloader.cancel(true);
   * // Los archivos temporales se mantienen en el directorio de chunks
   */
  cancel(keepFiles = false) {
    log.info(`Cancelando descarga fragmentada: ${this.title}`);
    this.isAborted = true;
    this.state = 'cancelled';

    // Detener detector de estancamiento
    this._stopStallCheck();

    // CRÍTICO: Limpiar timeout de verificación de completado
    if (this.completionCheckTimeout) {
      clearTimeout(this.completionCheckTimeout);
      this.completionCheckTimeout = null;
    }

    // Cancelar merge si está en progreso
    if (this.mergeInProgress && this.mergeWorker) {
      this._cleanupMergeWorker();
      this.mergeInProgress = false;
    }

    this._cleanupAllChunks(!keepFiles);

    // Eliminar chunks de la BD si no se mantienen archivos
    if (!keepFiles) {
      this.chunks.forEach(chunk => {
        try {
          queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
            state: 'cancelled',
            downloadedBytes: 0,
          });
        } catch (e) {
          log.warn(`Error actualizando chunk ${chunk.chunkIndex} en BD:`, e.message);
        }
      });
    }

    return true;
  }

  /**
   * Limpia todos los chunks
   */
  _cleanupAllChunks(deleteTempFiles = true) {
    // Abortar chunks activos
    this.activeChunks.forEach(chunk => {
      chunk.abort(!deleteTempFiles);
    });
    this.activeChunks.clear();

    // Eliminar archivos temporales
    if (deleteTempFiles) {
      this.chunks.forEach(chunk => {
        if (chunk.tempFile && fs.existsSync(chunk.tempFile)) {
          safeUnlink(chunk.tempFile);
        }
      });
    }
  }

  /**
   * Destruye la instancia y libera recursos
   */
  destroy() {
    // Detener detector de estancamiento
    this._stopStallCheck();

    // CRÍTICO: Limpiar timeout de verificación de completado
    if (this.completionCheckTimeout) {
      clearTimeout(this.completionCheckTimeout);
      this.completionCheckTimeout = null;
    }
    
    this.cancel(true); // Mantener archivos por si se quiere reanudar
    this.chunks = [];

    // Limpiar worker de merge si existe
    this._cleanupMergeWorker();

    if (this.progressBatcher) {
      this.progressBatcher.destroy();
      this.progressBatcher = null;
    }

    this.onProgress = () => {};
    this.onComplete = () => {};
    this.onError = () => {};
  }

  /**
   * Formatea bytes a string legible
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Obtiene estado serializable
   */
  getState() {
    return {
      downloadId: this.downloadId,
      url: this.url,
      savePath: this.savePath,
      title: this.title,
      totalBytes: this.totalBytes,
      state: this.state,
      numChunks: this.numChunks,
      completedChunks: this.completedChunks,
      activeChunks: this.activeChunks.size,
      totalDownloadedBytes: this.chunks.reduce((sum, c) => sum + c.downloadedBytes, 0),
      progress: this.chunks.reduce((sum, c) => sum + c.downloadedBytes, 0) / this.totalBytes,
      chunks: this.chunks.map(c => c.toJSON()),
    };
  }

  /**
   * Verifica si el servidor soporta Range requests para descargas parciales
   *
   * Realiza una petición HEAD con header Range para verificar si el servidor
   * acepta peticiones de rangos de bytes. Esto es necesario para descargas
   * fragmentadas. Si el servidor no soporta Range requests, se debe usar
   * descarga simple en lugar de fragmentada.
   *
   * @static
   * @param {string} url - URL del archivo a verificar
   * @returns {Promise<Object>} Resultado de la verificación: { supported: boolean, error?: string, statusCode?: number }
   *
   * @example
   * // Verificar soporte de Range antes de usar descarga fragmentada
   * const rangeCheck = await ChunkedDownloader.checkRangeSupport('https://myrient.erista.me/files/large.zip');
   *
   * if (rangeCheck.supported) {
   *   console.log('Servidor soporta Range requests - usando descarga fragmentada');
   *   const downloader = new ChunkedDownloader({ /* opciones *\/ });
   *   await downloader.start();
   * } else {
   *   console.log('Servidor NO soporta Range requests - usando descarga simple');
   *   // Usar descarga simple en su lugar
   * }
   */
  static async checkRangeSupport(url) {
    return new Promise(resolve => {
      const request = net.request({ method: 'HEAD', url });

      request.setHeader(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      );
      request.setHeader('Range', 'bytes=0-0');

      // CRÍTICO: Usar timeout configurado en lugar de valor hardcodeado
      const timeoutMs =
        config.downloads?.chunked?.rangeSupportTimeout ||
        config.network?.timeout ||
        config.network?.responseTimeout ||
        10000; // 10 segundos como fallback
      const timeout = setTimeout(() => {
        request.abort();
        resolve({ supported: false, error: 'timeout' });
      }, timeoutMs);

      request.on('response', response => {
        clearTimeout(timeout);

        const acceptRanges = response.headers['accept-ranges'];
        const contentRange = response.headers['content-range'];

        const supported =
          response.statusCode === 206 || acceptRanges === 'bytes' || contentRange !== undefined;

        resolve({
          supported,
          statusCode: response.statusCode,
          acceptRanges,
          contentRange,
          contentLength: response.headers['content-length'],
        });
      });

      request.on('error', error => {
        clearTimeout(timeout);
        resolve({ supported: false, error: error.message });
      });

      request.end();
    });
  }
}

// Exportar clase y constantes
module.exports = ChunkedDownloader;
module.exports.ChunkState = ChunkState;
module.exports.ChunkDownload = ChunkDownload;
