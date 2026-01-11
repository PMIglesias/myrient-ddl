/**
 * @fileoverview useDownloadSelection - Selección de descargas
 * @module useDownloadSelection
 *
 * Maneja la selección de descargas individuales y múltiples para operaciones
 * en lote. Proporciona funciones para alternar selección, seleccionar todo,
 * y gestionar selecciones tanto de descargas activas como de historial.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

import { selectedDownloads, selectedHistoryDownloads } from './useDownloadState';

/**
 * Composable para selección de descargas
 *
 * Proporciona funciones para gestionar la selección de descargas, útil
 * para operaciones en lote como cancelar múltiples descargas o limpiar
 * el historial.
 *
 * @returns {Object} Objeto con funciones de selección
 * @returns {Function} returns.toggleSelectDownload - Alterna selección de descarga activa
 * @returns {Function} returns.toggleSelectHistoryDownload - Alterna selección de descarga en historial
 * @returns {Function} returns.toggleSelectAllHistoryDownloads - Selecciona/deselecciona todas las descargas del historial
 *
 * @example
 * const {
 *   toggleSelectDownload,
 *   toggleSelectHistoryDownload,
 *   toggleSelectAllHistoryDownloads
 * } = useDownloadSelection();
 *
 * // Alternar selección individual
 * toggleSelectDownload(12345);
 *
 * // Seleccionar todas las descargas del historial
 * toggleSelectAllHistoryDownloads(allHistoryDownloads);
 */
export function useDownloadSelection() {
  const toggleSelectDownload = id => {
    if (selectedDownloads.value.has(id)) {
      selectedDownloads.value.delete(id);
    } else {
      selectedDownloads.value.add(id);
    }
  };

  const toggleSelectHistoryDownload = id => {
    if (selectedHistoryDownloads.value.has(id)) {
      selectedHistoryDownloads.value.delete(id);
    } else {
      selectedHistoryDownloads.value.add(id);
    }
  };

  const toggleSelectAllHistoryDownloads = allDownloads => {
    if (selectedHistoryDownloads.value.size === allDownloads.length) {
      selectedHistoryDownloads.value.clear();
    } else {
      allDownloads.forEach(d => selectedHistoryDownloads.value.add(d.id));
    }
  };

  return {
    toggleSelectDownload,
    toggleSelectHistoryDownload,
    toggleSelectAllHistoryDownloads,
  };
}

export default useDownloadSelection;
