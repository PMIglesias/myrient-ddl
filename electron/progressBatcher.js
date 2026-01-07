/**
 * ProgressBatcher - Acumulador de actualizaciones de progreso
 */

const { logger } = require('./utils');
const log = logger.child('ProgressBatcher');

class ProgressBatcher {
    /**
     * @param {Object} queueDb - Instancia de queueDatabase
     * @param {number} flushInterval - Intervalo en ms para flush automático (default: 2000)
     */
    constructor(queueDb, flushInterval = 2000) {
        this.queueDb = queueDb;
        this.flushInterval = flushInterval;
        
        // Maps para acumular actualizaciones
        this.chunkUpdates = new Map();      // key: "downloadId-chunkIndex"
        this.progressUpdates = new Map();    // key: downloadId
        
        this.timer = null;
        this.isFlushing = false;
        this.isDestroyed = false;
        
        // Estadísticas
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
     * @param {number} chunkIndex - Índice del chunk
     * @param {Object} data - Datos a actualizar (downloadedBytes, state, etc.)
     */
    queueChunkUpdate(downloadId, chunkIndex, data) {
        if (this.isDestroyed) return;
        
        const key = `${downloadId}-${chunkIndex}`;
        const existing = this.chunkUpdates.get(key);
        
        // Mergear con datos existentes (si los hay)
        this.chunkUpdates.set(key, { 
            downloadId, 
            chunkIndex,
            ...(existing || {}),
            ...data,
            timestamp: Date.now()
        });
        
        this.stats.totalQueued++;
        if (existing) {
            this.stats.savedWrites++; // Contamos una escritura ahorrada
        }
        
        this._scheduleFlush();
    }

    /**
     * Encola una actualización de progreso general de descarga
     * @param {number} downloadId - ID de la descarga
     * @param {number} progress - Progreso (0.0 - 1.0)
     * @param {number} downloadedBytes - Bytes descargados
     */
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

    /**
     * Programa un flush si no hay uno pendiente
     * @private
     */
    _scheduleFlush() {
        if (this.timer || this.isFlushing || this.isDestroyed) return;
        
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(err => {
                log.error('Error en flush programado:', err.message);
            });
        }, this.flushInterval);
    }

    /**
     * Ejecuta el flush de todas las actualizaciones pendientes
     * @returns {Promise<void>}
     */
    async flush() {
        if (this.isFlushing || this.isDestroyed) return;
        if (this.chunkUpdates.size === 0 && this.progressUpdates.size === 0) return;
        
        this.isFlushing = true;
        const startTime = Date.now();
        
        try {
            // Tomar snapshot y limpiar maps
            const chunkUpdates = [...this.chunkUpdates.values()];
            const progressUpdates = [...this.progressUpdates.values()];
            
            this.chunkUpdates.clear();
            this.progressUpdates.clear();
            
            const totalUpdates = chunkUpdates.length + progressUpdates.length;
            
            if (totalUpdates > 0) {
                // Verificar que la BD está disponible
                if (!this.queueDb || !this.queueDb.db) {
                    log.warn('QueueDB no disponible, descartando actualizaciones');
                    return;
                }
                
                // Ejecutar todo en una transacción para atomicidad y rendimiento
                const transaction = this.queueDb.db.transaction(() => {
                    // Actualizar chunks
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
                            // Log pero no fallar toda la transacción
                            log.debug(`Error actualizando chunk ${update.downloadId}-${update.chunkIndex}:`, e.message);
                        }
                    }
                    
                    // Actualizar progreso general
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
                
                // Actualizar estadísticas
                this.stats.totalFlushed += totalUpdates;
                this.stats.flushCount++;
                this.stats.lastFlushTime = Date.now() - startTime;
                
                log.debug(`Flush completado: ${totalUpdates} actualizaciones en ${this.stats.lastFlushTime}ms`);
            }
            
        } catch (error) {
            log.error('Error en flush:', error.message);
            // No re-throw para no interrumpir el flujo
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * Fuerza un flush inmediato (usado al completar/pausar descarga)
     * @returns {Promise<void>}
     */
    async forceFlush() {
        // Cancelar timer pendiente
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        
        // Esperar si hay flush en progreso
        while (this.isFlushing) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        return this.flush();
    }

    /**
     * Fuerza flush solo para una descarga específica
     * @param {number} downloadId - ID de la descarga
     * @returns {Promise<void>}
     */
    async flushDownload(downloadId) {
        if (this.isDestroyed) return;
        
        // Extraer actualizaciones de esta descarga
        const chunkUpdates = [];
        const progressUpdate = this.progressUpdates.get(downloadId);
        
        // Buscar chunks de esta descarga
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
        
        // Flush solo estas actualizaciones
        if (this.queueDb && this.queueDb.db) {
            const transaction = this.queueDb.db.transaction(() => {
                for (const update of chunkUpdates) {
                    try {
                        this.queueDb.updateChunk(update.downloadId, update.chunkIndex, {
                            downloadedBytes: update.downloadedBytes,
                            state: update.state
                        });
                    } catch (e) {}
                }
                
                if (progressUpdate) {
                    try {
                        this.queueDb.updateProgress(
                            progressUpdate.downloadId,
                            progressUpdate.progress,
                            progressUpdate.downloadedBytes
                        );
                    } catch (e) {}
                }
            });
            
            transaction();
        }
    }

    /**
     * Obtiene estadísticas del batcher
     * @returns {Object}
     */
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

    /**
     * Limpia recursos
     */
    destroy() {
        this.isDestroyed = true;
        
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        
        // Flush final sincrónico (best effort)
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
