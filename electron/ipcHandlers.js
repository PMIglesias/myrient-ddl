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
const { 
    logger, 
    readJSONFile, 
    writeJSONFile,
    validateDownloadParams,
    validateSearchTerm,
    validateNodeId,
    validateDownloadId,
    validateConfigFilename,
    validateDownloadFolderParams
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
 * Registra todos los handlers IPC
 */
function registerHandlers(mainWindow) {
    log.info('Registrando handlers IPC...');

    // =====================
    // BASE DE DATOS
    // =====================

    ipcMain.handle('search-db', createHandler('search-db', (event, searchTerm) => {
        // Validar término de búsqueda
        const validation = validateSearchTerm(searchTerm);
        if (!validation.valid) {
            // Retornar array vacío para búsquedas muy cortas (no es error)
            if (searchTerm && searchTerm.trim().length < 2) {
                return { success: true, data: [] };
            }
            return { success: false, error: validation.error };
        }
        
        return database.search(validation.data);
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

        const validation = validateDownloadParams(params);
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

        // Verificar duplicados
        if (downloadManager.isDownloadActive(validatedParams.id)) {
            log.warn(`Descarga ${validatedParams.id} ya está activa o en cola`);
            return {
                success: false,
                error: 'Descarga ya en proceso',
                duplicate: true
            };
        }

        // Si no hay slots disponibles, tirar a la puta cola
        if (!downloadManager.canStartDownload()) {
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
        // Validar el ID de descarga
        const validation = validateDownloadId(downloadId);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        return downloadManager.pauseDownload(validation.data);
    }));

    ipcMain.handle('resume-download', createHandler('resume-download', async (event, downloadId) => {
        // Validar el ID de descarga
        const validation = validateDownloadId(downloadId);
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
        // Validar el ID de descarga
        const validation = validateDownloadId(downloadId);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        return downloadManager.cancelDownload(validation.data);
    }));

    ipcMain.handle('get-download-stats', createHandler('get-download-stats', () => {
        return downloadManager.getStats();
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
        const validation = validateDownloadFolderParams(params);
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
            
            if (files.length === 0) {
                return { success: false, error: 'La carpeta no contiene archivos' };
            }

            log.info(`Encontrados ${files.length} archivos en la carpeta`);

            // Obtener información de la carpeta para el título
            const folderInfo = database.getNodeInfo(validatedParams.folderId);
            const folderTitle = folderInfo.success && folderInfo.data ? folderInfo.data.title : `Carpeta ${validatedParams.folderId}`;

            // Agregar cada archivo a la cola de descargas
            let addedCount = 0;
            let skippedCount = 0;
            const errors = [];

            for (const file of files) {
                // Verificar si ya está en descarga
                if (downloadManager.isDownloadActive(file.id)) {
                    skippedCount++;
                    continue;
                }

                // Preparar parámetros de descarga
                const downloadParams = {
                    id: file.id,
                    title: file.title,
                    downloadPath: validatedParams.downloadPath,
                    preserveStructure: validatedParams.preserveStructure !== false, // Por defecto true
                    forceOverwrite: validatedParams.forceOverwrite || false
                };

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

            return {
                success: true,
                totalFiles: files.length,
                added: addedCount,
                skipped: skippedCount,
                folderTitle: folderTitle.replace(/\/$/, ''),
                errors: errors.length > 0 ? errors : undefined
            };

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
