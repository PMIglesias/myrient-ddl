/**
 * Gestor de descargas
 * Maneja la cola, concurrencia, reintentos y persistencia de descargas
 * 
 * ACTUALIZADO v2.0 (Block 2):
 * - Usa queueDatabase (SQLite) para persistencia robusta
 * - Integra ChunkedDownloader para descargas fragmentadas
 * - Soporte automático de Range requests para archivos grandes
 */

const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const config = require('./config');
const { logger, readJSONFile, writeJSONFile, sanitizeFilename, safeUnlink } = require('./utils');
const database = require('./database');
const queueDatabase = require('./queueDatabase');
const { DownloadState, DownloadPriority } = require('./queueDatabase');
const { isValidUrl, getNetworkErrorMessage } = require('./utils/validation');
const ChunkedDownloader = require('./ChunkedDownloader');
const { CircuitBreaker } = require('./utils/circuitBreaker');
const { serviceManager } = require('./services');

const log = logger.child('DownloadManager');

class DownloadManager {
    constructor() {
        this.activeDownloads = new Map();  // Descargas activas (simples)
        this.chunkedDownloads = new Map(); // Descargas fragmentadas activas
        this.downloadQueue = [];            // Cola de descargas pendientes
        this.processing = false;            // Indicador de procesamiento
        this.processingLock = false;        // Un bloqueo clasico para evitar los race conditions
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
                onStateChange: (info) => {
                    log.warn(`[CircuitBreaker] Estado cambiado: ${info.oldState} -> ${info.newState}`);
                    if (info.newState === 'OPEN') {
                        this._sendProgress({
                            type: 'circuit-breaker-open',
                            message: 'Circuit breaker abierto debido a errores repetidos. Las descargas se pausarán temporalmente.'
                        });
                    } else if (info.newState === 'CLOSED') {
                        this._sendProgress({
                            type: 'circuit-breaker-closed',
                            message: 'Circuit breaker cerrado. Descargas reanudadas normalmente.'
                        });
                    }
                }
            });
        } else {
            this.circuitBreaker = null;
        }
        
        // Circuit Breakers por host para aislar problemas de servidores específicos
        this.hostCircuitBreakers = new Map();
    }

    /**
     * Establece referencias necesarias
     */
    async initialize(mainWindow, progressThrottler) {
        this.mainWindow = mainWindow;
        this.progressThrottler = progressThrottler;
        
        // Inicializar servicios si no están inicializados
        if (!serviceManager.initialized) {
            await serviceManager.initialize();
        }
        
        // Obtener referencias a servicios
        this.downloadService = serviceManager.getDownloadService();
        this.fileService = serviceManager.getFileService();
        this.queueService = serviceManager.getQueueService();
        
        // Si QueueService está disponible, actualizar maxConcurrent desde el servicio
        if (this.queueService) {
            // QueueService ya tiene maxConcurrent configurado
            log.debug('QueueService inicializado, usando lógica de negocio para gestión de cola');
        }
    }
    
    /**
     * FIX MEMORY LEAK: Limpia todos los recursos al cerrar la aplicación
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
        
        log.info('DownloadManager destruido');
    }


    // =====================
    // GESTIÍ“N DE LOCK
    // =====================

    /**
     * Adquiere lock con timeout para operaciones críticas
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
     * Libera el lock
     */
    releaseLock() {
        this.processingLock = false;
    }

    // =====================
    // GESTIÍ“N DE COLA
    // =====================

    /**
     * Verifica si hay slots disponibles
     * Usa QueueService si está disponible para consistencia
     */
    canStartDownload() {
        const totalActive = this.activeDownloads.size + this.chunkedDownloads.size;
        
        // Usar QueueService si está disponible
        if (this.queueService) {
            const availability = this.queueService.checkAvailability(totalActive, this.downloadQueue.length);
            log.debug(`Verificando slots: ${availability.activeCount}/${availability.maxConcurrent} (disponibles: ${availability.slotsAvailable})`);
            return availability.canStart;
        }
        
        // Fallback: método directo
        log.debug(`Verificando slots: ${totalActive}/${config.downloads.maxConcurrent}`);
        return totalActive < config.downloads.maxConcurrent;
    }

    /**
     * Verifica si una descarga está activa o en cola
     */
    isDownloadActive(downloadId) {
        return this.activeDownloads.has(downloadId) ||
            this.chunkedDownloads.has(downloadId) ||
            this.downloadQueue.some(d => d.id === downloadId);
    }

    /**
     * Agrega una descarga a la cola
     * Usa QueueService para mantener la cola ordenada por prioridad
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
            priority: download.priority || DownloadPriority.NORMAL
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

    /**
     * Agrega a la cola y persiste en SQLite
     */
    addToQueueWithPersist(download) {
        // Primero agregar a SQLite
        queueDatabase.addDownload({
            id: download.id,
            title: download.title,
            downloadPath: download.downloadPath,
            preserveStructure: download.preserveStructure,
            forceOverwrite: download.forceOverwrite,
            priority: download.priority || DownloadPriority.NORMAL,
            metadata: download.metadata || {}
        });
        
        // Luego a la cola en memoria
        const position = this.addToQueue(download);
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
            lastUpdate: Date.now()
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
     * Procesa la cola, iniciando descargas según slots disponibles
     * Usa QueueService para ordenamiento, selección y estadísticas
     */
    async processQueue() {
        if (this.processing) {
            log.debug('Ya hay un proceso de cola en ejecución');
            return;
        }

        if (!await this.acquireLock()) {
            log.error('No se pudo adquirir lock para procesar cola');
            return;
        }

        this.processing = true;

        try {
            // Calcular estadísticas usando QueueService si está disponible
            const totalActive = this.activeDownloads.size + this.chunkedDownloads.size;
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
                    const availability = this.queueService.checkAvailability(totalActive, this.downloadQueue.length);
                    canStart = availability.canStart;
                    
                    if (!canStart) {
                        // No hay slots disponibles, salir del loop
                        log.debug(`No hay slots disponibles (${availability.slotsAvailable} slots, ${availability.activeCount} activas)`);
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
                    downloadsToStart = this.queueService.selectDownloadsToStart(this.downloadQueue, totalActive);
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
                    // Remover de la cola
                    const index = this.downloadQueue.findIndex(d => d.id === nextDownload.id);
                    if (index !== -1) {
                        this.downloadQueue.splice(index, 1);
                    }

                    // Verificar que no esté activa (doble verificación)
                    if (this.hasActiveDownload(nextDownload.id)) {
                        log.warn(`Descarga ${nextDownload.id} ya está activa, saltando`);
                        continue;
                    }

                    // Reservar slot temporalmente
                    this.setActiveDownload(nextDownload.id, {
                        id: nextDownload.id,
                        title: nextDownload.title,
                        state: 'reserved',
                        startTime: Date.now(),
                        request: null,
                        response: null,
                        fileStream: null,
                        savePath: null
                    });

                    log.info(`Iniciando descarga desde cola: ${nextDownload.title} (prioridad: ${nextDownload.priority || DownloadPriority.NORMAL})`);
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
                        priority: nextDownload.priority
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
                    
                    if (timeEstimate.totalEstimatedSeconds !== null && timeEstimate.totalEstimatedSeconds > 0) {
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
    _handleDownloadError(download, error) {
        log.error(`Error en descarga (${download.title}):`, error.message);

        this.deleteActiveDownload(download.id);

        // Usar SQLite para manejar reintentos
        queueDatabase.failDownload(download.id, error.message);
        
        // Verificar si se va a reintentar
        const dbDownload = queueDatabase.getById(download.id);
        
        if (dbDownload && dbDownload.state === DownloadState.QUEUED) {
            // Se va a reintentar - agregar de vuelta a la cola en memoria
            log.info(`Reintentando ${download.title} (${dbDownload.retryCount}/${dbDownload.maxRetries})`);
            
            setTimeout(() => {
                download.retryCount = dbDownload.retryCount;
                this.downloadQueue.unshift(download);
                this.processQueue();
            }, this.retryDelay * (dbDownload.retryCount || 1));
            
        } else {
            // Falló definitivamente
            log.error(`Descarga ${download.title} falló después de múltiples intentos`);

            this._sendProgress({
                id: download.id,
                state: 'interrupted',
                error: 'Error después de múltiples reintentos'
            });
        }

        setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
    }

    // =====================
    // INICIO DE DESCARGA
    // =====================

    /**
     * Inicia una descarga
     * Decide automáticamente si usar descarga simple o fragmentada
     */
    async startDownload({ id, title, downloadPath, preserveStructure, forceOverwrite, savePath: providedSavePath }) {
        if (!id || !title) {
            log.error('startDownload: Parámetros inválidos', { id, title });
            return;
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
            savePath: null
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
                    savePath = await this._determineSavePath({
                        id, title, downloadPath, preserveStructure
                    });
                }
            }

            if (!savePath) {
                this.deleteActiveDownload(id);
                this._sendProgress({ id, state: 'cancelled', error: 'No se seleccionó ubicación' });
                setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
                return;
            }

            // Verificar archivo existente usando FileService
            // Para descargas fragmentadas, verificar si ya existe el archivo final completo
            if (!forceOverwrite && expectedFileSize > 0) {
                let fileCheck;
                
                // Usar FileService para verificar archivo existente si está disponible
                if (this.fileService) {
                    fileCheck = await this.fileService.getFileCheckInfo(savePath, expectedFileSize);
                } else {
                    // Fallback: usar método síncrono
                    fileCheck = this._checkExistingFile(savePath, expectedFileSize);
                }
                
                // También verificar si hay un archivo parcial que podría ser confundido
                const partialFilePath = savePath + '.part';
                const hasPartialFile = fs.existsSync(partialFilePath);
                
                // Solo pedir confirmación si:
                // 1. El archivo final existe Y tiene tamaño similar (o shouldOverwrite es true)
                // 2. NO hay archivo parcial (para evitar confusión)
                const shouldConfirm = fileCheck.exists && 
                    (fileCheck.shouldOverwrite || fileCheck.similarSize) && 
                    !hasPartialFile;
                
                if (shouldConfirm) {
                    log.info('Solicitando confirmación para:', title);
                    this.deleteActiveDownload(id);
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
                            similarSize: fileCheck.similarSize !== undefined ? fileCheck.similarSize : (fileCheck.sizeDifference <= config.files?.sizeMarginBytes),
                            hasPartialFile: hasPartialFile
                        }
                    });
                    return;
                }
                
                // Si hay archivo parcial pero el archivo final no existe o es diferente,
                // continuar normalmente (el archivo parcial se usará para reanudación)
                if (fileCheck.exists && !fileCheck.similarSize && !fileCheck.shouldOverwrite) {
                    log.info(`Archivo existente tiene tamaño diferente (${fileCheck.actualSize || fileCheck.existingSize} vs ${expectedFileSize}), continuando con descarga`);
                }
            }

            // Preparar directorio usando FileService
            const prepared = await this.fileService.prepareDirectory(path.dirname(savePath));
            if (!prepared.success) {
                throw new Error(prepared.error);
            }

            // =====================================
            // DECISIÍ"N: Simple vs Fragmentada usando DownloadService
            // =====================================
            const useChunked = await this.downloadService.shouldUseChunkedDownload(downloadUrl, expectedFileSize);
            
            if (useChunked) {
                log.info(`Usando descarga FRAGMENTADA para ${title} (${this._formatBytes(expectedFileSize)})`);
                await this._executeChunkedDownload({
                    id, title, downloadUrl, savePath, expectedFileSize, forceOverwrite
                });
            } else {
                log.info(`Usando descarga SIMPLE para ${title} (${this._formatBytes(expectedFileSize)})`);
                await this._executeDownload({
                    id, title, downloadUrl, savePath, expectedFileSize, forceOverwrite
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
                error: errorMessage
            });
            setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
        }
    }

    /**
     * Determina si se debe usar descarga fragmentada
     * DEPRECATED: Usa DownloadService.shouldUseChunkedDownload() directamente
     * Mantenido para compatibilidad temporal
     */
    async _shouldUseChunkedDownload(url, fileSize) {
        // Delegar a DownloadService si está disponible
        if (this.downloadService) {
            // DownloadService solo verifica reglas de negocio básicas
            // Aquí también verificamos soporte de Range requests (lógica técnica)
            const shouldUse = await this.downloadService.shouldUseChunkedDownload(url, fileSize);
            
            if (!shouldUse) {
                return false;
            }
            
            // Verificar soporte de Range requests (lógica técnica, no de negocio)
            const chunkedConfig = this.chunkedConfig;
            if (chunkedConfig.checkRangeSupport !== false) {
                log.debug('Verificando soporte de Range requests...');
                const rangeCheck = await ChunkedDownloader.checkRangeSupport(url);
                
                if (!rangeCheck.supported) {
                    log.warn('Servidor no soporta Range requests, usando descarga simple');
                    log.debug('Range check result:', rangeCheck);
                    return false;
                }
                
                log.debug('Servidor soporta Range requests ✓');
            }
            
            return true;
        }
        
        // Fallback: lógica antigua si el servicio no está disponible
        const chunkedConfig = this.chunkedConfig;
        if (chunkedConfig.forceSimpleDownload) {
            log.debug('Descargas fragmentadas deshabilitadas por configuración');
            return false;
        }
        
        const threshold = chunkedConfig.sizeThreshold || (25 * 1024 * 1024);
        if (fileSize < threshold) {
            log.debug(`Archivo (${this._formatBytes(fileSize)}) menor al umbral (${this._formatBytes(threshold)})`);
            return false;
        }
        
        return true;
    }

    /**
     * Ejecuta una descarga fragmentada usando ChunkedDownloader
     */
    async _executeChunkedDownload({ id, title, downloadUrl, savePath, expectedFileSize, forceOverwrite }) {
        // Eliminar de descargas simples si estaba ahí
        this.activeDownloads.delete(id);
        
        // Registrar inicio en SQLite
        queueDatabase.startDownload(id, {
            url: downloadUrl,
            savePath,
            totalBytes: expectedFileSize,
            downloadedBytes: 0,
            isChunked: true
        });

        // Crear instancia de ChunkedDownloader
        const chunked = new ChunkedDownloader({
            downloadId: id,
            url: downloadUrl,
            savePath,
            totalBytes: expectedFileSize,
            title,
            onProgress: (info) => this._onChunkedProgress(info),
            onComplete: (info) => this._onChunkedComplete(info),
            onError: (downloader, error) => this._onChunkedError(downloader, error)
        });

        // Guardar referencia
        this.chunkedDownloads.set(id, chunked);

        // Notificar inicio
        this._sendProgress({
            id,
            state: 'starting',
            title,
            chunked: true,
            numChunks: chunked.numChunks
        });

        // Iniciar descarga
        await chunked.start();
    }

    /**
     * Callback de progreso para descargas fragmentadas
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
        const remainingTime = info.remainingTime !== undefined && info.remainingTime !== null 
            ? info.remainingTime 
            : (info.speed > 0 && info.totalBytes && info.downloadedBytes 
                ? (info.totalBytes - info.downloadedBytes) / (info.speed * 1024 * 1024) 
                : 0);

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
            chunkProgress: info.chunkProgress
        };

        // IMPORTANTE: Si hay un chunk que se acaba de completar (completado > 0 y chunkProgress muestra un chunk al 100%),
        // enviar actualización inmediata para asegurar que el frontend vea el progreso actualizado
        const hasJustCompletedChunk = info.chunkProgress && info.chunkProgress.some(chunk => 
            chunk.state === 'completed' && chunk.progress >= 0.99
        );

        if (this.progressThrottler) {
            if (hasJustCompletedChunk || info.forceImmediate) {
                // Enviar inmediatamente si hay un chunk recién completado
                this.progressThrottler.sendImmediate(progressInfo);
            } else {
                // Usar throttle normal para actualizaciones de progreso durante la descarga
                this.progressThrottler.queueUpdate(progressInfo);
            }
        }
    }

    /**
     * Callback de completado para descargas fragmentadas
     */
    _onChunkedComplete(info) {
        log.info(`Descarga fragmentada completada: ${info.savePath}`);

        // Marcar como completada en SQLite
        queueDatabase.completeDownload(info.downloadId, {
            savePath: info.savePath,
            duration: info.duration
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
            chunked: true
        });

        // Procesar siguiente en cola
        setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
    }

    /**
     * Callback de error para descargas fragmentadas
     */
    _onChunkedError(downloader, error) {
        log.error(`Error en descarga fragmentada ${downloader.downloadId}:`, error.message);

        // Marcar como fallida en SQLite
        queueDatabase.failDownload(downloader.downloadId, error.message);

        // Verificar si se va a reintentar
        const dbDownload = queueDatabase.getById(downloader.downloadId);

        if (dbDownload && dbDownload.state === DownloadState.QUEUED) {
            // Se va a reintentar
            log.info(`Reintentando descarga fragmentada ${downloader.title}`);
            
            setTimeout(() => {
                // Agregar de vuelta a la cola
                this.downloadQueue.unshift({
                    id: downloader.downloadId,
                    title: downloader.title,
                    retryCount: dbDownload.retryCount
                });
                this.processQueue();
            }, this.retryDelay * (dbDownload.retryCount || 1));
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
                chunked: true
            });
        }

        // Eliminar de activas
        this.chunkedDownloads.delete(downloader.downloadId);

        // Procesar siguiente
        setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
    }

    /**
     * Ejecuta la descarga HTTP simple (single stream)
     * Registra el inicio en SQLite para persistencia
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
            isChunked: false
        });

        // Obtener circuit breaker apropiado
        const circuitBreaker = this._getHostCircuitBreaker(downloadUrl);

        // Crear request protegido por circuit breaker
        let request;
        
        if (circuitBreaker && config.circuitBreaker?.enabled) {
            try {
                request = await circuitBreaker.execute(async () => {
                    return net.request(downloadUrl);
                }, () => {
                    // Fallback: si circuit está abierto, lanzar error
                    throw new Error('Circuit breaker abierto: demasiados errores en este host. Reintentando más tarde...');
                });
            } catch (error) {
                log.error(`[CircuitBreaker] Error al crear request para ${downloadUrl}:`, error.message);
                queueDatabase.failDownload(id, error.message);
                this._cleanupDownload(id, savePath, false);
                this._sendProgress({ 
                    id, 
                    state: 'interrupted', 
                    error: error.message, 
                    savePath,
                    circuitBreakerOpen: circuitBreaker.isOpen()
                });
                setTimeout(() => this.processQueue(), config.downloads.queueProcessDelay);
                return;
            }
        } else {
            request = net.request(downloadUrl);
        }

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
            percent: 0
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
        this._sendProgress({
            id,
            state: 'starting',
            title,
            resuming: isResuming,
            resumeFromByte,
            chunked: false
        });

        // Manejar respuesta
        request.on('response', (response) => {
            this._handleResponse({
                id, response, request, savePath, partialFilePath,
                expectedFileSize, resumeFromByte, isResuming
            });
        });

        request.on('error', (error) => {
            log.error('Error en request:', error);
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
    _handleResponse({ id, response, request, savePath, partialFilePath, expectedFileSize, resumeFromByte, isResuming }) {
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
            queueDatabase.failDownload(id, 'Redirección no soportada');
            this._sendProgress({ id, state: 'interrupted', error: 'Redirección no soportada' });
            this.processQueue();
            return;
        }

        // Verificar código de estado
        if (response.statusCode !== 200 && response.statusCode !== 206) {
            log.error('Error HTTP:', response.statusCode);
            queueDatabase.failDownload(id, `Error HTTP ${response.statusCode}`);
            this._sendProgress({ id, state: 'interrupted', error: `Error HTTP ${response.statusCode}`, savePath });
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
        const writeMode = (serverSupportsResume && actualResumeFromByte > 0) ? 'a' : 'w';
        
        // Calcular highWaterMark inicial basado en tamaño de archivo y configuración
        const initialBufferSize = this._calculateOptimalBufferSize(expectedFileSize);
        
        const fileStream = fs.createWriteStream(partialFilePath, { 
            flags: writeMode,
            highWaterMark: initialBufferSize
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
            actualResumeFromByte
        });

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
                    if (backpressureDuration > 100) { // Solo loggear si fue significativo
                        log.debug(`[Backpressure] Descarga ${id} drenó después de ${backpressureDuration}ms`);
                    }
                    backpressureStartTime = null;
                }
                
                // Ajustar buffer si está habilitado
                if (config.downloads.adaptiveBufferSize && currentBufferSize < config.downloads.maxWriteBufferSize) {
                    // Si no hay backpressure frecuente, aumentar buffer gradualmente
                    const timeSinceLastBackpressure = Date.now() - lastBackpressureReset;
                    if (timeSinceLastBackpressure > 10000 && backpressureEvents < 3) {
                        const newSize = Math.min(
                            Math.floor(currentBufferSize * config.downloads.bufferIncreaseFactor),
                            config.downloads.maxWriteBufferSize
                        );
                        if (newSize > currentBufferSize) {
                            log.debug(`[Backpressure] Aumentando buffer de ${id}: ${this._formatBytes(currentBufferSize)} -> ${this._formatBytes(newSize)}`);
                            currentBufferSize = newSize;
                            // Nota: No podemos cambiar highWaterMark en tiempo de ejecución,
                            // pero podemos trackear para futuras descargas
                        }
                    }
                }
                
                response.resume();
            }
        };
        
        const fileStreamErrorHandler = (error) => {
            if (isCleanedUp) return;
            downloadError = true;
            log.error('Error en fileStream:', error.message);
            cleanup('fileStream error');
            
            if (this.progressThrottler) {
                this.progressThrottler.cancelPending(id);
            }
            
            queueDatabase.failDownload(id, `Error de escritura: ${error.message}`);
            this._cleanupDownload(id, savePath, false);
            this._sendProgress({ id, state: 'interrupted', error: `Error de escritura: ${error.message}`, savePath });
            this.processQueue();
        };
        
        const responseDataHandler = (chunk) => {
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

            // Escribir chunk con backpressure mejorado
            writeEvents++;
            const canContinue = fileStream.write(chunk);
            
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
                    log.warn(`[Backpressure] Descarga ${id} en backpressure por ${backpressureDuration}ms (${backpressureEvents} eventos)`);
                    
                    // Si hay backpressure persistente y adaptiveBufferSize está habilitado
                    if (config.downloads.adaptiveBufferSize && currentBufferSize > config.downloads.minWriteBufferSize) {
                        const newSize = Math.max(
                            Math.floor(currentBufferSize * config.downloads.bufferReductionFactor),
                            config.downloads.minWriteBufferSize
                        );
                        if (newSize < currentBufferSize) {
                            log.info(`[Backpressure] Reduciendo buffer recomendado para ${id}: ${this._formatBytes(currentBufferSize)} -> ${this._formatBytes(newSize)}`);
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
                        log.debug(`[Backpressure] Descarga ${id}: ${backpressureEvents} eventos de backpressure en los últimos 5s`);
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
                        chunked: false
                    });
                }
            }
        };
        
        const responseEndHandler = () => {
            if (downloadError || isCleanedUp || !this.hasActiveDownload(id)) return;
            if (!fileStream || fileStream.destroyed) return;

            isCompleting = true;
            log.debug(`Descarga ${id}: response.end recibido, finalizando escritura...`);

            fileStream.end(() => {
                if (isCleanedUp) return;
                
                try {
                    if (fs.existsSync(savePath)) {
                        fs.unlinkSync(savePath);
                    }
                    fs.renameSync(partialFilePath, savePath);
                    log.info('Descarga completada:', savePath);
                } catch (renameErr) {
                    log.error('Error renombrando archivo:', renameErr.message);
                }

                cleanup('completed');
                this.deleteActiveDownload(id);

                if (this.progressThrottler) {
                    this.progressThrottler.cancelPending(id);
                }

                // Marcar como completada en SQLite
                queueDatabase.completeDownload(id, { savePath });

                this._sendProgress({ 
                    id, 
                    state: 'completed', 
                    savePath,
                    percent: 1,
                    chunked: false
                });
                
                this.processQueue();
            });
        };
        
        const responseErrorHandler = (error) => {
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
                
                queueDatabase.failDownload(id, 'Conexión cerrada prematuramente');
                this._cleanupDownload(id, savePath);
                this._sendProgress({ id, state: 'interrupted', error: 'Conexión cerrada prematuramente', savePath });
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
            responseCloseHandler
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
     * Pausar descarga (simple o fragmentada)
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
                    try { download.request.abort(); } catch (e) { log.debug(`Pause cleanup request ${downloadId}:`, e.message); }
                }
                if (download.fileStream) {
                    try { download.fileStream.end(); } catch (e) { log.debug(`Pause cleanup fileStream ${downloadId}:`, e.message); }
                }
                if (download.response) {
                    try { download.response.removeAllListeners(); } catch (e) { log.debug(`Pause cleanup response ${downloadId}:`, e.message); }
                }

                this.activeDownloads.delete(downloadId);
                
                // Persistir pausa en SQLite
                queueDatabase.pauseDownload(downloadId);

                this._sendProgress({ id: downloadId, state: 'paused', percent: currentPercent, chunked: false });

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
     * Cancela una descarga (simple o fragmentada)
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
            if (now - (chunked.lastUpdate || chunked.startTime || 0) > maxAgeMs) {
                staleIds.push({ id, type: 'chunked' });
            }
        });

        staleIds.forEach(({ id, type }) => {
            log.warn(`Limpiando descarga zombie: ${id} (${type})`);
            
            if (type === 'chunked') {
                const chunked = this.chunkedDownloads.get(id);
                if (chunked) chunked.destroy();
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
        log.debug(`Estado sincronizado: ${this.downloadQueue.length} en cola, ${this.activeDownloads.size} simples, ${this.chunkedDownloads.size} fragmentadas`);
    }

    /**
     * Carga la cola desde SQLite
     */
    loadQueue() {
        try {
            const queuedDownloads = queueDatabase.getQueued();
            
            if (queuedDownloads.length > 0) {
                const validQueue = queuedDownloads.filter(d => 
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
                    priority: d.priority
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
     * Obtiene información de velocidad de las descargas activas
     * @returns {Array} Array de objetos con información de velocidad
     */
    getActiveDownloadsSpeed() {
        const activeSpeeds = [];
        
        // Obtener velocidades de descargas simples
        this.activeDownloads.forEach((download, id) => {
            // Buscar información de velocidad en la descarga activa
            // La velocidad se actualiza en los handlers de progreso
            const speedMBPerSec = download.speed || download.speedMBPerSec || 0;
            const speedBytesPerSec = download.speedBytesPerSec || (speedMBPerSec * 1024 * 1024);
            
            // Incluir todas las descargas activas, incluso si no tienen velocidad aún
            // Esto ayuda a tener información completa para las estimaciones
            activeSpeeds.push({
                id,
                speed: speedMBPerSec,
                speedBytesPerSec: speedBytesPerSec,
                totalBytes: download.totalBytes || download.expectedFileSize || 0,
                downloadedBytes: download.downloadedBytes || 0
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
                chunked: true
            });
        });
        
        return activeSpeeds;
    }

    /**
     * Estadísticas del gestor
     * Usa QueueService para estadísticas de cola si está disponible
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
                enabled: !this.chunkedConfig.forceSimpleDownload
            },
            activeIds: [
                ...Array.from(this.activeDownloads.keys()),
                ...Array.from(this.chunkedDownloads.keys())
            ],
            queuedIds: this.downloadQueue.map(d => d.id)
        };
        
        // Agregar estadísticas de QueueService si están disponibles
        if (queueStats) {
            baseStats.queueStats = {
                slotsAvailable: queueStats.slotsAvailable,
                byPriority: queueStats.byPriority,
                canStart: queueStats.canStart,
                shouldQueue: queueStats.shouldQueue
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
                    onStateChange: (info) => {
                        log.warn(`[CircuitBreaker:Host-${host}] Estado: ${info.oldState} -> ${info.newState}`);
                    }
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
     * Obtiene el tamaño de un archivo remoto
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
                    headRequest.on('response', (response) => {
                        if (timeoutId) clearTimeout(timeoutId);
                        resolve(response);
                    });
                    headRequest.on('error', (error) => {
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
     * Determina la ruta de guardado usando FileService
     */
    async _determineSavePath({ id, title, downloadPath, preserveStructure }) {
        const hasDownloadPath = downloadPath && downloadPath.trim() !== '';
        
        // Si no hay ruta base configurada, pedir al usuario
        if (!hasDownloadPath) {
            const { dialog } = require('electron');
            const result = await dialog.showSaveDialog(this.mainWindow, {
                defaultPath: title
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

            // Construir ruta usando FileService
            const result = this.fileService.buildSavePath(
                downloadPath,
                title,
                preserveStructure,
                relativePath
            );

            if (result.success) {
                return result.savePath;
            } else {
                log.error('Error construyendo ruta de guardado:', result.error);
                // Fallback a método simple
                return path.join(downloadPath, sanitizeFilename(title));
            }
        }

        // Fallback: método antiguo si FileService no está disponible
        if (preserveStructure) {
            const ancestors = database.getFileAncestorPath(id);
            const ancestorPath = ancestors
                .map(a => sanitizeFilename(a.title.replace(/\/$/, '')))
                .join(path.sep);
            return path.join(downloadPath, ancestorPath, sanitizeFilename(title));
        } else {
            return path.join(downloadPath, sanitizeFilename(title));
        }
    }

    /**
     * Verifica si existe un archivo con tamaño similar
     * DEPRECATED: Usa FileService.getFileCheckInfo() directamente
     * Mantenido para compatibilidad temporal - método síncrono para casos específicos
     */
    _checkExistingFile(filePath, expectedSize) {
        try {
            // Si FileService está disponible, intentar usar método asíncrono
            // Pero este método debe ser síncrono para mantener compatibilidad
            // Por ahora, usar lógica directa pero delegar a FileService cuando sea posible
            
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
                    hasPartialFile: false // Se verifica separadamente en el código que llama
                };
            }
        } catch (e) {
            log.error('Error verificando archivo:', e);
        }
        return { exists: false, hasPartialFile: false };
    }

    /**
     * Prepara el directorio de destino
     * DEPRECATED: Usa FileService.prepareDirectory() directamente
     * Mantenido para compatibilidad temporal - método síncrono para casos específicos
     */
    _prepareDirectory(savePath) {
        const fileDir = path.dirname(savePath);

        // Si FileService está disponible, usar método asíncrono sería mejor
        // Pero este método debe ser síncrono para mantener compatibilidad
        // Por ahora, usar lógica directa pero delegar a FileService cuando sea posible
        
        try {
            if (!fs.existsSync(fileDir)) {
                fs.mkdirSync(fileDir, { recursive: true });
            }

            fs.accessSync(fileDir, fs.constants.W_OK);
            return { success: true };

        } catch (err) {
            // Usar FileService para mensajes de error consistentes si está disponible
            if (this.fileService) {
                // Por ahora, usar lógica directa pero con mejor manejo de errores
                let errorMessage = 'Error al crear directorio';
                if (err.code === 'EACCES' || err.code === 'EPERM') {
                    errorMessage = 'Sin permisos para crear directorio';
                } else if (err.code === 'ENOSPC') {
                    errorMessage = 'Sin espacio en disco';
                }
                return { success: false, error: `${errorMessage}: ${err.message}` };
            }
            
            // Fallback sin servicio
            return { success: false, error: `Error al crear directorio: ${err.message}` };
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
                const partialPath = download.partialFilePath || (savePath + '.part');
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
                    if (handlers.responseDataHandler) response.removeListener('data', handlers.responseDataHandler);
                    if (handlers.responseEndHandler) response.removeListener('end', handlers.responseEndHandler);
                    if (handlers.responseErrorHandler) response.removeListener('error', handlers.responseErrorHandler);
                    if (handlers.responseCloseHandler) response.removeListener('close', handlers.responseCloseHandler);
                } catch (e) {
                    log.debug(`Remove response handlers ${id}:`, e.message);
                }
            }
            
            if (fileStream) {
                try {
                    if (handlers.fileStreamErrorHandler) fileStream.removeListener('error', handlers.fileStreamErrorHandler);
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
            fileStream: ['drain', 'error', 'finish', 'close']
        };

        [
            [request, events.request],
            [response, events.response],
            [fileStream, events.fileStream]
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
    _sendProgress(progressInfo) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            if (['completed', 'interrupted', 'cancelled'].includes(progressInfo.state)) {
                log.info(`Enviando estado '${progressInfo.state}' para descarga ${progressInfo.id}`);
            }
            this.mainWindow.webContents.send('download-progress', progressInfo);
        }
    }

    /**
     * Calcula el tamaño óptimo de buffer basado en el tamaño del archivo
     * @param {number} fileSize - Tamaño del archivo en bytes
     * @returns {number} Tamaño de buffer recomendado
     */
    _calculateOptimalBufferSize(fileSize) {
        const minSize = config.downloads.minWriteBufferSize || (256 * 1024);
        const maxSize = config.downloads.maxWriteBufferSize || (16 * 1024 * 1024);
        const defaultSize = config.downloads.writeBufferSize || (1024 * 1024);
        
        if (!fileSize || fileSize === 0) {
            return defaultSize;
        }
        
        // Para archivos pequeños, usar buffer más pequeño
        if (fileSize < 10 * 1024 * 1024) { // < 10MB
            return Math.min(defaultSize, maxSize);
        }
        
        // Para archivos grandes, usar buffer más grande (hasta el máximo)
        if (fileSize > 100 * 1024 * 1024) { // > 100MB
            return Math.min(maxSize, Math.max(defaultSize * 2, minSize));
        }
        
        // Archivos medianos: usar tamaño por defecto
        return defaultSize;
    }

    /**
     * Formatea bytes
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
