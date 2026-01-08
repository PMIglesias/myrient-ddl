/**
 * useDownloadQueue - Gestión de cola de descargas
 * 
 * Maneja el procesamiento de la cola con mutex para evitar race conditions
 */

import { downloads, downloadQueue, startingDownloads, queueMutex, timeoutManager } from './useDownloadState';
import * as api from '../../services/api';

/**
 * Composable de cola de descargas
 * @param {Object} settings - Configuración desde useSettings
 */
export function useDownloadQueue(settings = null) {
    // Si no se pasan settings, usar valores por defecto (para compatibilidad)
    const downloadPath = settings?.downloadPath || { value: '' };
    const preserveStructure = settings?.preserveStructure || { value: true };
    const maxParallelDownloads = settings?.maxParallelDownloads || { value: 3 };

    /**
     * Procesa la cola de descargas de forma segura con mutex.
     * 
     * Garantiza que:
     * 1. Solo una instancia procesa a la vez
     * 2. Las llamadas durante el procesamiento se acumulan
     * 3. Se procesan automáticamente al terminar
     */
    const processDownloadQueue = () => {
        // Si ya estamos procesando, solo marcar que hay trabajo pendiente
        if (queueMutex.isProcessing) {
            queueMutex.hasPendingWork = true;
            console.debug('[Queue] Proceso en curso, trabajo pendiente marcado');
            return;
        }

        // Debounce: Agrupar llamadas rápidas consecutivas
        if (queueMutex.debounceTimeout) {
            timeoutManager.safeClearTimeout(queueMutex.debounceTimeout);
        }

        queueMutex.debounceTimeout = timeoutManager.safeSetTimeout(async () => {
            queueMutex.debounceTimeout = null;
            await _executeQueueWithMutex();
        }, 100);
    };

    /**
     * Ejecuta el procesamiento con mutex (uso interno).
     * NO llamar directamente, usar processDownloadQueue().
     */
    const _executeQueueWithMutex = async () => {
        // Double-check: Si ya está procesando, marcar pendiente
        if (queueMutex.isProcessing) {
            queueMutex.hasPendingWork = true;
            return;
        }

        // Adquirir el "lock"
        queueMutex.isProcessing = true;
        queueMutex.hasPendingWork = false;

        try {
            // Verificar que el componente sigue montado
            if (!timeoutManager.isMounted) {
                console.debug('[Queue] Componente desmontado, abortando');
                return;
            }

            // Ejecutar el procesamiento real
            await executeQueueProcessing();

        } catch (error) {
            console.error('[Queue] Error en procesamiento:', error);
        } finally {
            // Liberar el "lock"
            queueMutex.isProcessing = false;

            // Si quedó trabajo pendiente, procesar
            if (queueMutex.hasPendingWork && timeoutManager.isMounted) {
                queueMutex.hasPendingWork = false;
                console.debug('[Queue] Procesando trabajo pendiente');
                timeoutManager.safeSetTimeout(() => _executeQueueWithMutex(), 50);
            }
        }
    };

    /**
     * Ejecuta el procesamiento real de la cola.
     * Inicia descargas según los slots disponibles.
     */
    const executeQueueProcessing = async () => {
        try {
            // Calcular descargas activas
            const activeCount = Object.values(downloads.value).filter(
                d => d.state === 'starting' || d.state === 'progressing'
            ).length;

            const totalActive = activeCount + startingDownloads.size;
            const availableSlots = maxParallelDownloads.value - totalActive;

            // Log para debugging
            console.debug(`[Queue] Slots: ${availableSlots} libres (${totalActive}/${maxParallelDownloads.value} activas)`);

            if (availableSlots <= 0) {
                console.debug('[Queue] Sin slots disponibles');
                return;
            }

            // Obtener descargas pendientes (no en tránsito)
            const queued = downloadQueue.value.filter(
                d => d.status === 'queued' && !startingDownloads.has(d.id)
            );

            const toStart = queued.slice(0, availableSlots);

            if (toStart.length === 0) {
                console.debug('[Queue] No hay descargas pendientes');
                return;
            }

            console.debug(`[Queue] Iniciando ${toStart.length} descarga(s)`);

            // Procesar cada descarga
            for (const item of toStart) {
                // Verificación de seguridad: componente montado
                if (!timeoutManager.isMounted) {
                    console.debug('[Queue] Componente desmontado, deteniendo');
                    break;
                }

                // Verificación de seguridad: no duplicar
                if (startingDownloads.has(item.id)) {
                    console.debug(`[Queue] ${item.id} ya iniciándose, omitiendo`);
                    continue;
                }

                // Marcar como "en tránsito" (evita duplicados)
                startingDownloads.add(item.id);
                item.status = 'downloading';

                try {
                    const result = await api.download({
                        id: item.id,
                        title: item.title,
                        downloadPath: downloadPath.value,
                        preserveStructure: preserveStructure.value,
                        forceOverwrite: item.forceOverwrite || false
                    });

                    // Manejar diferentes respuestas del backend
                    if (result.success) {
                        if (result.awaiting) {
                            // Archivo existe, esperando confirmación del usuario
                            console.debug(`[Queue] Esperando confirmación: "${item.title}"`);
                            item.status = 'awaiting';
                        } else if (result.queued) {
                            // Agregado a cola del backend
                            console.debug(`[Queue] En cola backend: "${item.title}"`);
                        } else {
                            // Descarga iniciada correctamente
                            console.debug(`[Queue] Iniciada: "${item.title}"`);
                        }
                    } else if (!result.queued) {
                        // Error real al iniciar
                        // Si el error es "ya en proceso", es una condición de carrera normal, solo loguear en debug
                        if (result.error && result.error.includes('ya en proceso')) {
                            console.debug(`[Queue] Descarga "${item.title}" ya está en proceso, omitiendo`);
                            item.status = 'queued';
                        } else {
                            console.warn(`[Queue] Error iniciando "${item.title}":`, result.error);
                            item.status = 'queued';

                            if (downloads.value[item.id]) {
                                downloads.value[item.id].state = 'interrupted';
                                downloads.value[item.id].error = result.error || 'Error al iniciar descarga';
                            }
                        }
                    }

                } catch (error) {
                    console.error(`[Queue] Excepción en ${item.id}:`, error);
                    item.status = 'queued';
                } finally {
                    // Liberar ID después de delay (da tiempo al evento de progreso)
                    timeoutManager.safeSetTimeout(() => {
                        startingDownloads.delete(item.id);
                    }, 500);
                }

                // Pausa entre descargas para no saturar
                await new Promise(resolve => timeoutManager.safeSetTimeout(resolve, 50));
            }

        } catch (error) {
            console.error('[Queue] Error general en procesamiento:', error);
        }
    };

    return {
        processDownloadQueue
    };
}

export default useDownloadQueue;
