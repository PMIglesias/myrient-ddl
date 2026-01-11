/**
 * @fileoverview Composable principal para gestión de descargas
 * @module useDownloads
 *
 * Orquesta todos los composables especializados de descargas en una API unificada.
 * Este composable actúa como un orquestador que combina:
 * - Estado global compartido
 * - Computed properties optimizadas
 * - Gestión de cola con mutex
 * - Acciones de descarga
 * - Confirmaciones de sobrescritura
 * - Persistencia de historial
 * - Reconciliación con backend
 * - Selección de descargas
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} DownloadSettings
 * @property {string} downloadPath - Ruta base de descarga
 * @property {boolean} preserveStructure - Si mantener estructura de carpetas
 * @property {number} maxParallelDownloads - Máximo de descargas concurrentes
 * @property {boolean} showNotifications - Si mostrar notificaciones
 * @property {number} maxHistoryInMemory - Máximo de historial en memoria
 * @property {number} maxCompletedInMemory - Máximo de completadas en memoria
 * @property {number} maxFailedInMemory - Máximo de fallidas en memoria
 */

import { onMounted, onUnmounted } from 'vue';
import {
  downloads,
  downloadQueue,
  speedStats,
  pendingConfirmations,
  showingDownloads,
  selectedDownloads,
  selectedHistoryDownloads,
  currentDownloadIndex,
  timeoutManager,
} from './downloads/useDownloadState';
import { useDownloadComputed } from './downloads/useDownloadComputed';
import { useDownloadQueue } from './downloads/useDownloadQueue';
import { useDownloadActions } from './downloads/useDownloadActions';
import { useDownloadConfirmations } from './downloads/useDownloadConfirmations';
import { useDownloadHistory } from './downloads/useDownloadHistory';
import { useDownloadReconciliation } from './downloads/useDownloadReconciliation';
import { useDownloadSelection } from './downloads/useDownloadSelection';
import { useDownloadHelpers } from './downloads/useDownloadHelpers';
import { useSettings } from './useSettings';

/**
 * Composable principal para gestión de descargas
 *
 * Proporciona una API unificada para gestionar descargas desde componentes Vue.
 * Combina múltiples composables especializados para ofrecer funcionalidad completa.
 *
 * @returns {Object} Objeto con estado, computed properties, métodos y lifecycle hooks
 * @returns {Object} returns.downloads - Estado reactivo de descargas activas
 * @returns {Object} returns.downloadQueue - Estado reactivo de cola de descargas
 * @returns {Object} returns.speedStats - Estadísticas de velocidad
 * @returns {Object} returns.pendingConfirmations - Confirmaciones pendientes
 * @returns {Function} returns.initDownloads - Inicializa el sistema de descargas
 * @returns {Function} returns.cleanup - Limpia recursos al desmontar
 * @returns {Function} returns.downloadFile - Inicia descarga de archivo
 * @returns {Function} returns.pauseDownload - Pausa una descarga
 * @returns {Function} returns.cancelDownload - Cancela una descarga
 *
 * @example
 * // En un componente Vue
 * import { useDownloads } from '@/composables/useDownloads';
 *
 * export default {
 *   setup() {
 *     const {
 *       downloads,
 *       downloadQueue,
 *       activeDownloads,
 *       initDownloads,
 *       downloadFile,
 *       pauseDownload,
 *       cleanup
 *     } = useDownloads();
 *
 *     // Inicializar al montar
 *     onMounted(() => {
 *       initDownloads();
 *     });
 *
 *     // Limpiar al desmontar
 *     onUnmounted(() => {
 *       cleanup();
 *     });
 *
 *     // Descargar archivo
 *     const handleDownload = async (fileId, fileName) => {
 *       await downloadFile({
 *         id: fileId,
 *         title: fileName,
 *         downloadPath: 'C:/Downloads'
 *       });
 *     };
 *
 *     return {
 *       downloads,
 *       downloadQueue,
 *       activeDownloads,
 *       handleDownload,
 *       pauseDownload
 *     };
 *   }
 * };
 */
export function useDownloads() {
  const {
    downloadPath,
    preserveStructure,
    maxParallelDownloads,
    showNotifications,
    maxHistoryInMemory,
    maxCompletedInMemory,
    maxFailedInMemory,
  } = useSettings();

  // =====================
  // COMPOSABLES ESPECIALIZADOS
  // =====================

  // Computed properties
  const computed = useDownloadComputed();

  // Configuración para pasar a otros composables
  const settings = {
    downloadPath,
    preserveStructure,
    maxParallelDownloads,
    showNotifications,
    maxHistoryInMemory,
    maxCompletedInMemory,
    maxFailedInMemory,
  };

  // Gestión de cola
  const queue = useDownloadQueue(settings);

  // Historial y persistencia (necesita acceso a queue para limitHistoryInMemory)
  const history = useDownloadHistory(settings);

  // Acciones (necesita processDownloadQueue y limitHistoryInMemory)
  const actions = useDownloadActions(
    queue.processDownloadQueue,
    history.limitHistoryInMemory,
    history.getCurrentLimits,
    settings
  );

  // Confirmaciones (necesita processDownloadQueue y saveDownloadHistory)
  const confirmations = useDownloadConfirmations(
    queue.processDownloadQueue,
    history.saveDownloadHistory
  );

  // Reconciliación (necesita varias funciones)
  const reconciliation = useDownloadReconciliation(
    queue.processDownloadQueue,
    history.saveDownloadHistory,
    history.limitHistoryInMemory,
    history.getCurrentLimits,
    settings
  );

  // Selección
  const selection = useDownloadSelection();

  // Helpers
  const helpers = useDownloadHelpers();

  // =====================
  // LIFECYCLE
  // =====================

  /**
   * Inicializa el sistema de descargas
   *
   * Carga el historial de descargas desde el almacenamiento local y
   * inicia la reconciliación con el backend para sincronizar estado.
   * Debe llamarse al montar el componente.
   *
   * @returns {Promise<void>}
   *
   * @example
   * onMounted(async () => {
   *   await initDownloads();
   *   console.log('Sistema de descargas inicializado');
   * });
   */
  const initDownloads = async () => {
    timeoutManager.isMounted = true;
    await history.loadDownloadHistory();
    reconciliation.startReconciliation();
  };

  /**
   * Limpia recursos al desmontar el componente
   *
   * Limita el historial en memoria antes de guardar para optimizar el archivo,
   * guarda el historial en el almacenamiento local, detiene la reconciliación
   * y limpia todos los timeouts pendientes. Debe llamarse al desmontar.
   *
   * @returns {void}
   *
   * @example
   * onUnmounted(() => {
   *   cleanup();
   *   console.log('Recursos de descargas limpiados');
   * });
   */
  const cleanup = () => {
    timeoutManager.isMounted = false;
    reconciliation.stopReconciliation();
    timeoutManager.clearAllTimeouts();

    // Limpiar historial antes de guardar (optimizar archivo guardado)
    history.limitHistoryInMemory(history.getCurrentLimits());

    // Guardar historial antes de salir
    history.saveDownloadHistory();
  };

  // =====================
  // RETURN
  // =====================

  return {
    // Estado global
    downloads,
    downloadQueue,
    speedStats,
    pendingConfirmations,
    showingDownloads,
    selectedDownloads,
    selectedHistoryDownloads,
    currentDownloadIndex,

    // Computed properties
    ...computed,

    // Gestión de cola
    ...queue,

    // Acciones
    ...actions,

    // Confirmaciones
    ...confirmations,

    // Historial
    ...history,

    // Reconciliación (no exportar métodos internos)
    // handleProgressEvent y handleDownloadsRestored se manejan internamente

    // Selección
    toggleSelectDownload: selection.toggleSelectDownload,
    toggleSelectHistoryDownload: selection.toggleSelectHistoryDownload,
    toggleSelectAllHistoryDownloads: allDownloads => {
      selection.toggleSelectAllHistoryDownloads(computed.allDownloads.value);
    },

    // Helpers
    ...helpers,

    // Lifecycle
    initDownloads,
    cleanup,
  };
}

export default useDownloads;
