/**
 * @fileoverview SearchService - Lógica de negocio para búsquedas
 * @module SearchService
 *
 * Encapsula las reglas de negocio relacionadas con:
 * - Validación de términos de búsqueda
 * - Normalización de búsquedas
 * - Reglas de negocio para FTS vs LIKE
 * - Optimización de búsquedas
 * - Cálculo de paginación
 * - Caché de resultados de búsqueda
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} SearchOptions
 * @property {number} [limit=500] - Número máximo de resultados (1-1000)
 * @property {number} [offset=0] - Número de resultados a omitir (paginación)
 * @property {boolean} [usePrefix=true] - Si usar búsqueda por prefijo (wildcard al final)
 * @property {boolean} [usePhrase=false] - Si buscar frase exacta
 * @property {boolean} [useOR=false] - Si usar operador OR en lugar de AND
 */

/**
 * @typedef {Object} PaginationInfo
 * @property {number} total - Total de resultados
 * @property {number} limit - Resultados por página
 * @property {number} offset - Resultados omitidos
 * @property {number} currentPage - Página actual (1-based)
 * @property {number} totalPages - Total de páginas
 * @property {boolean} hasNext - Si hay página siguiente
 * @property {boolean} hasPrevious - Si hay página anterior
 */

/**
 * @typedef {Object} CacheEntry
 * @property {Object} result - Resultado de la búsqueda almacenado
 * @property {number} timestamp - Timestamp de creación (ms)
 * @property {number} lastAccess - Timestamp del último acceso (ms)
 */

const BaseService = require('./BaseService');
const { validateSearchTerm } = require('../utils');

/**
 * Servicio de lógica de negocio para búsquedas
 *
 * Implementa las reglas de negocio relacionadas con validación, normalización
 * y optimización de búsquedas en el catálogo de Myrient.
 *
 * @class SearchService
 * @extends BaseService
 *
 * @example
 * const searchService = serviceManager.getSearchService();
 *
 * // Normalizar término de búsqueda
 * const normalized = searchService.normalizeSearchTerm('  archivo   zip  ');
 * // Resultado: 'archivo zip' (trim y espacios normalizados)
 *
 * // Normalizar opciones de búsqueda
 * const options = searchService.normalizeSearchOptions({
 *   limit: 100,
 *   offset: 50,
 *   usePrefix: true
 * });
 */
class SearchService extends BaseService {
  /**
   * Crea una nueva instancia de SearchService
   *
   * @constructor
   */
  constructor() {
    super('SearchService');
    // Configuración del caché
    this.cache = new Map(); // Map para almacenar entradas de caché (mantiene orden de inserción)
    this.cacheMaxSize = 100; // Número máximo de entradas en caché
    this.cacheTTL = 5 * 60 * 1000; // TTL por defecto: 5 minutos (300000 ms)
  }

  /**
   * Valida y normaliza un término de búsqueda según reglas de negocio
   *
   * Valida el término usando las funciones de validación existentes y luego
   * lo normaliza según las reglas de negocio (trim, espacios múltiples, etc.).
   *
   * @param {string} searchTerm - Término de búsqueda a validar y normalizar
   * @returns {Object} Resultado de validación con término normalizado: { valid: boolean, data?: string, error?: string }
   *
   * @example
   * // Validar y normalizar término válido
   * const result = searchService.validateAndNormalizeSearchTerm('  archivo   zip  ');
   * // result.valid = true
   * // result.data = 'archivo zip' (normalizado)
   *
   * // Validar término inválido (muy corto)
   * const invalid = searchService.validateAndNormalizeSearchTerm('a');
   * // invalid.valid = false
   * // invalid.error = 'Término de búsqueda debe tener al menos 2 caracteres'
   */
  validateAndNormalizeSearchTerm(searchTerm) {
    try {
      // Usar la validación existente
      const validation = validateSearchTerm(searchTerm);

      if (!validation.valid) {
        return {
          valid: false,
          error: validation.error,
        };
      }

      // Normalizar término
      const normalized = this.normalizeSearchTerm(validation.data);

      return {
        valid: true,
        data: normalized,
        original: searchTerm,
      };
    } catch (error) {
      return this.handleError(error, 'validateAndNormalizeSearchTerm');
    }
  }

  /**
   * Normaliza un término de búsqueda según reglas de negocio
   * @param {string} term - Término de búsqueda
   * @returns {string} - Término normalizado
   */
  normalizeSearchTerm(term) {
    try {
      if (!term || typeof term !== 'string') {
        return '';
      }

      // Trim y normalizar espacios
      let normalized = term.trim();

      // Normalizar espacios múltiples
      normalized = normalized.replace(/\s+/g, ' ');

      // Reglas de negocio:
      // - Términos muy cortos (< 2 caracteres) se consideran inválidos
      // - Términos largos se truncan (si es necesario)
      const maxLength = 200; // Longitud máxima permitida

      if (normalized.length > maxLength) {
        normalized = normalized.substring(0, maxLength).trim();
      }

      return normalized;
    } catch (error) {
      this.log.warn('Error normalizando término de búsqueda:', error.message);
      return term || ''; // Retornar original en caso de error
    }
  }

  /**
   * Determina las opciones de búsqueda según reglas de negocio
   * @param {Object} options - Opciones de búsqueda
   * @returns {Object} - Opciones normalizadas
   */
  normalizeSearchOptions(options = {}) {
    try {
      const defaultOptions = {
        limit: 500,
        offset: 0,
        usePrefix: true,
        usePhrase: false,
        useOR: false,
      };

      // Validar y normalizar limit
      let limit = parseInt(options.limit);
      if (isNaN(limit) || limit < 1) {
        limit = defaultOptions.limit;
      }
      limit = Math.min(Math.max(limit, 1), 1000); // Entre 1 y 1000

      // Validar y normalizar offset
      let offset = parseInt(options.offset);
      if (isNaN(offset) || offset < 0) {
        offset = defaultOptions.offset;
      }
      offset = Math.max(offset, 0);

      // Validar flags booleanos
      const usePrefix = options.usePrefix !== false; // Default true
      const usePhrase = options.usePhrase === true; // Default false
      const useOR = options.useOR === true; // Default false

      return {
        limit,
        offset,
        usePrefix,
        usePhrase,
        useOR,
      };
    } catch (error) {
      this.log.warn('Error normalizando opciones de búsqueda, usando defaults:', error.message);
      return {
        limit: 500,
        offset: 0,
        usePrefix: true,
        usePhrase: false,
        useOR: false,
      };
    }
  }

  /**
   * Determina si una búsqueda debe usar FTS o LIKE según reglas de negocio
   * @param {string} searchTerm - Término de búsqueda
   * @param {Object} options - Opciones de búsqueda
   * @returns {string} - Estrategia a usar: 'fts' o 'like'
   */
  determineSearchStrategy(searchTerm, options = {}) {
    try {
      // Reglas de negocio:
      // - FTS es preferido para búsquedas normales
      // - LIKE se usa como fallback si FTS no está disponible o falla
      // - LIKE se prefiere para términos muy específicos (exactos)

      // Si el término es muy corto, usar LIKE (más rápido)
      if (searchTerm.length < 2) {
        return 'like';
      }

      // Si se requiere búsqueda de frase exacta, FTS es mejor
      if (options.usePhrase) {
        return 'fts';
      }

      // Si se requiere búsqueda con OR, FTS es mejor
      if (options.useOR) {
        return 'fts';
      }

      // Por defecto, usar FTS (mejor rendimiento y relevancia)
      return 'fts';
    } catch (error) {
      this.log.warn('Error determinando estrategia de búsqueda, usando FTS:', error.message);
      return 'fts'; // Default seguro
    }
  }

  /**
   * Prepara un término de búsqueda para FTS según reglas de negocio
   * @param {string} term - Término de búsqueda
   * @param {Object} options - Opciones de búsqueda
   * @returns {string} - Término preparado para FTS
   */
  prepareFTSTerm(term, options = {}) {
    try {
      if (!term || typeof term !== 'string') {
        return '';
      }

      const normalized = this.normalizeSearchTerm(term);

      // Si es búsqueda de frase exacta
      if (options.usePhrase) {
        // Escapar comillas y envolver en comillas
        const escaped = normalized.replace(/"/g, '""');
        return `"${escaped}"`;
      }

      // Si es búsqueda con OR
      if (options.useOR) {
        const words = normalized.split(/\s+/).filter(w => w.length > 0);
        return words.join(' OR ');
      }

      // Búsqueda normal: usar prefijos si está habilitado
      if (options.usePrefix) {
        const words = normalized.split(/\s+/).filter(w => w.length > 0);
        return words.map(w => `${w}*`).join(' ');
      }

      // Sin prefijos: búsqueda exacta de palabras
      return normalized;
    } catch (error) {
      this.log.warn('Error preparando término FTS, usando término original:', error.message);
      return term || '';
    }
  }

  /**
   * Calcula límites de paginación según reglas de negocio
   * @param {number} total - Total de resultados
   * @param {number} limit - Límite solicitado
   * @param {number} offset - Offset solicitado
   * @returns {Object} - Información de paginación
   */
  calculatePagination(total, limit, offset) {
    try {
      const safeTotal = Math.max(0, total || 0);
      const safeLimit = Math.max(1, limit || 500);
      const safeOffset = Math.max(0, offset || 0);

      const totalPages = Math.ceil(safeTotal / safeLimit);
      const currentPage = Math.floor(safeOffset / safeLimit) + 1;
      const hasNext = safeOffset + safeLimit < safeTotal;
      const hasPrevious = safeOffset > 0;

      return {
        total: safeTotal,
        limit: safeLimit,
        offset: safeOffset,
        totalPages,
        currentPage,
        hasNext,
        hasPrevious,
        nextOffset: hasNext ? safeOffset + safeLimit : null,
        previousOffset: hasPrevious ? Math.max(0, safeOffset - safeLimit) : null,
      };
    } catch (error) {
      this.log.warn('Error calculando paginación:', error.message);
      return {
        total: 0,
        limit: limit || 500,
        offset: offset || 0,
        totalPages: 0,
        currentPage: 1,
        hasNext: false,
        hasPrevious: false,
        nextOffset: null,
        previousOffset: null,
      };
    }
  }

  // =====================
  // CACHÉ DE BÚSQUEDAS
  // =====================

  /**
   * Genera una clave única para el caché basada en el término y las opciones de búsqueda
   * @param {string} searchTerm - Término de búsqueda normalizado
   * @param {Object} options - Opciones de búsqueda normalizadas
   * @returns {string} - Clave única para el caché
   * @private
   */
  _generateCacheKey(searchTerm, options) {
    try {
      const normalizedTerm = this.normalizeSearchTerm(searchTerm);
      const normalizedOptions = this.normalizeSearchOptions(options);

      // Crear clave serializada con término y opciones relevantes
      // Solo incluir opciones que afecten los resultados (limit y offset afectan la paginación)
      const keyParts = [
        normalizedTerm.toLowerCase(),
        normalizedOptions.limit,
        normalizedOptions.offset,
        normalizedOptions.usePrefix ? '1' : '0',
        normalizedOptions.usePhrase ? '1' : '0',
        normalizedOptions.useOR ? '1' : '0',
      ];

      return keyParts.join('|');
    } catch (error) {
      this.log.warn('Error generando clave de caché:', error.message);
      return `${searchTerm}|${JSON.stringify(options)}`;
    }
  }

  /**
   * Obtiene un resultado de búsqueda del caché si existe y no está expirado
   * @param {string} searchTerm - Término de búsqueda
   * @param {Object} options - Opciones de búsqueda
   * @returns {Object|null} - Resultado de búsqueda del caché o null si no existe o está expirado
   */
  getFromCache(searchTerm, options = {}) {
    try {
      const key = this._generateCacheKey(searchTerm, options);
      const entry = this.cache.get(key);

      if (!entry) {
        return null;
      }

      // Verificar si la entrada está expirada
      const now = Date.now();
      const age = now - entry.timestamp;

      if (age > this.cacheTTL) {
        // Entrada expirada, eliminarla
        this.cache.delete(key);
        this.log.debug(`Entrada de caché expirada eliminada: "${searchTerm}" (edad: ${Math.round(age / 1000)}s)`);
        return null;
      }

      // Actualizar timestamp de último acceso (para estadísticas)
      entry.lastAccess = now;

      // Mover al final del Map (LRU: el más recientemente usado va al final)
      this.cache.delete(key);
      this.cache.set(key, entry);

      this.log.debug(`Resultado obtenido del caché: "${searchTerm}" (edad: ${Math.round(age / 1000)}s)`);
      return entry.result;
    } catch (error) {
      this.log.warn('Error obteniendo del caché:', error.message);
      return null;
    }
  }

  /**
   * Guarda un resultado de búsqueda en el caché
   * @param {string} searchTerm - Término de búsqueda
   * @param {Object} options - Opciones de búsqueda
   * @param {Object} result - Resultado de búsqueda a guardar
   */
  setCache(searchTerm, options = {}, result) {
    try {
      if (!result || !result.success) {
        // No guardar resultados fallidos en el caché
        return;
      }

      const key = this._generateCacheKey(searchTerm, options);
      const now = Date.now();

      // Si la clave ya existe, actualizarla (mover al final)
      if (this.cache.has(key)) {
        this.cache.delete(key);
      }

      // Crear nueva entrada
      const entry = {
        result: { ...result }, // Clonar resultado para evitar referencias
        timestamp: now,
        lastAccess: now,
      };

      // Si el caché está lleno, eliminar la entrada más antigua (primera del Map)
      if (this.cache.size >= this.cacheMaxSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
        this.log.debug(`Caché lleno, eliminada entrada más antigua: ${firstKey}`);
      }

      // Agregar nueva entrada (al final del Map)
      this.cache.set(key, entry);
      this.log.debug(`Resultado guardado en caché: "${searchTerm}" (tamaño caché: ${this.cache.size})`);
    } catch (error) {
      this.log.warn('Error guardando en caché:', error.message);
    }
  }

  /**
   * Limpia entradas expiradas del caché
   * @returns {number} - Número de entradas eliminadas
   */
  cleanExpiredCache() {
    try {
      const now = Date.now();
      let removedCount = 0;
      const keysToRemove = [];

      // Recopilar claves de entradas expiradas
      for (const [key, entry] of this.cache.entries()) {
        const age = now - entry.timestamp;
        if (age > this.cacheTTL) {
          keysToRemove.push(key);
        }
      }

      // Eliminar entradas expiradas
      for (const key of keysToRemove) {
        this.cache.delete(key);
        removedCount++;
      }

      if (removedCount > 0) {
        this.log.debug(`Limpieza de caché: ${removedCount} entradas expiradas eliminadas`);
      }

      return removedCount;
    } catch (error) {
      this.log.warn('Error limpiando caché expirado:', error.message);
      return 0;
    }
  }

  /**
   * Limpia todo el caché
   * @returns {number} - Número de entradas eliminadas
   */
  clearCache() {
    try {
      const size = this.cache.size;
      this.cache.clear();
      this.log.info(`Caché limpiado: ${size} entradas eliminadas`);
      return size;
    } catch (error) {
      this.log.warn('Error limpiando caché:', error.message);
      return 0;
    }
  }

  /**
   * Obtiene estadísticas del caché
   * @returns {Object} - Estadísticas del caché
   */
  getCacheStats() {
    try {
      const now = Date.now();
      let expiredCount = 0;
      let totalAge = 0;

      for (const entry of this.cache.values()) {
        const age = now - entry.timestamp;
        totalAge += age;
        if (age > this.cacheTTL) {
          expiredCount++;
        }
      }

      const avgAge = this.cache.size > 0 ? totalAge / this.cache.size : 0;

      return {
        size: this.cache.size,
        maxSize: this.cacheMaxSize,
        ttl: this.cacheTTL,
        expiredEntries: expiredCount,
        averageAge: Math.round(avgAge),
        hitRate: 0, // Se puede calcular si se agrega contador de hits/misses
      };
    } catch (error) {
      this.log.warn('Error obteniendo estadísticas de caché:', error.message);
      return {
        size: 0,
        maxSize: this.cacheMaxSize,
        ttl: this.cacheTTL,
        expiredEntries: 0,
        averageAge: 0,
        hitRate: 0,
      };
    }
  }
}

module.exports = SearchService;
