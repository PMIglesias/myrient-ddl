/**
 * Clase base para todos los servicios
 * Proporciona funcionalidad común y estructura estándar
 */

const { logger } = require('../utils');

class BaseService {
    constructor(name) {
        this.name = name;
        this.log = logger.child(`Service:${name}`);
        this.initialized = false;
    }

    /**
     * Inicializa el servicio
     * Debe ser sobrescrito por las clases hijas
     */
    async initialize() {
        this.initialized = true;
        this.log.info('Servicio inicializado');
    }

    /**
     * Verifica si el servicio está inicializado
     */
    isInitialized() {
        return this.initialized;
    }

    /**
     * Limpia recursos del servicio
     * Debe ser sobrescrito por las clases hijas si es necesario
     */
    async destroy() {
        this.initialized = false;
        this.log.info('Servicio destruido');
    }

    /**
     * Maneja errores de forma consistente
     */
    handleError(error, context = '') {
        const message = context 
            ? `Error en ${this.name}${context ? ` - ${context}` : ''}: ${error.message}`
            : `Error en ${this.name}: ${error.message}`;
        
        this.log.error(message, error);
        return {
            success: false,
            error: error.message || 'Error desconocido',
            code: error.code,
            context
        };
    }

    /**
     * Crea una respuesta exitosa estandarizada
     */
    success(data = null, message = '') {
        return {
            success: true,
            data,
            message
        };
    }
}

module.exports = BaseService;
