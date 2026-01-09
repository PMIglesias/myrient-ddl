// Acumulador de actualizaciones de progreso para escrituras batch a la base de datos
// Reduce el número de escrituras agrupando múltiples actualizaciones en transacciones
// Mejora el rendimiento al evitar escribir cada actualización individualmente

const { logger } = require('./utils');
const log = logger.child('ProgressBatcher');

class ProgressBatcher {
    // Inicializa el batcher con la base de datos de cola y un intervalo de flush
    // queueDb: Instancia de queueDatabase donde se escribirán las actualizaciones
    // flushInterval: Intervalo en milisegundos entre cada flush automático (default: 2000ms)
    constructor(queueDb, flushInterval = 2000) {
        this.queueDb = queueDb;
        this.flushInterval = flushInterval;
        
        // Maps para acumular actualizaciones antes de escribirlas en batch
        // chunkUpdates: key es "downloadId-chunkIndex", value es objeto con datos del chunk
        this.chunkUpdates = new Map();
        // progressUpdates: key es downloadId, value es objeto con progreso general
        this.progressUpdates = new Map();
        
        this.timer = null;
        this.isFlushing = false;
        this.isDestroyed = false;
        
        // Estadísticas de rendimiento y eficiencia del batching
        this.stats = {
            totalQueued: 0,
            totalFlushed: 0,
            flushCount: 0,
            lastFlushTime: 0,
            savedWrites: 0
        };
        
        log.info(`ProgressBatcher inicializado (flushInterval: ${flushInterval}ms)`);
    }

    /**
     * Encola una actualización de chunk
     * @param {number} downloadId - ID de la descarga
     * @param {number} chunkIndex - Índice del chunk
     * @param {Object} data - Datos a actualizar (downloadedBytes, state, etc.)
     */
    queueChunkUpdate(downloadId, chunkIndex, data) {
        if (this.isDestroyed) return;
        
        const key = `${downloadId}-${chunkIndex}`;
        const existing = this.chunkUpdates.get(key);
        
        // Mergear con datos existentes para acumular todas las actualizaciones pendientes
        // Esto evita escribir múltiples veces el mismo chunk si hay actualizaciones rápidas
        this.chunkUpdates.set(key, { 
            downloadId, 
            chunkIndex,
            ...(existing || {}),
            ...data,
            timestamp: Date.now()
        });
        
        this.stats.totalQueued++;
        if (existing) {
            // Si había una actualización previa, se ahorró una escritura a la BD
            this.stats.savedWrites++;
        }
        
        this._scheduleFlush();
    }

    // Agrega una actualización de progreso general de una descarga a la cola
    // Si ya existe una actualización pendiente para la misma descarga, se sobrescribe
    // downloadId: ID numérico de la descarga
    // progress: Progreso como valor decimal entre 0.0 y 1.0
    // downloadedBytes: Cantidad total de bytes descargados hasta el momento
    queueProgressUpdate(downloadId, progress, downloadedBytes) {
        if (this.isDestroyed) return;
        
        const existing = this.progressUpdates.has(downloadId);
        
        this.progressUpdates.set(downloadId, {
            downloadId,
            progress,
            downloadedBytes,
            timestamp: Date.now()
        });
        
        this.stats.totalQueued++;
        if (existing) {
            this.stats.savedWrites++;
        }
        
        this._scheduleFlush();
    }

    // Programa un flush automático si no hay uno ya programado o en ejecución
    // Evita múltiples timers concurrentes y flush simultáneos
    _scheduleFlush() {
        if (this.timer || this.isFlushing || this.isDestroyed) return;
        
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(err => {
                log.error('Error en flush programado:', err.message);
            });
        }, this.flushInterval);
    }

    // Escribe todas las actualizaciones acumuladas en la base de datos usando una transacción
    // Agrupa todas las escrituras en una sola transacción para mejor rendimiento y atomicidad
    // Retorna Promise<void> que se resuelve cuando todas las escrituras se completan
    async flush() {
        if (this.isFlushing || this.isDestroyed) return;
        if (this.chunkUpdates.size === 0 && this.progressUpdates.size === 0) return;
        
        this.isFlushing = true;
        const startTime = Date.now();
        
        try {
            // Crear snapshot de las actualizaciones y limpiar los maps inmediatamente
            // Esto permite que nuevas actualizaciones se acumulen mientras se procesa el batch actual
            const chunkUpdates = [...this.chunkUpdates.values()];
            const progressUpdates = [...this.progressUpdates.values()];
            
            this.chunkUpdates.clear();
            this.progressUpdates.clear();
            
            const totalUpdates = chunkUpdates.length + progressUpdates.length;
            
            if (totalUpdates > 0) {
                // Verificar que la base de datos está disponible antes de intentar escribir
                if (!this.queueDb || !this.queueDb.db) {
                    log.warn('QueueDB no disponible, descartando actualizaciones');
                    return;
                }
                
                // Ejecutar todas las actualizaciones en una transacción única
                // Esto garantiza atomicidad y mejor rendimiento que múltiples escrituras individuales
                const transaction = this.queueDb.db.transaction(() => {
                    // Actualizar el estado y progreso de cada chunk en la base de datos
                    for (const update of chunkUpdates) {
                        try {
                            this.queueDb.updateChunk(
                                update.downloadId, 
                                update.chunkIndex, 
                                {
                                    downloadedBytes: update.downloadedBytes,
                                    state: update.state,
                                    tempFile: update.tempFile
                                }
                            );
                        } catch (e) {
                            // Loggear errores pero no fallar toda la transacción por un chunk individual
                            log.debug(`Error actualizando chunk ${update.downloadId}-${update.chunkIndex}:`, e.message);
                        }
                    }
                    
                    // Actualizar el progreso general de cada descarga
                    for (const update of progressUpdates) {
                        try {
                            this.queueDb.updateProgress(
                                update.downloadId,
                                update.progress,
                                update.downloadedBytes
                            );
                        } catch (e) {
                            log.debug(`Error actualizando progreso ${update.downloadId}:`, e.message);
                        }
                    }
                });
                
                transaction();
                
                // Actualizar estadísticas de rendimiento
                this.stats.totalFlushed += totalUpdates;
                this.stats.flushCount++;
                this.stats.lastFlushTime = Date.now() - startTime;
                
                log.debug(`Flush completado: ${totalUpdates} actualizaciones en ${this.stats.lastFlushTime}ms`);
            }
            
        } catch (error) {
            log.error('Error en flush:', error.message);
            // No relanzar el error para no interrumpir el flujo de la aplicación
        } finally {
            this.isFlushing = false;
        }
    }

    // Fuerza un flush inmediato cancelando cualquier timer pendiente
    // Útil cuando se necesita garantizar que las actualizaciones se guarden antes de continuar
    // Espera a que cualquier flush en progreso termine antes de ejecutar uno nuevo
    // Retorna Promise<void> que se resuelve cuando el flush se completa
    async forceFlush() {
        // Cancelar timer pendiente para ejecutar flush inmediatamente
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        
        // Esperar a que termine cualquier flush en progreso para evitar condiciones de carrera
        while (this.isFlushing) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        return this.flush();
    }

    // Fuerza flush solo para las actualizaciones de una descarga específica
    // Extrae las actualizaciones de la descarga, las elimina de los maps, y las escribe inmediatamente
    // Útil al completar o pausar una descarga para asegurar estado consistente
    // downloadId: ID numérico de la descarga a flushar
    // Retorna Promise<void> que se resuelve cuando el flush se completa
    async flushDownload(downloadId) {
        if (this.isDestroyed) return;
        
        // Extraer actualizaciones pendientes solo para esta descarga
        const chunkUpdates = [];
        const progressUpdate = this.progressUpdates.get(downloadId);
        
        // Buscar y extraer todos los chunks de esta descarga de los maps
        for (const [key, update] of this.chunkUpdates) {
            if (update.downloadId === downloadId) {
                chunkUpdates.push(update);
                this.chunkUpdates.delete(key);
            }
        }
        
        if (progressUpdate) {
            this.progressUpdates.delete(downloadId);
        }
        
        if (chunkUpdates.length === 0 && !progressUpdate) return;
        
        // Escribir solo las actualizaciones de esta descarga en una transacción
        if (this.queueDb && this.queueDb.db) {
            const transaction = this.queueDb.db.transaction(() => {
                for (const update of chunkUpdates) {
                    try {
                        this.queueDb.updateChunk(update.downloadId, update.chunkIndex, {
                            downloadedBytes: update.downloadedBytes,
                            state: update.state
                        });
                    } catch (e) {
                        log.warn(`Error guardando chunk ${update.downloadId}-${update.chunkIndex}:`, e.message);
                    }
                }
                
                if (progressUpdate) {
                    try {
                        this.queueDb.updateProgress(
                            progressUpdate.downloadId,
                            progressUpdate.progress,
                            progressUpdate.downloadedBytes
                        );
                    } catch (e) {
                        log.warn(`Error guardando progreso ${progressUpdate.downloadId}:`, e.message);
                    }
                }
            });
            
            transaction();
        }
    }

    // Retorna estadísticas de rendimiento del batcher incluyendo eficiencia de batching
    // La eficiencia muestra el porcentaje de escrituras ahorradas gracias al batching
    // Retorna objeto con estadísticas actuales
    getStats() {
        return {
            ...this.stats,
            pendingChunkUpdates: this.chunkUpdates.size,
            pendingProgressUpdates: this.progressUpdates.size,
            efficiency: this.stats.totalQueued > 0 
                ? ((this.stats.savedWrites / this.stats.totalQueued) * 100).toFixed(1) + '%'
                : '0%'
        };
    }

    // Limpia todos los recursos y cancela timers pendientes
    // Intenta hacer un flush final de actualizaciones pendientes antes de destruir
    // Debe llamarse cuando la instancia ya no se necesite para evitar memory leaks
    destroy() {
        this.isDestroyed = true;
        
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        
        // Intentar hacer un flush final de actualizaciones pendientes (mejor esfuerzo)
        // Si falla, solo se loggea un warning ya que la aplicación está cerrándose
        if (this.chunkUpdates.size > 0 || this.progressUpdates.size > 0) {
            try {
                this.flush();
            } catch (e) {
                log.warn('Error en flush final:', e.message);
            }
        }
        
        log.info('ProgressBatcher destruido. Stats:', this.getStats());
        
        this.chunkUpdates.clear();
        this.progressUpdates.clear();
        this.queueDb = null;
    }
}

module.exports = ProgressBatcher;
