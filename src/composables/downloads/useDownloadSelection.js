/**
 * useDownloadSelection - Selección de descargas
 * 
 * Maneja la selección de descargas individuales y múltiples
 */

import { selectedDownloads, selectedHistoryDownloads } from './useDownloadState';

/**
 * Composable de selección
 */
export function useDownloadSelection() {
    const toggleSelectDownload = (id) => {
        if (selectedDownloads.value.has(id)) {
            selectedDownloads.value.delete(id);
        } else {
            selectedDownloads.value.add(id);
        }
    };

    const toggleSelectHistoryDownload = (id) => {
        if (selectedHistoryDownloads.value.has(id)) {
            selectedHistoryDownloads.value.delete(id);
        } else {
            selectedHistoryDownloads.value.add(id);
        }
    };

    const toggleSelectAllHistoryDownloads = (allDownloads) => {
        if (selectedHistoryDownloads.value.size === allDownloads.length) {
            selectedHistoryDownloads.value.clear();
        } else {
            allDownloads.forEach(d => selectedHistoryDownloads.value.add(d.id));
        }
    };

    return {
        toggleSelectDownload,
        toggleSelectHistoryDownload,
        toggleSelectAllHistoryDownloads
    };
}

export default useDownloadSelection;
