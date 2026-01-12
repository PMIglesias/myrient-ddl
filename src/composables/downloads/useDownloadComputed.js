/**
 * @fileoverview useDownloadComputed - Propiedades computadas optimizadas para descargas
 * @module useDownloadComputed
 *
 * Composable que transforma el estado crudo de las descargas en datos útiles
 * para la interfaz. Optimizado para rendimiento: en lugar de recalcular todo cada
 * vez que cambia algo (como el progreso que cambia constantemente), usa un sistema
 * de caché inteligente que solo reordena cuando realmente es necesario.
 *
 * Características:
 * - Caché inteligente de listas ordenadas
 * - Firma de estados para detectar cambios reales
 * - Propiedades computadas reactivas de Vue
 * - Optimización para rendimiento con muchas descargas
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} DownloadComputed
 * @property {Array} allDownloads - Lista de todas las descargas ordenadas
 * @property {Array} activeDownloads - Descargas activas (downloading)
 * @property {Array} queuedDownloads - Descargas en cola
 * @property {Array} pausedDownloads - Descargas pausadas
 * @property {Array} completedDownloads - Descargas completadas
 * @property {Array} errorDownloads - Descargas con error
 * @property {number} totalDownloads - Total de descargas
 * @property {number} activeCount - Cantidad de descargas activas
 * @property {number} queuedCount - Cantidad de descargas en cola
 * @property {number} pausedCount - Cantidad de descargas pausadas
 * @property {number} completedCount - Cantidad de descargas completadas
 * @property {number} errorCount - Cantidad de descargas con error
 * @property {number} totalSpeed - Velocidad total de descarga en MB/s
 * @property {number} totalProgress - Progreso total promedio
 */

import { computed, ref } from 'vue';
import { downloads, speedStats, currentDownloadIndex } from './useDownloadState';

/**
 * Composable para propiedades computadas de descargas
 *
 * Proporciona propiedades computadas reactivas optimizadas para el rendimiento.
 * Usa caché inteligente que solo recalcula cuando cambian los estados, no cuando
 * solo cambia el progreso de descargas individuales.
 *
 * @returns {DownloadComputed} Objeto con propiedades computadas de descargas
 *
 * @example
 * const {
 *   allDownloads,
 *   activeDownloads,
 *   queuedDownloads,
 *   totalSpeed,
 *   totalProgress
 * } = useDownloadComputed();
 *
 * // allDownloads se actualiza automáticamente cuando cambia el estado
 * // Pero no se reordena si solo cambia el progreso de una descarga
 * console.log(`Hay ${activeDownloads.length} descargas activas`);
 * console.log(`Velocidad total: ${totalSpeed.toFixed(2)} MB/s`);
 */
export function useDownloadComputed() {
  // Esta variable está declarada pero no se usa actualmente. Podría servir para forzar
  // recálculos manuales en el futuro si fuera necesario, pero por ahora el sistema de
  // firma de estados (cachedStateSignature) es suficiente.
  const downloadStateVersion = ref(0);

  // Caché de la lista de descargas ya procesada y ordenada. Esto evita tener que
  // reconstruir y reordenar la lista completa cada vez que cambia el progreso de una descarga.
  let cachedDownloadsList = [];

  // Firma del estado actual: es como un "hash" que representa qué descargas hay y en qué
  // estado están. Si esta firma cambia, significa que alguna descarga cambió de estado
  // (por ejemplo, de "queued" a "downloading"), y entonces sí necesitamos reordenar.
  // Si solo cambia el progreso (porcentaje, velocidad, etc.) pero no el estado, la firma
  // sigue igual y solo actualizamos los valores sin reordenar.
  let cachedStateSignature = '';

  /**
   * Genera una "firma" única del estado actual de todas las descargas
   *
   * La idea es simple: tomamos todas las descargas, creamos un string con su ID y estado
   * (por ejemplo: "123:downloading|456:queued|789:completed"), lo ordenamos para que sea
   * consistente, y eso nos da una "huella digital" del estado actual.
   *
   * Si esta firma cambia, significa que alguna descarga cambió de estado (no solo progreso),
   * así que necesitamos reordenar la lista. Si no cambia, solo actualizamos los valores.
   *
   * @returns {string} Una cadena que representa el estado de todas las descargas
   */
  const getStateSignature = () => {
    const states = Object.values(downloads.value)
      .map(d => `${d.id}:${d.state}`)
      .sort()
      .join('|');
    return states;
  };

  /**
   * Convierte los estados internos de descarga a estados más simples para la UI
   *
   * El sistema interno tiene varios estados específicos (como "starting", "progressing", "waiting"),
   * pero para la interfaz es más útil tener categorías más amplias. Esta función hace esa traducción.
   *
   * Por ejemplo, tanto "starting" como "progressing" se convierten en "downloading" porque
   * desde el punto de vista del usuario, ambas significan "se está descargando".
   *
   * @param {string} state - El estado interno de la descarga
   * @returns {string} El estado simplificado para mostrar en la UI
   */
  const getQueueStatus = state => {
    switch (state) {
      case 'queued':
      case 'waiting':
        return 'queued';
      case 'starting':
      case 'progressing':
        return 'downloading';
      case 'paused':
        return 'paused';
      case 'completed':
        return 'completed';
      case 'cancelled':
        return 'cancelled';
      case 'interrupted':
        return 'error';
      default:
        return 'completed';
    }
  };

  /**
   * Define el orden de prioridad para mostrar las descargas en la lista
   *
   * Los números más bajos aparecen primero. Así que las descargas activas (downloading: 0)
   * siempre aparecen arriba, seguidas de las en cola (queued: 1), pausadas (paused: 2), etc.
   *
   * Esto hace que el usuario siempre vea primero lo que está pasando ahora (descargas activas)
   * y luego lo que está esperando o terminado.
   */
  const QUEUE_ORDER = {
    downloading: 0,
    queued: 1,
    paused: 2,
    cancelled: 3,
    completed: 4,
    error: 5,
  };

  /**
   * allDownloads - La lista principal de todas las descargas, optimizada para rendimiento
   *
   * Esta es la propiedad computada más importante y la más optimizada. El problema que resuelve
   * es el siguiente: si tenemos 100 descargas y cada una actualiza su progreso 10 veces por segundo,
   * sin optimización estaríamos reordenando 1000 veces por segundo, lo cual es una locura.
   *
   * La solución: usamos un sistema de caché inteligente que distingue entre:
   * 1. Cambios de ESTADO (queued -> downloading, downloading -> completed, etc.)
   * 2. Cambios de PROGRESO (porcentaje, velocidad, bytes descargados, etc.)
   *
   * Solo cuando cambian los estados reordenamos la lista completa. Cuando solo cambia el progreso,
   * simplemente actualizamos los valores en la lista ya ordenada. Esto reduce drásticamente
   * el trabajo computacional.
   *
   * @returns {Array} Lista de todas las descargas, ordenadas por prioridad y con sus datos actualizados
   */
  const allDownloads = computed(() => {
    // Primero, generamos la firma del estado actual para ver si algo cambió
    const currentSignature = getStateSignature();
    const needsResort = currentSignature !== cachedStateSignature;

    if (needsResort) {
      // CASO 1: Los estados cambiaron, necesitamos reconstruir y reordenar todo
      // Esto pasa cuando una descarga cambia de estado (por ejemplo, pasa de "queued" a "downloading")

      // Convertimos el objeto de descargas a un array y le agregamos el queueStatus simplificado
      cachedDownloadsList = Object.values(downloads.value).map(download => ({
        ...download,
        queueStatus: getQueueStatus(download.state),
      }));

      // Ordenamos la lista: primero por prioridad de estado (downloading antes que queued, etc.),
      // y si dos descargas tienen el mismo estado, las ordenamos por fecha de creación (más antiguas primero)
      cachedDownloadsList.sort((a, b) => {
        const diff = QUEUE_ORDER[a.queueStatus] - QUEUE_ORDER[b.queueStatus];
        if (diff !== 0) return diff;
        return (a.addedAt || 0) - (b.addedAt || 0);
      });

      // Guardamos la nueva firma para la próxima vez
      cachedStateSignature = currentSignature;
      console.debug(`[allDownloads] Reordenado (${cachedDownloadsList.length} items)`);
    } else {
      // CASO 2: Solo cambió el progreso, no los estados.
      // IMPORTANTE: Para asegurar que Vue detecte los cambios en las propiedades internas
      // de cada descarga, necesitamos crear NUEVAS referencias de objeto para aquellas
      // descargas que están en progreso. Si solo mutamos las existentes, los componentes
      // hijos podrían no re-renderizar debido a la optimización de identidad de objetos.

      cachedDownloadsList = cachedDownloadsList.map(cached => {
        const current = downloads.value[cached.id];
        
        // Si no hay datos actuales para este item (no debería pasar), devolver el cacheado
        if (!current) return cached;

        // Si la descarga está activa o acaba de cambiar, devolver un NUEVO objeto (shallow copy)
        // Esto garantiza que el Virtual DOM detecte cambios en .percent, .speed, etc.
        const isActive = current.state === 'progressing' || current.state === 'starting' || current.merging;
        
        if (isActive) {
          return {
            ...cached,
            percent: current.percent,
            downloadedBytes: current.downloadedBytes,
            speed: current.speed,
            eta: current.eta,
            error: current.error,
            remainingTime: current.remainingTime,
            // Información de chunks
            chunked: current.chunked,
            chunkProgress: Array.isArray(current.chunkProgress) ? [...current.chunkProgress] : current.chunkProgress,
            activeChunks: current.activeChunks,
            completedChunks: current.completedChunks,
            totalChunks: current.totalChunks,
            // Información de merge
            merging: current.merging,
            mergeProgress: current.mergeProgress,
            mergeSpeed: current.mergeSpeed
          };
        }

        // Si no está activa (ej: completada), podemos devolver la referencia cacheada para ahorrar memoria
        return cached;
      });
    }

    // Retornamos una copia del array. 
    return [...cachedDownloadsList];
  });

  /**
   * activeDownloads - Descargas que están actualmente en progreso
   *
   * Filtra solo las descargas que están activamente descargando datos. Esto incluye tanto
   * las que están "starting" (iniciando) como las que están "progressing" (descargando).
   *
   * Estos computed son más simples que allDownloads porque no necesitan caché: solo filtran
   * el objeto de descargas según el estado. Son útiles cuando necesitas trabajar solo con
   * un subconjunto específico de descargas.
   *
   * @returns {Array} Array de descargas que están activas
   */
  const activeDownloads = computed(() => {
    return Object.values(downloads.value).filter(
      d => d.state === 'progressing' || d.state === 'starting'
    );
  });

  /**
   * queuedDownloads - Descargas que están esperando en la cola
   *
   * Estas son las descargas que están listas para empezar pero aún no han comenzado.
   * Pueden estar en estado "queued" (en cola) o "waiting" (esperando alguna condición).
   *
   * @returns {Array} Array de descargas en cola
   */
  const queuedDownloads = computed(() => {
    return Object.values(downloads.value).filter(
      d => d.state === 'queued' || d.state === 'waiting'
    );
  });

  /**
   * completedDownloads - Descargas que terminaron exitosamente
   *
   * Simple y directo: todas las descargas que llegaron al estado "completed".
   *
   * @returns {Array} Array de descargas completadas
   */
  const completedDownloads = computed(() => {
    return Object.values(downloads.value).filter(d => d.state === 'completed');
  });

  /**
   * failedDownloads - Descargas que fallaron o fueron canceladas
   *
   * Incluye tanto las descargas que fueron interrumpidas por error ("interrupted") como
   * las que fueron canceladas manualmente por el usuario ("cancelled").
   *
   * @returns {Array} Array de descargas fallidas o canceladas
   */
  const failedDownloads = computed(() => {
    return Object.values(downloads.value).filter(
      d => d.state === 'interrupted' || d.state === 'cancelled'
    );
  });

  /**
   * downloadCounts - Contadores de descargas por categoría
   *
   * Proporciona un objeto con la cantidad de descargas en cada estado. Es útil para mostrar
   * estadísticas en la UI (por ejemplo, "5 activas, 10 en cola, 20 completadas").
   *
   * Nota: Aunque usa los otros computed (activeDownloads, queuedDownloads, etc.), Vue es
   * lo suficientemente inteligente como para cachear estos valores y no recalcularlos
   * innecesariamente.
   *
   * @returns {Object} Objeto con contadores: { active, queued, completed, failed, total }
   */
  const downloadCounts = computed(() => ({
    active: activeDownloads.value.length,
    queued: queuedDownloads.value.length,
    completed: completedDownloads.value.length,
    failed: failedDownloads.value.length,
    total: Object.keys(downloads.value).length,
  }));

  /**
   * activeDownloadCount - Cantidad de descargas activas (usando speedStats)
   *
   * Esta es una forma alternativa de contar descargas activas, pero usando speedStats
   * en lugar de filtrar por estado. speedStats es un Map que solo contiene las descargas
   * que están realmente descargando datos en este momento, así que su tamaño nos da
   * el conteo directo.
   *
   * @returns {number} Número de descargas activas según speedStats
   */
  const activeDownloadCount = computed(() => speedStats.value.size);

  /**
   * averageDownloadSpeed - Velocidad total de descarga combinada
   *
   * Suma todas las velocidades individuales de las descargas activas para obtener
   * la velocidad total del sistema. Por ejemplo, si hay 3 descargas a 5MB/s cada una,
   * esto retornará 15MB/s.
   *
   * Nota: El nombre dice "average" pero en realidad es la suma total. Si quisieras
   * el promedio real, dividirías por speedStats.value.size.
   *
   * @returns {number} Velocidad total de descarga en bytes por segundo
   */
  const averageDownloadSpeed = computed(() => {
    if (speedStats.value.size === 0) return 0;
    let total = 0;
    speedStats.value.forEach(stats => (total += stats.speed || 0));
    return total;
  });

  /**
   * currentDownloadName - Nombre de la descarga que se está mostrando actualmente
   *
   * Este computed implementa un sistema de "rotación" para mostrar diferentes descargas
   * en la UI. Usa currentDownloadIndex (que probablemente se incrementa periódicamente)
   * para ciclar entre las descargas activas.
   *
   * El operador módulo (%) asegura que si el índice es mayor que la cantidad de descargas,
   * vuelva a empezar desde el principio (como un carrusel).
   *
   * Por ejemplo, si hay 3 descargas activas y currentDownloadIndex es 5:
   * 5 % 3 = 2, así que mostrará la descarga en la posición 2 (tercera descarga).
   *
   * @returns {string} El título de la descarga actualmente seleccionada para mostrar
   */
  const currentDownloadName = computed(() => {
    if (speedStats.value.size === 0) return '';
    const keys = Array.from(speedStats.value.keys());
    const index = currentDownloadIndex.value % keys.length;
    const dl = downloads.value[keys[index]];
    return dl ? dl.title : '';
  });

  /**
   * Retorna todas las propiedades computadas para que puedan ser usadas en los componentes
   *
   * Cada una de estas propiedades es reactiva: cuando el estado de las descargas cambia,
   * Vue automáticamente recalcula estos valores y actualiza cualquier componente que los use.
   */
  return {
    allDownloads,
    activeDownloads,
    queuedDownloads,
    completedDownloads,
    failedDownloads,
    downloadCounts,
    activeDownloadCount,
    averageDownloadSpeed,
    currentDownloadName,
  };
}

export default useDownloadComputed;
