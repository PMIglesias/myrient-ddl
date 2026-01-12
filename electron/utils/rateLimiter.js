/**
 * @fileoverview Rate Limiter - Control de frecuencia de requests
 * @module rateLimiter
 *
 * Implementa rate limiting usando algoritmo de ventana deslizante (sliding window)
 * para limitar el número de requests permitidas en un período de tiempo específico.
 * Útil para prevenir abuso del sistema y proteger contra DoS.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

const { logger } = require('./logger');
const log = logger.child('RateLimiter');

/**
 * Rate Limiter usando algoritmo de ventana deslizante
 *
 * Limita el número de requests permitidas por identificador (IP, usuario, etc.)
 * en una ventana de tiempo específica. Las requests antiguas se eliminan
 * automáticamente cuando salen de la ventana.
 *
 * @class RateLimiter
 *
 * @example
 * // Crear rate limiter: máximo 10 requests por segundo
 * const limiter = new RateLimiter(10, 1000);
 *
 * // Verificar si una request está permitida
 * const identifier = 'user-123';
 * if (limiter.isAllowed(identifier)) {
 *   // Procesar request
 *   processRequest();
 * } else {
 *   // Rechazar request (rate limit excedido)
 *   rejectRequest('Demasiadas requests');
 * }
 */
class RateLimiter {
  /**
   * Crea una nueva instancia de RateLimiter
   *
   * @constructor
   * @param {number} maxRequests - Número máximo de requests permitidas en la ventana
   * @param {number} windowMs - Tamaño de la ventana en milisegundos
   *
   * @example
   * // 10 requests por segundo
   * const limiter = new RateLimiter(10, 1000);
   *
   * // 100 requests por minuto
   * const limiter = new RateLimiter(100, 60000);
   */
  constructor(maxRequests, windowMs) {
    if (maxRequests <= 0 || windowMs <= 0) {
      throw new Error('maxRequests y windowMs deben ser mayores a 0');
    }

    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map(); // Map<identifier, Array<timestamp>>

    log.info(`RateLimiter inicializado: ${maxRequests} requests por ${windowMs}ms`);
  }

  /**
   * Verifica si una request está permitida para el identificador dado
   *
   * Limpia automáticamente las requests antiguas fuera de la ventana y
   * agrega la nueva request si está permitida.
   *
   * @param {string} identifier - Identificador único (IP, user ID, etc.)
   * @returns {boolean} true si la request está permitida, false si excede el límite
   *
   * @example
   * const allowed = limiter.isAllowed('user-123');
   * if (!allowed) {
   *   throw new Error('Rate limit excedido');
   * }
   */
  isAllowed(identifier) {
    if (!identifier || typeof identifier !== 'string') {
      log.warn('RateLimiter: identifier inválido, rechazando request');
      return false;
    }

    const now = Date.now();
    const userRequests = this.requests.get(identifier) || [];

    // Limpiar requests antiguos fuera de la ventana
    const recentRequests = userRequests.filter(
      timestamp => now - timestamp < this.windowMs
    );

    // Verificar si excede el límite
    if (recentRequests.length >= this.maxRequests) {
      log.debug(
        `Rate limit excedido para ${identifier}: ${recentRequests.length}/${this.maxRequests} requests en ${this.windowMs}ms`
      );
      return false;
    }

    // Agregar nueva request
    recentRequests.push(now);
    this.requests.set(identifier, recentRequests);

    return true;
  }

  /**
   * Obtiene información sobre el estado del rate limiter para un identificador
   *
   * @param {string} identifier - Identificador único
   * @returns {Object|null} Información del estado o null si no hay requests
   * @returns {number} returns.count - Número de requests en la ventana actual
   * @returns {number} returns.remaining - Requests restantes antes de exceder límite
   * @returns {number} returns.resetTime - Timestamp cuando la ventana se resetea
   */
  getStatus(identifier) {
    if (!identifier) return null;

    const now = Date.now();
    const userRequests = this.requests.get(identifier) || [];
    const recentRequests = userRequests.filter(
      timestamp => now - timestamp < this.windowMs
    );

    if (recentRequests.length === 0) return null;

    // Encontrar el timestamp más antiguo que aún está en la ventana
    const oldestRequest = Math.min(...recentRequests);
    const resetTime = oldestRequest + this.windowMs;

    return {
      count: recentRequests.length,
      remaining: Math.max(0, this.maxRequests - recentRequests.length),
      resetTime,
      resetInMs: Math.max(0, resetTime - now),
    };
  }

  /**
   * Limpia requests antiguas fuera de la ventana para todos los identificadores
   *
   * Útil para limpieza periódica y liberar memoria. Se llama automáticamente
   * en isAllowed(), pero puede llamarse manualmente para limpieza más agresiva.
   *
   * @returns {number} Número de identificadores eliminados (sin requests recientes)
   */
  cleanup() {
    const now = Date.now();
    let removedCount = 0;

    for (const [identifier, requests] of this.requests.entries()) {
      const recentRequests = requests.filter(
        timestamp => now - timestamp < this.windowMs
      );

      if (recentRequests.length === 0) {
        this.requests.delete(identifier);
        removedCount++;
      } else {
        this.requests.set(identifier, recentRequests);
      }
    }

    if (removedCount > 0) {
      log.debug(`RateLimiter cleanup: ${removedCount} identificadores eliminados`);
    }

    return removedCount;
  }

  /**
   * Resetea el rate limiter para un identificador específico
   *
   * @param {string} identifier - Identificador a resetear
   * @returns {boolean} true si se reseteó, false si no existía
   */
  reset(identifier) {
    if (this.requests.has(identifier)) {
      this.requests.delete(identifier);
      log.debug(`RateLimiter reset para: ${identifier}`);
      return true;
    }
    return false;
  }

  /**
   * Resetea todos los identificadores
   *
   * @returns {number} Número de identificadores reseteados
   */
  resetAll() {
    const count = this.requests.size;
    this.requests.clear();
    log.info(`RateLimiter: todos los identificadores reseteados (${count})`);
    return count;
  }

  /**
   * Obtiene estadísticas del rate limiter
   *
   * @returns {Object} Estadísticas
   * @returns {number} returns.totalIdentifiers - Total de identificadores activos
   * @returns {number} returns.maxRequests - Máximo de requests permitidas
   * @returns {number} returns.windowMs - Tamaño de la ventana en ms
   */
  getStats() {
    return {
      totalIdentifiers: this.requests.size,
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
    };
  }
}

module.exports = { RateLimiter };
