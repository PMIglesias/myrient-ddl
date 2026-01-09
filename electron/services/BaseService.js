// Clase base abstracta para todos los servicios de la capa de lógica de negocio
// Proporciona funcionalidad común, estructura estándar, y métodos de utilidad compartidos
// Las clases hijas extienden esta clase para implementar lógica específica de cada servicio

const { logger } = require('../utils');

class BaseService {
    // Constructor base que inicializa propiedades comunes a todos los servicios
    // name: Nombre identificador del servicio usado para logging y debugging
    constructor(name) {
        this.name = name;
        this.log = logger.child(`Service:${name}`);
        this.initialized = false;
    }

    // Inicializa el servicio con cualquier configuración o setup necesario
    // Debe ser sobrescrito por las clases hijas para implementar inicialización específica
    // Retorna Promise que se resuelve cuando la inicialización está completa
    async initialize() {
        this.initialized = true;
        this.log.info('Servicio inicializado');
    }

    // Verifica si el servicio ha sido inicializado correctamente
    // Útil para validar que un servicio está listo antes de usarlo
    // Retorna: true si está inicializado, false en caso contrario
    isInitialized() {
        return this.initialized;
    }

    // Limpia recursos del servicio y lo marca como no inicializado
    // Debe ser sobrescrito por las clases hijas si requieren limpieza específica (cerrar conexiones, cancelar timers, etc.)
    // Retorna Promise que se resuelve cuando la limpieza está completa
    async destroy() {
        this.initialized = false;
        this.log.info('Servicio destruido');
    }

    // Maneja errores de forma consistente en todos los servicios
    // Registra el error con contexto y retorna un formato estandarizado de respuesta de error
    // error: Objeto Error que contiene el error ocurrido
    // context: String opcional que describe el contexto donde ocurrió el error
    // Retorna: Objeto estandarizado con success: false, error message, code, y context
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

    // Crea una respuesta exitosa con formato estandarizado usado en todos los servicios
    // Facilita consistencia en las respuestas de métodos de servicios
    // data: Datos opcionales a incluir en la respuesta exitosa
    // message: Mensaje opcional que describe la operación exitosa
    // Retorna: Objeto estandarizado con success: true, data, y message
    success(data = null, message = '') {
        return {
            success: true,
            data,
            message
        };
    }
}

module.exports = BaseService;
