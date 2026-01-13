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
    const newSet = new Set(selectedDownloads.value);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    selectedDownloads.value = newSet;
  };

  const toggleSelectHistoryDownload = id => {
    const newSet = new Set(selectedHistoryDownloads.value);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    selectedHistoryDownloads.value = newSet;
  };

  const toggleSelectAllHistoryDownloads = allDownloads => {
    if (!allDownloads || allDownloads.length === 0) {
      selectedHistoryDownloads.value = new Set();
      return;
    }

    if (selectedHistoryDownloads.value.size === allDownloads.length) {
      selectedHistoryDownloads.value = new Set();
    } else {
      selectedHistoryDownloads.value = new Set(allDownloads.map(d => d.id));
    }
  };

  return {
    toggleSelectDownload,
    toggleSelectHistoryDownload,
    toggleSelectAllHistoryDownloads,
  };
}

export default useDownloadSelection;
