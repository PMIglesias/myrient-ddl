/**
 * @fileoverview Clase base abstracta para todos los servicios de la capa de lógica de negocio
 * @module BaseService
 *
 * Proporciona funcionalidad común, estructura estándar, y métodos de utilidad compartidos.
 * Las clases hijas extienden esta clase para implementar lógica específica de cada servicio.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} ServiceResponse
 * @property {boolean} success - Si la operación fue exitosa
 * @property {*} [data] - Datos de respuesta (si success es true)
 * @property {string} [message] - Mensaje descriptivo (si success es true)
 * @property {string} [error] - Mensaje de error (si success es false)
 * @property {string} [code] - Código de error (si success es false)
 * @property {string} [context] - Contexto donde ocurrió el error
 */

const { logger } = require('../utils');
const { ERRORS } = require('../constants/errors');

/**
 * Clase base abstracta para todos los servicios
 *
 * Proporciona una estructura común y métodos de utilidad para todos los servicios.
 * Incluye manejo de errores estandarizado, logging, y gestión del ciclo de vida.
 *
 * @abstract
 * @class BaseService
 *
 * @example
 * // Crear un servicio personalizado
 * class MyService extends BaseService {
 *   constructor() {
 *     super('MyService');
 *   }
 *
 *   async initialize() {
 *     await super.initialize();
 *     // Inicialización específica del servicio
 *   }
 *
 *   doSomething() {
 *     try {
 *       // Lógica del servicio
 *       return this.success({ result: 'done' }, 'Operación exitosa');
 *     } catch (error) {
 *       return this.handleError(error, 'doSomething');
 *     }
 *   }
 * }
 */
class BaseService {
  /**
   * Crea una nueva instancia de BaseService
   *
   * Inicializa propiedades comunes a todos los servicios, incluyendo
   * el logger con scope específico y el estado de inicialización.
   *
   * @param {string} name - Nombre identificador del servicio (usado para logging)
   *
   * @example
   * const service = new BaseService('MyService');
   * // service.log es un logger con scope 'Service:MyService'
   * // service.initialized es false
   */
  constructor(name) {
    this.name = name;
    this.log = logger.child(`Service:${name}`);
    this.initialized = false;
  }

  /**
   * Inicializa el servicio con cualquier configuración o setup necesario
   *
   * Debe ser sobrescrito por las clases hijas para implementar inicialización específica.
   * La implementación base solo marca el servicio como inicializado. Las clases hijas
   * deben llamar a `super.initialize()` y luego agregar su lógica específica.
   *
   * @returns {Promise<void>}
   *
   * @example
   * async initialize() {
   *   await super.initialize(); // Marca como inicializado
   *   // Tu lógica de inicialización aquí
   *   await this.setupConnections();
   *   await this.loadConfig();
   * }
   */
  async initialize() {
    this.initialized = true;
    this.log.info('Servicio inicializado');
  }

  /**
   * Verifica si el servicio ha sido inicializado correctamente
   *
   * Útil para validar que un servicio está listo antes de usarlo.
   *
   * @returns {boolean} true si está inicializado, false en caso contrario
   *
   * @example
   * const service = new MyService();
   * await service.initialize();
   *
   * if (service.isInitialized()) {
   *   // El servicio está listo para usar
   *   service.doSomething();
   * } else {
   *   console.error('Servicio no inicializado');
   * }
   */
  isInitialized() {
    return this.initialized;
  }

  /**
   * Limpia recursos del servicio y lo marca como no inicializado
   *
   * Debe ser sobrescrito por las clases hijas si requieren limpieza específica
   * (cerrar conexiones, cancelar timers, liberar memoria, etc.).
   * La implementación base solo marca el servicio como no inicializado.
   *
   * @returns {Promise<void>}
   *
   * @example
   * async destroy() {
   *   // Limpiar recursos específicos
   *   this.timer?.clearInterval();
   *   this.connection?.close();
   *
   *   // Llamar a la implementación base
   *   await super.destroy();
   * }
   */
  async destroy() {
    this.initialized = false;
    this.log.info('Servicio destruido');
  }

  /**
   * Maneja errores de forma consistente en todos los servicios
   *
   * Registra el error con contexto y retorna un formato estandarizado de respuesta de error.
   * Facilita el manejo de errores uniforme en todos los servicios.
   *
   * @param {Error} error - Objeto Error que contiene el error ocurrido
   * @param {string} [context=''] - Contexto opcional que describe dónde ocurrió el error
   * @returns {ServiceResponse} Objeto estandarizado con success: false, error, code, y context
   *
   * @example
   * try {
   *   // Operación que puede fallar
   *   const result = await riskyOperation();
   *   return this.success(result);
   * } catch (error) {
   *   // Manejo automático de errores
   *   return this.handleError(error, 'riskyOperation');
   *   // Retorna: { success: false, error: 'mensaje', code: 'ERROR_CODE', context: 'riskyOperation' }
   * }
   */
  handleError(error, context = '') {
    const message = context
      ? `Error en ${this.name}${context ? ` - ${context}` : ''}: ${error.message}`
      : `Error en ${this.name}: ${error.message}`;

    this.log.error(message, error);
    return {
      success: false,
      error: error.message || ERRORS.GENERAL.UNKNOWN,
      code: error.code,
      context,
    };
  }

  /**
   * Crea una respuesta exitosa con formato estandarizado
   *
   * Facilita consistencia en las respuestas de métodos de servicios.
   * Todos los métodos de servicios deben usar este formato para respuestas exitosas.
   *
   * @param {*} [data=null] - Datos opcionales a incluir en la respuesta exitosa
   * @param {string} [message=''] - Mensaje opcional que describe la operación exitosa
   * @returns {ServiceResponse} Objeto estandarizado con success: true, data, y message
   *
   * @example
   * // Retornar resultado exitoso con datos
   * const result = await this.processData();
   * return this.success(result, 'Datos procesados correctamente');
   * // Retorna: { success: true, data: result, message: 'Datos procesados correctamente' }
   *
   * // Retornar solo confirmación de éxito
   * return this.success(null, 'Operación completada');
   * // Retorna: { success: true, data: null, message: 'Operación completada' }
   */
  success(data = null, message = '') {
    return {
      success: true,
      data,
      message,
    };
  }
}

module.exports = BaseService;
