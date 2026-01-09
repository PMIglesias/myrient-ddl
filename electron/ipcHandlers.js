/**
 * Los Handlers IPC para comunicación entre main y renderer
 * Centraliza todos los ipcMain.handle() en un solo lugar
 * 
 * Todos los handlers incluyen validación de parámetros con Zod para que la wea sea super profesional
 */

const { ipcMain, dialog } = require('electron');
const database = require('./database');
const downloadManager = require('./downloadManager');
const queueDatabase = require('./queueDatabase');
const { serviceManager } = require('./services');
const { 
    logger, 
    readJSONFile, 
    writeJSONFile,
    validateDownloadParams: validateDownloadParamsLegacy,
    validateSearchTerm: validateSearchTermLegacy,
    validateNodeId,
    validateDownloadId: validateDownloadIdLegacy,
    validateConfigFilename,
    validateDownloadFolderParams: validateDownloadFolderParamsLegacy
} = require('./utils');

const log = logger.child('IPC');

/**
 * Wrapper para handlers IPC con validación y manejo de errores
 */
function createHandler(channel, handler, options = {}) {
    return async (event, ...args) => {
        try {
            return await handler(event, ...args);
        } catch (error) {
            log.error(`Error en handler '${channel}':`, error);
            return { 
                success: false, 
                error: error.message || 'Error interno del servidor' 
            };
        }
    };
}

/**
 * Obtiene servicios de forma segura (con fallback si no están inicializados)
 */
function getServices() {
    const downloadService = serviceManager.initialized ? serviceManager.getDownloadService() : null;
    const searchService = serviceManager.initialized ? serviceManager.getSearchService() : null;
    const queueService = serviceManager.initialized ? serviceManager.getQueueService() : null;
    const fileService = serviceManager.initialized ? serviceManager.getFileService() : null;
    
    return { downloadService, searchService, queueService, fileService };
}

/**
 * Registra todos los handlers IPC
 */
function registerHandlers(mainWindow) {
    log.info('Registrando handlers IPC...');
    
    // Asegurar que los servicios estén inicializados
    if (!serviceManager.initialized) {
        log.warn('ServiceManager no está inicializado, usando validaciones legacy');
    }

    // =====================
    // BASE DE DATOS
    // =====================

    ipcMain.handle('search-db', createHandler('search-db', async (event, searchTerm, options = {}) => {
        const { searchService } = getServices();
        
        // Validar y normalizar término de búsqueda usando SearchService si está disponible
        let validation;
        if (searchService) {
            validation = searchService.validateAndNormalizeSearchTerm(searchTerm);
            if (!validation.valid) {
                // Retornar array vacío para búsquedas muy cortas (no es error)
                if (searchTerm && searchTerm.trim().length < 2) {
                    return { success: true, data: [], total: 0 };
                }
                return { success: false, error: validation.error };
            }
            
            // Normalizar opciones usando SearchService
            const normalizedOptions = searchService.normalizeSearchOptions(options);
            
            // Determinar estrategia de búsqueda
            const strategy = searchService.determineSearchStrategy(validation.data, normalizedOptions);
            
            // Preparar término para FTS si es necesario
            let searchTermToUse = validation.data;
            if (strategy === 'fts') {
                searchTermToUse = searchService.prepareFTSTerm(validation.data, normalizedOptions);
            }
            
            // Ejecutar búsqueda (database.search es síncrono, pero lo mantenemos como async para consistencia)
            const result = database.search(searchTermToUse, normalizedOptions);
            
            // Calcular paginación si es necesario
            if (result.success && result.total !== undefined) {
                const pagination = searchService.calculatePagination(
                    result.total, 
                    normalizedOptions.limit, 
                    normalizedOptions.offset
                );
                return { ...result, pagination };
            }
            
            return result;
        } else {
            // Fallback: usar validación legacy
            validation = validateSearchTermLegacy(searchTerm);
            if (!validation.valid) {
                if (searchTerm && searchTerm.trim().length < 2) {
                    return { success: true, data: [], total: 0 };
                }
                return { success: false, error: validation.error };
            }
            
            const searchOptions = {
                limit: Math.min(Math.max(parseInt(options.limit) || 500, 1), 1000),
                offset: Math.max(parseInt(options.offset) || 0, 0),
                usePrefix: options.usePrefix !== false,
                usePhrase: options.usePhrase === true,
                useOR: options.useOR === true
            };
            
            return database.search(validation.data, searchOptions);
        }
    }));

    ipcMain.handle('get-children', createHandler('get-children', (event, parentId) => {

        const validation = validateNodeId(parentId);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        return database.getChildren(validation.data);
    }));

    ipcMain.handle('get-ancestors', createHandler('get-ancestors', (event, nodeId) => {

        const validation = validateNodeId(nodeId);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        return database.getAncestors(validation.data);
    }));

    ipcMain.handle('get-node-info', createHandler('get-node-info', (event, nodeId) => {

        const validation = validateNodeId(nodeId);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        return database.getNodeInfo(validation.data);
    }));

    ipcMain.handle('get-db-update-date', createHandler('get-db-update-date', () => {
        return database.getUpdateDate();
    }));

    // =====================
    // DESCARGAS
    // =====================

    ipcMain.handle('download-file', createHandler('download-file', async (event, params) => {
        const { downloadService, queueService } = getServices();
        
        // Validar parámetros usando DownloadService si está disponible
        let validation;
        if (downloadService) {
            validation = downloadService.validateDownloadParams(params);
        } else {
            // Fallback: usar validación legacy
            validation = validateDownloadParamsLegacy(params);
        }
        
        if (!validation.valid) {
            log.error('Parámetros de descarga inválidos:', validation.error);
            return { success: false, error: validation.error };
        }

        const validatedParams = validation.data;

        log.info(`=== SOLICITUD DE DESCARGA ===`);
        log.info(`ID: ${validatedParams.id}`);
        log.info(`Título: ${validatedParams.title}`);
        log.info(`Stats:`, downloadManager.getStats());
        log.info(`============================`);

        // Verificar duplicados usando DownloadService si está disponible
        const existingDownloads = Array.from(downloadManager.activeDownloads.keys())
            .concat(Array.from(downloadManager.chunkedDownloads.keys()))
            .concat(downloadManager.downloadQueue.map(d => d.id));
        
        let isDuplicate = false;
        if (downloadService && existingDownloads.length > 0) {
            const duplicateCheck = downloadService.isDuplicate(
                validatedParams, 
                existingDownloads.map(id => ({ id }))
            );
            isDuplicate = duplicateCheck.isDuplicate;
        }
        
        // Verificar si está activa o en cola
        if (downloadManager.isDownloadActive(validatedParams.id) || isDuplicate) {
            log.warn(`Descarga ${validatedParams.id} ya está activa o en cola`);
            return {
                success: false,
                error: 'Descarga ya en proceso',
                duplicate: true
            };
        }

        // Verificar disponibilidad usando QueueService si está disponible
        const stats = downloadManager.getStats();
        let canStart = false;
        let shouldQueue = false;
        let queuePosition = 0;
        
        if (queueService) {
            const availability = queueService.checkAvailability(
                stats.activeSimple + stats.activeChunked,
                stats.queuedInMemory
            );
            canStart = availability.canStart;
            shouldQueue = availability.shouldQueue;
            
            if (shouldQueue) {
                // Calcular posición en cola usando QueueService
                const queue = downloadManager.downloadQueue;
                queuePosition = queueService.calculateQueuePosition(validatedParams, queue) + 1;
            }
        } else {
            // Fallback: usar método directo
            canStart = downloadManager.canStartDownload();
            shouldQueue = !canStart;
        }

        // Si no hay slots disponibles, agregar a la cola
        if (!canStart && shouldQueue) {
            // Calcular prioridad usando DownloadService si está disponible
            if (downloadService && !validatedParams.priority) {
                validatedParams.priority = downloadService.calculatePriority(validatedParams);
            }
            
            const position = downloadManager.addToQueueWithPersist(validatedParams);

            if (position === -1) {
                return {
                    success: false,
                    error: 'Descarga duplicada',
                    duplicate: true
                };
            }

            // Notificar que está en cola
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('download-progress', {
                    id: validatedParams.id,
                    state: 'queued',
                    title: validatedParams.title,
                    position: position
                });
            }

            log.info(`Descarga en cola: ${validatedParams.title} (posición ${position})`);
            return { success: true, queued: true, position };
        }

        // SUPER MEGA HIPER IMPORTANTE : Primero agregar la descarga a la BD si no existe
        // Esto evita el error de FOREIGN KEY al crear chunks
        if (!queueDatabase.exists(validatedParams.id)) {
            queueDatabase.addDownload({
                id: validatedParams.id,
                title: validatedParams.title,
                url: null, // Se establecerá al iniciar
                savePath: null, // Se establecerá al iniciar
                downloadPath: validatedParams.downloadPath,
                preserveStructure: validatedParams.preserveStructure || false,
                forceOverwrite: validatedParams.forceOverwrite || false,
                state: 'queued',
                priority: validatedParams.priority || 1,
                totalBytes: validatedParams.expectedFileSize || 0
            });
        }

        // Iniciar descarga
        await downloadManager.startDownload(validatedParams);

        // Pequeña espera para que el estado se actualice
        await new Promise(resolve => setTimeout(resolve, 100));

        // Verificar estado de la descarga (puede ser activa, awaiting, o queued)
        const isActive = downloadManager.hasActiveDownload(validatedParams.id);
        const dbDownload = queueDatabase.getById(validatedParams.id);
        const downloadState = dbDownload?.state;

        if (isActive || downloadState === 'downloading') {
            log.info(`Descarga iniciada: ${validatedParams.title}`);
            return { success: true, queued: false, started: true };
        } else if (downloadState === 'awaiting') {
            log.info(`Descarga esperando confirmación: ${validatedParams.title}`);
            return { success: true, awaiting: true };
        } else if (downloadState === 'queued') {
            log.info(`Descarga en cola: ${validatedParams.title}`);
            return { success: true, queued: true };
        } else if (downloadState === 'completed') {
            log.info(`Descarga ya completada: ${validatedParams.title}`);
            return { success: true, completed: true };
        } else {
            log.warn(`Descarga no se inició correctamente: ${validatedParams.title} (estado: ${downloadState})`);
            return { success: false, error: 'No se pudo iniciar la descarga' };
        }

    }));

    ipcMain.handle('pause-download', createHandler('pause-download', async (event, downloadId) => {
        const { downloadService } = getServices();
        
        // Validar ID usando DownloadService si está disponible
        let validation;
        if (downloadService) {
            // DownloadService no tiene validateDownloadId específico, usar legacy por ahora
            validation = validateDownloadIdLegacy(downloadId);
        } else {
            validation = validateDownloadIdLegacy(downloadId);
        }
        
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        return downloadManager.pauseDownload(validation.data);
    }));

    ipcMain.handle('resume-download', createHandler('resume-download', async (event, downloadId) => {
        const { downloadService, queueService } = getServices();
        
        // Validar ID de descarga
        const validation = validateDownloadIdLegacy(downloadId);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        const id = validation.data;
        
        // Verificar que la descarga existe y está pausada
        const dbDownload = queueDatabase.getById(id);
        if (!dbDownload) {
            return { success: false, error: 'Descarga no encontrada' };
        }
        
        if (dbDownload.state !== 'paused') {
            return { success: false, error: `No se puede reanudar descarga en estado ${dbDownload.state}` };
        }
        
        // Reanudar en SQLite (cambiar a queued)
        const resumed = queueDatabase.resumeDownload(id);
        if (!resumed) {
            return { success: false, error: 'Error al reanudar descarga' };
        }
        
        // Notificar al frontend que la descarga está en cola
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('download-progress', {
                id: dbDownload.id,
                state: 'queued',
                title: dbDownload.title,
                progress: dbDownload.progress || 0
            });
        }
        
        // Agregar a la cola del DownloadManager
        // Si hay un savePath guardado, pasarlo para evitar pedir nueva ubicación
        const download = {
            id: dbDownload.id,
            title: dbDownload.title,
            downloadPath: dbDownload.downloadPath,
            preserveStructure: dbDownload.preserveStructure,
            forceOverwrite: dbDownload.forceOverwrite,
            priority: dbDownload.priority,
            savePath: dbDownload.savePath || null // Pasar savePath si existe
        };
        
        downloadManager.addToQueue(download);
        
        // Procesar la cola
        setTimeout(() => {
            downloadManager.processQueue();
        }, 100);
        
        return { success: true };
    }));

    ipcMain.handle('cancel-download', createHandler('cancel-download', async (event, downloadId) => {
        // Validar ID de descarga
        const validation = validateDownloadIdLegacy(downloadId);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        return downloadManager.cancelDownload(validation.data);
    }));

    ipcMain.handle('get-download-stats', createHandler('get-download-stats', () => {
        return downloadManager.getStats();
    }));

    /**
     * Obtiene la estimación de tiempo de cola
     * Incluye tiempo total y tiempo hasta que una descarga específica comience
     */
    ipcMain.handle('get-queue-time-estimate', createHandler('get-queue-time-estimate', async (event, downloadId = null) => {
        try {
            const { queueService } = getServices();
            const stats = downloadManager.getStats();
            
            if (!queueService) {
                return {
                    success: false,
                    error: 'QueueService no disponible'
                };
            }

            // Si no hay descargas en cola, retornar estimación vacía
            if (!stats.queuedInMemory || stats.queuedInMemory === 0) {
                return {
                    success: true,
                    queueTimeEstimate: {
                        totalEstimatedSeconds: 0,
                        totalEstimatedMinutes: 0,
                        totalEstimatedHours: 0,
                        totalDownloads: 0,
                        totalBytes: 0,
                        canStartImmediately: true
                    }
                };
            }

            // Si se solicita estimación para una descarga específica
            if (downloadId !== null) {
                const totalActive = stats.activeSimple + stats.activeChunked;
                const activeSpeeds = downloadManager.getActiveDownloadsSpeed();
                const averageSpeedBytesPerSec = queueService.calculateAverageSpeed(activeSpeeds);
                
                const timeUntilStart = queueService.estimateTimeUntilStart(
                    downloadId,
                    downloadManager.downloadQueue || [],
                    totalActive,
                    averageSpeedBytesPerSec
                );

                return {
                    success: true,
                    downloadId,
                    timeUntilStart,
                    queueTimeEstimate: stats.queueTimeEstimate || null
                };
            }

            // Retornar solo estimación total de cola (ya incluida en stats)
            return {
                success: true,
                queueTimeEstimate: stats.queueTimeEstimate || null,
                queueStats: stats.queueStats || null
            };

        } catch (error) {
            log.error('Error obteniendo estimación de tiempo de cola:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }));

    ipcMain.handle('clean-history', createHandler('clean-history', async (event, daysOld = 30) => {
        // Validar días
        if (typeof daysOld !== 'number' || daysOld < 1 || daysOld > 365) {
            return { success: false, error: 'Días inválidos (debe ser entre 1 y 365)' };
        }
        
        const cleaned = queueDatabase.cleanOldHistory(daysOld);
        
        // Notificar al frontend
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('history-cleaned', {
                count: cleaned,
                timestamp: Date.now(),
                manual: true
            });
        }
        
        return { success: true, count: cleaned };
    }));

    ipcMain.handle('download-folder', createHandler('download-folder', async (event, params) => {
        const { downloadService, queueService } = getServices();
        
        // Validar parámetros de descarga de carpeta usando DownloadService si está disponible
        let validation;
        if (downloadService) {
            validation = downloadService.validateDownloadFolderParams(params);
        } else {
            // Fallback: usar validación legacy
            validation = validateDownloadFolderParamsLegacy(params);
        }
        
        if (!validation.valid) {
            log.error('Parámetros de descarga de carpeta inválidos:', validation.error);
            return { success: false, error: validation.error };
        }

        const validatedParams = validation.data;

        log.info(`=== SOLICITUD DE DESCARGA DE CARPETA ===`);
        log.info(`Folder ID: ${validatedParams.folderId}`);
        log.info(`Download Path: ${validatedParams.downloadPath || 'No especificado'}`);
        log.info(`Preserve Structure: ${validatedParams.preserveStructure || false}`);
        log.info(`========================================`);

        try {
            // Obtener todos los archivos de la carpeta recursivamente
            const filesResult = database.getAllFilesInFolder(validatedParams.folderId);
            
            if (!filesResult.success) {
                return { success: false, error: filesResult.error || 'Error al obtener archivos de la carpeta' };
            }

            const files = filesResult.data || [];
            
            // Validar si la carpeta puede ser descargada usando DownloadService si está disponible
            if (downloadService) {
                const stats = downloadManager.getStats();
                const canDownload = downloadService.canDownloadFolder(validatedParams, files.length, stats);
                
                if (!canDownload.canDownload) {
                    log.warn(`No se puede descargar carpeta: ${canDownload.reason}`);
                    return { 
                        success: false, 
                        error: canDownload.reason,
                        fileCount: files.length,
                        maxFilesPerFolder: canDownload.maxFilesPerFolder,
                        availableQueueSlots: canDownload.availableQueueSlots
                    };
                }
            } else {
                // Fallback: validación básica
                if (files.length === 0) {
                    return { success: false, error: 'La carpeta no contiene archivos' };
                }
            }

            log.info(`Encontrados ${files.length} archivos en la carpeta`);

            // Obtener información de la carpeta para el título
            const folderInfo = database.getNodeInfo(validatedParams.folderId);
            const folderTitle = folderInfo.success && folderInfo.data ? folderInfo.data.title : `Carpeta ${validatedParams.folderId}`;

            // Calcular estadísticas usando DownloadService si está disponible
            let folderStats = null;
            if (downloadService) {
                const existingDownloads = Array.from(downloadManager.activeDownloads.keys())
                    .concat(Array.from(downloadManager.chunkedDownloads.keys()))
                    .concat(downloadManager.downloadQueue.map(d => d.id))
                    .map(id => ({ id }));
                
                folderStats = downloadService.calculateFolderDownloadStats(
                    validatedParams,
                    files,
                    existingDownloads
                );
                
                log.info(`Estadísticas de carpeta:`, folderStats);
            }

            // Agregar cada archivo a la cola de descargas
            let addedCount = 0;
            let skippedCount = 0;
            const errors = [];

            for (const file of files) {
                // Preparar parámetros de descarga usando DownloadService si está disponible
                let downloadParams;
                
                if (downloadService) {
                    const prepared = downloadService.prepareFileDownloadParams(validatedParams, file);
                    
                    if (!prepared.success) {
                        errors.push({
                            fileId: file.id,
                            fileName: file.title,
                            error: prepared.error
                        });
                        skippedCount++;
                        continue;
                    }
                    
                    downloadParams = prepared.params;
                } else {
                    // Fallback: preparar parámetros manualmente
                    downloadParams = {
                        id: file.id,
                        title: file.title,
                        downloadPath: validatedParams.downloadPath,
                        preserveStructure: validatedParams.preserveStructure !== false, // Por defecto true
                        forceOverwrite: validatedParams.forceOverwrite || false
                    };
                }

                // Verificar si ya está en descarga o es duplicado
                if (downloadManager.isDownloadActive(downloadParams.id)) {
                    skippedCount++;
                    continue;
                }

                // Verificar duplicados usando DownloadService si está disponible
                if (downloadService) {
                    const existingDownloads = Array.from(downloadManager.activeDownloads.keys())
                        .concat(Array.from(downloadManager.chunkedDownloads.keys()))
                        .concat(downloadManager.downloadQueue.map(d => d.id))
                        .map(id => ({ id }));
                    
                    const duplicateCheck = downloadService.isDuplicate(downloadParams, existingDownloads);
                    if (duplicateCheck.isDuplicate) {
                        skippedCount++;
                        continue;
                    }
                }

                // Agregar a la cola (siempre a la cola para evitar saturar)
                const position = downloadManager.addToQueueWithPersist(downloadParams);
                
                if (position === -1) {
                    skippedCount++;
                } else {
                    addedCount++;
                    
                    // Notificar que está en cola
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('download-progress', {
                            id: file.id,
                            state: 'queued',
                            title: file.title,
                            position: position
                        });
                    }
                }
            }

            // Procesar la cola
            downloadManager.processQueue();

            log.info(`Descarga de carpeta iniciada: ${addedCount} archivos agregados, ${skippedCount} omitidos`);

            // Incluir estadísticas si están disponibles
            const result = {
                success: true,
                totalFiles: files.length,
                added: addedCount,
                skipped: skippedCount,
                folderTitle: folderTitle.replace(/\/$/, ''),
                errors: errors.length > 0 ? errors : undefined
            };

            // Agregar estadísticas si están disponibles
            if (folderStats) {
                result.stats = {
                    validFiles: folderStats.validFiles,
                    duplicateFiles: folderStats.duplicateFiles,
                    newDownloads: folderStats.newDownloads,
                    totalSize: folderStats.totalSize,
                    averageSize: folderStats.averageSize
                };
            }

            return result;

        } catch (error) {
            log.error('Error al descargar carpeta:', error);
            return { success: false, error: error.message || 'Error al procesar la descarga de la carpeta' };
        }
    }));

    // =====================
    // CONFIGURACIÓN
    // =====================

    ipcMain.handle('read-config-file', createHandler('read-config-file', (event, filename) => {
        // Validar nombre de archivo
        const validation = validateConfigFilename(filename);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        const data = readJSONFile(validation.data);
        return { success: true, data };
    }));

    ipcMain.handle('write-config-file', createHandler('write-config-file', (event, filename, data) => {
        // Validar nombre de archivo
        const filenameValidation = validateConfigFilename(filename);
        if (!filenameValidation.valid) {
            return { success: false, error: filenameValidation.error };
        }
        
        // Validar que data sea un objeto y no sea absolutamente nada
        if (data === undefined || data === null) {
            return { success: false, error: 'Datos no proporcionados' };
        }
        
        try {
            // Intentar serializar para verificar que es válido
            JSON.stringify(data);
        } catch (error) {
            return { success: false, error: 'Los datos no son serializables a JSON' };
        }
        
        const result = writeJSONFile(filenameValidation.data, data);
        return { success: result };
    }));

    // =====================
    // VENTANA
    // =====================

    ipcMain.handle('window-minimize', createHandler('window-minimize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.minimize();
        }
    }));

    ipcMain.handle('window-maximize', createHandler('window-maximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
        }
    }));

    ipcMain.handle('window-close', createHandler('window-close', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.close();
        }
    }));

    // =====================
    // DIÁLOGOS
    // =====================

    ipcMain.handle('select-folder', createHandler('select-folder', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory']
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false };
        }

        return { success: true, path: result.filePaths[0] };
    }));

    log.info('Handlers IPC registrados correctamente');
}

/**
 * Elimina todos los handlers IPC registrados
 */
function removeHandlers() {
    const channels = [
        'search-db',
        'get-children',
        'get-ancestors',
        'get-node-info',
        'get-db-update-date',
        'download-file',
        'download-folder',
        'pause-download',
        'resume-download',
        'cancel-download',
        'get-download-stats',
        'read-config-file',
        'write-config-file',
        'window-minimize',
        'window-maximize',
        'window-close',
        'select-folder'
    ];

    channels.forEach(channel => {
        ipcMain.removeHandler(channel);
    });

    log.info('Handlers IPC removidos');
}

module.exports = {
    registerHandlers,
    removeHandlers
};
