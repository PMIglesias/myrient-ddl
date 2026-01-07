/**
 * Los Handlers IPC para comunicación entre main y renderer
 * Centraliza todos los ipcMain.handle() en un solo lugar
 * 
 * Todos los handlers incluyen validación de parámetros con Zod para que la wea sea super profesional
 */

const { ipcMain, dialog } = require('electron');
const database = require('./database');
const downloadManager = require('./downloadManager');
const { 
    logger, 
    readJSONFile, 
    writeJSONFile,
    validateDownloadParams,
    validateSearchTerm,
    validateNodeId,
    validateDownloadId,
    validateConfigFilename
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

        // Iniciar descarga
        await downloadManager.startDownload(validatedParams);

        // Verificar que se inició correctamente la descarga
        await new Promise(resolve => setTimeout(resolve, 100));

        if (downloadManager.hasActiveDownload(validatedParams.id)) {
            log.info(`Descarga iniciada: ${validatedParams.title}`);
            return { success: true, queued: false, started: true };
        } else {
            log.warn(`Descarga no se inició correctamente: ${validatedParams.title}`);
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
        'pause-download',
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
