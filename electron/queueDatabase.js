/**
 * QueueDatabase - Sistema de cola persistente con SQLite
 * 
 * Maneja toda la persistencia de descargas incluyendo:
 * - Estados: queued, downloading, paused, completed, failed, cancelled
 * - Fragmentos parciales para reanudación
 * - Historial de descargas
 * - Estadísticas
 * 
 * Decisiones técnicas:
 * - SQLite en modo WAL para mejor concurrencia y resistencia a crashes
 * - Prepared statements para rendimiento óptimo
 * - Transacciones ACID para consistencia de datos
 * - Índices optimizados para queries frecuentes
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logger } = require('./utils');

const log = logger.child('QueueDB');

// =====================
// CONSTANTES
// =====================

/**
 * Estados posibles de una descarga
 * @readonly
 * @enum {string}
 */
const DownloadState = Object.freeze({
    QUEUED: 'queued',           // En cola, esperando
    DOWNLOADING: 'downloading', // Descargando activamente
    PAUSED: 'paused',          // Pausada por el usuario
    COMPLETED: 'completed',     // Completada exitosamente
    FAILED: 'failed',          // Falló después de reintentos
    CANCELLED: 'cancelled',     // Cancelada por el usuario
    AWAITING: 'awaiting'       // Esperando confirmación (archivo existente)
});

/**
 * Prioridades de descarga
 * @readonly
 * @enum {number}
 */
const DownloadPriority = Object.freeze({
    LOW: 0,
    NORMAL: 1,
    HIGH: 2,
    URGENT: 3
});

// =====================
// SCHEMA SQL
// =====================

const SCHEMA_VERSION = 1;

const CREATE_TABLES_SQL = `
-- Tabla principal de descargas
CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY,                          -- ID del nodo en Myrient DB
    title TEXT NOT NULL,                             -- Nombre del archivo
    url TEXT,                                        -- URL de descarga
    save_path TEXT,                                  -- Ruta de guardado
    download_path TEXT,                              -- Directorio base configurado
    preserve_structure INTEGER DEFAULT 0,            -- Mantener estructura de carpetas
    
    -- Estado y progreso
    state TEXT NOT NULL DEFAULT 'queued',            -- Estado actual
    progress REAL DEFAULT 0,                         -- Progreso (0.0 - 1.0)
    downloaded_bytes INTEGER DEFAULT 0,              -- Bytes descargados
    total_bytes INTEGER DEFAULT 0,                   -- Tamaño total del archivo
    
    -- Configuración de descarga
    priority INTEGER DEFAULT 1,                      -- Prioridad (0-3)
    force_overwrite INTEGER DEFAULT 0,               -- Forzar sobrescritura
    
    -- Metadatos de tiempo
    created_at INTEGER NOT NULL,                     -- Timestamp de creación
    started_at INTEGER,                              -- Timestamp de inicio
    completed_at INTEGER,                            -- Timestamp de completado
    updated_at INTEGER NOT NULL,                     -- Última actualización
    
    -- Control de errores y reintentos
    retry_count INTEGER DEFAULT 0,                   -- Intentos realizados
    max_retries INTEGER DEFAULT 3,                   -- Máximo de reintentos
    last_error TEXT,                                 -- Último error
    
    -- Verificación de integridad
    expected_hash TEXT,                              -- Hash esperado (opcional)
    actual_hash TEXT,                                -- Hash calculado
    
    -- Índices para orden en la cola
    queue_position INTEGER                           -- Posición en la cola
);

-- Tabla de fragmentos para descargas parciales/chunked
CREATE TABLE IF NOT EXISTS download_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL,                    -- FK a downloads
    chunk_index INTEGER NOT NULL,                    -- Índice del fragmento (0, 1, 2...)
    start_byte INTEGER NOT NULL,                     -- Byte inicial
    end_byte INTEGER NOT NULL,                       -- Byte final
    downloaded_bytes INTEGER DEFAULT 0,              -- Bytes descargados en este chunk
    state TEXT DEFAULT 'pending',                    -- pending, downloading, completed, failed
    temp_file TEXT,                                  -- Archivo temporal del chunk
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE,
    UNIQUE(download_id, chunk_index)
);

-- Tabla de historial para estadísticas
CREATE TABLE IF NOT EXISTS download_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,                        -- started, paused, resumed, completed, failed, cancelled
    event_data TEXT,                                 -- JSON con datos adicionales
    created_at INTEGER NOT NULL,
    
    FOREIGN KEY (download_id) REFERENCES downloads(id) ON DELETE CASCADE
);

-- Tabla de configuración/metadatos
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Índices para optimización
CREATE INDEX IF NOT EXISTS idx_downloads_state ON downloads(state);
CREATE INDEX IF NOT EXISTS idx_downloads_queue ON downloads(state, priority DESC, queue_position ASC);
CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chunks_download ON download_chunks(download_id);
CREATE INDEX IF NOT EXISTS idx_history_download ON download_history(download_id);
CREATE INDEX IF NOT EXISTS idx_history_created ON download_history(created_at DESC);
`;

// =====================
// CLASE PRINCIPAL
// =====================

class QueueDatabase {
    constructor() {
        this.db = null;
        this.statements = null;
        this.isInitialized = false;
    }

    // =====================
    // INICIALIZACIÓN
    // =====================

    /**
     * Inicializa la base de datos de cola
     * @returns {boolean} true si se inicializó correctamente
     */
    initialize() {
        if (this.isInitialized) {
            log.warn('QueueDatabase ya está inicializada');
            return true;
        }

        const endInit = log.startOperation('Inicialización QueueDB');

        try {
            // Asegurar que existe el directorio
            const dbDir = path.dirname(config.paths.queueDbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
                log.info('Directorio de DB creado:', dbDir);
            }

            // Abrir/crear base de datos
            this.db = new Database(config.paths.queueDbPath, {
                // verbose: log.debug.bind(log) // Descomentar para debug SQL
            });

            // Configurar para mejor rendimiento y resistencia a crashes
            this.db.pragma('journal_mode = WAL');      // Write-Ahead Logging
            this.db.pragma('synchronous = NORMAL');    // Balance entre seguridad y velocidad
            this.db.pragma('cache_size = -64000');     // 64MB de caché
            this.db.pragma('temp_store = MEMORY');     // Temporales en memoria
            this.db.pragma('foreign_keys = ON');       // Integridad referencial

            // Crear/actualizar schema
            this._initializeSchema();

            // Preparar statements
            this._prepareStatements();

            // Recuperar descargas interrumpidas
            this._recoverInterruptedDownloads();

            this.isInitialized = true;
            endInit(`DB en ${config.paths.queueDbPath}`);

            return true;

        } catch (error) {
            log.error('Error inicializando QueueDatabase:', error);
            return false;
        }
    }

    /**
     * Inicializa el schema de la base de datos
     */
    _initializeSchema() {
        log.debug('Verificando schema...');

        // Ejecutar creación de tablas
        this.db.exec(CREATE_TABLES_SQL);

        // Verificar/actualizar versión del schema
        const versionStmt = this.db.prepare(
            'INSERT OR REPLACE INTO metadata (key, value, updated_at) VALUES (?, ?, ?)'
        );
        versionStmt.run('schema_version', String(SCHEMA_VERSION), Date.now());

        log.debug('Schema inicializado (versión ' + SCHEMA_VERSION + ')');
    }

    /**
     * Prepara todos los statements reutilizables
     */
    _prepareStatements() {
        log.debug('Preparando statements...');

        this.statements = {
            // ===== CRUD DESCARGAS =====

            /** Insertar nueva descarga */
            insertDownload: this.db.prepare(`
                INSERT INTO downloads (
                    id, title, url, save_path, download_path, preserve_structure,
                    state, progress, downloaded_bytes, total_bytes,
                    priority, force_overwrite,
                    created_at, updated_at, queue_position
                ) VALUES (
                    @id, @title, @url, @savePath, @downloadPath, @preserveStructure,
                    @state, @progress, @downloadedBytes, @totalBytes,
                    @priority, @forceOverwrite,
                    @createdAt, @updatedAt, @queuePosition
                )
            `),

            /** Actualizar descarga existente */
            updateDownload: this.db.prepare(`
                UPDATE downloads SET
                    state = COALESCE(@state, state),
                    progress = COALESCE(@progress, progress),
                    downloaded_bytes = COALESCE(@downloadedBytes, downloaded_bytes),
                    total_bytes = COALESCE(@totalBytes, total_bytes),
                    save_path = COALESCE(@savePath, save_path),
                    url = COALESCE(@url, url),
                    started_at = COALESCE(@startedAt, started_at),
                    completed_at = COALESCE(@completedAt, completed_at),
                    retry_count = COALESCE(@retryCount, retry_count),
                    last_error = COALESCE(@lastError, last_error),
                    updated_at = @updatedAt
                WHERE id = @id
            `),

            /** Actualizar solo estado */
            updateState: this.db.prepare(`
                UPDATE downloads SET
                    state = @state,
                    updated_at = @updatedAt
                WHERE id = @id
            `),

            /** Actualizar progreso (optimizado para llamadas frecuentes) */
            updateProgress: this.db.prepare(`
                UPDATE downloads SET
                    progress = @progress,
                    downloaded_bytes = @downloadedBytes,
                    updated_at = @updatedAt
                WHERE id = @id
            `),

            /** Obtener descarga por ID */
            getById: this.db.prepare(`
                SELECT * FROM downloads WHERE id = ?
            `),

            /** Eliminar descarga */
            deleteDownload: this.db.prepare(`
                DELETE FROM downloads WHERE id = ?
            `),

            // ===== QUERIES DE COLA =====

            /** Obtener todas las descargas en cola ordenadas por prioridad */
            getQueued: this.db.prepare(`
                SELECT * FROM downloads
                WHERE state = 'queued'
                ORDER BY priority DESC, queue_position ASC, created_at ASC
            `),

            /** Obtener descargas activas (downloading) */
            getActive: this.db.prepare(`
                SELECT * FROM downloads
                WHERE state = 'downloading'
                ORDER BY started_at ASC
            `),

            /** Obtener descargas pausadas */
            getPaused: this.db.prepare(`
                SELECT * FROM downloads
                WHERE state = 'paused'
                ORDER BY updated_at DESC
            `),

            /** Obtener historial (completadas, fallidas, canceladas) */
            getHistory: this.db.prepare(`
                SELECT * FROM downloads
                WHERE state IN ('completed', 'failed', 'cancelled')
                ORDER BY updated_at DESC
                LIMIT ?
            `),

            /** Obtener todas las descargas (para UI) */
            getAll: this.db.prepare(`
                SELECT * FROM downloads
                ORDER BY 
                    CASE state 
                        WHEN 'downloading' THEN 0 
                        WHEN 'queued' THEN 1 
                        WHEN 'paused' THEN 2 
                        WHEN 'awaiting' THEN 3
                        ELSE 4 
                    END,
                    priority DESC,
                    queue_position ASC,
                    updated_at DESC
            `),

            /** Contar descargas por estado */
            countByState: this.db.prepare(`
                SELECT state, COUNT(*) as count
                FROM downloads
                GROUP BY state
            `),

            /** Obtener siguiente posición en cola */
            getNextQueuePosition: this.db.prepare(`
                SELECT COALESCE(MAX(queue_position), 0) + 1 as next
                FROM downloads
                WHERE state = 'queued'
            `),

            /** Verificar si existe descarga */
            exists: this.db.prepare(`
                SELECT 1 FROM downloads WHERE id = ? LIMIT 1
            `),

            // ===== CHUNKS =====

            /** Insertar chunk */
            insertChunk: this.db.prepare(`
                INSERT INTO download_chunks (
                    download_id, chunk_index, start_byte, end_byte,
                    downloaded_bytes, state, temp_file, created_at, updated_at
                ) VALUES (
                    @downloadId, @chunkIndex, @startByte, @endByte,
                    @downloadedBytes, @state, @tempFile, @createdAt, @updatedAt
                )
            `),

            /** Actualizar chunk (con soporte para temp_file - Block 2) */
            updateChunk: this.db.prepare(`
                UPDATE download_chunks SET
                    downloaded_bytes = COALESCE(@downloadedBytes, downloaded_bytes),
                    state = COALESCE(@state, state),
                    temp_file = COALESCE(@tempFile, temp_file),
                    updated_at = @updatedAt
                WHERE download_id = @downloadId AND chunk_index = @chunkIndex
            `),

            /** Obtener chunks de una descarga */
            getChunks: this.db.prepare(`
                SELECT * FROM download_chunks
                WHERE download_id = ?
                ORDER BY chunk_index ASC
            `),

            /** Eliminar chunks de una descarga */
            deleteChunks: this.db.prepare(`
                DELETE FROM download_chunks WHERE download_id = ?
            `),

            // ===== HISTORIAL =====

            /** Insertar evento en historial */
            insertHistory: this.db.prepare(`
                INSERT INTO download_history (download_id, event_type, event_data, created_at)
                VALUES (@downloadId, @eventType, @eventData, @createdAt)
            `),

            /** Obtener historial de una descarga */
            getDownloadHistory: this.db.prepare(`
                SELECT * FROM download_history
                WHERE download_id = ?
                ORDER BY created_at DESC
            `),

            // ===== LIMPIEZA =====

            /** Limpiar historial antiguo */
            cleanOldHistory: this.db.prepare(`
                DELETE FROM downloads
                WHERE state IN ('completed', 'failed', 'cancelled')
                AND updated_at < ?
            `),

            /** Limpiar todo el historial */
            clearHistory: this.db.prepare(`
                DELETE FROM downloads
                WHERE state IN ('completed', 'failed', 'cancelled')
            `),

            /** Resetear descargas interrumpidas a estado queued */
            recoverInterrupted: this.db.prepare(`
                UPDATE downloads SET
                    state = 'queued',
                    updated_at = ?
                WHERE state = 'downloading'
            `)
        };

        log.debug('Statements preparados');
    }

    /**
     * Recupera descargas que estaban en progreso cuando se cerró la app
     */
    _recoverInterruptedDownloads() {
        const now = Date.now();

        // Las descargas que estaban "downloading" se ponen en "queued" para reiniciar
        const result = this.statements.recoverInterrupted.run(now);

        if (result.changes > 0) {
            log.info(`Recuperadas ${result.changes} descargas interrumpidas`);

            // Registrar en historial
            const interrupted = this.getByState(DownloadState.QUEUED);
            interrupted.forEach(d => {
                this._logEvent(d.id, 'recovered', { previousState: 'downloading' });
            });
        }
    }

    // =====================
    // OPERACIONES CRUD
    // =====================

    /**
     * Agrega una nueva descarga a la cola
     * @param {Object} download - Datos de la descarga
     * @returns {Object} La descarga creada o null si ya existe
     */
    addDownload(download) {
        if (!download.id || !download.title) {
            log.error('addDownload: ID y título son requeridos');
            return null;
        }

        // Verificar si ya existe
        if (this.exists(download.id)) {
            log.warn(`Descarga ${download.id} ya existe`);
            return null;
        }

        const now = Date.now();
        const nextPosition = this.statements.getNextQueuePosition.get().next;

        try {
            this.statements.insertDownload.run({
                id: download.id,
                title: download.title,
                url: download.url || null,
                savePath: download.savePath || null,
                downloadPath: download.downloadPath || null,
                preserveStructure: download.preserveStructure ? 1 : 0,
                state: download.state || DownloadState.QUEUED,
                progress: download.progress || 0,
                downloadedBytes: download.downloadedBytes || 0,
                totalBytes: download.totalBytes || 0,
                priority: download.priority ?? DownloadPriority.NORMAL,
                forceOverwrite: download.forceOverwrite ? 1 : 0,
                createdAt: now,
                updatedAt: now,
                queuePosition: nextPosition
            });

            // Registrar en historial
            this._logEvent(download.id, 'created', { title: download.title });

            log.info(`Descarga agregada: ${download.title} (pos: ${nextPosition})`);

            return this.getById(download.id);

        } catch (error) {
            log.error('Error agregando descarga:', error);
            return null;
        }
    }

    /**
     * Actualiza una descarga existente
     * @param {number} id - ID de la descarga
     * @param {Object} updates - Campos a actualizar
     * @returns {boolean} true si se actualizó
     */
    updateDownload(id, updates) {
        if (!this.exists(id)) {
            log.warn(`updateDownload: Descarga ${id} no existe`);
            return false;
        }

        const now = Date.now();

        try {
            this.statements.updateDownload.run({
                id,
                state: updates.state || null,
                progress: updates.progress ?? null,
                downloadedBytes: updates.downloadedBytes ?? null,
                url: updates.url || null,
                savePath: updates.savePath || null,
                totalBytes: updates.totalBytes ?? null,
                startedAt: updates.startedAt || null,
                completedAt: updates.completedAt || null,
                retryCount: updates.retryCount ?? null,
                lastError: updates.lastError || null,
                updatedAt: now
            });

            return true;

        } catch (error) {
            log.error('Error actualizando descarga:', error);
            return false;
        }
    }

    /**
     * Actualiza solo el estado de una descarga
     * @param {number} id - ID de la descarga
     * @param {string} state - Nuevo estado
     * @param {Object} [extra] - Datos adicionales para el evento
     * @returns {boolean} true si se actualizó
     */
    setState(id, state, extra = {}) {
        if (!Object.values(DownloadState).includes(state)) {
            log.error(`Estado inválido: ${state}`);
            return false;
        }

        try {
            const result = this.statements.updateState.run({
                id,
                state,
                updatedAt: Date.now()
            });

            if (result.changes > 0) {
                this._logEvent(id, `state_${state}`, extra);
                log.debug(`Estado actualizado: ${id} -> ${state}`);
                return true;
            }

            return false;

        } catch (error) {
            log.error('Error actualizando estado:', error);
            return false;
        }
    }

    /**
     * Actualiza el progreso de una descarga (llamada frecuente, optimizada)
     * @param {number} id - ID de la descarga
     * @param {number} progress - Progreso (0.0 - 1.0)
     * @param {number} downloadedBytes - Bytes descargados
     */
    updateProgress(id, progress, downloadedBytes) {
        try {
            this.statements.updateProgress.run({
                id,
                progress,
                downloadedBytes,
                updatedAt: Date.now()
            });
        } catch (error) {
            // No loguear errores frecuentes de progreso
        }
    }

    /**
     * Obtiene una descarga por ID
     * @param {number} id - ID de la descarga
     * @returns {Object|null} La descarga o null
     */
    getById(id) {
        const row = this.statements.getById.get(id);
        return row ? this._rowToDownload(row) : null;
    }

    /**
     * Verifica si existe una descarga
     * @param {number} id - ID de la descarga
     * @returns {boolean}
     */
    exists(id) {
        return !!this.statements.exists.get(id);
    }

    /**
     * Elimina una descarga
     * @param {number} id - ID de la descarga
     * @returns {boolean} true si se eliminó
     */
    deleteDownload(id) {
        try {
            // Primero eliminar chunks
            this.statements.deleteChunks.run(id);

            // Luego la descarga (el historial se elimina en cascada)
            const result = this.statements.deleteDownload.run(id);

            if (result.changes > 0) {
                log.info(`Descarga eliminada: ${id}`);
                return true;
            }

            return false;

        } catch (error) {
            log.error('Error eliminando descarga:', error);
            return false;
        }
    }

    // =====================
    // QUERIES DE COLA
    // =====================

    /**
     * Obtiene todas las descargas en cola
     * @returns {Array} Lista de descargas ordenadas por prioridad
     */
    getQueued() {
        return this.statements.getQueued.all().map(r => this._rowToDownload(r));
    }

    /**
     * Obtiene las descargas activas (en progreso)
     * @returns {Array} Lista de descargas activas
     */
    getActive() {
        return this.statements.getActive.all().map(r => this._rowToDownload(r));
    }

    /**
     * Obtiene las descargas pausadas
     * @returns {Array} Lista de descargas pausadas
     */
    getPaused() {
        return this.statements.getPaused.all().map(r => this._rowToDownload(r));
    }

    /**
     * Obtiene descargas por estado
     * @param {string} state - Estado a buscar
     * @returns {Array} Lista de descargas
     */
    getByState(state) {
        const stmt = this.db.prepare('SELECT * FROM downloads WHERE state = ?');
        return stmt.all(state).map(r => this._rowToDownload(r));
    }

    /**
     * Obtiene el historial de descargas completadas/fallidas
     * @param {number} limit - Límite de resultados
     * @returns {Array} Lista de descargas
     */
    getHistory(limit = 100) {
        return this.statements.getHistory.all(limit).map(r => this._rowToDownload(r));
    }

    /**
     * Obtiene todas las descargas para la UI
     * @returns {Array} Lista completa ordenada
     */
    getAll() {
        return this.statements.getAll.all().map(r => this._rowToDownload(r));
    }

    /**
     * Obtiene la siguiente descarga en cola para iniciar
     * @returns {Object|null} La siguiente descarga o null
     */
    getNext() {
        const queued = this.getQueued();
        return queued.length > 0 ? queued[0] : null;
    }

    /**
     * Cuenta descargas por estado
     * @returns {Object} Conteos por estado
     */
    getCounts() {
        const rows = this.statements.countByState.all();
        const counts = {
            total: 0,
            queued: 0,
            downloading: 0,
            paused: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            awaiting: 0
        };

        rows.forEach(row => {
            counts[row.state] = row.count;
            counts.total += row.count;
        });

        return counts;
    }

    // =====================
    // OPERACIONES DE COLA
    // =====================

    /**
     * Marca una descarga como iniciada
     * @param {number} id - ID de la descarga
     * @param {Object} [info] - Info adicional (url, totalBytes, etc.)
     * @returns {boolean}
     */
    startDownload(id, info = {}) {
        const now = Date.now();

        try {
            this.statements.updateDownload.run({
                id,
                state: DownloadState.DOWNLOADING,
                progress: info.progress || 0,
                downloadedBytes: info.downloadedBytes || 0,
                totalBytes: info.totalBytes || null,
                savePath: info.savePath || null,
                url: info.url || null,
                startedAt: now,
                completedAt: null,
                retryCount: null,
                lastError: null,
                updatedAt: now
            });

            this._logEvent(id, 'started', info);
            log.info(`Descarga iniciada: ${id}`);

            return true;

        } catch (error) {
            log.error('Error iniciando descarga:', error);
            return false;
        }
    }

    /**
     * Marca una descarga como pausada
     * @param {number} id - ID de la descarga
     * @returns {boolean}
     */
    pauseDownload(id) {
        return this.setState(id, DownloadState.PAUSED);
    }

    /**
     * Reanuda una descarga pausada (vuelve a queued)
     * @param {number} id - ID de la descarga
     * @returns {boolean}
     */
    resumeDownload(id) {
        const download = this.getById(id);
        if (!download) return false;

        if (download.state !== DownloadState.PAUSED) {
            log.warn(`No se puede reanudar descarga en estado ${download.state}`);
            return false;
        }

        return this.setState(id, DownloadState.QUEUED, { resumed: true });
    }

   /**
     * Marca una descarga como completada
     * @param {number} id - ID de la descarga
     * @param {Object} [info] - Info adicional (savePath, etc.)
     * @returns {boolean}
     */
    completeDownload(id, info = {}) {
        const now = Date.now();

        try {
            // Obtener datos actuales para preservar bytes
            const download = this.getById(id);
            
            // IMPORTANTE: El prepared statement requiere TODOS los parámetros
            this.statements.updateDownload.run({
                id,
                state: DownloadState.COMPLETED,
                progress: 1.0,
                downloadedBytes: download?.downloaded_bytes || download?.total_bytes || null,
                totalBytes: download?.total_bytes || null,
                savePath: info.savePath || download?.save_path || null,
                url: null,
                startedAt: null,
                completedAt: now,
                retryCount: null,
                lastError: null,
                updatedAt: now
            });

            this._logEvent(id, 'completed', info);
            log.info(`Descarga completada: ${id}`);

            return true;

        } catch (error) {
            log.error('Error completando descarga:', error);
            return false;
        }
    }

    /**
     * Marca una descarga como fallida
     * @param {number} id - ID de la descarga
     * @param {string} error - Mensaje de error
     * @returns {boolean}
     */
    failDownload(id, error) {
        try {
            const download = this.getById(id);
            if (!download) return false;

            const retryCount = (download.retryCount || 0) + 1;

            // Si no ha excedido reintentos, volver a encolar
            if (retryCount < (download.maxRetries || 3)) {
                this.statements.updateDownload.run({
                    id,
                    state: DownloadState.QUEUED,
                    progress: null,
                    downloadedBytes: null,
                    totalBytes: null,
                    savePath: null,
                    url: null,
                    startedAt: null,
                    completedAt: null,
                    retryCount,
                    lastError: error,
                    updatedAt: Date.now()
                });

                this._logEvent(id, 'retry', { attempt: retryCount, error });
                log.info(`Descarga ${id} reintentará (${retryCount}/${download.maxRetries})`);

                return true;
            }

            // Excedió reintentos, marcar como fallida
                this.statements.updateDownload.run({
                    id,
                    state: DownloadState.FAILED,
                    progress: null,
                    downloadedBytes: null,
                    totalBytes: null,
                    savePath: null,
                    url: null,
                    startedAt: null,
                    completedAt: null,
                    retryCount,
                    lastError: error,
                    updatedAt: Date.now()
                });

            this._logEvent(id, 'failed', { error, attempts: retryCount });
            log.error(`Descarga ${id} falló después de ${retryCount} intentos: ${error}`);

            return true;

        } catch (err) {
            log.error('Error marcando descarga como fallida:', err);
            return false;
        }
    }

    /**
     * Cancela una descarga
     * @param {number} id - ID de la descarga
     * @returns {boolean}
     */
    cancelDownload(id) {
        return this.setState(id, DownloadState.CANCELLED);
    }

    // =====================
    // CHUNKS (FRAGMENTOS)
    // =====================

    /**
     * Crea chunks para una descarga fragmentada
     * @param {number} downloadId - ID de la descarga
     * @param {number} totalBytes - Tamaño total del archivo
     * @param {number} numChunks - Número de fragmentos
     * @returns {Array} Lista de chunks creados
     */
    createChunks(downloadId, totalBytes, numChunks = 4) {
        const chunkSize = Math.ceil(totalBytes / numChunks);
        const now = Date.now();
        const chunks = [];

        // Usar transacción para atomicidad
        const transaction = this.db.transaction(() => {
            for (let i = 0; i < numChunks; i++) {
                const startByte = i * chunkSize;
                const endByte = Math.min(startByte + chunkSize - 1, totalBytes - 1);

                this.statements.insertChunk.run({
                    downloadId,
                    chunkIndex: i,
                    startByte,
                    endByte,
                    downloadedBytes: 0,
                    state: 'pending',
                    tempFile: null,
                    createdAt: now,
                    updatedAt: now
                });

                chunks.push({
                    downloadId,
                    chunkIndex: i,
                    startByte,
                    endByte,
                    downloadedBytes: 0,
                    state: 'pending'
                });
            }
        });

        transaction();
        log.debug(`Creados ${numChunks} chunks para descarga ${downloadId}`);

        return chunks;
    }

    /**
     * Obtiene los chunks de una descarga
     * @param {number} downloadId - ID de la descarga
     * @returns {Array} Lista de chunks
     */
    getChunks(downloadId) {
        return this.statements.getChunks.all(downloadId);
    }

    /**
     * Actualiza un chunk (Block 2 - con soporte para temp_file)
     * @param {number} downloadId - ID de la descarga
     * @param {number} chunkIndex - Índice del chunk
     * @param {Object} updates - Campos a actualizar (downloadedBytes, state, tempFile)
     */
    updateChunk(downloadId, chunkIndex, updates) {
        try {
            this.statements.updateChunk.run({
                downloadId,
                chunkIndex,
                downloadedBytes: updates.downloadedBytes ?? null,
                state: updates.state ?? null,
                tempFile: updates.tempFile ?? null,
                updatedAt: Date.now()
            });
        } catch (error) {
            // Log solo si es un error real
            if (error.message && !error.message.includes('no such')) {
                log.error('Error actualizando chunk:', error.message);
            }
        }
    }

    // =====================
    // LIMPIEZA Y UTILIDADES
    // =====================

    /**
     * Limpia el historial de descargas antiguas
     * @param {number} daysOld - Días de antigüedad
     * @returns {number} Número de registros eliminados
     */
    cleanOldHistory(daysOld = 30) {
        const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
        const result = this.statements.cleanOldHistory.run(cutoff);
        log.info(`Limpiados ${result.changes} registros antiguos`);
        return result.changes;
    }

    /**
     * Limpia todo el historial completado/fallido
     * @returns {number} Número de registros eliminados
     */
    clearHistory() {
        const result = this.statements.clearHistory.run();
        log.info(`Historial limpiado: ${result.changes} registros`);
        return result.changes;
    }

    /**
     * Obtiene estadísticas generales
     * @returns {Object} Estadísticas
     */
    getStats() {
        const counts = this.getCounts();
        const active = this.getActive();

        let totalBytes = 0;
        let downloadedBytes = 0;

        active.forEach(d => {
            totalBytes += d.totalBytes || 0;
            downloadedBytes += d.downloadedBytes || 0;
        });

        return {
            ...counts,
            totalBytesActive: totalBytes,
            downloadedBytesActive: downloadedBytes,
            progressActive: totalBytes > 0 ? downloadedBytes / totalBytes : 0
        };
    }

    /**
     * Cierra la conexión a la base de datos
     */
    close() {
        if (this.db) {
            // Checkpoint WAL antes de cerrar
            this.db.pragma('wal_checkpoint(TRUNCATE)');
            this.db.close();
            this.db = null;
            this.statements = null;
            this.isInitialized = false;
            log.info('QueueDatabase cerrada');
        }
    }

    // =====================
    // MÉTODOS PRIVADOS
    // =====================

    /**
     * Convierte una fila de BD a objeto de descarga
     * @param {Object} row - Fila de la BD
     * @returns {Object} Objeto de descarga normalizado
     */
    _rowToDownload(row) {
        return {
            id: row.id,
            title: row.title,
            url: row.url,
            savePath: row.save_path,
            downloadPath: row.download_path,
            preserveStructure: !!row.preserve_structure,
            state: row.state,
            progress: row.progress,
            downloadedBytes: row.downloaded_bytes,
            totalBytes: row.total_bytes,
            priority: row.priority,
            forceOverwrite: !!row.force_overwrite,
            createdAt: row.created_at,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            updatedAt: row.updated_at,
            retryCount: row.retry_count,
            maxRetries: row.max_retries,
            lastError: row.last_error,
            expectedHash: row.expected_hash,
            actualHash: row.actual_hash,
            queuePosition: row.queue_position
        };
    }

    /**
     * Registra un evento en el historial
     * @param {number} downloadId - ID de la descarga
     * @param {string} eventType - Tipo de evento
     * @param {Object} eventData - Datos adicionales
     */
    _logEvent(downloadId, eventType, eventData = {}) {
        try {
            this.statements.insertHistory.run({
                downloadId,
                eventType,
                eventData: JSON.stringify(eventData),
                createdAt: Date.now()
            });
        } catch (error) {
            // Silenciar errores de historial
        }
    }
}

// =====================
// EXPORTACIONES
// =====================

// Instancia singleton
const queueDatabase = new QueueDatabase();

module.exports = queueDatabase;
module.exports.QueueDatabase = QueueDatabase;
module.exports.DownloadState = DownloadState;
module.exports.DownloadPriority = DownloadPriority;
