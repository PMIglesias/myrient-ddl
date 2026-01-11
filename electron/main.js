/**
 * @fileoverview Proceso principal de Electron que coordina todos los componentes de la aplicación
 * @module main
 *
 * Maneja el ciclo de vida de la aplicación, inicialización, y comunicación entre procesos.
 * Integra SQLite para persistencia de cola de descargas y restaura estado al reiniciar.
 *
 * Responsabilidades principales:
 * - Inicialización de bases de datos (Myrient DB y Queue DB)
 * - Creación y gestión de la ventana principal
 * - Registro de handlers IPC
 * - Manejo global de errores
 * - Limpieza periódica de recursos
 * - Restauración de descargas interrumpidas
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const {
  configureLogger,
  logger,
  cleanOldLogs,
  readJSONFile,
  setMainWindowGetter,
} = require('./utils');
const database = require('./database');
const queueDatabase = require('./queueDatabase');
const downloadManager = require('./downloadManager');
const ProgressThrottler = require('./progressThrottler');
const { createMainWindow, getMainWindow } = require('./window');
const { registerHandlers, removeHandlers } = require('./ipcHandlers');

// Configurar el sistema de logging ANTES que cualquier otra operación
// Esto garantiza que todos los logs subsecuentes se registren correctamente
configureLogger({
  fileLevel: 'info',
  consoleLevel: 'debug',
  maxSize: 10 * 1024 * 1024,
  isDev: !app.isPackaged,
});

const log = logger.child('Main');

/**
 * Envía notificaciones de error al proceso de renderizado
 *
 * Utilizada por los handlers globales de errores para notificar al frontend
 * cuando ocurren errores no capturados, permitiendo mostrar notificaciones
 * al usuario.
 *
 * @param {Error} error - Objeto Error con el error ocurrido
 * @param {string} [type='uncaught'] - Tipo de error: 'uncaught' | 'uncaughtException' | 'unhandledRejection'
 * @returns {void}
 */
function sendErrorToRenderer(error, type = 'uncaught') {
  try {
    const mainWindow = require('./window').getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
      const errorInfo = {
        type,
        message: error?.message || String(error || 'Error desconocido'),
        stack: error?.stack,
        timestamp: Date.now(),
        severity: 'error',
      };

      mainWindow.webContents.send('error-notification', errorInfo);
    }
  } catch (sendError) {
    log.error('Error enviando notificación al renderer:', sendError);
  }
}

// Manejo global de errores no capturados para prevenir crashes inesperados
// Captura excepciones síncronas que no fueron manejadas por try-catch
process.on('uncaughtException', error => {
  log.error('=== ERROR NO CAPTURADO ===');
  log.error('Error:', error.message);
  log.error('Stack:', error.stack);
  log.error('=========================');

  // Enviar notificación al renderer
  sendErrorToRenderer(error, 'uncaughtException');

  // NO hacer app.quit() automáticamente para errores no críticos
  // Permitir que la aplicación continúe funcionando si es posible
  // Solo cerrar si es un error crítico del sistema
  if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
    log.error('Error crítico del sistema, cerrando aplicación...');
    app.quit();
  }
});

// Captura promesas rechazadas que no fueron manejadas con .catch()
// Previene que errores asíncronos pasen desapercibidos
process.on('unhandledRejection', (reason, promise) => {
  log.error('=== PROMESA RECHAZADA ===');
  log.error('Razón:', reason);
  if (reason instanceof Error) {
    log.error('Stack:', reason.stack);
  }
  log.error('=========================');

  // Enviar notificación al renderer
  const error = reason instanceof Error ? reason : new Error(String(reason));
  sendErrorToRenderer(error, 'unhandledRejection');
});

// Instancias globales que se utilizan en múltiples partes del proceso principal
const progressThrottler = new ProgressThrottler();
let cleanupInterval = null;
let historyCleanupInterval = null;

/**
 * Función principal de inicialización que prepara todos los componentes de la aplicación
 *
 * Se ejecuta cuando Electron está listo y configura:
 * - Bases de datos (Myrient DB y Queue DB)
 * - Ventana principal
 * - Handlers IPC
 * - Servicios de negocio
 * - Restauración de descargas interrumpidas
 * - Limpieza periódica de recursos
 *
 * @async
 * @returns {Promise<void>}
 */
async function initialize() {
  const endInit = log.startOperation('Inicialización de aplicación');

  log.separator('INICIANDO MYRIENT DDL');
  log.info('Versión de Electron:', process.versions.electron);
  log.info('Versión de Node:', process.versions.node);
  log.info('Plataforma:', process.platform);
  log.info('Modo:', app.isPackaged ? 'Producción' : 'Desarrollo');
  log.info('Archivo de log:', logger.getFilePath());

  // Crear el directorio de configuración si no existe
  // Este directorio almacena archivos de configuración del usuario y la base de datos de cola
  if (!fs.existsSync(config.paths.configPath)) {
    fs.mkdirSync(config.paths.configPath, { recursive: true });
    log.info('Directorio de configuración creado:', config.paths.configPath);
  }

  // Limpiar archivos de log antiguos para evitar que ocupen demasiado espacio
  // Mantiene solo los logs de los últimos 5 días
  await cleanOldLogs(5);

  // Inicializar las bases de datos necesarias para el funcionamiento de la aplicación

  // Base de datos de índice Myrient: contiene el catálogo completo de archivos disponibles
  // Es de solo lectura y se usa para búsquedas y navegación
  const dbInitialized = await database.initialize();
  if (!dbInitialized) {
    log.error('No se pudo inicializar la base de datos de índice');
    app.quit();
    return;
  }

  // Base de datos de cola de descargas: almacena el estado persistente de todas las descargas
  // Es de lectura/escritura y permite restaurar descargas después de reiniciar la aplicación
  const queueInitialized = queueDatabase.initialize();
  if (!queueInitialized) {
    log.error('No se pudo inicializar la base de datos de cola');
    app.quit();
    return;
  }

  // Limpiar descargas que tienen estados incorrectos en la base de datos
  // Corrige descargas marcadas como "paused" que en realidad están completadas, fallidas, o muy antiguas
  // Esto puede ocurrir si la aplicación se cerró abruptamente
  log.info('Iniciando limpieza de descargas mal etiquetadas...');
  const cleanupResult = queueDatabase.cleanupMislabeledDownloads(7);
  if (cleanupResult.corrected > 0) {
    log.info(
      `Limpieza completada: ${cleanupResult.corrected} descargas corregidas (${cleanupResult.completed || 0} completadas, ${cleanupResult.failed || 0} fallidas, ${cleanupResult.cancelled || 0} canceladas)`
    );
  } else if (cleanupResult.error) {
    log.warn(`Error en limpieza: ${cleanupResult.error}`);
  } else {
    log.info('No se encontraron descargas mal etiquetadas para corregir');
  }

  // Mostrar estadísticas actuales de la cola de descargas para diagnóstico
  const stats = queueDatabase.getStats();
  log.info('Estado de la cola SQLite:', {
    enCola: stats.queued,
    activas: stats.downloading,
    pausadas: stats.paused,
    completadas: stats.completed,
    fallidas: stats.failed,
  });

  // Crear la ventana principal de la aplicación
  const mainWindow = createMainWindow();

  // Configurar el throttler de progreso y el gestor de descargas con referencias necesarias
  progressThrottler.setMainWindow(mainWindow);
  await downloadManager.initialize(mainWindow, progressThrottler);

  // Registrar todos los handlers IPC que permiten comunicación entre el renderer y el proceso principal
  registerHandlers(mainWindow);

  // Restaurar descargas pendientes cuando la ventana termine de cargar el contenido
  // Esto permite mostrar al usuario las descargas que estaban en progreso antes de cerrar la app
  mainWindow.webContents.on('did-finish-load', () => {
    const queuedDownloads = queueDatabase.getQueued();
    const pausedDownloads = queueDatabase.getPaused();

    if (queuedDownloads.length > 0 || pausedDownloads.length > 0) {
      log.info(
        `Restaurando ${queuedDownloads.length} en cola + ${pausedDownloads.length} pausadas...`
      );

      // Leer configuración del usuario sobre si debe reanudar descargas automáticamente al iniciar
      // Por defecto es false, lo que significa que las descargas quedan en estado de espera
      let autoResume = false;
      try {
        const settingsPath = path.join(config.paths.configPath, 'download-settings.json');
        if (fs.existsSync(settingsPath)) {
          const settings = readJSONFile('download-settings.json');
          if (settings && settings.autoResumeDownloads !== undefined) {
            autoResume = settings.autoResumeDownloads === true;
          }
        }
      } catch (error) {
        log.warn(
          'Error leyendo configuración de reanudación automática, usando valor por defecto:',
          error.message
        );
      }

      // Marcar todas las descargas que estaban en cola como pausadas (estado de espera)
      // Esto permite al usuario decidir si quiere reanudarlas o cancelarlas
      // EXCEPCIÓN: Las descargas en estado 'awaiting' se mantienen así porque esperan confirmación del usuario
      if (queuedDownloads.length > 0) {
        log.info(
          `Marcando ${queuedDownloads.length} descargas en cola como pausadas (en espera)...`
        );
        queuedDownloads.forEach(download => {
          // No pausar descargas que están esperando confirmación de sobrescritura de archivo existente
          if (download.state !== 'awaiting') {
            queueDatabase.pauseDownload(download.id);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('download-progress', {
                id: download.id,
                state: 'paused',
                title: download.title,
                progress: download.progress || 0,
              });
            }
          } else {
            // Mantener el estado 'awaiting' y notificar al frontend para mostrar diálogo de confirmación
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('download-progress', {
                id: download.id,
                state: 'awaiting-confirmation',
                title: download.title,
                progress: download.progress || 0,
                savePath: download.savePath,
              });
            }
          }
        });
      }

      // Notificar al frontend sobre las descargas que ya estaban pausadas antes del cierre
      // Esto asegura que la UI muestre correctamente el estado de todas las descargas
      pausedDownloads.forEach(download => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-progress', {
            id: download.id,
            state: 'paused',
            title: download.title,
            progress: download.progress || 0,
          });
        }
      });

      // Si la reanudación automática está habilitada, reanudar todas las descargas después de un breve delay
      // Esto permite que la UI se cargue completamente antes de comenzar las descargas
      if (autoResume) {
        setTimeout(() => {
          log.info('Reanudación automática activada, iniciando descargas...');
          // Cambiar todas las descargas pausadas de vuelta a estado 'queued' para procesarlas
          const allPaused = queueDatabase.getPaused();
          allPaused.forEach(download => {
            queueDatabase.resumeDownload(download.id);
          });

          // Cargar la cola desde la base de datos a la memoria del DownloadManager
          const loadedCount = downloadManager.loadQueue();
          log.info(`Cola cargada en memoria: ${loadedCount} descargas`);

          // Procesar la cola después de otro breve delay para asegurar que todo esté listo
          setTimeout(() => {
            downloadManager.processQueue();
          }, 500);
        }, 1000);
      } else {
        log.info(
          'Descargas en estado de espera. El usuario puede reanudarlas, eliminarlas o cancelarlas desde la interfaz.'
        );
      }
    }

    // Enviar al frontend solo las descargas que son relevantes para mostrar al usuario
    // Excluye descargas completadas o fallidas antiguas para evitar confusión en la UI
    // Se obtienen nuevamente porque los estados pueden haber cambiado después de pausar las descargas en cola
    const allPausedNow = queueDatabase.getPaused();
    const allQueuedNow = queueDatabase.getQueued();
    const activeDownloads = queueDatabase.getActive();
    const awaitingDownloads = queueDatabase.getByState('awaiting');

    // Combinar todas las descargas relevantes de diferentes estados
    const allRelevant = [
      ...allPausedNow,
      ...allQueuedNow,
      ...activeDownloads,
      ...awaitingDownloads,
    ];

    // Eliminar duplicados usando un Map donde la clave es el ID de la descarga
    // Esto previene mostrar la misma descarga múltiples veces si aparece en varios estados
    const uniqueDownloads = new Map();
    allRelevant.forEach(download => {
      uniqueDownloads.set(download.id, download);
    });

    const relevantDownloads = Array.from(uniqueDownloads.values());

    // Enviar evento al frontend con todas las descargas restauradas
    if (relevantDownloads.length > 0) {
      mainWindow.webContents.send('downloads-restored', relevantDownloads);
    }
  });

  // Configurar intervalo periódico para limpiar descargas "zombies" (sin actividad por mucho tiempo)
  // Las descargas zombies pueden ocurrir si la aplicación se cierra abruptamente o hay errores de red
  cleanupInterval = setInterval(() => {
    const cleaned = downloadManager.cleanupStaleDownloads();
    if (cleaned > 0) {
      log.info(`Limpiadas ${cleaned} descargas zombies`);
      // Procesar la cola después de limpiar para iniciar descargas que estaban bloqueadas
      downloadManager.processQueue();
    }
  }, config.downloads.staleTimeout);

  // Ejecutar limpieza inicial del historial de descargas al iniciar la aplicación
  // Elimina registros de descargas completadas o fallidas más antiguos de 30 días
  const cleanedHistory = queueDatabase.cleanOldHistory(30);
  if (cleanedHistory > 0) {
    log.info(`Limpiados ${cleanedHistory} registros antiguos`);
  }

  // Configurar limpieza automática periódica del historial que se ejecuta cada hora
  // Mantiene la base de datos de tamaño razonable eliminando registros antiguos automáticamente
  historyCleanupInterval = setInterval(
    () => {
      try {
        const cleaned = queueDatabase.cleanOldHistory(30);
        if (cleaned > 0) {
          log.info(`Limpieza automática: ${cleaned} registros antiguos eliminados`);

          // Notificar al frontend sobre la limpieza para actualizar la UI si es necesario
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('history-cleaned', {
              count: cleaned,
              timestamp: Date.now(),
            });
          }
        }
      } catch (error) {
        log.error('Error en limpieza automática de historial:', error);
      }
    },
    60 * 60 * 1000
  );

  endInit('exitosa');
  log.separator('APLICACIÓN LISTA');
}

// Eventos del ciclo de vida de la aplicación Electron
// Manejan la inicialización, activación, y cierre de la aplicación

// Inicializar la aplicación cuando Electron esté completamente listo
app.whenReady().then(initialize);

// Evento específico de macOS: crear ventana si no hay ninguna cuando la app se activa
// En otros sistemas operativos este evento no se dispara típicamente
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    initialize();
  }
});

// Cuando todas las ventanas se cierran, ejecutar limpieza y salir
// En macOS la aplicación normalmente continúa corriendo aunque no haya ventanas
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanup();
    app.quit();
  }
});

// Ejecutar limpieza antes de que la aplicación comience a cerrarse
// Garantiza que todos los recursos se liberen y el estado se guarde correctamente
app.on('before-quit', () => {
  cleanup();
});

// Función de limpieza que se ejecuta antes de cerrar la aplicación
// Guarda el estado actual de descargas, cierra conexiones, y libera recursos
function cleanup() {
  log.separator('LIMPIANDO RECURSOS');

  // Guardar el estado actual de todas las descargas activas en la base de datos SQLite
  // IMPORTANTE: Solo cambiar el estado de descargas que realmente estaban descargando
  // Respetar los estados que el usuario haya establecido (paused, cancelled, etc.)

  // Procesar descargas simples (no fragmentadas) que estaban activas al cerrar
  const activeDownloads = downloadManager.activeDownloads;
  if (activeDownloads && activeDownloads.size > 0) {
    log.info(`Verificando estado de ${activeDownloads.size} descargas simples activas...`);

    let queuedCount = 0;
    let skippedCount = 0;

    activeDownloads.forEach((download, id) => {
      // Verificar el estado actual registrado en la base de datos
      const dbDownload = queueDatabase.getById(id);

      if (!dbDownload) {
        // La descarga fue eliminada de la BD, no hacer nada con ella
        log.debug(`Descarga ${id} no encontrada en BD, omitiendo`);
        skippedCount++;
        return;
      }

      // Solo cambiar a 'queued' si realmente estaba descargando activamente
      // No cambiar descargas que el usuario pausó, canceló, o que ya estaban en otro estado
      if (dbDownload.state === 'downloading') {
        queueDatabase.updateDownload(id, {
          state: 'queued',
          lastError: 'Aplicación cerrada durante la descarga',
        });
        queuedCount++;
      } else {
        log.debug(`Descarga ${id} en estado '${dbDownload.state}', manteniendo estado`);
        skippedCount++;
      }
    });

    if (queuedCount > 0 || skippedCount > 0) {
      log.info(
        `Descargas simples: ${queuedCount} reencoladas, ${skippedCount} omitidas (estados respetados)`
      );
    }
  }

  // Procesar descargas fragmentadas (chunked) que estaban activas al cerrar
  const chunkedDownloads = downloadManager.chunkedDownloads;
  if (chunkedDownloads && chunkedDownloads.size > 0) {
    log.info(`Verificando estado de ${chunkedDownloads.size} descargas fragmentadas activas...`);

    let queuedCount = 0;
    let skippedCount = 0;

    chunkedDownloads.forEach((chunked, id) => {
      // Verificar el estado actual registrado en la base de datos
      const dbDownload = queueDatabase.getById(id);

      if (!dbDownload) {
        // La descarga fue eliminada de la BD, no hacer nada con ella
        log.debug(`Descarga fragmentada ${id} no encontrada en BD, omitiendo`);
        skippedCount++;
        return;
      }

      // Solo cambiar a 'queued' si realmente estaba descargando activamente
      // Respetar estados que el usuario estableció antes del cierre
      if (dbDownload.state === 'downloading') {
        queueDatabase.updateDownload(id, {
          state: 'queued',
          lastError: 'Aplicación cerrada durante la descarga',
        });
        queuedCount++;
      } else {
        log.debug(`Descarga fragmentada ${id} en estado '${dbDownload.state}', manteniendo estado`);
        skippedCount++;
      }
    });

    if (queuedCount > 0 || skippedCount > 0) {
      log.info(
        `Descargas fragmentadas: ${queuedCount} reencoladas, ${skippedCount} omitidas (estados respetados)`
      );
    }
  }

  log.info('Estado de descargas guardado en SQLite');

  // Destruir el gestor de descargas, cancelando todas las descargas activas y limpiando recursos
  downloadManager.destroy();
  log.info('DownloadManager destruido');

  // Detener el intervalo periódico de limpieza de descargas zombies
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    log.info('Intervalo de limpieza detenido');
  }

  // Detener el intervalo de limpieza automática de historial
  if (historyCleanupInterval) {
    clearInterval(historyCleanupInterval);
    historyCleanupInterval = null;
    log.info('Intervalo de limpieza de historial detenido');
  }

  // Destruir el throttler de progreso y cancelar cualquier actualización pendiente
  progressThrottler.destroy();
  log.info('Throttler destruido');

  // Cerrar la base de datos de cola ejecutando un checkpoint del WAL
  // El checkpoint garantiza que todas las transacciones pendientes se escriban al archivo principal
  queueDatabase.close();
  log.info('QueueDatabase cerrada');

  // Cerrar la conexión a la base de datos de índice Myrient
  database.close();
  log.info('Database de índice cerrada');

  // Remover todos los handlers IPC registrados para limpiar listeners
  removeHandlers();
  log.info('Handlers IPC removidos');

  log.separator('APLICACIÓN CERRADA');
}
