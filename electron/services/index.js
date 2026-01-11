/**
 * @fileoverview Índice centralizado de servicios de la capa de lógica de negocio
 * @module services
 *
 * Exporta todos los servicios y el ServiceManager que coordina su inicialización
 * y ciclo de vida. Proporciona una instancia singleton del ServiceManager para
 * acceso global a todos los servicios desde cualquier parte de la aplicación.
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

const BaseService = require('./BaseService');
const DownloadService = require('./DownloadService');
const QueueService = require('./QueueService');
const SearchService = require('./SearchService');
const FileService = require('./FileService');

/**
 * Factory centralizado para crear, inicializar y gestionar todas las instancias de servicios
 *
 * Proporciona acceso unificado a los servicios y garantiza que se inicialicen en el
 * orden correcto. Mantiene una instancia singleton que debe ser inicializada antes
 * de usar cualquier servicio.
 *
 * @class ServiceManager
 *
 * @example
 * const { serviceManager } = require('./services');
 *
 * // Inicializar todos los servicios
 * await serviceManager.initialize();
 *
 * // Obtener servicios individuales
 * const downloadService = serviceManager.getDownloadService();
 * const searchService = serviceManager.getSearchService();
 *
 * // Usar servicios
 * const result = await downloadService.startDownload({ /* params *\/ });
 *
 * // Limpiar recursos al cerrar
 * await serviceManager.destroy();
 */
class ServiceManager {
  /**
   * Crea una nueva instancia de ServiceManager
   *
   * @constructor
   */
  constructor() {
    this.services = new Map();
    this.initialized = false;
  }

  /**
   * Inicializa todos los servicios en el orden apropiado
   *
   * Crea instancias de cada servicio, las inicializa de forma asíncrona, y las
   * registra para acceso posterior. Garantiza que todos los servicios estén listos
   * antes de permitir su uso.
   *
   * @returns {Promise<void>} Se resuelve cuando todos los servicios están inicializados
   *
   * @example
   * await serviceManager.initialize();
   * // Ahora todos los servicios están disponibles
   * const downloadService = serviceManager.getDownloadService();
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    // Crear instancias de cada servicio siguiendo el patrón de herencia de BaseService
    const downloadService = new DownloadService();
    const queueService = new QueueService();
    const searchService = new SearchService();
    const fileService = new FileService();

    // Inicializar cada servicio asíncronamente (algunos pueden requerir operaciones async)
    await downloadService.initialize();
    await queueService.initialize();
    await searchService.initialize();
    await fileService.initialize();

    // Registrar servicios en el Map usando claves descriptivas para acceso rápido
    this.services.set('download', downloadService);
    this.services.set('queue', queueService);
    this.services.set('search', searchService);
    this.services.set('file', fileService);

    this.initialized = true;
  }

  /**
   * Obtiene un servicio por su nombre clave
   *
   * @param {string} name - Nombre del servicio: 'download' | 'queue' | 'search' | 'file'
   * @returns {BaseService|null} Instancia del servicio o null si no existe o no está inicializado
   *
   * @example
   * const service = serviceManager.get('download');
   * if (service) {
   *   // Usar el servicio
   * }
   */
  get(name) {
    return this.services.get(name) || null;
  }

  /**
   * Obtiene el servicio de descargas que maneja la lógica de negocio de descargas
   *
   * @returns {DownloadService|null} Instancia de DownloadService o null si no está inicializado
   *
   * @example
   * const downloadService = serviceManager.getDownloadService();
   * if (downloadService) {
   *   await downloadService.startDownload({ id: 12345, title: 'archivo.zip' });
   * }
   */
  getDownloadService() {
    return this.services.get('download');
  }

  /**
   * Obtiene el servicio de cola que gestiona la lógica de ordenamiento y prioridades
   *
   * @returns {QueueService|null} Instancia de QueueService o null si no está inicializado
   */
  getQueueService() {
    return this.services.get('queue');
  }

  /**
   * Obtiene el servicio de búsqueda que maneja validación y normalización de búsquedas
   *
   * @returns {SearchService|null} Instancia de SearchService o null si no está inicializado
   */
  getSearchService() {
    return this.services.get('search');
  }

  /**
   * Obtiene el servicio de archivos que maneja operaciones con archivos y rutas
   *
   * @returns {FileService|null} Instancia de FileService o null si no está inicializado
   */
  getFileService() {
    return this.services.get('file');
  }

  /**
   * Destruye todos los servicios y libera sus recursos
   *
   * Ejecuta el método destroy() de cada servicio si está disponible. Útil durante
   * el cierre de la aplicación para limpieza ordenada de recursos (cerrar conexiones,
   * cancelar timers, etc.).
   *
   * @returns {Promise<void>} Se resuelve cuando todos los servicios han sido destruidos
   *
   * @example
   * // Limpiar recursos al cerrar la aplicación
   * app.on('before-quit', async () => {
   *   await serviceManager.destroy();
   * });
   */
  async destroy() {
    const destroyPromises = Array.from(this.services.values()).map(service => {
      if (service && typeof service.destroy === 'function') {
        return service.destroy();
      }
      return Promise.resolve();
    });

    await Promise.all(destroyPromises);
    this.services.clear();
    this.initialized = false;
  }
}

/**
 * Instancia singleton del ServiceManager
 *
 * Solo existe una instancia en toda la aplicación, proporcionando acceso global
 * consistente a todos los servicios. Esta es la instancia que debe usarse en toda
 * la aplicación.
 *
 * @type {ServiceManager}
 */
const serviceManager = new ServiceManager();

/**
 * Exporta todas las clases de servicios y el ServiceManager singleton
 *
 * - **BaseService**: Clase base que todas las clases de servicio extienden
 * - **DownloadService, QueueService, SearchService, FileService**: Clases individuales
 *   (exportadas para testing o uso directo si es necesario)
 * - **ServiceManager**: Clase del manager (útil para testing o creación de instancias separadas)
 * - **serviceManager**: Instancia singleton principal que debe usarse en toda la aplicación
 */
module.exports = {
  BaseService,
  DownloadService,
  QueueService,
  SearchService,
  FileService,
  ServiceManager,
  serviceManager,
};
