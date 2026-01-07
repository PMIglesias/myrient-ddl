/**
 * ChunkedDownloader - Descargador Fragmentado con Range Requests
 * 
 * Implementa descargas paralelas dividiendo archivos grandes en fragmentos (chunks)
 * que se descargan simultáneamente usando HTTP Range headers.
 * 
 * Características:
 * - Descargas paralelas configurables (2-16 chunks)
 * - Persistencia de estado en SQLite para recuperación ante crashes
 * - Reanudación de chunks individuales interrumpidos
 * - Fusión automática de fragmentos al completar
 * - Backpressure handling para evitar saturación de memoria
 * - Progreso agregado con velocidad por chunk
 * 
 * @module ChunkedDownloader
 * @version 2.0.0 - Block 2 Implementation
 */

const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const config = require('./config');
const { logger, safeUnlink } = require('./utils');
const queueDatabase = require('./queueDatabase');

const log = logger.child('ChunkedDownloader');

// Estados de chunk
const ChunkState = Object.freeze({
    PENDING: 'pending',
    DOWNLOADING: 'downloading',
    COMPLETED: 'completed',
    PAUSED: 'paused',
    FAILED: 'failed'
});

/**
 * Clase para manejar la descarga de un chunk individual
 */
class ChunkDownload {
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
        
        // Callbacks
        this.onProgress = options.onProgress || (() => {});
        this.onComplete = options.onComplete || (() => {});
        this.onError = options.onError || (() => {});
    }

    /**
     * Inicia la descarga del chunk
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

        log.debug(`Iniciando chunk ${this.chunkIndex}: bytes ${actualStartByte}-${this.endByte} (${bytesToDownload} bytes)`);

        try {
            // Crear directorio si no existe
            const dir = path.dirname(this.tempFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Crear request con Range header
            this.request = net.request(this.url);
            this.request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            this.request.setHeader('Referer', 'https://myrient.erista.me/');
            this.request.setHeader('Accept', '*/*');
            this.request.setHeader('Connection', 'keep-alive');
            this.request.setHeader('Range', `bytes=${actualStartByte}-${this.endByte}`);

            this.request.on('response', (response) => this._handleResponse(response, actualStartByte));
            this.request.on('error', (error) => this._handleError(error));

            this.request.end();

        } catch (error) {
            this._handleError(error);
        }
    }

    /**
     * Maneja la respuesta HTTP
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
        const writeMode = (this.downloadedBytes > 0 && response.statusCode === 206) ? 'a' : 'w';
        
        try {
            this.fileStream = fs.createWriteStream(this.tempFile, { flags: writeMode });
            this.fileStream.setMaxListeners(15);
        } catch (error) {
            this._handleError(error);
            return;
        }

        // Variables locales para este chunk
        const chunkTotalBytes = this.endByte - this.startByte + 1;
        let sessionDownloaded = 0;

        // Handler para errores de escritura
        this.fileStream.on('error', (error) => {
            log.error(`Chunk ${this.chunkIndex} error de escritura:`, error.message);
            this._handleError(error);
        });

        // Handler para datos
        response.on('data', (chunk) => {
            if (this.isAborted || !this.fileStream || this.fileStream.destroyed) {
                return;
            }

            // Escribir con backpressure
            const canContinue = this.fileStream.write(chunk);
            if (!canContinue) {
                response.pause();
                this.fileStream.once('drain', () => {
                    if (!this.isAborted && !response.destroyed) {
                        response.resume();
                    }
                });
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
                speed: this.speed
            });
        });

        // Handler para fin
        response.on('end', () => {
            if (this.isAborted) return;

            if (this.fileStream && !this.fileStream.destroyed) {
                this.fileStream.end(() => {
                    // Verificar que descargamos todos los bytes esperados
                    const expectedBytes = this.endByte - this.startByte + 1;
                    
                    if (this.downloadedBytes >= expectedBytes) {
                        log.debug(`Chunk ${this.chunkIndex} completado: ${this.downloadedBytes}/${expectedBytes} bytes`);
                        this.state = ChunkState.COMPLETED;
                        this.onComplete(this);
                    } else {
                        log.warn(`Chunk ${this.chunkIndex} incompleto: ${this.downloadedBytes}/${expectedBytes} bytes`);
                        this._handleError(new Error(`Descarga incompleta: ${this.downloadedBytes}/${expectedBytes}`));
                    }
                });
            }
        });

        // Handler para errores de response
        response.on('error', (error) => {
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
     * Maneja errores
     */
    _handleError(error) {
        if (this.isAborted) return;

        log.error(`Chunk ${this.chunkIndex} error:`, error.message);
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
    _cleanup(keepTempFile = true) {
        // Abortar request
        if (this.request) {
            try {
                this.request.abort();
            } catch (e) {}
            this.request = null;
        }

        // Cerrar response
        if (this.response) {
            try {
                this.response.removeAllListeners();
                if (!this.response.destroyed) {
                    this.response.destroy();
                }
            } catch (e) {}
            this.response = null;
        }

        // Cerrar fileStream
        if (this.fileStream) {
            try {
                this.fileStream.removeAllListeners();
                if (!this.fileStream.destroyed) {
                    this.fileStream.end();
                }
            } catch (e) {}
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
            speed: this.speed
        };
    }
}

/**
 * Clase principal para descargas fragmentadas
 */
class ChunkedDownloader {
    /**
     * @param {Object} options - Opciones de configuración
     * @param {number} options.downloadId - ID de la descarga en BD
     * @param {string} options.url - URL del archivo
     * @param {string} options.savePath - Ruta final del archivo
     * @param {number} options.totalBytes - Tamaño total del archivo
     * @param {number} [options.numChunks] - Número de chunks (auto-calculado si no se especifica)
     * @param {Function} [options.onProgress] - Callback de progreso
     * @param {Function} [options.onComplete] - Callback de completado
     * @param {Function} [options.onError] - Callback de error
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
        this.completedChunks = 0;
        this.totalDownloadedBytes = 0;
        this.isAborted = false;
        this.mergeInProgress = false;
        
        // Callbacks
        this.onProgress = options.onProgress || (() => {});
        this.onComplete = options.onComplete || (() => {});
        this.onError = options.onError || (() => {});
        
        // Configuración
        this.maxConcurrentChunks = config.downloads.chunked?.maxConcurrentChunks || 4;
        this.chunkRetries = config.downloads.chunked?.chunkRetries || 3;
        
        log.info(`ChunkedDownloader creado: ${this.title} (${this._formatBytes(this.totalBytes)}, ${this.numChunks} chunks)`);
    }

    /**
     * Calcula el número óptimo de chunks basado en el tamaño del archivo
     */
    _calculateOptimalChunks(totalBytes) {
        const minChunkSize = config.downloads.chunked?.minChunkSize || (5 * 1024 * 1024); // 5 MB mínimo
        const maxChunks = config.downloads.chunked?.maxChunks || 16;
        const defaultChunks = config.downloads.chunked?.defaultChunks || 4;
        
        // Archivos pequeños: menos chunks
        if (totalBytes < 50 * 1024 * 1024) { // < 50 MB
            return 2;
        }
        
        // Calcular chunks para mantener tamaño mínimo
        const calculatedChunks = Math.floor(totalBytes / minChunkSize);
        
        // Limitar entre 2 y maxChunks
        return Math.min(Math.max(calculatedChunks, 2), maxChunks);
    }

    /**
     * Inicia la descarga fragmentada
     */
    async start() {
        if (this.state === 'downloading') {
            log.warn('Descarga ya en progreso');
            return false;
        }

        log.info(`Iniciando descarga fragmentada: ${this.title}`);
        this.state = 'downloading';
        this.startTime = Date.now();
        this.isAborted = false;

        try {
            // Verificar o crear chunks en la BD
            await this._initializeChunks();

            // Iniciar chunks pendientes
            await this._startPendingChunks();

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
            
            this.chunks = existingChunks.map(dbChunk => new ChunkDownload({
                downloadId: this.downloadId,
                chunkIndex: dbChunk.chunk_index,
                startByte: dbChunk.start_byte,
                endByte: dbChunk.end_byte,
                downloadedBytes: dbChunk.downloaded_bytes || 0,
                state: dbChunk.state || ChunkState.PENDING,
                tempFile: dbChunk.temp_file || this._getChunkTempFile(dbChunk.chunk_index),
                url: this.url,
                onProgress: (info) => this._onChunkProgress(info),
                onComplete: (chunk) => this._onChunkComplete(chunk),
                onError: (chunk, error) => this._onChunkError(chunk, error)
            }));

            // Calcular bytes ya descargados
            this.totalDownloadedBytes = this.chunks.reduce((sum, c) => sum + c.downloadedBytes, 0);
            this.completedChunks = this.chunks.filter(c => c.state === ChunkState.COMPLETED).length;

            log.info(`Estado recuperado: ${this.completedChunks}/${this.chunks.length} completados, ${this._formatBytes(this.totalDownloadedBytes)} descargados`);

        } else {
            log.info(`Creando ${this.numChunks} nuevos chunks`);
            
            // Crear chunks en la BD
            const dbChunks = queueDatabase.createChunks(this.downloadId, this.totalBytes, this.numChunks);

            // Crear objetos ChunkDownload
            this.chunks = dbChunks.map((dbChunk, index) => new ChunkDownload({
                downloadId: this.downloadId,
                chunkIndex: index,
                startByte: dbChunk.startByte,
                endByte: dbChunk.endByte,
                downloadedBytes: 0,
                state: ChunkState.PENDING,
                tempFile: this._getChunkTempFile(index),
                url: this.url,
                onProgress: (info) => this._onChunkProgress(info),
                onComplete: (chunk) => this._onChunkComplete(chunk),
                onError: (chunk, error) => this._onChunkError(chunk, error)
            }));

            // Actualizar temp_file en BD
            this.chunks.forEach(chunk => {
                queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                    tempFile: chunk.tempFile,
                    state: ChunkState.PENDING,
                    downloadedBytes: 0
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
        const pendingChunks = this.chunks.filter(c => 
            c.state === ChunkState.PENDING || c.state === ChunkState.PAUSED
        );

        // Calcular cuántos slots disponibles hay
        const activeCount = this.activeChunks.size;
        const slotsAvailable = this.maxConcurrentChunks - activeCount;

        if (slotsAvailable <= 0 || pendingChunks.length === 0) {
            return;
        }

        // Iniciar chunks hasta llenar los slots
        const chunksToStart = pendingChunks.slice(0, slotsAvailable);
        
        log.debug(`Iniciando ${chunksToStart.length} chunks (${activeCount} activos, ${slotsAvailable} slots)`);

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
     * Callback cuando un chunk reporta progreso
     */
    _onChunkProgress(info) {
        if (this.isAborted) return;

        // Actualizar estado en BD
        queueDatabase.updateChunk(this.downloadId, info.chunkIndex, {
            downloadedBytes: info.downloadedBytes,
            state: ChunkState.DOWNLOADING
        });

        // Calcular progreso total
        const totalDownloaded = this.chunks.reduce((sum, c) => sum + c.downloadedBytes, 0);
        const overallProgress = totalDownloaded / this.totalBytes;

        // Calcular velocidad total (suma de velocidades de chunks activos)
        let totalSpeed = 0;
        this.activeChunks.forEach(chunk => {
            totalSpeed += chunk.speed || 0;
        });

        // Actualizar progreso en BD principal
        queueDatabase.updateProgress(this.downloadId, overallProgress, totalDownloaded);

        // Notificar callback
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
            chunkProgress: this.chunks.map(c => ({
                index: c.chunkIndex,
                progress: c.downloadedBytes / (c.endByte - c.startByte + 1),
                speed: c.speed
            }))
        });
    }

    /**
     * Callback cuando un chunk se completa
     */
    _onChunkComplete(chunk) {
        log.info(`Chunk ${chunk.chunkIndex} completado`);

        // Actualizar BD
        queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
            downloadedBytes: chunk.downloadedBytes,
            state: ChunkState.COMPLETED
        });

        // Actualizar contadores
        this.completedChunks++;
        this.activeChunks.delete(chunk.chunkIndex);

        // Verificar si todos los chunks están completados
        const allCompleted = this.chunks.every(c => c.state === ChunkState.COMPLETED);

        if (allCompleted) {
            log.info(`Todos los chunks completados, iniciando fusión`);
            this._mergeChunks();
        } else {
            // Iniciar más chunks si hay disponibles
            this._startPendingChunks();
        }
    }

    /**
     * Callback cuando un chunk tiene error
     */
    _onChunkError(chunk, error) {
        log.error(`Chunk ${chunk.chunkIndex} error:`, error.message);

        this.activeChunks.delete(chunk.chunkIndex);

        // Verificar reintentos
        if (!chunk.retryCount) chunk.retryCount = 0;
        chunk.retryCount++;

        if (chunk.retryCount < this.chunkRetries) {
            log.info(`Reintentando chunk ${chunk.chunkIndex} (${chunk.retryCount}/${this.chunkRetries})`);
            
            // Resetear estado para reintento
            chunk.state = ChunkState.PENDING;
            chunk.isAborted = false;

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
                state: ChunkState.FAILED
            });

            // Fallar toda la descarga
            this.state = 'failed';
            this.isAborted = true;
            this._cleanupAllChunks(true); // Mantener archivos para posible reanudación

            this.onError(this, new Error(`Chunk ${chunk.chunkIndex} falló: ${error.message}`));
        }
    }

    /**
     * Fusiona todos los chunks en el archivo final
     */
    async _mergeChunks() {
        if (this.mergeInProgress) return;
        this.mergeInProgress = true;
        this.state = 'merging';

        log.info(`Fusionando ${this.chunks.length} chunks en ${this.savePath}`);

        // Notificar estado de fusión
        this.onProgress({
            downloadId: this.downloadId,
            state: 'merging',
            percent: 1,
            downloadedBytes: this.totalBytes,
            totalBytes: this.totalBytes
        });

        try {
            // Verificar que todos los chunks existen
            for (const chunk of this.chunks) {
                if (!fs.existsSync(chunk.tempFile)) {
                    throw new Error(`Chunk ${chunk.chunkIndex} no encontrado: ${chunk.tempFile}`);
                }

                const stats = fs.statSync(chunk.tempFile);
                const expectedSize = chunk.endByte - chunk.startByte + 1;
                
                if (stats.size < expectedSize) {
                    throw new Error(`Chunk ${chunk.chunkIndex} incompleto: ${stats.size}/${expectedSize}`);
                }
            }

            // Crear archivo de destino
            const finalDir = path.dirname(this.savePath);
            if (!fs.existsSync(finalDir)) {
                fs.mkdirSync(finalDir, { recursive: true });
            }

            // Si existe archivo previo, eliminarlo
            if (fs.existsSync(this.savePath)) {
                fs.unlinkSync(this.savePath);
            }

            // Fusionar chunks en orden
            const writeStream = fs.createWriteStream(this.savePath);

            await new Promise((resolve, reject) => {
                writeStream.on('error', reject);
                writeStream.on('finish', resolve);

                // Función recursiva para escribir chunks en orden
                const writeChunk = (index) => {
                    if (index >= this.chunks.length) {
                        writeStream.end();
                        return;
                    }

                    const chunk = this.chunks[index];
                    const readStream = fs.createReadStream(chunk.tempFile);

                    readStream.on('error', reject);
                    readStream.on('end', () => {
                        log.debug(`Chunk ${index} fusionado`);
                        writeChunk(index + 1);
                    });

                    readStream.pipe(writeStream, { end: false });
                };

                writeChunk(0);
            });

            // Verificar tamaño final
            const finalStats = fs.statSync(this.savePath);
            if (finalStats.size !== this.totalBytes) {
                throw new Error(`Tamaño final incorrecto: ${finalStats.size}/${this.totalBytes}`);
            }

            log.info(`Fusión completada: ${this._formatBytes(finalStats.size)}`);

            // Eliminar archivos temporales
            for (const chunk of this.chunks) {
                try {
                    if (fs.existsSync(chunk.tempFile)) {
                        fs.unlinkSync(chunk.tempFile);
                    }
                } catch (e) {
                    log.warn(`Error eliminando temp file ${chunk.tempFile}:`, e.message);
                }
            }

            // Limpiar chunks de la BD
            this.chunks.forEach(chunk => {
                queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                    state: ChunkState.COMPLETED,
                    downloadedBytes: chunk.endByte - chunk.startByte + 1
                });
            });

            // Marcar descarga como completada
            this.state = 'completed';
            this.mergeInProgress = false;

            // Notificar completado
            this.onComplete({
                downloadId: this.downloadId,
                savePath: this.savePath,
                totalBytes: this.totalBytes,
                duration: (Date.now() - this.startTime) / 1000
            });

        } catch (error) {
            log.error('Error en fusión:', error);
            this.state = 'failed';
            this.mergeInProgress = false;

            // No eliminar chunks para permitir reintento
            this.onError(this, error);
        }
    }

    /**
     * Pausa la descarga
     */
    pause() {
        if (this.state !== 'downloading') {
            log.warn('No se puede pausar: no está descargando');
            return false;
        }

        log.info(`Pausando descarga fragmentada: ${this.title}`);
        this.isAborted = true;
        this.state = 'paused';

        // Pausar todos los chunks activos
        this.activeChunks.forEach(chunk => {
            chunk.pause();
            
            // Guardar estado en BD
            queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                downloadedBytes: chunk.downloadedBytes,
                state: ChunkState.PAUSED
            });
        });

        this.activeChunks.clear();

        return true;
    }

    /**
     * Reanuda la descarga pausada
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
     * Cancela y limpia todo
     */
    cancel(keepFiles = false) {
        log.info(`Cancelando descarga fragmentada: ${this.title}`);
        this.isAborted = true;
        this.state = 'cancelled';

        this._cleanupAllChunks(!keepFiles);

        // Eliminar chunks de la BD si no se mantienen archivos
        if (!keepFiles) {
            this.chunks.forEach(chunk => {
                try {
                    queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                        state: 'cancelled',
                        downloadedBytes: 0
                    });
                } catch (e) {}
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
        this.cancel(true); // Mantener archivos por si se quiere reanudar
        this.chunks = [];
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
            chunks: this.chunks.map(c => c.toJSON())
        };
    }

    /**
     * Verifica si el servidor soporta Range requests
     * @static
     */
    static async checkRangeSupport(url) {
        return new Promise((resolve) => {
            const request = net.request({ method: 'HEAD', url });
            
            request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
            request.setHeader('Range', 'bytes=0-0');

            const timeout = setTimeout(() => {
                request.abort();
                resolve({ supported: false, error: 'timeout' });
            }, 10000);

            request.on('response', (response) => {
                clearTimeout(timeout);

                const acceptRanges = response.headers['accept-ranges'];
                const contentRange = response.headers['content-range'];

                const supported = (
                    response.statusCode === 206 ||
                    acceptRanges === 'bytes' ||
                    contentRange !== undefined
                );

                resolve({
                    supported,
                    statusCode: response.statusCode,
                    acceptRanges,
                    contentRange,
                    contentLength: response.headers['content-length']
                });
            });

            request.on('error', (error) => {
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
