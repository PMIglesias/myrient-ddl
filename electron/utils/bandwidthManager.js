/**
 * @fileoverview BandwidthManager - Gestor de ancho de banda para descargas
 * @module BandwidthManager
 *
 * Gestiona la distribución del ancho de banda disponible entre todas las
 * descargas activas usando porcentajes predefinidos (40%, 30%, 30%).
 * Implementa auto-detección de ancho de banda y throttling dinámico.
 *
 * Características:
 * - Auto-detección de ancho de banda mediante medición de velocidad real
 * - Distribución por porcentajes: 40% primera, 30% segunda, 30% tercera
 * - Ajuste dinámico cuando cambian las descargas activas
 * - Soporte para descargas simples y fragmentadas
 * - Compatible con el sistema de backpressure existente
 * - Throttling preciso usando tokens/quotas
 *
 * @author Myrient Downloader
 * @version 2.1.0
 */

const { logger } = require('./logger');
const { net } = require('electron');
const log = logger.child('BandwidthManager');

/**
 * @typedef {Object} BandwidthQuota
 * @property {number} downloadId - ID de la descarga
 * @property {number} bytesPerSecond - Bytes por segundo asignados
 * @property {number} bytesUsed - Bytes usados en el período actual
 * @property {number} lastReset - Timestamp del último reset
 * @property {boolean} isChunked - Si es descarga fragmentada
 * @property {number} [chunkIndex] - Índice del chunk (solo para fragmentadas)
 * @property {number} [position] - Posición en el orden de inicio (1, 2, 3, etc.)
 * @property {number} [percentage] - Porcentaje asignado (40, 30, 30, etc.)
 */

/**
 * Gestor de ancho de banda para descargas
 *
 * Distribuye equitativamente el ancho de banda disponible entre todas
 * las descargas activas, ajustándose dinámicamente cuando cambian.
 *
 * @class BandwidthManager
 * @example
 * const bandwidthManager = new BandwidthManager({
 *   maxBandwidthBytesPerSecond: 10 * 1024 * 1024 // 10 MB/s
 * });
 *
 * // Registrar descarga
 * bandwidthManager.registerDownload(12345, false);
 *
 * // Obtener quota para escribir datos
 * const quota = bandwidthManager.getQuota(12345);
 * if (quota.allowed) {
 *   // Escribir hasta quota.bytesAllowed bytes
 *   fileStream.write(chunk.slice(0, quota.bytesAllowed));
 * }
 *
 * // Desregistrar cuando termine
 * bandwidthManager.unregisterDownload(12345);
 */
class BandwidthManager {
  /**
   * Crea una nueva instancia de BandwidthManager
   *
   * @constructor
   * @param {Object} options - Opciones de configuración
   * @param {number} [options.maxBandwidthBytesPerSecond] - Ancho de banda máximo en bytes/segundo (0 = ilimitado)
   * @param {number} [options.updateInterval] - Intervalo de actualización de quotas en ms (default: 100ms)
   * @param {boolean} [options.enabled] - Si el bandwidth shaping está habilitado (default: true)
   */
  constructor(options = {}) {
    this.maxBandwidthBytesPerSecond = options.maxBandwidthBytesPerSecond || 0; // 0 = auto-detect
    this.updateInterval = options.updateInterval || 100; // Actualizar cada 100ms
    this.enabled = options.enabled !== false;

    // Porcentajes de distribución (40%, 30%, 30%)
    this.distributionPercentages = options.distributionPercentages || [40, 30, 30];

    // Map de quotas por downloadId
    // Estructura: Map<downloadId, BandwidthQuota>
    this.quotas = new Map();

    // Orden de inicio de descargas (para asignar porcentajes)
    // Estructura: Array<{downloadId, timestamp, position}>
    this.downloadOrder = [];

    // Contador de descargas activas
    this.activeDownloadsCount = 0;

    // Intervalo de actualización de quotas
    this.updateTimer = null;

    // Auto-detección de ancho de banda
    this.autoDetectEnabled = options.autoDetect !== false;
    this.detectedBandwidth = 0; // Ancho de banda detectado en bytes/segundo
    this.isDetecting = false;
    this.detectionUrl = options.detectionUrl || 'https://myrient.erista.me/files/'; // URL para speed test

    // Estadísticas
    this.stats = {
      totalBytesThrottled: 0,
      totalBytesAllowed: 0,
      lastUpdate: Date.now(),
      detectedBandwidth: 0,
    };

    log.info('BandwidthManager inicializado', {
      maxBandwidth: this.maxBandwidthBytesPerSecond
        ? this._formatBytes(this.maxBandwidthBytesPerSecond) + '/s'
        : this.autoDetectEnabled
        ? 'auto-detección'
        : 'ilimitado',
      enabled: this.enabled,
      updateInterval: this.updateInterval + 'ms',
      distributionPercentages: this.distributionPercentages,
      autoDetect: this.autoDetectEnabled,
    });

    // Si está habilitado y hay auto-detección, iniciar detección
    if (this.enabled && this.autoDetectEnabled && this.maxBandwidthBytesPerSecond === 0) {
      this._autoDetectBandwidth();
    } else if (this.enabled && this.maxBandwidthBytesPerSecond > 0) {
      this._startUpdateInterval();
    }
  }

  /**
   * Formatea bytes para logging
   * @private
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Inicia el intervalo de actualización de quotas
   * @private
   */
  _startUpdateInterval() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    this.updateTimer = setInterval(() => {
      this._updateQuotas();
    }, this.updateInterval);
  }

  /**
   * Actualiza las quotas de todas las descargas activas usando distribución por porcentajes
   * @private
   */
  _updateQuotas() {
    if (!this.enabled) {
      return;
    }

    // Usar ancho de banda detectado si está disponible, sino el configurado
    const effectiveBandwidth =
      this.detectedBandwidth > 0 ? this.detectedBandwidth : this.maxBandwidthBytesPerSecond;

    if (effectiveBandwidth <= 0) {
      return;
    }

    const now = Date.now();
    const activeCount = this.quotas.size;

    if (activeCount === 0) {
      return;
    }

    // Obtener descargas activas ordenadas por posición
    const activeDownloads = Array.from(this.quotas.entries())
      .map(([key, quota]) => ({
        key,
        quota,
        position: quota.position || 999, // Sin posición = última
      }))
      .sort((a, b) => a.position - b.position);

    // Asignar porcentajes según posición
    activeDownloads.forEach((item, index) => {
      const position = index + 1; // 1, 2, 3, ...
      let percentage;

      if (position === 1) {
        percentage = this.distributionPercentages[0] || 40; // Primera: 40%
      } else if (position === 2) {
        percentage = this.distributionPercentages[1] || 30; // Segunda: 30%
      } else if (position === 3) {
        percentage = this.distributionPercentages[2] || 30; // Tercera: 30%
      } else {
        // Si hay más de 3, distribuir el resto equitativamente
        const remainingPercentage = 100 - (this.distributionPercentages[0] || 40) - (this.distributionPercentages[1] || 30) - (this.distributionPercentages[2] || 30);
        const extraDownloads = activeCount - 3;
        percentage = extraDownloads > 0 ? remainingPercentage / extraDownloads : 0;
      }

      // Calcular bytes por segundo según porcentaje
      const bytesPerSecond = Math.floor((effectiveBandwidth * percentage) / 100);

      // Actualizar quota
      const quota = item.quota;
      const timeSinceReset = now - quota.lastReset;
      if (timeSinceReset >= this.updateInterval) {
        quota.bytesUsed = 0;
        quota.lastReset = now;
      }

      quota.bytesPerSecond = bytesPerSecond;
      quota.percentage = percentage;
      quota.position = position;
    });

    // Actualizar estadísticas
    this.stats.lastUpdate = now;
    this.stats.detectedBandwidth = this.detectedBandwidth;
  }

  /**
   * Registra una descarga para gestión de ancho de banda
   *
   * @param {number} downloadId - ID único de la descarga
   * @param {boolean} [isChunked=false] - Si es descarga fragmentada
   * @param {number} [chunkIndex] - Índice del chunk (solo para fragmentadas)
   * @returns {void}
   *
   * @example
   * // Registrar descarga simple
   * bandwidthManager.registerDownload(12345, false);
   *
   * // Registrar chunk de descarga fragmentada
   * bandwidthManager.registerDownload(12345, true, 0);
   */
  registerDownload(downloadId, isChunked = false, chunkIndex = null) {
    if (!this.enabled) {
      return;
    }

    // Para descargas fragmentadas, usar una clave única por chunk
    const key = isChunked && chunkIndex !== null ? `${downloadId}-chunk-${chunkIndex}` : downloadId;

    if (this.quotas.has(key)) {
      log.debug(`Descarga ${key} ya registrada`);
      return;
    }

    // Determinar posición en el orden (solo para descargas simples, no chunks)
    let position = null;
    if (!isChunked || chunkIndex === null) {
      // Verificar si ya existe en el orden
      const existingOrder = this.downloadOrder.find(o => o.downloadId === downloadId);
      if (!existingOrder) {
        // Nueva descarga, agregar al orden
        position = this.downloadOrder.length + 1;
        this.downloadOrder.push({
          downloadId,
          timestamp: Date.now(),
          position,
        });
      } else {
        position = existingOrder.position;
      }
    }

    const quota = {
      downloadId,
      bytesPerSecond: 0, // Se asignará en el próximo update
      bytesUsed: 0,
      lastReset: Date.now(),
      isChunked,
      chunkIndex: chunkIndex !== null ? chunkIndex : undefined,
      position,
      percentage: null, // Se asignará en _updateQuotas
    };

    this.quotas.set(key, quota);
    this.activeDownloadsCount = this.quotas.size;

    log.debug(`Descarga ${key} registrada para bandwidth shaping`, {
      totalActive: this.activeDownloadsCount,
      isChunked,
      chunkIndex,
      position,
    });

    // Si no está corriendo el timer, iniciarlo
    if (!this.updateTimer) {
      this._startUpdateInterval();
    }

    // Si hay auto-detección y aún no se ha detectado, iniciar detección
    if (this.autoDetectEnabled && this.detectedBandwidth === 0 && !this.isDetecting) {
      this._autoDetectBandwidth();
    }

    // Actualizar quotas inmediatamente
    this._updateQuotas();
  }

  /**
   * Desregistra una descarga
   *
   * @param {number} downloadId - ID único de la descarga
   * @param {number} [chunkIndex] - Índice del chunk (solo para fragmentadas)
   * @returns {void}
   *
   * @example
   * // Desregistrar descarga simple
   * bandwidthManager.unregisterDownload(12345);
   *
   * // Desregistrar chunk específico
   * bandwidthManager.unregisterDownload(12345, 0);
   */
  unregisterDownload(downloadId, chunkIndex = null) {
    if (!this.enabled) {
      return;
    }

    const key = chunkIndex !== null ? `${downloadId}-chunk-${chunkIndex}` : downloadId;

    if (!this.quotas.has(key)) {
      return;
    }

    this.quotas.delete(key);
    this.activeDownloadsCount = this.quotas.size;

    log.debug(`Descarga ${key} desregistrada`, {
      remainingActive: this.activeDownloadsCount,
    });

    // Si no hay descargas activas, detener el timer
    if (this.activeDownloadsCount === 0 && this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    // Actualizar quotas después de desregistrar
    this._updateQuotas();
  }

  /**
   * Obtiene la quota disponible para una descarga
   *
   * @param {number} downloadId - ID único de la descarga
   * @param {number} [chunkIndex] - Índice del chunk (solo para fragmentadas)
   * @param {number} [requestedBytes] - Bytes solicitados (opcional, para logging)
   * @returns {Object} Quota disponible
   * @returns {boolean} returns.allowed - Si se permite escribir
   * @returns {number} returns.bytesAllowed - Bytes permitidos en este momento
   * @returns {number} returns.bytesPerSecond - Bytes por segundo asignados
   *
   * @example
   * const quota = bandwidthManager.getQuota(12345, null, chunk.length);
   * if (quota.allowed) {
   *   // Escribir hasta quota.bytesAllowed bytes
   *   const bytesToWrite = Math.min(chunk.length, quota.bytesAllowed);
   *   fileStream.write(chunk.slice(0, bytesToWrite));
   *   bandwidthManager.consumeQuota(12345, bytesToWrite);
   * }
   */
  getQuota(downloadId, chunkIndex = null, requestedBytes = null) {
    // Si está deshabilitado, permitir todo
    if (!this.enabled) {
      return {
        allowed: true,
        bytesAllowed: requestedBytes || Infinity,
        bytesPerSecond: Infinity,
      };
    }

    // Usar ancho de banda detectado si está disponible, sino el configurado
    const effectiveBandwidth =
      this.detectedBandwidth > 0 ? this.detectedBandwidth : this.maxBandwidthBytesPerSecond;

    // Si no hay límite efectivo, permitir todo
    if (effectiveBandwidth <= 0) {
      return {
        allowed: true,
        bytesAllowed: requestedBytes || Infinity,
        bytesPerSecond: Infinity,
      };
    }

    const key = chunkIndex !== null ? `${downloadId}-chunk-${chunkIndex}` : downloadId;
    const quota = this.quotas.get(key);

    if (!quota) {
      // Si no está registrada, permitir (puede ser descarga que no usa bandwidth shaping)
      return {
        allowed: true,
        bytesAllowed: requestedBytes || Infinity,
        bytesPerSecond: Infinity,
      };
    }

    // Calcular bytes disponibles en este intervalo
    const now = Date.now();
    const timeSinceReset = now - quota.lastReset;

    // Si ha pasado suficiente tiempo, resetear
    if (timeSinceReset >= this.updateInterval) {
      quota.bytesUsed = 0;
      quota.lastReset = now;
    }

    // Calcular bytes permitidos en este intervalo
    const bytesPerInterval = Math.floor(
      (quota.bytesPerSecond * this.updateInterval) / 1000
    );

    // Bytes disponibles
    const bytesAvailable = Math.max(0, bytesPerInterval - quota.bytesUsed);

    // Si se solicitó un número específico de bytes, verificar si está disponible
    const bytesAllowed = requestedBytes
      ? Math.min(requestedBytes, bytesAvailable)
      : bytesAvailable;

    const allowed = bytesAllowed > 0;

    return {
      allowed,
      bytesAllowed: allowed ? bytesAllowed : 0,
      bytesPerSecond: quota.bytesPerSecond,
      bytesAvailable,
      bytesUsed: quota.bytesUsed,
    };
  }

  /**
   * Consume quota después de escribir datos
   *
   * @param {number} downloadId - ID único de la descarga
   * @param {number} bytesWritten - Bytes escritos
   * @param {number} [chunkIndex] - Índice del chunk (solo para fragmentadas)
   * @returns {void}
   *
   * @example
   * const bytesWritten = fileStream.write(chunk);
   * bandwidthManager.consumeQuota(12345, bytesWritten);
   */
  consumeQuota(downloadId, bytesWritten, chunkIndex = null) {
    if (!this.enabled || bytesWritten <= 0) {
      return;
    }

    // Usar ancho de banda detectado si está disponible, sino el configurado
    const effectiveBandwidth =
      this.detectedBandwidth > 0 ? this.detectedBandwidth : this.maxBandwidthBytesPerSecond;

    if (effectiveBandwidth <= 0) {
      return;
    }

    const key = chunkIndex !== null ? `${downloadId}-chunk-${chunkIndex}` : downloadId;
    const quota = this.quotas.get(key);

    if (!quota) {
      return;
    }

    quota.bytesUsed += bytesWritten;
    this.stats.totalBytesAllowed += bytesWritten;
  }

  /**
   * Actualiza el ancho de banda máximo
   *
   * @param {number} maxBandwidthBytesPerSecond - Nuevo límite en bytes/segundo (0 = ilimitado)
   * @returns {void}
   *
   * @example
   * // Establecer límite de 10 MB/s
   * bandwidthManager.setMaxBandwidth(10 * 1024 * 1024);
   *
   * // Quitar límite
   * bandwidthManager.setMaxBandwidth(0);
   */
  setMaxBandwidth(maxBandwidthBytesPerSecond) {
    const wasEnabled = this.maxBandwidthBytesPerSecond > 0;
    this.maxBandwidthBytesPerSecond = maxBandwidthBytesPerSecond;

    if (maxBandwidthBytesPerSecond > 0 && !wasEnabled) {
      // Activar throttling
      if (this.activeDownloadsCount > 0) {
        this._startUpdateInterval();
      }
      log.info(`Bandwidth shaping activado: ${this._formatBytes(maxBandwidthBytesPerSecond)}/s`);
    } else if (maxBandwidthBytesPerSecond === 0 && wasEnabled) {
      // Desactivar throttling
      if (this.updateTimer) {
        clearInterval(this.updateTimer);
        this.updateTimer = null;
      }
      log.info('Bandwidth shaping desactivado (ilimitado)');
    } else if (maxBandwidthBytesPerSecond > 0) {
      log.info(`Bandwidth máximo actualizado: ${this._formatBytes(maxBandwidthBytesPerSecond)}/s`);
    }

    // Recalcular quotas inmediatamente
    this._updateQuotas();
  }

  /**
   * Habilita o deshabilita el bandwidth shaping
   *
   * @param {boolean} enabled - Si habilitar o deshabilitar
   * @returns {void}
   */
  setEnabled(enabled) {
    this.enabled = enabled;

    if (enabled && this.maxBandwidthBytesPerSecond > 0 && this.activeDownloadsCount > 0) {
      this._startUpdateInterval();
      log.info('Bandwidth shaping habilitado');
    } else if (!enabled && this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
      log.info('Bandwidth shaping deshabilitado');
    }
  }

  /**
   * Auto-detecta el ancho de banda disponible mediante speed test
   * @private
   * @returns {Promise<void>}
   */
  async _autoDetectBandwidth() {
    if (this.isDetecting || !this.autoDetectEnabled) {
      return;
    }

    this.isDetecting = true;
    log.info('Iniciando auto-detección de ancho de banda...');

    try {
      // Usar un archivo pequeño para medir velocidad
      // Intentar descargar un pequeño fragmento y medir la velocidad
      const testUrl = this.detectionUrl;
      const testSize = 1024 * 1024; // 1 MB para test
      const startTime = Date.now();
      let downloadedBytes = 0;

      return new Promise((resolve, reject) => {
        const request = net.request({
          method: 'HEAD',
          url: testUrl,
        });

        request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        request.setHeader('Referer', 'https://myrient.erista.me/');

        const timeout = setTimeout(() => {
          request.abort();
          reject(new Error('Timeout en detección de ancho de banda'));
        }, 10000); // 10 segundos timeout

        request.on('response', response => {
          clearTimeout(timeout);

          if (response.statusCode !== 200 && response.statusCode !== 206) {
            reject(new Error(`HTTP ${response.statusCode} en detección`));
            return;
          }

          // Si hay descargas activas, medir su velocidad real
          if (this.activeDownloadsCount > 0) {
            // Usar la velocidad promedio de las descargas activas como referencia
            let totalSpeed = 0;
            let count = 0;

            this.quotas.forEach(quota => {
              if (quota.bytesPerSecond > 0) {
                totalSpeed += quota.bytesPerSecond;
                count++;
              }
            });

            if (count > 0) {
              const avgSpeed = totalSpeed / count;
              // Estimar ancho de banda total basado en velocidad promedio
              // Asumir que estamos usando ~80% del ancho de banda disponible
              this.detectedBandwidth = Math.floor((avgSpeed * this.activeDownloadsCount) / 0.8);
              this.stats.detectedBandwidth = this.detectedBandwidth;

              log.info(
                `Ancho de banda auto-detectado: ${this._formatBytes(this.detectedBandwidth)}/s (basado en velocidad promedio de ${this.activeDownloadsCount} descargas)`
              );

              this.isDetecting = false;
              this._updateQuotas();
              resolve();
              return;
            }
          }

          // Si no hay descargas activas, usar un valor conservador por defecto
          // O intentar una descarga pequeña para medir
          this.detectedBandwidth = 10 * 1024 * 1024; // 10 MB/s por defecto
          this.stats.detectedBandwidth = this.detectedBandwidth;

          log.info(
            `Ancho de banda auto-detectado (valor por defecto): ${this._formatBytes(this.detectedBandwidth)}/s`
          );

          this.isDetecting = false;
          resolve();
        });

        request.on('error', error => {
          clearTimeout(timeout);
          log.warn('Error en auto-detección de ancho de banda, usando valor por defecto:', error.message);
          this.detectedBandwidth = 10 * 1024 * 1024; // 10 MB/s por defecto
          this.stats.detectedBandwidth = this.detectedBandwidth;
          this.isDetecting = false;
          resolve(); // No rechazar, usar valor por defecto
        });

        request.end();
      });
    } catch (error) {
      log.warn('Error en auto-detección de ancho de banda:', error.message);
      this.detectedBandwidth = 10 * 1024 * 1024; // 10 MB/s por defecto
      this.stats.detectedBandwidth = this.detectedBandwidth;
      this.isDetecting = false;
    }
  }

  /**
   * Actualiza el ancho de banda detectado basado en velocidad real de descargas
   * @param {number} measuredSpeed - Velocidad medida en bytes/segundo
   * @returns {void}
   */
  updateDetectedBandwidth(measuredSpeed) {
    if (!this.autoDetectEnabled || measuredSpeed <= 0) {
      return;
    }

    // Calcular ancho de banda total estimado basado en velocidad medida
    // Asumir que estamos usando ~80% del ancho de banda disponible
    const estimatedTotal = Math.floor((measuredSpeed * this.activeDownloadsCount) / 0.8);

    if (estimatedTotal > this.detectedBandwidth * 0.5 && estimatedTotal < this.detectedBandwidth * 2) {
      // Solo actualizar si el cambio es razonable (evitar saltos bruscos)
      this.detectedBandwidth = Math.floor(this.detectedBandwidth * 0.7 + estimatedTotal * 0.3); // Suavizado
      this.stats.detectedBandwidth = this.detectedBandwidth;

      log.debug(
        `Ancho de banda actualizado: ${this._formatBytes(this.detectedBandwidth)}/s (medido: ${this._formatBytes(measuredSpeed)}/s)`
      );

      this._updateQuotas();
    }
  }

  /**
   * Obtiene estadísticas del bandwidth manager
   *
   * @returns {Object} Estadísticas
   */
  getStats() {
    return {
      ...this.stats,
      activeDownloads: this.activeDownloadsCount,
      maxBandwidth: this.maxBandwidthBytesPerSecond,
      detectedBandwidth: this.detectedBandwidth,
      enabled: this.enabled,
      autoDetect: this.autoDetectEnabled,
      isDetecting: this.isDetecting,
      distributionPercentages: this.distributionPercentages,
      quotas: Array.from(this.quotas.entries()).map(([key, quota]) => ({
        key,
        downloadId: quota.downloadId,
        bytesPerSecond: quota.bytesPerSecond,
        bytesUsed: quota.bytesUsed,
        isChunked: quota.isChunked,
        chunkIndex: quota.chunkIndex,
        position: quota.position,
        percentage: quota.percentage,
      })),
    };
  }

  /**
   * Limpia todos los recursos y detiene el manager
   *
   * @returns {void}
   */
  destroy() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }

    this.quotas.clear();
    this.downloadOrder = [];
    this.activeDownloadsCount = 0;
    this.isDetecting = false;

    log.info('BandwidthManager destruido');
  }
}

module.exports = BandwidthManager;
