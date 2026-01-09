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

        // NUEVAS OPCIONES OPTIMIZADAS
        connectTimeout: 10000,      // Timeout específico para conexión
        responseTimeout: 30000,     // Timeout para respuesta inicial
        idleTimeout: 60000,         // Timeout para conexiones idle
    },

    // =====================
    // CIRCUIT BREAKER
    // =====================
    circuitBreaker: {
        /** Habilitar Circuit Breaker para errores de red */
        enabled: true,

        /** Configuración para descargas simples */
        download: {
            /** Número de fallos antes de abrir el circuit */
            failureThreshold: 5,
            /** Número de éxitos para cerrar desde HALF_OPEN */
            successThreshold: 2,
            /** Tiempo en OPEN antes de intentar HALF_OPEN (ms) */
            timeout: 60000, // 60 segundos
            /** Tiempo para resetear contadores en CLOSED (ms) */
            resetTimeout: 60000, // 60 segundos
        },

        /** Configuración para chunks */
        chunk: {
            /** Número de fallos antes de abrir el circuit */
            failureThreshold: 10, // Más tolerante porque hay muchos chunks
            /** Número de éxitos para cerrar desde HALF_OPEN */
            successThreshold: 3,
            /** Tiempo en OPEN antes de intentar HALF_OPEN (ms) */
            timeout: 30000, // 30 segundos (más corto para chunks)
            /** Tiempo para resetear contadores en CLOSED (ms) */
            resetTimeout: 30000,
        },

        /** Configuración global por dominio/host */
        perHost: {
            /** Habilitar circuit breakers por host */
            enabled: true,
            /** Número de fallos antes de abrir el circuit por host */
            failureThreshold: 10,
            /** Tiempo en OPEN antes de intentar HALF_OPEN (ms) */
            timeout: 120000, // 2 minutos para hosts
        },
    },

    // =====================
    // CONFIGURACIÓN DE DESCARGAS
    // =====================
    downloads: {
        /** Máximo de descargas simultáneas */
        maxConcurrent: 3,
        
        /** Máximo de archivos permitidos en una descarga de carpeta */
        maxFilesPerFolder: 1000,
        
        /** Máximo de descargas permitidas en la cola */
        maxQueueSize: 1000,
        
        /** Tiempo para considerar una descarga "zombie" en ms (5 minutos) */
        staleTimeout: 300000,
        
        /** Intervalo de actualización de progreso en ms */
        progressUpdateInterval: 1000,
        
        /** Timeout para procesar la cola en ms (10 segundos) */
        queueProcessingTimeout: 10000,
        
        /** Delay después de completar/cancelar para procesar cola en ms */
        queueProcessDelay: 50,
        
        /** Timeout para adquirir lock en ms */
        lockTimeout: 5000,
        
        /** Intervalo para verificar lock en ms */
        lockCheckInterval: 25,

        /** Tamaño del buffer de escritura por defecto (1MB) */
        writeBufferSize: 1024 * 1024,

        /** Tamaño mínimo del buffer de escritura (256KB) */
        minWriteBufferSize: 256 * 1024,

        /** Tamaño máximo del buffer de escritura (16MB) */
        maxWriteBufferSize: 16 * 1024 * 1024,

        /** Habilitar ajuste dinámico de buffer según backpressure */
        adaptiveBufferSize: true,

        /** Umbral de backpressure para reducir tamaño de buffer (eventos por segundo) */
        backpressureEventThreshold: 10,

        /** Tiempo máximo en backpressure antes de reducir buffer (ms) */
        maxBackpressureDuration: 5000,

        /** Factor de reducción de buffer cuando hay backpressure (0.5 = reducir a la mitad) */
        bufferReductionFactor: 0.75,

        /** Factor de aumento de buffer cuando no hay backpressure (1.25 = aumentar 25%) */
        bufferIncreaseFactor: 1.25,

        // =====================
        // DESCARGAS FRAGMENTADAS (CHUNKED)
        // Multi-thread con Range requests
        // =====================
        chunked: {
            /** 
             * Umbral de tamaño para activar descarga fragmentada (bytes)
             * Archivos mayores a este tamaño usarán chunks paralelos
             * Default: 25 MB
             */
            sizeThreshold: 10 * 1024 * 1024,

            /**
             * Número de chunks por defecto para archivos grandes
             * Se ajusta automáticamente según el tamaño del archivo
             */
            defaultChunks: 8,

            /**
             * Máximo número de chunks permitido
             * Más chunks = más conexiones paralelas = potencialmente más velocidad
             * Pero también más overhead y uso de recursos
             */
            maxChunks: 32,

            /**
             * Mínimo número de chunks (incluso para archivos pequeños sobre el umbral)
             */
            minChunks: 2,

            /**
             * Tamaño mínimo de cada chunk (bytes)
             * Evita crear demasiados chunks pequeños
             * Default: 5 MB
             */
            minChunkSize: 2 * 1024 * 1024,

            /**
             * Máximo de chunks descargando simultáneamente por archivo
             * Limita el uso de conexiones para no saturar
             */
            maxConcurrentChunks: 8,

            /**
             * Reintentos por chunk individual antes de fallar
             */
            chunkRetries: 5,

            /**
             * Verificar soporte de Range requests antes de fragmentar
             * Si el servidor no soporta Range, usa descarga simple
             */
            checkRangeSupport: true,

            /**
             * Timeout para verificar soporte de Range (ms)
             */
            rangeSupportTimeout: 5000,

            /**
             * Forzar descarga simple (desactivar chunks)
             * Útil para debugging o el servidor culiao es problemático
             */
            forceSimpleDownload: false,

            /**
             * Intervalo de actualización de progreso por chunk (ms)
             * Más frecuente = UI más responsive pero más CPU
             */
            chunkProgressInterval: 500,

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
            
            /**
             * Habilitar concurrencia adaptativa
             * Ajusta automáticamente el número de chunks según velocidad
             */
            adaptiveConcurrency: true,

            /**
             * Pre-allocar espacio en disco antes de descargar
             * Reduce fragmentación
             */
            preallocateFile: true,

            /**
             * Intervalo para batch de actualizaciones a BD (ms)
             * En lugar de escribir cada progreso, se acumulan
             */
            dbBatchInterval: 2000,

            /**
             * Tamaño del buffer de escritura para chunks (1MB por defecto)
             * Se ajusta automáticamente según el tamaño del chunk
             */
            chunkWriteBufferSize: 1024 * 1024,

            /**
             * Buffer para fusión de chunks (16MB por defecto, reducido para evitar bloqueo)
             */
            mergeBufferSize: 16 * 1024 * 1024,

            /**
             * Tamaño de batch para procesamiento de merge (8MB)
             * Procesa en lotes para ceder control al event loop
             */
            mergeBatchSize: 8 * 1024 * 1024,

            /**
             * Intervalo para ceder control al event loop durante merge
             * Cede cada N operaciones de lectura/escritura
             */
            mergeYieldInterval: 10,

            /**
             * Velocidad objetivo por chunk para ajuste adaptativo
             */
            targetSpeedPerChunk: 5 * 1024 * 1024,

            /**
             * Umbral de backpressure para reducir concurrencia
             */
            backpressureThreshold: 5,

            /**
             * Usar Worker Thread para merge de chunks
             * Evita bloquear el event loop del main thread
             * Default: true
             */
            useWorkerThread: true,
        },
    },

    // =====================
    // CONFIGURACIÓN DE UI
    // =====================
    ui: {
        /** Throttle para actualizaciones de progreso IPC en ms */
        progressThrottle: 200,
        
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
