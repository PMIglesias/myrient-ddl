/**
 * Proceso Principal de Electron
 * 
 * Este archivo reemplaza a electron/main.js original
 * Incluye integración con SQLite para cola persistente de descargas
 * 
 * CAMBIOS VS ORIGINAL:
 * - Inicializa queueDatabase (SQLite para persistencia)
 * - Restaura descargas pendientes al iniciar
 * - Guarda estado de descargas al cerrar
 * - Envía evento 'downloads-restored' al frontend
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const config = require('./config');
const { configureLogger, logger, cleanOldLogs } = require('./utils');
const database = require('./database');
const queueDatabase = require('./queueDatabase');
const downloadManager = require('./downloadManager');
const ProgressThrottler = require('./progressThrottler');
const { createMainWindow, getMainWindow } = require('./window');
const { registerHandlers, removeHandlers } = require('./ipcHandlers');

// =====================
// CONFIGURAR LOGGER (debe ser lo primero)
// =====================

configureLogger({
    fileLevel: 'info',
    consoleLevel: 'debug',
    maxSize: 10 * 1024 * 1024,
    isDev: !app.isPackaged
});

const log = logger.child('Main');

// =====================
// MANEJO DE ERRORES GLOBALES
// =====================

process.on('uncaughtException', (error) => {
    log.error('=== ERROR NO CAPTURADO ===');
    log.error('Error:', error.message);
    log.error('Stack:', error.stack);
    log.error('=========================');
});

process.on('unhandledRejection', (reason, promise) => {
    log.error('=== PROMESA RECHAZADA ===');
    log.error('Razón:', reason);
    log.error('=========================');
});

// =====================
// INSTANCIAS GLOBALES
// =====================

const progressThrottler = new ProgressThrottler();
let cleanupInterval = null;

// =====================
// INICIALIZACIÓN
// =====================

async function initialize() {
    const endInit = log.startOperation('Inicialización de aplicación');
    
    log.separator('INICIANDO MYRIENT DDL');
    log.info('Versión de Electron:', process.versions.electron);
    log.info('Versión de Node:', process.versions.node);
    log.info('Plataforma:', process.platform);
    log.info('Modo:', app.isPackaged ? 'Producción' : 'Desarrollo');
    log.info('Archivo de log:', logger.getFilePath());

    // Crear directorio de configuración
    if (!fs.existsSync(config.paths.configPath)) {
        fs.mkdirSync(config.paths.configPath, { recursive: true });
        log.info('Directorio de configuración creado:', config.paths.configPath);
    }

    // Limpiar logs antiguos
    await cleanOldLogs(5);

    // =====================
    // INICIALIZAR BASES DE DATOS
    // =====================

    // 1. Base de datos de índice Myrient (solo lectura)
    const dbInitialized = await database.initialize();
    if (!dbInitialized) {
        log.error('No se pudo inicializar la base de datos de índice');
        app.quit();
        return;
    }

    // 2. [BLOQUE 1] Base de datos de cola de descargas (lectura/escritura - SQLite)
    const queueInitialized = queueDatabase.initialize();
    if (!queueInitialized) {
        log.error('No se pudo inicializar la base de datos de cola');
        app.quit();
        return;
    }

    // Mostrar estadísticas de la cola
    const stats = queueDatabase.getStats();
    log.info('Estado de la cola SQLite:', {
        enCola: stats.queued,
        activas: stats.downloading,
        pausadas: stats.paused,
        completadas: stats.completed,
        fallidas: stats.failed
    });

    // Crear ventana principal
    const mainWindow = createMainWindow();

    // Configurar throttler y download manager
    progressThrottler.setMainWindow(mainWindow);
    downloadManager.initialize(mainWindow, progressThrottler);

    // Registrar handlers IPC
    registerHandlers(mainWindow);

    // [BLOQUE 1] Restaurar descargas al cargar la ventana
    mainWindow.webContents.on('did-finish-load', () => {
        const queuedDownloads = queueDatabase.getQueued();
        const pausedDownloads = queueDatabase.getPaused();

        if (queuedDownloads.length > 0 || pausedDownloads.length > 0) {
            log.info(`Restaurando ${queuedDownloads.length} en cola + ${pausedDownloads.length} pausadas...`);

            // Notificar al frontend sobre cada descarga
            [...queuedDownloads, ...pausedDownloads].forEach((download, index) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('download-progress', {
                        id: download.id,
                        state: download.state,
                        title: download.title,
                        progress: download.progress,
                        position: index + 1
                    });
                }
            });

            // Procesar cola después de delay
            setTimeout(() => {
                downloadManager.processQueue();
            }, 1000);
        }

        // Enviar historial completo al frontend
        const allDownloads = queueDatabase.getAll();
        if (allDownloads.length > 0) {
            mainWindow.webContents.send('downloads-restored', allDownloads);
        }
    });

    // Intervalo de limpieza de zombies
    cleanupInterval = setInterval(() => {
        const cleaned = downloadManager.cleanupStaleDownloads();
        if (cleaned > 0) {
            log.info(`Limpiadas ${cleaned} descargas zombies`);
            downloadManager.processQueue();
        }
    }, config.downloads.staleTimeout);

    // Limpiar historial antiguo (30 días)
    const cleanedHistory = queueDatabase.cleanOldHistory(30);
    if (cleanedHistory > 0) {
        log.info(`Limpiados ${cleanedHistory} registros antiguos`);
    }

    endInit('exitosa');
    log.separator('APLICACIÓN LISTA');
}

// =====================
// EVENTOS DE LA APP
// =====================

app.whenReady().then(initialize);

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        initialize();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        cleanup();
        app.quit();
    }
});

app.on('before-quit', () => {
    cleanup();
});

// =====================
// LIMPIEZA
// =====================

function cleanup() {
    log.separator('LIMPIANDO RECURSOS');

    // [BLOQUE 1] Guardar estado de descargas activas en SQLite
    const activeDownloads = downloadManager.activeDownloads;
    if (activeDownloads && activeDownloads.size > 0) {
        log.info(`Guardando estado de ${activeDownloads.size} descargas activas...`);
        
        activeDownloads.forEach((download, id) => {
            queueDatabase.updateDownload(id, {
                state: 'queued', // Volver a encolar para reintentar
                lastError: 'Aplicación cerrada durante la descarga'
            });
        });
    }
    log.info('Estado de descargas guardado en SQLite');

    // Destruir downloadManager
    downloadManager.destroy();
    log.info('DownloadManager destruido');

    // Detener intervalo de limpieza
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
        log.info('Intervalo de limpieza detenido');
    }

    // Destruir throttler
    progressThrottler.destroy();
    log.info('Throttler destruido');

    // [BLOQUE 1] Cerrar base de datos de cola (checkpoint WAL)
    queueDatabase.close();
    log.info('QueueDatabase cerrada');

    // Cerrar base de datos de índice
    database.close();
    log.info('Database de índice cerrada');

    // Remover handlers IPC
    removeHandlers();
    log.info('Handlers IPC removidos');

    log.separator('APLICACIÓN CERRADA');
}
