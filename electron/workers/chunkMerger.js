/**
 * Worker Thread para Merge de Chunks
 *
 * Este worker procesa la fusión de chunks en un thread separado
 * para no bloquear el event loop del main thread.
 *
 * COMUNICACIÓN:
 * - Main thread envía: { type: 'merge', chunks, savePath, totalBytes, downloadId }
 * - Worker responde: { type: 'progress', progress, currentChunk, totalChunks }
 * - Worker responde: { type: 'complete', savePath, totalBytes }
 * - Worker responde: { type: 'error', error }
 */

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs').promises;
const path = require('path');

// Configuración de merge
const BUFFER_SIZE = 16 * 1024 * 1024; // 16MB buffer
const BATCH_SIZE = 8 * 1024 * 1024; // 8MB por batch
const PROGRESS_INTERVAL = 0.05; // Actualizar progreso cada 5%

/**
 * Formatea bytes a string legible
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Fusiona chunks en el archivo final
 */
async function mergeChunks(chunks, savePath, totalBytes, downloadId) {
  let finalHandle = null;
  let position = 0;
  let totalProcessed = 0;
  const startTime = Date.now();

  try {
    // Abrir archivo final para escritura
    finalHandle = await fs.open(savePath, 'w');

    // Enviar progreso inicial
    parentPort.postMessage({
      type: 'progress',
      progress: 0,
      currentChunk: 0,
      totalChunks: chunks.length,
      bytesProcessed: 0,
      totalBytes,
    });

    // Procesar cada chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkSize = chunk.endByte - chunk.startByte + 1;
      const chunkFile = chunk.tempFile;

      // Verificar que el archivo del chunk existe
      try {
        await fs.access(chunkFile);
      } catch (e) {
        throw new Error(`Chunk ${i} no encontrado: ${chunkFile}`);
      }

      // Abrir chunk para lectura
      const chunkHandle = await fs.open(chunkFile, 'r');
      const buffer = Buffer.allocUnsafe(Math.min(BUFFER_SIZE, chunkSize));

      try {
        let bytesProcessed = 0;
        let lastProgressUpdate = 0;

        // Leer y escribir en batches
        while (bytesProcessed < chunkSize) {
          const toRead = Math.min(Math.min(buffer.length, BATCH_SIZE), chunkSize - bytesProcessed);

          const { bytesRead } = await chunkHandle.read(buffer, 0, toRead, bytesProcessed);

          if (bytesRead === 0) break;

          // Escribir al archivo final
          await finalHandle.write(buffer, 0, bytesRead, position);

          position += bytesRead;
          bytesProcessed += bytesRead;
          totalProcessed += bytesRead;

          // Actualizar progreso periódicamente
          const chunkProgress = bytesProcessed / chunkSize;
          const overallProgress = (i + chunkProgress) / chunks.length;

          if (overallProgress - lastProgressUpdate >= PROGRESS_INTERVAL) {
            lastProgressUpdate = overallProgress;

            parentPort.postMessage({
              type: 'progress',
              progress: overallProgress,
              currentChunk: i + 1,
              totalChunks: chunks.length,
              bytesProcessed: totalProcessed,
              totalBytes,
              chunkProgress,
              speed: totalProcessed / ((Date.now() - startTime) / 1000), // bytes/seg
            });
          }
        }

        // Verificar que se leyó todo el chunk
        if (bytesProcessed < chunkSize) {
          throw new Error(`Chunk ${i} incompleto: ${bytesProcessed}/${chunkSize} bytes`);
        }
      } finally {
        await chunkHandle.close();
      }

      // Eliminar archivo temporal del chunk inmediatamente
      try {
        await fs.unlink(chunkFile);
      } catch (e) {
        // Log pero no fallar si no se puede eliminar
        parentPort.postMessage({
          type: 'warning',
          message: `No se pudo eliminar chunk ${i}: ${e.message}`,
        });
      }

      // Actualizar progreso después de cada chunk completado
      // IMPORTANTE: Calcular progreso exacto basado en bytes procesados para mayor precisión
      const chunkProgress = Math.min(1.0, totalProcessed / totalBytes);
      parentPort.postMessage({
        type: 'progress',
        progress: chunkProgress,
        currentChunk: i + 1,
        totalChunks: chunks.length,
        bytesProcessed: totalProcessed,
        totalBytes,
        speed: totalProcessed / ((Date.now() - startTime) / 1000), // bytes/seg actualizado
      });
    }

    // Cerrar archivo final
    await finalHandle.close();
    finalHandle = null;

    // Verificar tamaño final
    const stats = await fs.stat(savePath);
    if (stats.size !== totalBytes) {
      throw new Error(`Tamaño final incorrecto: ${stats.size}/${totalBytes} bytes`);
    }

    const duration = (Date.now() - startTime) / 1000;
    const speed = totalBytes / duration; // bytes/seg

    // IMPORTANTE: Enviar mensaje de progreso final al 100% exacto antes de 'complete'
    // Esto asegura que el frontend vea el progreso completo antes del cambio de estado
    parentPort.postMessage({
      type: 'progress',
      progress: 1.0, // 100% exacto
      currentChunk: chunks.length,
      totalChunks: chunks.length,
      bytesProcessed: totalBytes,
      totalBytes,
      speed,
    });

    // Pequeño delay para asegurar que el mensaje de progreso al 100% se procese antes de 'complete'
    // Esto evita que el frontend se quede en 99% antes de cambiar a 'completed'
    await new Promise(resolve => setTimeout(resolve, 150));

    // Enviar resultado exitoso
    parentPort.postMessage({
      type: 'complete',
      savePath,
      totalBytes,
      duration,
      speed,
      formatBytes: formatBytes(totalBytes),
      formatSpeed: formatBytes(speed) + '/s',
      totalChunks: chunks.length, // Incluir totalChunks para consistencia
    });
  } catch (error) {
    // Cerrar handle si está abierto
    if (finalHandle) {
      try {
        await finalHandle.close();
      } catch (e) {
        // Ignorar errores al cerrar
      }
    }

    // Enviar error
    parentPort.postMessage({
      type: 'error',
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code,
      },
    });
  }
}

/**
 * Maneja mensajes del main thread
 */
parentPort.on('message', async message => {
  if (message.type === 'merge') {
    const { chunks, savePath, totalBytes, downloadId } = message;

    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      parentPort.postMessage({
        type: 'error',
        error: { message: 'Chunks inválidos o vacíos' },
      });
      return;
    }

    if (!savePath || !totalBytes) {
      parentPort.postMessage({
        type: 'error',
        error: { message: 'savePath o totalBytes no proporcionados' },
      });
      return;
    }

    await mergeChunks(chunks, savePath, totalBytes, downloadId);
  } else if (message.type === 'cancel') {
    // El merge se cancelará cuando el worker termine su operación actual
    // No podemos cancelar operaciones de I/O en progreso fácilmente
    parentPort.postMessage({
      type: 'cancelled',
      message: 'Merge cancelado',
    });
  }
});

/**
 * Maneja errores no capturados
 */
process.on('uncaughtException', error => {
  parentPort.postMessage({
    type: 'error',
    error: {
      message: error.message,
      stack: error.stack,
      code: 'UNCAUGHT_EXCEPTION',
    },
  });
});

process.on('unhandledRejection', reason => {
  parentPort.postMessage({
    type: 'error',
    error: {
      message: reason?.message || String(reason),
      stack: reason?.stack,
      code: 'UNHANDLED_REJECTION',
    },
  });
});
