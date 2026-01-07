/**
 * ChunkedDownloader - Descargador Fragmentado con Range Requests
 * 
 * Implementa descargas paralelas dividiendo archivos grandes en fragmentos (chunks)
 * que se descargan simultáneamente usando HTTP Range headers.
 * 
 */

const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const config = require('./config');
const { logger, safeUnlink } = require('./utils');
const queueDatabase = require('./queueDatabase');
const ProgressBatcher = require('./progressBatcher');
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
            this.fileStream = fs.createWriteStream(this.tempFile, { 
                flags: writeMode,
                highWaterMark: config.downloads.writeBufferSize || (1024 * 1024) // 1MB buffer
            });
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

        // Cerrar fileStream
        if (this.fileStream) {
            try {
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
            speed: this.speed
        };
    }
}

/**
 * Clase principal para descargas fragmentadas
 */
class ChunkedDownloader {

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
        
        // Concurrencia adaptativa
        this.adaptiveConcurrency = config.downloads.chunked?.adaptiveConcurrency || false;
        this.currentConcurrency = this.maxConcurrentChunks;
        this.backpressureCount = 0;
        
        // Progress batcher
        this.progressBatcher = new ProgressBatcher(queueDatabase, 
            config.downloads.chunked?.dbBatchInterval || 2000
        );

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
     * Ajusta la concurrencia dinámicamente basado en rendimiento
     */
    _adjustConcurrency() {
        if (!this.adaptiveConcurrency) return;
        
        // Calcular velocidad promedio de chunks activos
        let totalSpeed = 0;
        let activeCount = 0;
        
        this.activeChunks.forEach(chunk => {
            if (chunk.speed > 0) {
                totalSpeed += chunk.speed;
                activeCount++;
            }
        });

        if (activeCount === 0) return;
        
        const avgSpeed = totalSpeed / activeCount;
        const targetSpeed = config.downloads.chunked?.targetSpeedPerChunk || (5 * 1024 * 1024);
        const backpressureThreshold = config.downloads.chunked?.backpressureThreshold || 5;
        
        // Si velocidad es baja y no hay mucho backpressure, aumentar concurrencia
        if (avgSpeed < targetSpeed && this.backpressureCount < backpressureThreshold) {
            if (this.currentConcurrency < this.maxConcurrentChunks) {
                this.currentConcurrency = Math.min(
                    this.currentConcurrency + 1,
                    this.maxConcurrentChunks
                );
                log.debug(`Concurrencia aumentada a ${this.currentConcurrency}`);
            }
        }
        // Si hay mucho backpressure, reducir
        else if (this.backpressureCount >= backpressureThreshold) {
            if (this.currentConcurrency > 2) {
                this.currentConcurrency = Math.max(2, this.currentConcurrency - 1);
                log.debug(`Concurrencia reducida a ${this.currentConcurrency}`);
            }
            this.backpressureCount = 0; // Reset counter
        }
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
            
            // NUEVO: Pre-allocar espacio
            await this._preallocateFile();
            
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
                    log.debug(`Chunk ${chunk.chunkIndex}: estado 'downloading' de sesión anterior, reseteando a pending`);
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
                        state: ChunkState.PENDING
                    });
                    chunksFixed++;
                }
                // Normalizar estado 'failed' - también debe reintentar
                else if (chunk.state === ChunkState.FAILED || chunk.state === 'failed') {
                    log.debug(`Chunk ${chunk.chunkIndex}: estado 'failed', reseteando a pending para reintentar`);
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
                        state: ChunkState.PENDING
                    });
                    chunksFixed++;
                }
                else if (chunk.state === ChunkState.COMPLETED) {
                    const expectedSize = chunk.endByte - chunk.startByte + 1;
                    
                    if (!fs.existsSync(chunk.tempFile)) {
                        // Archivo no existe, resetear chunk
                        log.warn(`Chunk ${chunk.chunkIndex}: marcado como completado pero archivo no existe, reiniciando`);
                        chunk.state = ChunkState.PENDING;
                        chunk.downloadedBytes = 0;
                        chunksFixed++;
                        
                        queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                            downloadedBytes: 0,
                            state: ChunkState.PENDING
                        });
                    } else {
                        try {
                            const stats = fs.statSync(chunk.tempFile);
                            if (stats.size < expectedSize) {
                                // Archivo incompleto, resetear chunk
                                log.warn(`Chunk ${chunk.chunkIndex}: archivo incompleto (${stats.size}/${expectedSize} bytes), reiniciando`);
                                chunk.state = ChunkState.PENDING;
                                chunk.downloadedBytes = stats.size;
                                chunksFixed++;
                                
                                queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                                    downloadedBytes: stats.size,
                                    state: ChunkState.PENDING
                                });
                            }
                        } catch (e) {
                            // Error leyendo archivo, resetear chunk
                            log.warn(`Chunk ${chunk.chunkIndex}: error verificando archivo (${e.message}), reiniciando`);
                            chunk.state = ChunkState.PENDING;
                            chunk.downloadedBytes = 0;
                            chunksFixed++;
                            
                            queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                                downloadedBytes: 0,
                                state: ChunkState.PENDING
                            });
                        }
                    }
                } else if (chunk.state === ChunkState.PENDING || chunk.state === ChunkState.PAUSED) {
                    // Para chunks pendientes/pausados, sincronizar con tamaño real del archivo
                    if (fs.existsSync(chunk.tempFile)) {
                        try {
                            const stats = fs.statSync(chunk.tempFile);
                            if (stats.size !== chunk.downloadedBytes) {
                                log.debug(`Chunk ${chunk.chunkIndex}: sincronizando bytes (archivo: ${stats.size}, BD: ${chunk.downloadedBytes})`);
                                chunk.downloadedBytes = stats.size;
                                
                                queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                                    downloadedBytes: stats.size
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
                            downloadedBytes: 0
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
        const slotsAvailable = this.currentConcurrency - activeCount;

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

        // Actualiza la base de datos con batcher
        this.progressBatcher.queueChunkUpdate(this.downloadId, info.chunkIndex, {
            downloadedBytes: info.downloadedBytes,
            state: ChunkState.DOWNLOADING
        });

        // Calcular progreso total
        const totalDownloaded = this.chunks.reduce((sum, c) => sum + c.downloadedBytes, 0);
        const overallProgress = totalDownloaded / this.totalBytes;

        this.progressBatcher.queueProgressUpdate(this.downloadId, overallProgress, totalDownloaded);

        // Calcular velocidad total (suma de velocidades de chunks activos)
        let totalSpeed = 0;
        this.activeChunks.forEach(chunk => {
            totalSpeed += chunk.speed || 0;
        });

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

        // Ajustar concurrencia periódicamente
        this._adjustConcurrency();
    }

    /**
     * Callback cuando un chunk se completa
     */
    async _onChunkComplete(chunk) {
        log.info(`Chunk ${chunk.chunkIndex} completado`);

        // Flush pendientes de este chunk antes de marcar completado
        await this.progressBatcher.flushDownload(this.downloadId);

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
            
            // IMPORTANTE: Si el archivo temporal fue eliminado, resetear downloadedBytes
            if (!fs.existsSync(chunk.tempFile)) {
                log.debug(`Chunk ${chunk.chunkIndex}: archivo temporal eliminado, reiniciando desde byte ${chunk.startByte}`);
                chunk.downloadedBytes = 0;
                
                // Actualizar BD
                queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                    downloadedBytes: 0,
                    state: ChunkState.PENDING
                });
            } else {
                // Si el archivo existe, verificar su tamaño real y sincronizar
                try {
                    const stats = fs.statSync(chunk.tempFile);
                    if (stats.size !== chunk.downloadedBytes) {
                        log.debug(`Chunk ${chunk.chunkIndex}: sincronizando bytes (archivo: ${stats.size}, memoria: ${chunk.downloadedBytes})`);
                        chunk.downloadedBytes = stats.size;
                        
                        queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                            downloadedBytes: stats.size,
                            state: ChunkState.PENDING
                        });
                    }
                } catch (e) {
                    // Si hay error leyendo el archivo, resetear
                    log.debug(`Chunk ${chunk.chunkIndex}: error leyendo archivo temporal, reiniciando`);
                    chunk.downloadedBytes = 0;
                    queueDatabase.updateChunk(this.downloadId, chunk.chunkIndex, {
                        downloadedBytes: 0,
                        state: ChunkState.PENDING
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
     * Fusiona todos los chunks en el archivo final (versión optimizada)
     */
    async _mergeChunks() {
        if (this.mergeInProgress) return;
        this.mergeInProgress = true;
        this.state = 'merging';

        log.info(`Iniciando fusión optimizada de ${this.chunks.length} chunks`);

        const BUFFER_SIZE = config.downloads.chunked?.mergeBufferSize || (64 * 1024 * 1024);

        try {
            // Usar handle de archivo para control preciso
            const finalHandle = await fs.promises.open(this.savePath, 'w');
            let position = 0;

            for (let i = 0; i < this.chunks.length; i++) {
                const chunk = this.chunks[i];
                const chunkSize = chunk.endByte - chunk.startByte + 1;
                
                log.debug(`Fusionando chunk ${i + 1}/${this.chunks.length}`);

                const chunkHandle = await fs.promises.open(chunk.tempFile, 'r');
                const buffer = Buffer.allocUnsafe(Math.min(BUFFER_SIZE, chunkSize));
                
                try {
                    let bytesProcessed = 0;

                    while (bytesProcessed < chunkSize) {
                        const toRead = Math.min(buffer.length, chunkSize - bytesProcessed);
                        const { bytesRead } = await chunkHandle.read(
                            buffer, 0, toRead, bytesProcessed
                        );

                        if (bytesRead === 0) break;

                        await finalHandle.write(buffer, 0, bytesRead, position);
                        position += bytesRead;
                        bytesProcessed += bytesRead;
                    }
                } finally {
                    await chunkHandle.close();
                }

                // Eliminar temp file inmediatamente para liberar espacio
                try {
                    await fs.promises.unlink(chunk.tempFile);
                } catch (e) {
                    log.warn(`Error eliminando temp ${chunk.tempFile}:`, e.message);
                }

                // Actualizar progreso de fusión
                this.onProgress({
                    downloadId: this.downloadId,
                    state: 'merging',
                    mergeProgress: (i + 1) / this.chunks.length
                });
            }

            await finalHandle.close();

            // Verificar tamaño final
            const finalStats = await fs.promises.stat(this.savePath);
            if (finalStats.size !== this.totalBytes) {
                throw new Error(`Tamaño final incorrecto: ${finalStats.size}/${this.totalBytes}`);
            }

            log.info(`Fusión completada: ${this._formatBytes(finalStats.size)}`);

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
        this.cancel(true); // Mantener archivos por si se quiere reanudar
        this.chunks = [];

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
            chunks: this.chunks.map(c => c.toJSON())
        };
    }

    /**
     * Verifica si el servidor soporta Range requests
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
