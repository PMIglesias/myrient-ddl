/**
 * useDownloadHelpers - Funciones helper para descargas
 * 
 * Funciones de utilidad para trabajar con descargas
 */

import { downloads } from './useDownloadState';

/**
 * Composable de helpers
 */
export function useDownloadHelpers() {
    const getDownloadPercentage = (dl) => Math.round((dl?.percent || 0) * 100);

    const getDownloadButtonText = (id) => {
        const dl = downloads.value[id];
        if (dl) {
            if (dl.state === 'completed') return '¡Listo!';
            if (dl.state === 'progressing') return 'Bajando...';
            if (dl.state === 'interrupted') return 'Reintentar';
        }
        return 'Descargar';
    };

    const isDownloading = (id) => {
        const dl = downloads.value[id];
        return dl && ['progressing', 'starting', 'queued'].includes(dl.state);
    };

    return {
        getDownloadPercentage,
        getDownloadButtonText,
        isDownloading
    };
}

export default useDownloadHelpers;
