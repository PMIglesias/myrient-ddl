/**
 * Índice de Composables de Descargas
 * 
 * Re-exporta todos los composables de descargas para uso centralizado
 */

export { default as useDownloadState } from './useDownloadState';
export { default as useDownloadComputed } from './useDownloadComputed';
export { default as useDownloadQueue } from './useDownloadQueue';
export { default as useDownloadActions } from './useDownloadActions';
export { default as useDownloadConfirmations } from './useDownloadConfirmations';
export { default as useDownloadHistory } from './useDownloadHistory';
export { default as useDownloadReconciliation } from './useDownloadReconciliation';
export { default as useDownloadSelection } from './useDownloadSelection';
export { default as useDownloadHelpers } from './useDownloadHelpers';

// Exportar también los exports nombrados de useDownloadState
export {
    downloads,
    downloadQueue,
    speedStats,
    pendingConfirmations,
    showingDownloads,
    selectedDownloads,
    selectedHistoryDownloads,
    currentDownloadIndex,
    startingDownloads,
    queueMutex,
    timeoutManager,
    MEMORY_LIMITS
} from './useDownloadState';
