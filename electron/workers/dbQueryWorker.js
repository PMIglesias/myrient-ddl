/**
 * @fileoverview Worker Thread para ejecutar queries SQL pesadas
 * @module dbQueryWorker
 *
 * Ejecuta queries SQL pesadas en un worker thread separado para no bloquear
 * el main thread de Electron. Soporta búsquedas FTS, actualizaciones masivas,
 * y otras operaciones que pueden ser lentas.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Múltiples conexiones de base de datos (una por tipo)
const databases = {
  queue: null, // Base de datos de cola
  catalog: null, // Base de datos de catálogo Myrient
};

const statements = {
  queue: null,
  catalog: null,
};

/**
 * Inicializa la conexión a una base de datos en el worker
 */
function initializeDatabase(dbPath, dbType = 'queue') {
  // Validar tipo de base de datos
  if (dbType !== 'queue' && dbType !== 'catalog') {
    return { success: false, error: `Tipo de base de datos inválido: ${dbType}` };
  }

  // Si ya está inicializada, retornar éxito
  if (databases[dbType]) {
    return { success: true };
  }

  try {
    // Verificar que el archivo existe
    if (!fs.existsSync(dbPath)) {
      return { success: false, error: `Base de datos no encontrada: ${dbPath}` };
    }

    // Abrir base de datos
    // La base de datos de catálogo es solo lectura, la de cola es lectura/escritura
    const db = new Database(dbPath, dbType === 'catalog' ? { readonly: true } : {});

    // Configurar para mejor rendimiento
    if (dbType === 'queue') {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = -64000'); // 64MB
      db.pragma('temp_store = MEMORY');
      db.pragma('foreign_keys = ON');
    } else {
      // Catálogo: solo lectura, optimizaciones mínimas
      db.pragma('cache_size = -64000'); // 64MB
    }

    databases[dbType] = db;

    // Preparar statements según el tipo
    if (dbType === 'queue') {
      statements.queue = {
        updateProgressBatch: db.prepare(`
          UPDATE downloads SET
            progress = @progress,
            downloaded_bytes = @downloadedBytes,
            updated_at = @updatedAt
          WHERE id = @id
        `),
      };
    } else {
      // Catálogo: statements para FTS se prepararán dinámicamente
      statements.catalog = {
        searchFTS: null,
        getAllFilesRecursive: db.prepare(`
          WITH RECURSIVE folder_tree AS (
              SELECT id, parent_id, title, type, url, size, modified_date
              FROM nodes 
              WHERE id = ?
              UNION ALL
              SELECT n.id, n.parent_id, n.title, n.type, n.url, n.size, n.modified_date
              FROM nodes n
              INNER JOIN folder_tree ft ON n.parent_id = ft.id
          )
          SELECT id, title, url, size, modified_date
          FROM folder_tree
          WHERE type = 'File'
          ORDER BY title ASC
        `),
      };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Ejecuta batch de actualizaciones de progreso
 */
function batchUpdateProgress(updates) {
  if (!databases.queue || !statements.queue) {
    return { success: false, error: 'Base de datos de cola no inicializada' };
  }

  try {
    const db = databases.queue;
    const transaction = db.transaction((updates) => {
      const stmt = statements.queue.updateProgressBatch;
      const now = Date.now();

      for (const update of updates) {
        stmt.run({
          id: update.id,
          progress: update.progress,
          downloadedBytes: update.downloadedBytes,
          updatedAt: now,
        });
      }
    });

    transaction(updates);

    return {
      success: true,
      updated: updates.length,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Ejecuta búsqueda FTS en el worker
 */
function executeSearchFTS(searchTerm, options, ftsTable, ftsType) {
  if (!databases.catalog || !statements.catalog) {
    return { success: false, error: 'Base de datos de catálogo no inicializada' };
  }

  try {
    const db = databases.catalog;
    
    // Validar nombre de tabla FTS (prevenir SQL injection)
    if (!/^[a-zA-Z0-9_]+$/.test(ftsTable)) {
      return { success: false, error: 'Nombre de tabla FTS inválido' };
    }

    // Preparar statement FTS si no existe o cambió la tabla
    if (!statements.catalog.searchFTS || statements.catalog.currentFtsTable !== ftsTable) {
      if (ftsType === 'fts5') {
        statements.catalog.searchFTS = db.prepare(`
          SELECT n.id, n.title, n.modified_date, n.type, n.parent_id, n.size,
                 bm25(${ftsTable}) AS relevance
          FROM ${ftsTable} fts
          INNER JOIN nodes n ON n.id = fts.rowid
          WHERE ${ftsTable} MATCH ?
          ORDER BY relevance ASC, n.title ASC
          LIMIT ? OFFSET ?
        `);
      } else {
        statements.catalog.searchFTS = db.prepare(`
          SELECT n.id, n.title, n.modified_date, n.type, n.parent_id, n.size,
                 0 AS relevance
          FROM ${ftsTable} fts
          INNER JOIN nodes n ON n.id = fts.rowid
          WHERE ${ftsTable} MATCH ?
          ORDER BY n.title ASC
          LIMIT ? OFFSET ?
        `);
      }
      statements.catalog.currentFtsTable = ftsTable;
    }

    const { limit = 500, offset = 0 } = options;
    const results = statements.catalog.searchFTS.all(searchTerm, limit, offset);

    return {
      success: true,
      data: results,
      total: results.length,
      limit,
      offset,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Obtiene todos los archivos de una carpeta recursivamente en el worker
 */
function getAllFilesInFolder(folderId) {
  if (!databases.catalog || !statements.catalog || !statements.catalog.getAllFilesRecursive) {
    return { success: false, error: 'Base de datos de catálogo no inicializada' };
  }

  try {
    const results = statements.catalog.getAllFilesRecursive.all(folderId);
    return {
      success: true,
      data: results.map(file => ({
        id: file.id,
        title: file.title.replace(/\/$/, ''),
        url: file.url,
        size: file.size,
        modified_date: file.modified_date,
      })),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Maneja mensajes del main thread
 */
parentPort.on('message', async (message) => {
  try {
    let result;

    switch (message.type) {
      case 'init':
        result = initializeDatabase(message.dbPath, message.dbType || 'queue');
        break;

      case 'batchUpdateProgress':
        result = batchUpdateProgress(message.updates);
        break;

      case 'searchFTS':
        result = executeSearchFTS(
          message.searchTerm,
          message.options,
          message.ftsTable,
          message.ftsType
        );
        break;

      case 'getAllFilesInFolder':
        result = getAllFilesInFolder(message.folderId);
        break;

      case 'ping':
        result = { success: true, message: 'pong' };
        break;

      default:
        result = { success: false, error: `Tipo de query desconocido: ${message.type}` };
    }

    // Enviar resultado al main thread
    parentPort.postMessage({
      id: message.id,
      success: result.success !== false,
      data: result.data,
      error: result.error,
      ...result,
    });
  } catch (error) {
    // Enviar error al main thread
    parentPort.postMessage({
      id: message.id,
      success: false,
      error: error.message,
      stack: error.stack,
    });
  }
});

/**
 * Maneja errores no capturados
 */
process.on('uncaughtException', (error) => {
  parentPort.postMessage({
    type: 'error',
    error: error.message,
    stack: error.stack,
  });
});

process.on('unhandledRejection', (reason) => {
  parentPort.postMessage({
    type: 'error',
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
