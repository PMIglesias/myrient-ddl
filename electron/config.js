/**
 * Configuración centralizada de la aplicación
 * Todos los valores configurables en un solo lugar
 * 
 * v2.0 - Incluye configuración de descargas fragmentadas (Block 2)
 */

const path = require('path');
const { app } = require('electron');

// Rutas de la aplicación
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config');

module.exports = {
    // =====================
    // CONFIGURACIÓN DE RED
    // =====================
    network: {
        /** Timeout para requests HTTP (HEAD, GET) en ms */
        timeout: 30000,
        
        /** Delay base para reintentos (se multiplica exponencialmente) en ms */
        retryDelay: 1000,
        
        /** Máximo de reintentos por operación de red */
        maxRetries: 3,
    },

    // =====================
    // CONFIGURACIÓN DE DESCARGAS
    // =====================
    downloads: {
        /** Máximo de descargas simultáneas */
        maxConcurrent: 3,
        
        /** Tiempo para considerar una descarga "zombie" en ms (5 minutos) */
        staleTimeout: 300000,
        
        /** Intervalo de actualización de progreso en ms */
        progressUpdateInterval: 500,
        
        /** Timeout para procesar la cola en ms (10 segundos) */
        queueProcessingTimeout: 10000,
        
        /** Delay después de completar/cancelar para procesar cola en ms */
        queueProcessDelay: 100,
        
        /** Timeout para adquirir lock en ms */
        lockTimeout: 5000,
        
        /** Intervalo para verificar lock en ms */
        lockCheckInterval: 50,

        // =====================
        // DESCARGAS FRAGMENTADAS (CHUNKED)
        // Block 2 - Multi-thread con Range requests
        // =====================
        chunked: {
            /** 
             * Umbral de tamaño para activar descarga fragmentada (bytes)
             * Archivos mayores a este tamaño usarán chunks paralelos
             * Default: 25 MB
             */
            sizeThreshold: 25 * 1024 * 1024,

            /**
             * Número de chunks por defecto para archivos grandes
             * Se ajusta automáticamente según el tamaño del archivo
             */
            defaultChunks: 4,

            /**
             * Máximo número de chunks permitido
             * Más chunks = más conexiones paralelas = potencialmente más velocidad
             * Pero también más overhead y uso de recursos
             */
            maxChunks: 16,

            /**
             * Mínimo número de chunks (incluso para archivos pequeños sobre el umbral)
             */
            minChunks: 2,

            /**
             * Tamaño mínimo de cada chunk (bytes)
             * Evita crear demasiados chunks pequeños
             * Default: 5 MB
             */
            minChunkSize: 5 * 1024 * 1024,

            /**
             * Máximo de chunks descargando simultáneamente por archivo
             * Limita el uso de conexiones para no saturar
             */
            maxConcurrentChunks: 4,

            /**
             * Reintentos por chunk individual antes de fallar
             */
            chunkRetries: 3,

            /**
             * Verificar soporte de Range requests antes de fragmentar
             * Si el servidor no soporta Range, usa descarga simple
             */
            checkRangeSupport: true,

            /**
             * Timeout para verificar soporte de Range (ms)
             */
            rangeSupportTimeout: 10000,

            /**
             * Forzar descarga simple (desactivar chunks)
             * Útil para debugging o servidores problemáticos
             */
            forceSimpleDownload: false,

            /**
             * Intervalo de actualización de progreso por chunk (ms)
             * Más frecuente = UI más responsive pero más CPU
             */
            chunkProgressInterval: 200,

            /**
             * Eliminar archivos temporales de chunks al completar
             * Si es false, se mantienen hasta confirmar integridad
             */
            cleanupOnComplete: true,

            /**
             * Preservar chunks parciales al pausar/cancelar
             * Permite reanudación más rápida
             */
            preserveOnPause: true,
        },
    },

    // =====================
    // CONFIGURACIÓN DE UI
    // =====================
    ui: {
        /** Throttle para actualizaciones de progreso IPC en ms */
        progressThrottle: 250,
        
        /** Debounce para búsqueda en ms */
        searchDebounce: 300,
    },

    // =====================
    // RUTAS
    // =====================
    paths: {
        userDataPath,
        configPath,
        /** Base de datos de índice Myrient (solo lectura) */
        dbPath: app.isPackaged
            ? path.join(process.resourcesPath, 'myrient.db')
            : path.join(process.cwd(), 'resources', 'myrient.db'),
        compressed7zPath: app.isPackaged
            ? path.join(process.resourcesPath, 'myrient.7z')
            : path.join(process.cwd(), 'resources', 'myrient.7z'),
        /** Base de datos de cola de descargas (lectura/escritura) */
        queueDbPath: path.join(configPath, 'downloads.db'),
    },

    // =====================
    // SEGURIDAD
    // =====================
    security: {
        /** Hosts permitidos para descargas */
        allowedHosts: Object.freeze([
            'myrient.erista.me'
        ]),
    },

    // =====================
    // LÍMITES DE ARCHIVOS
    // =====================
    files: {
        /** Tamaño máximo de archivo permitido (50 GB) */
        maxFileSize: 50 * 1024 * 1024 * 1024,
        
        /** Margen en bytes para comparar tamaños de archivo (10 KB) */
        sizeMarginBytes: 10240,
    },

    // =====================
    // VENTANA
    // =====================
    window: {
        /** Ancho por defecto */
        defaultWidth: 1200,
        
        /** Alto por defecto */
        defaultHeight: 800,
    },
};
