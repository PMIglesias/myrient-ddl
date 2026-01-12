/**
 * @fileoverview Handlers IPC para comunicación entre main y renderer
 * @module ipcHandlers
 *
 * Centraliza todos los ipcMain.handle() en un solo lugar para facilitar el mantenimiento.
 * Todos los handlers incluyen validación de parámetros con Zod y manejo robusto de errores.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} IPCHandlerResponse
 * @property {boolean} success - Si la operación fue exitosa
 * @property {*} [data] - Datos de respuesta (si success es true)
 * @property {string} [error] - Mensaje de error (si success es false)
 * @property {number} [total] - Total de resultados (para búsquedas paginadas)
 * @property {Object} [pagination] - Información de paginación (para búsquedas)
 */

/**
 * @typedef {Object} SearchOptions
 * @property {number} [limit=500] - Número máximo de resultados (1-1000)
 * @property {number} [offset=0] - Número de resultados a omitir (paginación)
 * @property {boolean} [usePrefix=true] - Si usar búsqueda por prefijo
 * @property {boolean} [usePhrase=false] - Si buscar frase exacta
 * @property {boolean} [useOR=false] - Si usar operador OR en lugar de AND
 */

/**
 * @typedef {Object} DownloadFileParams
 * @property {number} id - ID único del archivo (desde base de datos)
 * @property {string} title - Nombre del archivo
 * @property {string} [downloadPath] - Ruta base de descarga
 * @property {boolean} [preserveStructure=true] - Si mantener estructura de carpetas
 * @property {boolean} [forceOverwrite=false] - Si sobrescribir sin preguntar
 * @property {string} [priority='normal'] - Prioridad: 'low' | 'normal' | 'high'
 */

/**
 * @typedef {Object} DownloadFolderParams
 * @property {number} folderId - ID de la carpeta a descargar
 * @property {string} [downloadPath] - Ruta base de descarga
 * @property {boolean} [preserveStructure=true] - Si mantener estructura de carpetas
 * @property {boolean} [forceOverwrite=false] - Si sobrescribir sin preguntar
 */

const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const database = require('./database');
const downloadManager = require('./downloadManager');
const queueDatabase = require('./queueDatabase');
const { serviceManager } = require('./services');
const { safeUnlink } = require('./utils/fileHelpers');
const {
  logger,
  readJSONFile,
  writeJSONFile,
  validateDownloadParams,
  validateSearchTerm,
  validateNodeId,
  validateDownloadId,
  validateConfigFilename,
  validateDownloadFolderParams,
  sanitizeSearchTerm,
  validateAndSanitizeDownloadPath,
  sanitizeFileName,
} = require('./utils');
const { sendDownloadProgress } = require('./utils/ipcHelpers');
const { ERRORS } = require('./constants/errors');
const { RateLimiter } = require('./utils/rateLimiter');
const config = require('./config');

const log = logger.child('IPC');

// =====================
// RATE LIMITING
// =====================

// CRÍTICO: Rate limiter para búsquedas para prevenir saturación del sistema
const searchRateLimiter = new RateLimiter(
  config.rateLimiting?.search?.maxRequests || 10,
  config.rateLimiting?.search?.windowMs || 1000
);

// Limpieza periódica del rate limiter para liberar memoria
const cleanupInterval = setInterval(() => {
  searchRateLimiter.cleanup();
}, config.rateLimiting?.search?.cleanupIntervalMs || 60000);

// Limpiar intervalo al cerrar la aplicación
if (typeof process !== 'undefined') {
  process.on('exit', () => {
    clearInterval(cleanupInterval);
  });
}

/**
 * Crea un wrapper para handlers IPC con manejo automático de errores
 *
 * Envuelve un handler IPC para capturar errores y retornar respuestas consistentes.
 * Todos los errores se registran en el logger antes de retornar al renderer.
 *
 * @param {string} channel - Nombre del canal IPC (para logging)
 * @param {Function} handler - Función handler que se ejecutará
 * @param {Object} [options={}] - Opciones adicionales (reservado para futuro)
 * @returns {Function} Handler envuelto que captura errores automáticamente
 *
 * @example
 * ipcMain.handle('my-channel', createHandler('my-channel', async (event, param1, param2) => {
 *   // Tu lógica aquí
 *   return { success: true, data: result };
 * }));
 * // Si hay un error, se captura automáticamente y se retorna:
 * // { success: false, error: 'mensaje de error' }
 */
function createHandler(channel, handler, options = {}) {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      log.error(`Error en handler '${channel}':`, error);
      return {
        success: false,
        error: error.message || ERRORS.GENERAL.INTERNAL_SERVER_ERROR,
      };
    }
  };
}

/**
 * Obtiene servicios de forma segura
 *
 * Retorna referencias a todos los servicios disponibles. Si ServiceManager
 * no está inicializado, retorna null para cada servicio en lugar de lanzar error.
 *
 * @returns {Object} Objeto con servicios disponibles
 * @returns {Object|null} returns.downloadService - DownloadService si está disponible
 * @returns {Object|null} returns.searchService - SearchService si está disponible
 * @returns {Object|null} returns.queueService - QueueService si está disponible
 * @returns {Object|null} returns.fileService - FileService si está disponible
 *
 * @example
 * const { downloadService, searchService } = getServices();
 *
 * if (downloadService) {
 *   // Usar servicio de forma segura
 *   const result = downloadService.validateDownloadParams(params);
 * } else {
 *   // Fallback si servicio no está disponible
 *   console.warn('DownloadService no disponible');
 * }
 */
function getServices() {
  const downloadService = serviceManager.initialized ? serviceManager.getDownloadService() : null;
  const searchService = serviceManager.initialized ? serviceManager.getSearchService() : null;
  const queueService = serviceManager.initialized ? serviceManager.getQueueService() : null;
  const fileService = serviceManager.initialized ? serviceManager.getFileService() : null;

  return { downloadService, searchService, queueService, fileService };
}

/**
 * Registra todos los handlers IPC con el proceso principal
 *
 * Configura todos los canales IPC disponibles para comunicación entre el proceso
 * principal (main) y el proceso de renderizado (renderer). Incluye validación de
 * parámetros y manejo de errores para cada handler.
 *
 * Handlers registrados:
 * - Búsqueda: 'search-db', 'get-children', 'get-ancestors', 'get-node-info'
 * - Descargas: 'download-file', 'download-folder', 'pause-download', 'cancel-download', etc.
 * - Configuración: 'get-settings', 'save-settings', etc.
 * - Estado: 'get-downloads', 'get-queue', 'get-stats', etc.
 *
 * @param {Object} mainWindow - Ventana principal de Electron (BrowserWindow)
 * @returns {void}
 *
 * @example
 * // En main.js, después de crear la ventana:
 * const { registerHandlers } = require('./ipcHandlers');
 * registerHandlers(mainWindow);
 *
 * // Ahora el renderer puede usar:
 * // const result = await window.electronAPI.downloadFile({ id: 123, title: 'archivo.zip' });
 */
function registerHandlers(mainWindow) {
  log.info('Registrando handlers IPC...');

  // Asegurar que los servicios estén inicializados
  if (!serviceManager.initialized) {
    log.warn('ServiceManager no está inicializado, usando validaciones básicas');
  }

  // =====================
  // BASE DE DATOS
  // =====================

  ipcMain.handle(
    'search-db',
    createHandler('search-db', async (event, searchTerm, options = {}) => {
      // CRÍTICO: Rate limiting para prevenir saturación del sistema
      // Usar sender.id como identificador único por ventana de renderer
      const identifier = event.sender.id.toString();

      if (!searchRateLimiter.isAllowed(identifier)) {
        const status = searchRateLimiter.getStatus(identifier);
        log.warn(
          `Rate limit excedido para búsqueda (sender: ${identifier}): ${status?.count || 'N/A'}/${searchRateLimiter.maxRequests} requests`
        );
        return {
          success: false,
          error: 'Demasiadas búsquedas. Por favor espera un momento antes de buscar nuevamente.',
          rateLimited: true,
          retryAfter: status?.resetInMs || searchRateLimiter.windowMs,
        };
      }

      const { searchService } = getServices();

      // CRÍTICO: Sanitizar término de búsqueda antes de validar
      const sanitizedTerm = sanitizeSearchTerm(searchTerm);

      // Validar término de búsqueda (ya sanitizado)
      const validation = validateSearchTerm(sanitizedTerm);
      if (!validation.valid) {
        // Retornar array vacío para búsquedas muy cortas (no es error)
        if (sanitizedTerm && sanitizedTerm.trim().length < 2) {
          return { success: true, data: [], total: 0 };
        }
        return { success: false, error: validation.error };
      }

      // Normalizar y preparar opciones usando SearchService si está disponible
      let normalizedOptions;
      let searchTermToUse = validation.data;

      if (searchService) {
        // Normalizar opciones usando SearchService
        normalizedOptions = searchService.normalizeSearchOptions(options);
        // Normalizar término adicionalmente usando SearchService
        const normalizedTerm = searchService.normalizeSearchTerm(searchTermToUse);
        searchTermToUse = normalizedTerm;

        // Intentar obtener resultado del caché
        const cachedResult = searchService.getFromCache(searchTermToUse, normalizedOptions);
        if (cachedResult) {
          log.debug(`Búsqueda servida desde caché: "${searchTermToUse}"`);
          // Calcular paginación si es necesario
          if (cachedResult.total !== undefined) {
            const pagination = searchService.calculatePagination(
              cachedResult.total,
              normalizedOptions.limit,
              normalizedOptions.offset
            );
            return { ...cachedResult, pagination };
          }
          return cachedResult;
        }
      } else {
        // Opciones básicas si SearchService no está disponible
        normalizedOptions = {
          limit: Math.min(Math.max(parseInt(options.limit) || 500, 1), 1000),
          offset: Math.max(parseInt(options.offset) || 0, 0),
          usePrefix: options.usePrefix !== false,
          usePhrase: options.usePhrase === true,
          useOR: options.useOR === true,
        };
      }

      // Ejecutar búsqueda (ahora puede ser async si usa worker thread)
      const result = await database.search(searchTermToUse, normalizedOptions);

      // Guardar resultado en caché si SearchService está disponible y la búsqueda fue exitosa
      if (searchService && result.success) {
        searchService.setCache(searchTermToUse, normalizedOptions, result);
      }

      // Calcular paginación si SearchService está disponible
      if (searchService && result.success && result.total !== undefined) {
        const pagination = searchService.calculatePagination(
          result.total,
          normalizedOptions.limit,
          normalizedOptions.offset
        );
        return { ...result, pagination };
      }

      return result;
    })
  );

  ipcMain.handle(
    'get-children',
    createHandler('get-children', (event, parentId) => {
      const validation = validateNodeId(parentId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      return database.getChildren(validation.data);
    })
  );

  ipcMain.handle(
    'get-ancestors',
    createHandler('get-ancestors', (event, nodeId) => {
      const validation = validateNodeId(nodeId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      return database.getAncestors(validation.data);
    })
  );

  ipcMain.handle(
    'get-node-info',
    createHandler('get-node-info', (event, nodeId) => {
      const validation = validateNodeId(nodeId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      return database.getNodeInfo(validation.data);
    })
  );

  ipcMain.handle(
    'get-db-update-date',
    createHandler('get-db-update-date', () => {
      return database.getUpdateDate();
    })
  );

  // =====================
  // DESCARGAS
  // =====================

  ipcMain.handle(
    'download-file',
    createHandler('download-file', async (event, params) => {
      const { downloadService, queueService } = getServices();

      // CRÍTICO: Sanitizar inputs antes de validar
      if (params.title) {
        params.title = sanitizeFileName(params.title);
      }

      if (params.downloadPath) {
        const pathValidation = validateAndSanitizeDownloadPath(params.downloadPath);
        if (!pathValidation.valid) {
          return { success: false, error: pathValidation.error };
        }
        params.downloadPath = pathValidation.path;
      }

      // Validar parámetros de descarga (ya sanitizados)
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
          duplicate: true,
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
            duplicate: true,
          };
        }

        // Notificar que está en cola (usar helper optimizado)
        sendDownloadProgress(mainWindow, {
          id: validatedParams.id,
          state: 'queued',
          title: validatedParams.title,
          progress: 0,
        }, { includeMetadata: true });

        log.info(`Descarga en cola: ${validatedParams.title} (posición ${position})`);
        return { success: true, queued: true, position };
      }

      // SUPER MEGA HIPER IMPORTANTE : Primero agregar la descarga a la BD si no existe
      // Esto evita el error de FOREIGN KEY al crear chunks
      if (!queueDatabase.exists(validatedParams.id)) {
        // Normalizar downloadPath: convertir strings vacíos a null para evitar problemas
        const normalizedDownloadPath =
          validatedParams.downloadPath && typeof validatedParams.downloadPath === 'string'
            ? validatedParams.downloadPath.trim() || null
            : null;

        queueDatabase.addDownload({
          id: validatedParams.id,
          title: validatedParams.title,
          url: null, // Se establecerá al iniciar
          savePath: null, // Se establecerá al iniciar
          downloadPath: normalizedDownloadPath, // Normalizado: null si está vacío
          preserveStructure: validatedParams.preserveStructure || false,
          forceOverwrite: validatedParams.forceOverwrite || false,
          state: 'queued',
          priority: validatedParams.priority || 1,
          totalBytes: validatedParams.expectedFileSize || 0,
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
        log.warn(
          `Descarga no se inició correctamente: ${validatedParams.title} (estado: ${downloadState})`
        );
        return { success: false, error: 'No se pudo iniciar la descarga' };
      }
    })
  );

  ipcMain.handle(
    'pause-download',
    createHandler('pause-download', async (event, downloadId) => {
      const { downloadService } = getServices();

      // Validar ID usando DownloadService si está disponible
      let validation;
      if (downloadService) {
        validation = validateDownloadId(downloadId);
      } else {
        validation = validateDownloadId(downloadId);
      }

      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      return downloadManager.pauseDownload(validation.data);
    })
  );

  ipcMain.handle(
    'resume-download',
    createHandler('resume-download', async (event, downloadId) => {
      const { downloadService, queueService } = getServices();

      // Validar ID de descarga
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
        return {
          success: false,
          error: `No se puede reanudar descarga en estado ${dbDownload.state}`,
        };
      }

      // Reanudar en SQLite (cambiar a queued)
      const resumed = queueDatabase.resumeDownload(id);
      if (!resumed) {
        return { success: false, error: ERRORS.DOWNLOAD.RESUME_FAILED };
      }

      // Notificar al frontend que la descarga está en cola (usar helper optimizado)
      sendDownloadProgress(mainWindow, {
        id: dbDownload.id,
        state: 'queued',
        title: dbDownload.title,
        progress: dbDownload.progress || 0,
      }, { includeMetadata: true });

      // Agregar a la cola del DownloadManager
      // Si hay un savePath guardado, pasarlo para evitar pedir nueva ubicación
      // Normalizar downloadPath: si está vacío o es null, será tratado como "sin ruta configurada"
      // y se pedirá ubicación en _determineSavePath
      const normalizedDownloadPath =
        dbDownload.downloadPath && typeof dbDownload.downloadPath === 'string'
          ? dbDownload.downloadPath.trim() || null
          : null;

      const download = {
        id: dbDownload.id,
        title: dbDownload.title,
        downloadPath: normalizedDownloadPath, // Normalizado: null si está vacío
        preserveStructure: dbDownload.preserveStructure,
        forceOverwrite: dbDownload.forceOverwrite,
        priority: dbDownload.priority,
        savePath: dbDownload.savePath || null, // Pasar savePath si existe
      };

      downloadManager.addToQueue(download);

      // Procesar la cola
      setTimeout(() => {
        downloadManager.processQueue();
      }, 100);

      return { success: true };
    })
  );

  ipcMain.handle(
    'cancel-download',
    createHandler('cancel-download', async (event, downloadId) => {
      // Validar ID de descarga
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      return downloadManager.cancelDownload(validation.data);
    })
  );

  ipcMain.handle(
    'retry-download',
    createHandler('retry-download', async (event, downloadId) => {
      const { downloadService, queueService } = getServices();

      // Validar ID de descarga
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const id = validation.data;

      // Verificar que la descarga existe
      const dbDownload = queueDatabase.getById(id);
      if (!dbDownload) {
        return { success: false, error: 'Descarga no encontrada' };
      }

      // Verificar que está en un estado válido para reiniciar
      // NO permitir reiniciar descargas completadas
      if (dbDownload.state === 'completed') {
        return {
          success: false,
          error: `No se puede reiniciar descarga en estado ${dbDownload.state}`,
        };
      }

      const validStates = ['cancelled', 'failed', 'awaiting', 'paused'];
      if (!validStates.includes(dbDownload.state)) {
        return {
          success: false,
          error: `No se puede reiniciar descarga en estado ${dbDownload.state}`,
        };
      }

      // Limpiar chunks de descargas fragmentadas si existen
      try {
        const chunks = queueDatabase.getChunks(id);
        if (chunks && chunks.length > 0) {
          log.info(`Limpiando ${chunks.length} chunks para reinicio de descarga ${id}`);
          // Eliminar archivos temporales de chunks
          chunks.forEach(chunk => {
            if (chunk.tempFile && fs.existsSync(chunk.tempFile)) {
              safeUnlink(chunk.tempFile);
            }
          });
          // Eliminar chunks de la base de datos
          queueDatabase.statements.deleteChunks.run(id);
        }
      } catch (error) {
        log.warn(`Error limpiando chunks para descarga ${id}:`, error.message);
      }

      // Limpiar archivo parcial si existe (para descargas simples)
      try {
        if (dbDownload.savePath) {
          const partialPath = dbDownload.savePath + '.part';
          if (fs.existsSync(partialPath)) {
            safeUnlink(partialPath);
            log.info(`Archivo parcial eliminado: ${partialPath}`);
          }
        }
      } catch (error) {
        log.warn(`Error limpiando archivo parcial para descarga ${id}:`, error.message);
      }

      // Reiniciar en SQLite (resetear progreso y volver a cola)
      const retried = queueDatabase.retryDownload(id);
      if (!retried) {
        return { success: false, error: ERRORS.DOWNLOAD.RETRY_FAILED };
      }

      // Obtener la descarga actualizada de la BD
      const updatedDownload = queueDatabase.getById(id);
      if (!updatedDownload) {
        return { success: false, error: ERRORS.DOWNLOAD.GET_UPDATED_FAILED };
      }

      // Agregar a la cola en memoria del DownloadManager si no está ya ahí
      // Normalizar downloadPath: si está vacío o es null, será tratado como "sin ruta configurada"
      const normalizedDownloadPath =
        updatedDownload.downloadPath && typeof updatedDownload.downloadPath === 'string'
          ? updatedDownload.downloadPath.trim() || null
          : null;

      const inQueue = downloadManager.downloadQueue.some(d => d.id === id);
      if (!inQueue) {
        downloadManager.downloadQueue.push({
          id: updatedDownload.id,
          title: updatedDownload.title,
          downloadPath: normalizedDownloadPath, // Normalizado: null si está vacío
          preserveStructure: updatedDownload.preserveStructure,
          forceOverwrite: updatedDownload.forceOverwrite || false,
          retryCount: updatedDownload.retryCount || 0,
          addedAt: updatedDownload.createdAt,
          queuePosition: updatedDownload.queuePosition,
          priority: updatedDownload.priority || 1,
          savePath: updatedDownload.savePath || null,
        });
        log.info(`Descarga ${id} agregada a la cola en memoria después de reiniciar`);
      }

      // Notificar al frontend que la descarga está en cola (usar helper optimizado)
      sendDownloadProgress(mainWindow, {
        id,
        state: 'queued',
        title: updatedDownload.title,
        progress: 0,
        downloadedBytes: 0,
      }, { includeMetadata: true });

      // Procesar la cola para iniciar la descarga
      setImmediate(() => downloadManager.processQueue());

      return { success: true };
    })
  );

  ipcMain.handle(
    'confirm-overwrite',
    createHandler('confirm-overwrite', async (event, downloadId) => {
      // Validar ID de descarga
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const id = validation.data;

      // Verificar que la descarga existe
      const dbDownload = queueDatabase.getById(id);
      if (!dbDownload) {
        return { success: false, error: 'Descarga no encontrada' };
      }

      // Verificar que está en estado awaiting, queued, paused o completed (completed puede ser desincronización)
      const validStates = ['awaiting', 'queued', 'paused', 'completed'];
      if (!validStates.includes(dbDownload.state)) {
        return {
          success: false,
          error: `No se puede confirmar sobrescritura de descarga en estado ${dbDownload.state}`,
        };
      }

      // Confirmar sobrescritura en SQLite (cambiar a queued y activar forceOverwrite)
      const confirmed = queueDatabase.confirmOverwrite(id);
      if (!confirmed) {
        return { success: false, error: ERRORS.DOWNLOAD.CONFIRM_OVERWRITE_FAILED };
      }

      // Obtener la descarga actualizada de la BD
      const updatedDownload = queueDatabase.getById(id);
      if (!updatedDownload) {
        return { success: false, error: ERRORS.DOWNLOAD.GET_UPDATED_FAILED };
      }

      // Agregar a la cola en memoria del DownloadManager si no está ya ahí
      const inQueue = downloadManager.downloadQueue.some(d => d.id === id);
      if (!inQueue) {
        downloadManager.downloadQueue.push({
          id: updatedDownload.id,
          title: updatedDownload.title,
          downloadPath: updatedDownload.downloadPath,
          preserveStructure: updatedDownload.preserveStructure,
          forceOverwrite: updatedDownload.forceOverwrite || true, // Asegurar que forceOverwrite esté activado
          retryCount: updatedDownload.retryCount || 0,
          addedAt: updatedDownload.createdAt,
          queuePosition: updatedDownload.queuePosition,
          priority: updatedDownload.priority || 1,
          savePath: updatedDownload.savePath || null,
        });
        log.info(`Descarga ${id} agregada a la cola en memoria después de confirmar sobrescritura`);
      } else {
        // Si ya está en la cola, actualizar forceOverwrite
        const queueItem = downloadManager.downloadQueue.find(d => d.id === id);
        if (queueItem) {
          queueItem.forceOverwrite = true;
        }
      }

      // Notificar al frontend que la descarga está en cola (usar helper optimizado)
      sendDownloadProgress(mainWindow, {
        id,
        state: 'queued',
        title: updatedDownload.title,
        progress: 0,
        downloadedBytes: 0,
      }, { includeMetadata: true });

      // Procesar la cola para iniciar la descarga con forceOverwrite
      setImmediate(() => downloadManager.processQueue());

      return { success: true };
    })
  );

  ipcMain.handle(
    'delete-download',
    createHandler('delete-download', async (event, downloadId) => {
      // Validar ID de descarga
      const validation = validateDownloadId(downloadId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const id = validation.data;

      // Verificar que la descarga existe
      const dbDownload = queueDatabase.getById(id);
      if (!dbDownload) {
        return { success: false, error: 'Descarga no encontrada' };
      }

      // Eliminar de la base de datos
      const deleted = queueDatabase.deleteDownload(id);
      if (!deleted) {
        return { success: false, error: ERRORS.DOWNLOAD.DELETE_FAILED };
      }

      // Si está activa, cancelarla primero
      const isActive = downloadManager.hasActiveDownload(id);
      if (isActive) {
        await downloadManager.cancelDownload(id);
      }

      // Remover de la cola en memoria si está ahí
      downloadManager.removeFromQueue(id);

      // Notificar al frontend que la descarga fue eliminada (usar helper optimizado)
      sendDownloadProgress(mainWindow, {
        id,
        state: 'deleted',
        progress: 0,
      });

      return { success: true };
    })
  );

  ipcMain.handle(
    'get-download-stats',
    createHandler('get-download-stats', () => {
      return downloadManager.getStats();
    })
  );

  /**
   * Obtiene la estimación de tiempo de cola
   * Incluye tiempo total y tiempo hasta que una descarga específica comience
   */
  ipcMain.handle(
    'get-queue-time-estimate',
    createHandler('get-queue-time-estimate', async (event, downloadId = null) => {
      try {
        const { queueService } = getServices();
        const stats = downloadManager.getStats();

        if (!queueService) {
          return {
            success: false,
            error: 'QueueService no disponible',
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
              canStartImmediately: true,
            },
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
            queueTimeEstimate: stats.queueTimeEstimate || null,
          };
        }

        // Retornar solo estimación total de cola (ya incluida en stats)
        return {
          success: true,
          queueTimeEstimate: stats.queueTimeEstimate || null,
          queueStats: stats.queueStats || null,
        };
      } catch (error) {
        log.error('Error obteniendo estimación de tiempo de cola:', error);
        return {
          success: false,
          error: error.message,
        };
      }
    })
  );

  ipcMain.handle(
    'clean-history',
    createHandler('clean-history', async (event, daysOld = 30) => {
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
          manual: true,
        });
      }

      return { success: true, count: cleaned };
    })
  );

  ipcMain.handle(
    'download-folder',
    createHandler('download-folder', async (event, params) => {
      const { downloadService, queueService } = getServices();

      // Validar parámetros de descarga de carpeta
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
          return { success: false, error: filesResult.error || ERRORS.DOWNLOAD.GET_FILES_FAILED };
        }

        const files = filesResult.data || [];

        // Validar si la carpeta puede ser descargada usando DownloadService si está disponible
        if (downloadService) {
          const stats = downloadManager.getStats();
          const canDownload = downloadService.canDownloadFolder(
            validatedParams,
            files.length,
            stats
          );

          if (!canDownload.canDownload) {
            log.warn(`No se puede descargar carpeta: ${canDownload.reason}`);
            return {
              success: false,
              error: canDownload.reason,
              fileCount: files.length,
              maxFilesPerFolder: canDownload.maxFilesPerFolder,
              availableQueueSlots: canDownload.availableQueueSlots,
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
        const folderTitle =
          folderInfo.success && folderInfo.data
            ? folderInfo.data.title
            : `Carpeta ${validatedParams.folderId}`;

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

        // CRÍTICO: Preparar todas las descargas primero, luego insertar en transacción
        const downloadsToAdd = [];
        const skippedFiles = [];
        const errors = [];

        // Primera pasada: preparar y validar todas las descargas
        for (const file of files) {
          // Preparar parámetros de descarga usando DownloadService si está disponible
          let downloadParams;

          if (downloadService) {
            const prepared = downloadService.prepareFileDownloadParams(validatedParams, file);

            if (!prepared.success) {
              errors.push({
                fileId: file.id,
                fileName: file.title,
                error: prepared.error,
              });
              skippedFiles.push(file);
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
              forceOverwrite: validatedParams.forceOverwrite || false,
            };
          }

          // CRÍTICO: Sanitizar inputs
          downloadParams.title = sanitizeFileName(downloadParams.title);
          if (downloadParams.downloadPath) {
            const pathValidation = validateAndSanitizeDownloadPath(downloadParams.downloadPath);
            if (!pathValidation.valid) {
              errors.push({
                fileId: file.id,
                fileName: file.title,
                error: pathValidation.error,
              });
              skippedFiles.push(file);
              continue;
            }
            downloadParams.downloadPath = pathValidation.path;
          }

          // Verificar si ya está en descarga o es duplicado
          if (downloadManager.isDownloadActive(downloadParams.id)) {
            skippedFiles.push(file);
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
              skippedFiles.push(file);
              continue;
            }
          }

          // Agregar a lista de descargas a insertar
          downloadsToAdd.push(downloadParams);
        }

        // CRÍTICO: Insertar todas las descargas en una sola transacción
        let addedCount = 0;
        if (downloadsToAdd.length > 0) {
          try {
            // Usar método de transacción masiva si está disponible, sino insertar una por una
            const now = Date.now();
            let nextPosition = queueDatabase.statements.getNextQueuePosition.get().next;

            const transaction = queueDatabase.db.transaction((downloads) => {
              const insertStmt = queueDatabase.statements.insertDownload;

              for (let i = 0; i < downloads.length; i++) {
                const download = downloads[i];
                
                // Verificar que no existe antes de insertar
                if (queueDatabase.exists(download.id)) {
                  continue;
                }

                insertStmt.run({
                  id: download.id,
                  title: download.title,
                  url: null,
                  savePath: null,
                  downloadPath: download.downloadPath || null,
                  preserveStructure: download.preserveStructure ? 1 : 0,
                  state: 'queued',
                  progress: 0,
                  downloadedBytes: 0,
                  totalBytes: 0,
                  priority: download.priority ?? 1,
                  forceOverwrite: download.forceOverwrite ? 1 : 0,
                  createdAt: now,
                  updatedAt: now,
                  queuePosition: nextPosition + i,
                });
              }
            });

            // Ejecutar transacción
            transaction(downloadsToAdd);
            addedCount = downloadsToAdd.length;
            log.info(`Transacción completada: ${addedCount} descargas insertadas en batch`);

            // Agregar a cola en memoria y notificar
            downloadsToAdd.forEach((download, index) => {
              const position = downloadManager.addToQueue(download);
              if (position > 0) {
                // Notificar individualmente (payload pequeño)
                sendDownloadProgress(mainWindow, {
                  id: download.id,
                  state: 'queued',
                  title: download.title,
                  progress: 0,
                }, { includeMetadata: true });
              }
            });
          } catch (error) {
            log.error('Error en transacción de descargas masivas:', error);
            // Fallback: insertar una por una si la transacción falla
            log.warn('Usando fallback: insertando descargas una por una');
            for (const download of downloadsToAdd) {
              try {
                const position = downloadManager.addToQueueWithPersist(download);
                if (position > 0) {
                  addedCount++;
                  sendDownloadProgress(mainWindow, {
                    id: download.id,
                    state: 'queued',
                    title: download.title,
                    progress: 0,
                  }, { includeMetadata: true });
                }
              } catch (err) {
                log.error(`Error insertando descarga ${download.id}:`, err);
                skippedFiles.push({ id: download.id, title: download.title });
              }
            }
          }
        }

        const skippedCount = skippedFiles.length;

        // Procesar la cola
        downloadManager.processQueue();

        log.info(
          `Descarga de carpeta iniciada: ${addedCount} archivos agregados, ${skippedCount} omitidos`
        );

        // Incluir estadísticas si están disponibles
        const result = {
          success: true,
          totalFiles: files.length,
          added: addedCount,
          skipped: skippedCount,
          folderTitle: folderTitle.replace(/\/$/, ''),
          errors: errors.length > 0 ? errors : undefined,
        };

        // Agregar estadísticas si están disponibles
        if (folderStats) {
          result.stats = {
            validFiles: folderStats.validFiles,
            duplicateFiles: folderStats.duplicateFiles,
            newDownloads: folderStats.newDownloads,
            totalSize: folderStats.totalSize,
            averageSize: folderStats.averageSize,
          };
        }

        return result;
      } catch (error) {
        log.error('Error al descargar carpeta:', error);
        return { success: false, error: error.message || ERRORS.DOWNLOAD.FOLDER_PROCESSING_FAILED };
      }
    })
  );

  // =====================
  // CONFIGURACIÓN
  // =====================

  ipcMain.handle(
    'read-config-file',
    createHandler('read-config-file', (event, filename) => {
      // Validar nombre de archivo
      const validation = validateConfigFilename(filename);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }

      const data = readJSONFile(validation.data);
      return { success: true, data };
    })
  );

  ipcMain.handle(
    'write-config-file',
    createHandler('write-config-file', (event, filename, data) => {
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
    })
  );

  // =====================
  // VENTANA
  // =====================

  ipcMain.handle(
    'window-minimize',
    createHandler('window-minimize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.minimize();
      }
    })
  );

  ipcMain.handle(
    'window-maximize',
    createHandler('window-maximize', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
      }
    })
  );

  ipcMain.handle(
    'window-close',
    createHandler('window-close', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close();
      }
    })
  );

  // =====================
  // DIÁLOGOS
  // =====================

  ipcMain.handle(
    'select-folder',
    createHandler('select-folder', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false };
      }

      return { success: true, path: result.filePaths[0] };
    })
  );

  ipcMain.handle(
    'open-folder',
    createHandler('open-folder', async (event, filePath) => {
      // Validar que filePath sea un string
      if (!filePath || typeof filePath !== 'string') {
        return { success: false, error: 'Ruta no proporcionada o inválida' };
      }

      try {
        const resolvedPath = path.resolve(filePath);
        
        // Verificar si la ruta existe
        if (!fs.existsSync(resolvedPath)) {
          return { success: false, error: 'La ruta no existe' };
        }

        // Verificar si es un directorio o un archivo
        const stats = fs.statSync(resolvedPath);
        
        if (stats.isDirectory()) {
          // Si es un directorio, abrirlo directamente
          await shell.openPath(resolvedPath);
        } else if (stats.isFile()) {
          // Si es un archivo, mostrar el archivo en el explorador
          shell.showItemInFolder(resolvedPath);
        } else {
          return { success: false, error: 'La ruta no es un archivo ni un directorio válido' };
        }
        
        return { success: true };
      } catch (error) {
        log.error('Error abriendo carpeta:', error);
        return { success: false, error: error.message };
      }
    })
  );

  // =====================
  // LOGGING FRONTEND
  // =====================

  /**
   * Recibe logs del frontend y los registra usando el logger del backend
   */
  ipcMain.handle(
    'frontend-log',
    createHandler('frontend-log', async (event, logEntry) => {
      const { level, scope, message, timestamp, mode } = logEntry;
      const frontendLogger = logger.child(`Frontend:${scope || 'App'}`);

      // Formatear mensaje
      const formattedMessage = message
        .map(msg => {
          if (typeof msg === 'object' && msg.type === 'error') {
            return `${msg.message}\n${msg.stack || ''}`;
          }
          if (typeof msg === 'object') {
            return JSON.stringify(msg, null, 2);
          }
          return String(msg);
        })
        .join(' ');

      // Registrar según nivel
      const levelMethod =
        {
          DEBUG: frontendLogger.debug.bind(frontendLogger),
          INFO: frontendLogger.info.bind(frontendLogger),
          WARN: frontendLogger.warn.bind(frontendLogger),
          ERROR: frontendLogger.error.bind(frontendLogger),
        }[level] || frontendLogger.info.bind(frontendLogger);

      levelMethod(`[${mode}] ${formattedMessage}`);

      return { success: true };
    })
  );

  /**
   * Guarda logs del frontend en un archivo de texto
   */
  ipcMain.handle(
    'save-logs-to-file',
    createHandler('save-logs-to-file', async (event, logText) => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Guardar logs',
        defaultPath: `myrient-logs-${new Date().toISOString().split('T')[0]}.txt`,
        filters: [
          { name: 'Archivos de texto', extensions: ['txt'] },
          { name: 'Todos los archivos', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'Usuario canceló' };
      }

      try {
        await fs.promises.writeFile(result.filePath, logText, 'utf8');
        log.info(`Logs guardados en: ${result.filePath}`);
        return { success: true, path: result.filePath };
      } catch (error) {
        log.error('Error guardando logs:', error);
        return { success: false, error: error.message };
      }
    })
  );

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
    'select-folder',
  ];

  channels.forEach(channel => {
    ipcMain.removeHandler(channel);
  });

  // Remover handlers de logging
  ipcMain.removeHandler('frontend-log');
  ipcMain.removeHandler('save-logs-to-file');

  log.info('Handlers IPC removidos');
}

module.exports = {
  registerHandlers,
  removeHandlers,
};
