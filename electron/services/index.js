/**
 * Índice de servicios
 * Exporta todos los servicios de la capa de lógica de negocio
 */

const BaseService = require('./BaseService');
const DownloadService = require('./DownloadService');
const QueueService = require('./QueueService');
const SearchService = require('./SearchService');
const FileService = require('./FileService');

/**
 * Factory para crear instancias de servicios
 * Proporciona una forma centralizada de inicializar y gestionar servicios
 */
class ServiceManager {
    constructor() {
        this.services = new Map();
        this.initialized = false;
    }

    /**
     * Inicializa todos los servicios
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        // Crear instancias de servicios
        const downloadService = new DownloadService();
        const queueService = new QueueService();
        const searchService = new SearchService();
        const fileService = new FileService();

        // Inicializar servicios
        await downloadService.initialize();
        await queueService.initialize();
        await searchService.initialize();
        await fileService.initialize();

        // Registrar servicios
        this.services.set('download', downloadService);
        this.services.set('queue', queueService);
        this.services.set('search', searchService);
        this.services.set('file', fileService);

        this.initialized = true;
    }

    /**
     * Obtiene un servicio por nombre
     * @param {string} name - Nombre del servicio
     * @returns {BaseService|null} - Instancia del servicio o null si no existe
     */
    get(name) {
        return this.services.get(name) || null;
    }

    /**
     * Obtiene el servicio de descargas
     * @returns {DownloadService}
     */
    getDownloadService() {
        return this.services.get('download');
    }

    /**
     * Obtiene el servicio de cola
     * @returns {QueueService}
     */
    getQueueService() {
        return this.services.get('queue');
    }

    /**
     * Obtiene el servicio de búsqueda
     * @returns {SearchService}
     */
    getSearchService() {
        return this.services.get('search');
    }

    /**
     * Obtiene el servicio de archivos
     * @returns {FileService}
     */
    getFileService() {
        return this.services.get('file');
    }

    /**
     * Destruye todos los servicios
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

// Crear instancia singleton
const serviceManager = new ServiceManager();

module.exports = {
    // Clases base
    BaseService,
    
    // Servicios individuales
    DownloadService,
    QueueService,
    SearchService,
    FileService,
    
    // Service Manager (singleton)
    ServiceManager,
    serviceManager
};
