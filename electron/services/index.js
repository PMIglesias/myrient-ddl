// Índice centralizado de servicios de la capa de lógica de negocio
// Exporta todos los servicios y el ServiceManager que coordina su inicialización y ciclo de vida

const BaseService = require('./BaseService');
const DownloadService = require('./DownloadService');
const QueueService = require('./QueueService');
const SearchService = require('./SearchService');
const FileService = require('./FileService');

// Factory centralizado para crear, inicializar y gestionar todas las instancias de servicios
// Proporciona acceso unificado a los servicios y garantiza que se inicialicen en el orden correcto
class ServiceManager {
    constructor() {
        this.services = new Map();
        this.initialized = false;
    }

    // Inicializa todos los servicios en el orden apropiado
    // Crea instancias, las inicializa, y las registra para acceso posterior
    // Retorna Promise que se resuelve cuando todos los servicios están listos
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

    // Obtiene un servicio por su nombre clave
    // name: Nombre del servicio ('download', 'queue', 'search', 'file')
    // Retorna: Instancia del servicio o null si no existe
    get(name) {
        return this.services.get(name) || null;
    }

    // Obtiene el servicio de descargas que maneja la lógica de negocio de descargas
    // Retorna: Instancia de DownloadService o null si no está inicializado
    getDownloadService() {
        return this.services.get('download');
    }

    // Obtiene el servicio de cola que gestiona la lógica de ordenamiento y prioridades
    // Retorna: Instancia de QueueService o null si no está inicializado
    getQueueService() {
        return this.services.get('queue');
    }

    // Obtiene el servicio de búsqueda que maneja validación y normalización de búsquedas
    // Retorna: Instancia de SearchService o null si no está inicializado
    getSearchService() {
        return this.services.get('search');
    }

    // Obtiene el servicio de archivos que maneja operaciones con archivos y rutas
    // Retorna: Instancia de FileService o null si no está inicializado
    getFileService() {
        return this.services.get('file');
    }

    // Destruye todos los servicios y libera sus recursos
    // Ejecuta el método destroy de cada servicio si está disponible
    // Útil durante el cierre de la aplicación para limpieza ordenada
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

// Crear instancia singleton del ServiceManager
// Solo existe una instancia en toda la aplicación, proporcionando acceso global consistente
const serviceManager = new ServiceManager();

module.exports = {
    // Clase base que todas las clases de servicio extienden
    BaseService,
    
    // Clases de servicios individuales (exportadas para testing o uso directo si es necesario)
    DownloadService,
    QueueService,
    SearchService,
    FileService,
    
    // Clase ServiceManager y su instancia singleton
    // serviceManager es la instancia principal que debe usarse en toda la aplicación
    ServiceManager,
    serviceManager
};
