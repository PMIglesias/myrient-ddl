/**
 * SearchService - Lógica de negocio para búsquedas
 * 
 * Encapsula las reglas de negocio relacionadas con:
 * - Validación de términos de búsqueda
 * - Normalización de búsquedas
 * - Reglas de negocio para FTS vs LIKE
 * - Optimización de búsquedas
 */

const BaseService = require('./BaseService');
const { validateSearchTerm } = require('../utils');

class SearchService extends BaseService {
    constructor() {
        super('SearchService');
    }

    /**
     * Valida y normaliza un término de búsqueda según reglas de negocio
     * @param {string} searchTerm - Término de búsqueda
     * @returns {Object} - Resultado de validación
     */
    validateAndNormalizeSearchTerm(searchTerm) {
        try {
            // Usar la validación existente
            const validation = validateSearchTerm(searchTerm);

            if (!validation.valid) {
                return {
                    valid: false,
                    error: validation.error
                };
            }

            // Normalizar término
            const normalized = this.normalizeSearchTerm(validation.data);

            return {
                valid: true,
                data: normalized,
                original: searchTerm
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
                useOR: false
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
                useOR
            };

        } catch (error) {
            this.log.warn('Error normalizando opciones de búsqueda, usando defaults:', error.message);
            return {
                limit: 500,
                offset: 0,
                usePrefix: true,
                usePhrase: false,
                useOR: false
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
                previousOffset: hasPrevious ? Math.max(0, safeOffset - safeLimit) : null
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
                previousOffset: null
            };
        }
    }
}

module.exports = SearchService;
