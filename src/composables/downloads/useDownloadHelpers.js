/**
 * @fileoverview useDownloadHelpers - Funciones helper para descargas
 * @module useDownloadHelpers
 *
 * Funciones de utilidad para trabajar con descargas, incluyendo formateo,
 * verificación de estados, y generación de texto para UI.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

import { downloads } from './useDownloadState';

/**
 * Composable para funciones helper de descargas
 *
 * Proporciona funciones de utilidad para formatear y verificar estados
 * de descargas, útiles para componentes de UI.
 *
 * @returns {Object} Objeto con funciones helper
 * @returns {Function} returns.getDownloadPercentage - Obtiene porcentaje de descarga
 * @returns {Function} returns.getDownloadButtonText - Obtiene texto para botón de descarga
 * @returns {Function} returns.isDownloading - Verifica si una descarga está activa
 *
 * @example
 * const {
 *   getDownloadPercentage,
 *   getDownloadButtonText,
 *   isDownloading
 * } = useDownloadHelpers();
 *
 * // Obtener porcentaje
 * const percent = getDownloadPercentage(download);
 * console.log(`${percent}% completado`);
 *
 * // Obtener texto de botón
 * const buttonText = getDownloadButtonText(downloadId);
 * // 'Bajando...', 'Reintentar', 'Descargar', etc.
 *
 * // Verificar si está descargando
 * if (isDownloading(downloadId)) {
 *   console.log('Descarga en progreso');
 * }
 */
export function useDownloadHelpers() {
  /**
   * Obtiene el porcentaje de descarga como número entero (0-100)
   *
   * @param {Object} dl - Objeto de descarga con propiedad percent (0.0 - 1.0)
   * @returns {number} Porcentaje redondeado (0-100)
   *
   * @example
   * const percent = getDownloadPercentage({ percent: 0.75 });
   * // Retorna: 75
   */
  const getDownloadPercentage = dl => Math.round((dl?.percent || 0) * 100);

  /**
   * Obtiene el texto apropiado para el botón de descarga según el estado
   *
   * @param {number} id - ID de la descarga
   * @returns {string} Texto del botón: '¡Listo!', 'Bajando...', 'Reintentar', o 'Descargar'
   *
   * @example
   * const text = getDownloadButtonText(12345);
   * // Retorna: 'Bajando...' si está en progreso
   * // Retorna: '¡Listo!' si está completada
   * // Retorna: 'Reintentar' si está interrumpida
   */
  const getDownloadButtonText = id => {
    const dl = downloads.value[id];
    if (dl) {
      if (dl.state === 'completed') return '¡Listo!';
      if (dl.state === 'progressing') return 'Bajando...';
      if (dl.state === 'interrupted') return 'Reintentar';
    }
    return 'Descargar';
  };

  /**
   * Verifica si una descarga está actualmente en progreso
   *
   * @param {number} id - ID de la descarga
   * @returns {boolean} true si está descargando (progressing, starting, o queued)
   *
   * @example
   * if (isDownloading(12345)) {
   *   console.log('La descarga está activa');
   * }
   */
  const isDownloading = id => {
    const dl = downloads.value[id];
    return dl && ['progressing', 'starting', 'queued'].includes(dl.state);
  };

  return {
    getDownloadPercentage,
    getDownloadButtonText,
    isDownloading,
  };
}

export default useDownloadHelpers;
