/**
 * useDownloads - Composable principal para gestión de descargas
 * 
 * Orquesta todos los composables especializados de descargas
 * 
 * Este composable actúa como un orquestador que combina:
 * - Estado global compartido
 * - Computed properties optimizadas
 * - Gestión de cola con mutex
 * - Acciones de descarga
 * - Confirmaciones de sobrescritura
 * - Persistencia de historial
 * - Reconciliación con backend
 * - Selección de descargas
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
    timeoutManager
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
 * Composable principal de descargas
 */
export function useDownloads() {
    const { downloadPath, preserveStructure, maxParallelDownloads, showNotifications, maxHistoryInMemory, maxCompletedInMemory, maxFailedInMemory } = useSettings();

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
        maxFailedInMemory
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
    const confirmations = useDownloadConfirmations(queue.processDownloadQueue, history.saveDownloadHistory);

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
     */
    const initDownloads = async () => {
        timeoutManager.isMounted = true;
        await history.loadDownloadHistory();
        reconciliation.startReconciliation();
    };

    /**
     * Limpia recursos al desmontar
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
        toggleSelectAllHistoryDownloads: (allDownloads) => {
            selection.toggleSelectAllHistoryDownloads(computed.allDownloads.value);
        },

        // Helpers
        ...helpers,

        // Lifecycle
        initDownloads,
        cleanup
    };
}

export default useDownloads;
