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
const path = require('path');
const config = require('./config');
const { configureLogger, logger, cleanOldLogs, readJSONFile } = require('./utils');
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
let historyCleanupInterval = null;

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

    // Limpiar descargas mal etiquetadas (paused pero realmente completadas, fallidas, o muy antiguas)
    log.info('Iniciando limpieza de descargas mal etiquetadas...');
    const cleanupResult = queueDatabase.cleanupMislabeledDownloads(7); // 7 días como máximo
    if (cleanupResult.corrected > 0) {
        log.info(`Limpieza completada: ${cleanupResult.corrected} descargas corregidas (${cleanupResult.completed || 0} completadas, ${cleanupResult.failed || 0} fallidas, ${cleanupResult.cancelled || 0} canceladas)`);
    } else if (cleanupResult.error) {
        log.warn(`Error en limpieza: ${cleanupResult.error}`);
    } else {
        log.info('No se encontraron descargas mal etiquetadas para corregir');
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
    await downloadManager.initialize(mainWindow, progressThrottler);

    // Registrar handlers IPC
    registerHandlers(mainWindow);

    // [BLOQUE 1] Restaurar descargas al cargar la ventana
    mainWindow.webContents.on('did-finish-load', () => {
        const queuedDownloads = queueDatabase.getQueued();
        const pausedDownloads = queueDatabase.getPaused();

        if (queuedDownloads.length > 0 || pausedDownloads.length > 0) {
            log.info(`Restaurando ${queuedDownloads.length} en cola + ${pausedDownloads.length} pausadas...`);

            // Leer configuración de reanudación automática
            let autoResume = false; // Por defecto false - descargas quedan en espera
            try {
                const settingsPath = path.join(config.paths.configPath, 'download-settings.json');
                if (fs.existsSync(settingsPath)) {
                    const settings = readJSONFile('download-settings.json');
                    if (settings && settings.autoResumeDownloads !== undefined) {
                        autoResume = settings.autoResumeDownloads === true;
                    }
                }
            } catch (error) {
                log.warn('Error leyendo configuración de reanudación automática, usando valor por defecto:', error.message);
            }

            // Marcar todas las descargas en cola como pausadas (estado de espera)
            // EXCEPTO las que están en estado 'awaiting' (esperando confirmación de sobrescritura)
            // Esto permite al usuario decidir qué hacer con ellas
            if (queuedDownloads.length > 0) {
                log.info(`Marcando ${queuedDownloads.length} descargas en cola como pausadas (en espera)...`);
                queuedDownloads.forEach((download) => {
                    // No pausar descargas que están esperando confirmación de sobrescritura
                    if (download.state !== 'awaiting') {
                        queueDatabase.pauseDownload(download.id);
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('download-progress', {
                                id: download.id,
                                state: 'paused',
                                title: download.title,
                                progress: download.progress || 0
                            });
                        }
                    } else {
                        // Mantener estado 'awaiting' y notificar al frontend
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('download-progress', {
                                id: download.id,
                                state: 'awaiting-confirmation',
                                title: download.title,
                                progress: download.progress || 0,
                                savePath: download.savePath
                            });
                        }
                    }
                });
            }

            // Notificar al frontend sobre descargas pausadas existentes
            pausedDownloads.forEach((download) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('download-progress', {
                        id: download.id,
                        state: 'paused',
                        title: download.title,
                        progress: download.progress || 0
                    });
                }
            });

            // Si autoResume está activado, procesar automáticamente después de un delay
            if (autoResume) {
                setTimeout(() => {
                    log.info('Reanudación automática activada, iniciando descargas...');
                    // Reanudar todas las descargas pausadas
                    const allPaused = queueDatabase.getPaused();
                    allPaused.forEach((download) => {
                        queueDatabase.resumeDownload(download.id);
                    });
                    
                    // Cargar la cola en memoria y procesar
                    const loadedCount = downloadManager.loadQueue();
                    log.info(`Cola cargada en memoria: ${loadedCount} descargas`);
                    
                    setTimeout(() => {
                        downloadManager.processQueue();
                    }, 500);
                }, 1000);
            } else {
                log.info('Descargas en estado de espera. El usuario puede reanudarlas, eliminarlas o cancelarlas desde la interfaz.');
            }
        }

        // Enviar solo descargas relevantes al frontend (pausadas, en cola, activas, awaiting)
        // No enviar descargas completadas o fallidas antiguas para evitar confusión
        // Nota: pausedDownloads y queuedDownloads ya fueron obtenidos arriba, pero pueden haber cambiado
        // después de pausar las que estaban en cola, así que las obtenemos de nuevo
        const allPausedNow = queueDatabase.getPaused();
        const allQueuedNow = queueDatabase.getQueued();
        const activeDownloads = queueDatabase.getActive();
        const awaitingDownloads = queueDatabase.getByState('awaiting');
        
        // Combinar todas las descargas relevantes y eliminar duplicados por ID
        const allRelevant = [
            ...allPausedNow,
            ...allQueuedNow,
            ...activeDownloads,
            ...awaitingDownloads
        ];
        
        // Eliminar duplicados usando un Map
        const uniqueDownloads = new Map();
        allRelevant.forEach(download => {
            uniqueDownloads.set(download.id, download);
        });
        
        const relevantDownloads = Array.from(uniqueDownloads.values());
        
        if (relevantDownloads.length > 0) {
            mainWindow.webContents.send('downloads-restored', relevantDownloads);
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

    // Limpiar historial antiguo (30 días) al iniciar
    const cleanedHistory = queueDatabase.cleanOldHistory(30);
    if (cleanedHistory > 0) {
        log.info(`Limpiados ${cleanedHistory} registros antiguos`);
    }

    // Configurar limpieza automática periódica del historial (cada hora)
    historyCleanupInterval = setInterval(() => {
        try {
            const cleaned = queueDatabase.cleanOldHistory(30);
            if (cleaned > 0) {
                log.info(`Limpieza automática: ${cleaned} registros antiguos eliminados`);
                
                // Notificar al frontend si hay ventana activa
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('history-cleaned', {
                        count: cleaned,
                        timestamp: Date.now()
                    });
                }
            }
        } catch (error) {
            log.error('Error en limpieza automática de historial:', error);
        }
    }, 60 * 60 * 1000); // Cada hora

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
    // IMPORTANTE: Solo cambiar el estado de descargas que realmente están en estado 'downloading'
    // Respetar los estados pausadas, completadas, canceladas, etc. que el usuario haya establecido
    
    // Guardar descargas simples activas
    const activeDownloads = downloadManager.activeDownloads;
    if (activeDownloads && activeDownloads.size > 0) {
        log.info(`Verificando estado de ${activeDownloads.size} descargas simples activas...`);
        
        let queuedCount = 0;
        let skippedCount = 0;
        
        activeDownloads.forEach((download, id) => {
            // Verificar el estado actual en la base de datos
            const dbDownload = queueDatabase.getById(id);
            
            if (!dbDownload) {
                // La descarga fue eliminada de la BD, no hacer nada
                log.debug(`Descarga ${id} no encontrada en BD, omitiendo`);
                skippedCount++;
                return;
            }
            
            // Solo cambiar a 'queued' si realmente estaba en estado 'downloading'
            // Respetar estados como 'paused', 'completed', 'cancelled', etc.
            if (dbDownload.state === 'downloading') {
                queueDatabase.updateDownload(id, {
                    state: 'queued', // Volver a encolar para reintentar
                    lastError: 'Aplicación cerrada durante la descarga'
                });
                queuedCount++;
            } else {
                log.debug(`Descarga ${id} en estado '${dbDownload.state}', manteniendo estado`);
                skippedCount++;
            }
        });
        
        if (queuedCount > 0 || skippedCount > 0) {
            log.info(`Descargas simples: ${queuedCount} reencoladas, ${skippedCount} omitidas (estados respetados)`);
        }
    }
    
    // Guardar descargas fragmentadas activas
    const chunkedDownloads = downloadManager.chunkedDownloads;
    if (chunkedDownloads && chunkedDownloads.size > 0) {
        log.info(`Verificando estado de ${chunkedDownloads.size} descargas fragmentadas activas...`);
        
        let queuedCount = 0;
        let skippedCount = 0;
        
        chunkedDownloads.forEach((chunked, id) => {
            // Verificar el estado actual en la base de datos
            const dbDownload = queueDatabase.getById(id);
            
            if (!dbDownload) {
                // La descarga fue eliminada de la BD, no hacer nada
                log.debug(`Descarga fragmentada ${id} no encontrada en BD, omitiendo`);
                skippedCount++;
                return;
            }
            
            // Solo cambiar a 'queued' si realmente estaba en estado 'downloading'
            // Respetar estados como 'paused', 'completed', 'cancelled', etc.
            if (dbDownload.state === 'downloading') {
                queueDatabase.updateDownload(id, {
                    state: 'queued', // Volver a encolar para reintentar
                    lastError: 'Aplicación cerrada durante la descarga'
                });
                queuedCount++;
            } else {
                log.debug(`Descarga fragmentada ${id} en estado '${dbDownload.state}', manteniendo estado`);
                skippedCount++;
            }
        });
        
        if (queuedCount > 0 || skippedCount > 0) {
            log.info(`Descargas fragmentadas: ${queuedCount} reencoladas, ${skippedCount} omitidas (estados respetados)`);
        }
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
