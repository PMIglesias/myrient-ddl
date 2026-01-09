/**
 * QueueService - Lógica de negocio para gestión de cola de descargas
 * 
 * Encapsula las reglas de negocio relacionadas con:
 * - Ordenamiento de cola
 * - Priorización
 * - Gestión de límites de concurrencia
 * - Selección de siguiente descarga a procesar
 */

const BaseService = require('./BaseService');
const config = require('../config');
const { DownloadPriority } = require('../queueDatabase');

class QueueService extends BaseService {
    constructor() {
        super('QueueService');
        this.maxConcurrent = config.downloads.maxConcurrent || 3;
    }

    /**
     * Ordena la cola de descargas según reglas de negocio
     * @param {Array} queue - Cola de descargas
     * @returns {Array} - Cola ordenada
     */
    sortQueue(queue) {
        try {
            if (!queue || !Array.isArray(queue)) {
                return [];
            }

            // Ordenar por:
            // 1. Prioridad (descendente - mayor número = mayor prioridad)
            // 2. Fecha de creación (ascendente - más antiguas primero)
            return [...queue].sort((a, b) => {
                // Comparar por prioridad primero
                const priorityA = a.priority || DownloadPriority.NORMAL;
                const priorityB = b.priority || DownloadPriority.NORMAL;

                if (priorityA !== priorityB) {
                    return priorityB - priorityA; // Descendente
                }

                // Si tienen la misma prioridad, ordenar por fecha de creación
                const createdA = a.created_at || a.createdAt || 0;
                const createdB = b.created_at || b.createdAt || 0;

                return createdA - createdB; // Ascendente (más antiguas primero)
            });

        } catch (error) {
            this.log.error('Error ordenando cola:', error.message);
            return queue || []; // Retornar cola original en caso de error
        }
    }

    /**
     * Selecciona las descargas que pueden iniciarse según límites de concurrencia
     * @param {Array} queue - Cola de descargas ordenada
     * @param {number} activeCount - Número de descargas activas actuales
     * @returns {Array} - Descargas seleccionadas para iniciar
     */
    selectDownloadsToStart(queue, activeCount) {
        try {
            if (!queue || !Array.isArray(queue) || queue.length === 0) {
                return [];
            }

            // Calcular slots disponibles
            const slotsAvailable = Math.max(0, this.maxConcurrent - activeCount);

            if (slotsAvailable <= 0) {
                return []; // No hay slots disponibles
            }

            // Seleccionar las primeras N descargas de la cola ordenada
            const queueSorted = this.sortQueue(queue);
            const selected = queueSorted.slice(0, slotsAvailable);

            return selected;

        } catch (error) {
            this.log.error('Error seleccionando descargas:', error.message);
            return [];
        }
    }

    /**
     * Calcula la posición en cola para una nueva descarga
     * @param {Object} downloadParams - Parámetros de descarga
     * @param {Array} queue - Cola actual
     * @returns {number} - Posición en cola (0-based)
     */
    calculateQueuePosition(downloadParams, queue) {
        try {
            if (!queue || !Array.isArray(queue)) {
                return 0;
            }

            // Insertar en la posición correcta según prioridad
            const queueSorted = this.sortQueue(queue);
            const priority = downloadParams.priority || DownloadPriority.NORMAL;
            const createdAt = Date.now();

            // Encontrar la posición de inserción
            let position = queueSorted.length;

            for (let i = 0; i < queueSorted.length; i++) {
                const item = queueSorted[i];
                const itemPriority = item.priority || DownloadPriority.NORMAL;

                // Si la nueva descarga tiene mayor prioridad, insertar aquí
                if (priority > itemPriority) {
                    position = i;
                    break;
                }

                // Si tienen la misma prioridad, comparar por fecha
                if (priority === itemPriority) {
                    const itemCreated = item.created_at || item.createdAt || 0;
                    if (createdAt < itemCreated) {
                        position = i;
                        break;
                    }
                }
            }

            return position;

        } catch (error) {
            this.log.error('Error calculando posición en cola:', error.message);
            return queue?.length || 0; // Insertar al final en caso de error
        }
    }

    /**
     * Verifica si hay slots disponibles para nuevas descargas
     * @param {number} activeCount - Número de descargas activas
     * @param {number} queuedCount - Número de descargas en cola
     * @returns {Object} - Información sobre disponibilidad
     */
    checkAvailability(activeCount = 0, queuedCount = 0) {
        try {
            const slotsAvailable = Math.max(0, this.maxConcurrent - activeCount);
            const canStart = slotsAvailable > 0;
            const shouldQueue = !canStart && queuedCount < config.downloads.maxQueueSize;

            return {
                canStart,
                shouldQueue,
                slotsAvailable,
                activeCount,
                queuedCount,
                maxConcurrent: this.maxConcurrent,
                maxQueueSize: config.downloads.maxQueueSize || 1000
            };

        } catch (error) {
            this.log.error('Error verificando disponibilidad:', error.message);
            return {
                canStart: false,
                shouldQueue: false,
                slotsAvailable: 0,
                activeCount: 0,
                queuedCount: 0,
                maxConcurrent: this.maxConcurrent,
                maxQueueSize: 1000
            };
        }
    }

    /**
     * Calcula estadísticas de la cola
     * @param {Array} queue - Cola de descargas
     * @param {number} activeCount - Número de descargas activas
     * @returns {Object} - Estadísticas de la cola
     */
    calculateQueueStats(queue, activeCount) {
        try {
            const queuedCount = queue?.length || 0;
            const availability = this.checkAvailability(activeCount, queuedCount);

            // Agrupar por prioridad
            const byPriority = {
                [DownloadPriority.LOW]: 0,
                [DownloadPriority.NORMAL]: 0,
                [DownloadPriority.HIGH]: 0,
                [DownloadPriority.URGENT]: 0
            };

            if (queue && Array.isArray(queue)) {
                queue.forEach(item => {
                    const priority = item.priority || DownloadPriority.NORMAL;
                    byPriority[priority] = (byPriority[priority] || 0) + 1;
                });
            }

            return {
                total: queuedCount,
                active: activeCount,
                slotsAvailable: availability.slotsAvailable,
                maxConcurrent: this.maxConcurrent,
                byPriority,
                canStart: availability.canStart,
                shouldQueue: availability.shouldQueue
            };

        } catch (error) {
            this.log.error('Error calculando estadísticas de cola:', error.message);
            return {
                total: 0,
                active: 0,
                slotsAvailable: 0,
                maxConcurrent: this.maxConcurrent,
                byPriority: {},
                canStart: false,
                shouldQueue: false
            };
        }
    }

    /**
     * Prioriza una descarga en la cola
     * @param {string|number} downloadId - ID de la descarga
     * @param {Array} queue - Cola actual
     * @param {number} newPriority - Nueva prioridad
     * @returns {Object} - Resultado de la operación
     */
    prioritizeDownload(downloadId, queue, newPriority) {
        try {
            if (!queue || !Array.isArray(queue)) {
                return {
                    success: false,
                    error: 'Cola inválida'
                };
            }

            // Validar prioridad
            const validPriorities = [
                DownloadPriority.LOW,
                DownloadPriority.NORMAL,
                DownloadPriority.HIGH,
                DownloadPriority.URGENT
            ];

            if (!validPriorities.includes(newPriority)) {
                return {
                    success: false,
                    error: 'Prioridad inválida'
                };
            }

            // Encontrar y actualizar descarga
            const index = queue.findIndex(item => 
                item.id === downloadId || item.download_id === downloadId
            );

            if (index === -1) {
                return {
                    success: false,
                    error: 'Descarga no encontrada en cola'
                };
            }

            // Actualizar prioridad
            queue[index].priority = newPriority;
            queue[index].updated_at = Date.now();

            // Reordenar cola
            const reorderedQueue = this.sortQueue(queue);

            return {
                success: true,
                queue: reorderedQueue,
                newPosition: reorderedQueue.findIndex(item => 
                    item.id === downloadId || item.download_id === downloadId
                )
            };

        } catch (error) {
            return this.handleError(error, 'prioritizeDownload');
        }
    }

    /**
     * Reordena una descarga en la cola
     * @param {string|number} downloadId - ID de la descarga
     * @param {Array} queue - Cola actual
     * @param {number} newPosition - Nueva posición (0-based)
     * @returns {Object} - Resultado de la operación
     */
    reorderDownload(downloadId, queue, newPosition) {
        try {
            if (!queue || !Array.isArray(queue)) {
                return {
                    success: false,
                    error: 'Cola inválida'
                };
            }

            // Validar posición
            if (newPosition < 0 || newPosition >= queue.length) {
                return {
                    success: false,
                    error: 'Posición inválida'
                };
            }

            // Encontrar descarga
            const index = queue.findIndex(item => 
                item.id === downloadId || item.download_id === downloadId
            );

            if (index === -1) {
                return {
                    success: false,
                    error: 'Descarga no encontrada en cola'
                };
            }

            // Mover a nueva posición (usando lógica de array)
            const item = queue.splice(index, 1)[0];
            queue.splice(newPosition, 0, item);

            // Actualizar timestamps
            item.updated_at = Date.now();

            return {
                success: true,
                queue: this.sortQueue(queue),
                newPosition
            };

        } catch (error) {
            return this.handleError(error, 'reorderDownload');
        }
    }

    /**
     * Calcula la velocidad promedio de descarga en bytes/segundo
     * @param {Array} activeDownloads - Array de descargas activas con información de velocidad
     * @returns {number} - Velocidad promedio en bytes/segundo, o 0 si no hay descargas
     */
    calculateAverageSpeed(activeDownloads = []) {
        try {
            if (!activeDownloads || activeDownloads.length === 0) {
                return 0;
            }

            // Filtrar descargas con velocidad válida (> 0)
            const downloadsWithSpeed = activeDownloads.filter(d => {
                const speed = d.speed || d.speedBytesPerSec || 0;
                return speed > 0;
            });

            if (downloadsWithSpeed.length === 0) {
                return 0;
            }

            // Calcular velocidad total (suma de todas las velocidades)
            // Esto representa el ancho de banda total disponible
            const totalSpeedBytesPerSec = downloadsWithSpeed.reduce((sum, d) => {
                // Convertir a bytes/segundo si está en MB/s
                let speedBytesPerSec = d.speedBytesPerSec || 0;
                if (d.speed && !d.speedBytesPerSec) {
                    // Asumir que está en MB/s si no hay speedBytesPerSec
                    speedBytesPerSec = (d.speed * 1024 * 1024);
                }
                return sum + speedBytesPerSec;
            }, 0);

            // Velocidad promedio = velocidad total / número de descargas
            // Pero para estimaciones de cola, usamos la velocidad total
            // ya que las descargas se ejecutan en paralelo
            return totalSpeedBytesPerSec;

        } catch (error) {
            this.log.error('Error calculando velocidad promedio:', error.message);
            return 0;
        }
    }

    /**
     * Estima el tiempo hasta que una descarga específica comience
     * @param {string|number} downloadId - ID de la descarga
     * @param {Array} queue - Cola de descargas ordenada
     * @param {number} activeCount - Número de descargas activas
     * @param {number} averageSpeedBytesPerSec - Velocidad promedio en bytes/segundo
     * @returns {Object} - Estimación de tiempo
     */
    estimateTimeUntilStart(downloadId, queue, activeCount, averageSpeedBytesPerSec = 0) {
        try {
            if (!queue || !Array.isArray(queue) || queue.length === 0) {
                return {
                    estimatedSeconds: 0,
                    estimatedMinutes: 0,
                    estimatedHours: 0,
                    positionInQueue: 0,
                    canStartImmediately: true
                };
            }

            // Ordenar cola para obtener posición correcta
            const sortedQueue = this.sortQueue(queue);
            
            // Encontrar posición en la cola
            const position = sortedQueue.findIndex(item => 
                item.id === downloadId || item.download_id === downloadId
            );

            if (position === -1) {
                return {
                    estimatedSeconds: 0,
                    estimatedMinutes: 0,
                    estimatedHours: 0,
                    positionInQueue: 0,
                    canStartImmediately: false,
                    notFound: true
                };
            }

            // Calcular cuántas descargas deben completarse antes de esta
            // Considerando slots disponibles y descargas activas
            const slotsAvailable = Math.max(0, this.maxConcurrent - activeCount);
            
            // Si hay slots disponibles y está entre las primeras descargas, puede empezar de inmediato
            const canStartImmediately = slotsAvailable > 0 && position < slotsAvailable;
            
            if (canStartImmediately) {
                return {
                    estimatedSeconds: 0,
                    estimatedMinutes: 0,
                    estimatedHours: 0,
                    positionInQueue: position + 1,
                    canStartImmediately: true
                };
            }

            // Calcular cuántas descargas deben completarse antes
            // Las descargas se procesan en batch según slots disponibles
            const downloadsBefore = position;
            const batchesToWait = Math.ceil(downloadsBefore / Math.max(1, this.maxConcurrent));

            // Si no hay velocidad promedio, no podemos estimar tiempo
            if (averageSpeedBytesPerSec <= 0) {
                return {
                    estimatedSeconds: null, // No se puede estimar
                    estimatedMinutes: null,
                    estimatedHours: null,
                    positionInQueue: position + 1,
                    canStartImmediately: false,
                    requiresSpeed: true,
                    batchesToWait
                };
            }

            // Estimar tiempo basado en descargas anteriores
            // Asumimos que cada descarga promedio toma cierto tiempo
            // Para simplificar, usamos el tamaño promedio de las descargas anteriores
            const previousDownloads = sortedQueue.slice(0, position);
            let totalBytesToDownload = 0;
            let validDownloads = 0;

            previousDownloads.forEach(d => {
                const totalBytes = d.totalBytes || d.total_bytes || 0;
                if (totalBytes > 0) {
                    totalBytesToDownload += totalBytes;
                    validDownloads++;
                }
            });

            // Si no hay información de tamaño, usar estimación conservadora
            if (totalBytesToDownload === 0) {
                // Asumir 100MB promedio por descarga si no hay información
                const avgFileSize = 100 * 1024 * 1024; // 100 MB
                totalBytesToDownload = validDownloads > 0 ? validDownloads * avgFileSize : downloadsBefore * avgFileSize;
            }

            // Calcular tiempo estimado en segundos
            // Dividir entre maxConcurrent porque las descargas son paralelas
            const estimatedSeconds = totalBytesToDownload / (averageSpeedBytesPerSec * Math.max(1, this.maxConcurrent));

            return {
                estimatedSeconds: Math.max(0, estimatedSeconds),
                estimatedMinutes: Math.max(0, estimatedSeconds / 60),
                estimatedHours: Math.max(0, estimatedSeconds / 3600),
                positionInQueue: position + 1,
                canStartImmediately: false,
                totalBytesToDownload,
                batchesToWait
            };

        } catch (error) {
            this.log.error('Error estimando tiempo hasta inicio:', error.message);
            return {
                estimatedSeconds: null,
                estimatedMinutes: null,
                estimatedHours: null,
                positionInQueue: 0,
                canStartImmediately: false,
                error: error.message
            };
        }
    }

    /**
     * Estima el tiempo total para procesar toda la cola
     * @param {Array} queue - Cola de descargas ordenada
     * @param {number} activeCount - Número de descargas activas
     * @param {number} averageSpeedBytesPerSec - Velocidad promedio en bytes/segundo
     * @returns {Object} - Estimación de tiempo total
     */
    estimateQueueTime(queue, activeCount, averageSpeedBytesPerSec = 0) {
        try {
            if (!queue || !Array.isArray(queue) || queue.length === 0) {
                return {
                    totalEstimatedSeconds: 0,
                    totalEstimatedMinutes: 0,
                    totalEstimatedHours: 0,
                    totalDownloads: 0,
                    totalBytes: 0,
                    canStartImmediately: true
                };
            }

            // Ordenar cola
            const sortedQueue = this.sortQueue(queue);
            const slotsAvailable = Math.max(0, this.maxConcurrent - activeCount);

            // Calcular total de bytes en cola
            let totalBytes = 0;
            let downloadsWithSize = 0;

            sortedQueue.forEach(d => {
                const bytes = d.totalBytes || d.total_bytes || 0;
                if (bytes > 0) {
                    totalBytes += bytes;
                    downloadsWithSize++;
                }
            });

            // Si no hay velocidad promedio, no podemos estimar
            if (averageSpeedBytesPerSec <= 0) {
                return {
                    totalEstimatedSeconds: null,
                    totalEstimatedMinutes: null,
                    totalEstimatedHours: null,
                    totalDownloads: sortedQueue.length,
                    totalBytes,
                    downloadsWithSize,
                    canStartImmediately: slotsAvailable > 0,
                    requiresSpeed: true,
                    slotsAvailable
                };
            }

            // Calcular tiempo estimado
            // Dividir entre maxConcurrent porque las descargas son paralelas
            // Pero considerar que cuando una descarga termina, otra puede comenzar
            const effectiveSpeed = averageSpeedBytesPerSec * this.maxConcurrent;
            const totalEstimatedSeconds = totalBytes / effectiveSpeed;

            // Si hay descargas sin tamaño conocido, agregar tiempo estimado conservador
            const downloadsWithoutSize = sortedQueue.length - downloadsWithSize;
            if (downloadsWithoutSize > 0) {
                // Asumir 100MB promedio por descarga sin tamaño
                const avgFileSize = 100 * 1024 * 1024; // 100 MB
                const additionalBytes = downloadsWithoutSize * avgFileSize;
                const additionalSeconds = additionalBytes / effectiveSpeed;
                const finalEstimatedSeconds = totalEstimatedSeconds + additionalSeconds;

                return {
                    totalEstimatedSeconds: Math.max(0, finalEstimatedSeconds),
                    totalEstimatedMinutes: Math.max(0, finalEstimatedSeconds / 60),
                    totalEstimatedHours: Math.max(0, finalEstimatedSeconds / 3600),
                    totalDownloads: sortedQueue.length,
                    totalBytes: totalBytes + additionalBytes,
                    downloadsWithSize,
                    downloadsWithoutSize,
                    canStartImmediately: slotsAvailable > 0,
                    slotsAvailable,
                    effectiveSpeed
                };
            }

            return {
                totalEstimatedSeconds: Math.max(0, totalEstimatedSeconds),
                totalEstimatedMinutes: Math.max(0, totalEstimatedSeconds / 60),
                totalEstimatedHours: Math.max(0, totalEstimatedSeconds / 3600),
                totalDownloads: sortedQueue.length,
                totalBytes,
                downloadsWithSize,
                downloadsWithoutSize: 0,
                canStartImmediately: slotsAvailable > 0,
                slotsAvailable,
                effectiveSpeed
            };

        } catch (error) {
            this.log.error('Error estimando tiempo de cola:', error.message);
            return {
                totalEstimatedSeconds: null,
                totalEstimatedMinutes: null,
                totalEstimatedHours: null,
                totalDownloads: queue?.length || 0,
                totalBytes: 0,
                error: error.message
            };
        }
    }
}

module.exports = QueueService;
