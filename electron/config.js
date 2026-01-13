// Configuración centralizada de la aplicación
// Contiene todos los valores configurables en un solo lugar para facilitar mantenimiento
// v2.0: Incluye configuración completa para descargas fragmentadas con Range requests

const path = require('path');
const { app } = require('electron');

// Calcula las rutas base de la aplicación donde se almacenarán datos y configuración
const userDataPath = app.getPath('userData');
const configPath = path.join(userDataPath, 'config');

module.exports = {
  // Configuración de red y timeouts para operaciones HTTP
  network: {
    // Timeout general para todas las operaciones HTTP (HEAD, GET) en milisegundos
    timeout: 30000,

    // Delay base entre reintentos que se multiplica exponencialmente en cada intento
    // Ejemplo: intento 1 = 1000ms, intento 2 = 2000ms, intento 3 = 4000ms
    retryDelay: 1000,

    // Número máximo de reintentos antes de considerar fallida una operación de red
    maxRetries: 3,

    // Timeouts específicos para diferentes fases de la conexión HTTP
    // Timeout para establecer la conexión TCP inicial
    connectTimeout: 10000,
    // Timeout para recibir la primera respuesta del servidor después de enviar la request
    responseTimeout: 30000,
    // Timeout para conexiones que quedan inactivas sin recibir datos
    idleTimeout: 60000,
  },

  // Configuración del Circuit Breaker para prevenir sobrecarga cuando hay errores repetidos
  // El Circuit Breaker abre el circuito después de múltiples fallos y evita hacer más requests hasta que se recupere
  circuitBreaker: {
    // Habilitar o deshabilitar el sistema de Circuit Breaker globalmente
    enabled: true,

    // Configuración específica para descargas simples (no fragmentadas)
    download: {
      // Cantidad de fallos consecutivos antes de abrir el circuito y detener nuevas descargas
      failureThreshold: 5,
      // Cantidad de éxitos necesarios cuando el circuito está en estado HALF_OPEN para cerrarlo completamente
      successThreshold: 2,
      // Tiempo en milisegundos que el circuito permanece abierto antes de intentar entrar en estado HALF_OPEN
      timeout: 60000,
      // Tiempo en milisegundos para resetear los contadores de fallos cuando el circuito está cerrado
      resetTimeout: 60000,
    },

    // Configuración específica para chunks de descargas fragmentadas
    // Más tolerante porque hay muchos chunks y algunos fallos son esperados
    chunk: {
      // Mayor threshold porque los chunks tienen más oportunidades de fallar individualmente
      failureThreshold: 10,
      // Más éxitos requeridos para cerrar el circuito de chunks (mayor estabilidad)
      successThreshold: 3,
      // Timeout más corto para chunks porque necesitan recuperarse más rápido
      timeout: 30000,
      // Reset más rápido para chunks
      resetTimeout: 30000,
    },

    // Configuración para circuit breakers independientes por dominio/host
    // Permite aislar problemas de un servidor específico sin afectar otros hosts
    perHost: {
      // Habilitar circuit breakers individuales por host
      enabled: true,
      // Umbral de fallos por host antes de abrir su circuito específico
      failureThreshold: 10,
      // Timeout más largo para hosts porque su recuperación puede tomar más tiempo
      timeout: 120000,
    },
  },

  // Configuración general del sistema de descargas
  downloads: {
    // Cantidad máxima de descargas que se ejecutarán simultáneamente
    // Más descargas simultáneas = más velocidad total pero mayor uso de recursos
    maxConcurrent: 3,

    // Límite máximo de archivos permitidos en una sola descarga de carpeta completa
    // Previene descargas accidentales de carpetas con millones de archivos
    maxFilesPerFolder: 1000,

    // Tamaño máximo de la cola de descargas pendientes
    // Una vez alcanzado, no se aceptarán más descargas hasta que haya espacio
    maxQueueSize: 1000,

    // Tiempo en milisegundos sin actividad para considerar una descarga como "zombie"
    // Las descargas zombies son limpiadas automáticamente para liberar recursos
    staleTimeout: 300000,

    // Intervalo en milisegundos entre actualizaciones de progreso enviadas al frontend
    // Valores más bajos = UI más responsive pero mayor overhead de IPC
    progressUpdateInterval: 1000,

    // Timeout máximo en milisegundos para procesar un lote de la cola
    // Previene que el procesamiento de cola bloquee la aplicación indefinidamente
    queueProcessingTimeout: 10000,

    // Delay en milisegundos después de completar o cancelar una descarga antes de procesar la siguiente
    // Permite que el sistema se estabilice antes de iniciar nuevas descargas
    queueProcessDelay: 50,

    // Timeout máximo en milisegundos para adquirir un lock de procesamiento
    // Previene deadlocks si un lock nunca se libera
    lockTimeout: 5000,

    // Intervalo en milisegundos entre verificaciones de disponibilidad de lock
    // Balance entre responsividad y uso de CPU
    lockCheckInterval: 25,

    // Tamaño por defecto del buffer de escritura en bytes (1 MB)
    // Buffer más grande = menos escrituras a disco pero mayor uso de memoria
    writeBufferSize: 1024 * 1024,

    // Tamaño mínimo permitido del buffer de escritura en bytes (256 KB)
    // Límite inferior para evitar buffers demasiado pequeños que degraden rendimiento
    minWriteBufferSize: 256 * 1024,

    // Tamaño máximo permitido del buffer de escritura en bytes (16 MB)
    // Límite superior para evitar uso excesivo de memoria
    maxWriteBufferSize: 16 * 1024 * 1024,

    // Habilitar ajuste automático del tamaño de buffer basado en backpressure
    // Reduce el buffer si hay backpressure frecuente, lo aumenta si no hay problemas
    adaptiveBufferSize: true,

    // Cantidad de eventos de backpressure por segundo antes de considerar reducir el buffer
    // Más eventos = más probable que se reduzca el buffer
    backpressureEventThreshold: 10,

    // Tiempo máximo en milisegundos que se tolera estar en backpressure antes de reducir el buffer
    // Si el backpressure persiste más tiempo, se reduce el buffer
    maxBackpressureDuration: 5000,

    // Factor multiplicador para reducir el buffer cuando se detecta backpressure persistente
    // 0.75 = reducir a 75% del tamaño actual (reducción del 25%)
    bufferReductionFactor: 0.75,

    // Factor multiplicador para aumentar el buffer cuando no hay backpressure
    // 1.25 = aumentar a 125% del tamaño actual (aumento del 25%)
    bufferIncreaseFactor: 1.25,

    // Configuración de Bandwidth Shaping para equilibrar velocidades entre descargas
    // Distribuye el ancho de banda disponible usando porcentajes predefinidos (40%, 30%, 30%)
    bandwidth: {
      // Habilitar o deshabilitar el bandwidth shaping
      // Si está deshabilitado, las descargas usarán todo el ancho de banda disponible
      enabled: true,

      // Ancho de banda máximo en bytes por segundo (0 = auto-detección)
      // Si se establece 0 y autoDetect está habilitado, se medirá automáticamente
      // Si se establece un valor, se usará ese límite fijo
      maxBandwidthBytesPerSecond: 0, // 0 = auto-detección por defecto

      // Habilitar auto-detección de ancho de banda
      // Mide la velocidad real de las descargas para calcular el ancho de banda total disponible
      autoDetect: true,

      // Porcentajes de distribución para las primeras 3 descargas
      // Primera descarga: 40%, Segunda: 30%, Tercera: 30%
      // Si hay más de 3 descargas, el resto se distribuye equitativamente
      distributionPercentages: [40, 30, 30],

      // Intervalo de actualización de quotas en milisegundos
      // Valores más bajos = control más preciso pero mayor overhead de CPU
      // Valores más altos = menos overhead pero control menos preciso
      updateInterval: 100, // 100ms por defecto (buen balance)
    },

    // Configuración para descargas fragmentadas usando HTTP Range requests
    // Divide archivos grandes en múltiples fragmentos (chunks) que se descargan en paralelo
    // Mejora significativamente la velocidad para archivos grandes
    chunked: {
      // Tamaño mínimo en bytes para activar descarga fragmentada automáticamente
      // Archivos menores a este tamaño usan descarga simple, mayores usan chunks paralelos
      sizeThreshold: 10 * 1024 * 1024,

      // Número de chunks que se crearán por defecto para archivos grandes
      // Este valor se ajusta dinámicamente según el tamaño total del archivo
      defaultChunks: 8,

      // Límite máximo de chunks que se pueden crear para un solo archivo
      // Más chunks permiten más paralelismo pero también más overhead y uso de recursos
      maxChunks: 32,

      // Número mínimo de chunks que se crearán incluso para archivos relativamente pequeños
      // Garantiza cierto nivel de paralelismo incluso para archivos que apenas superan el umbral
      minChunks: 2,

      // Tamaño mínimo en bytes que debe tener cada chunk individual
      // Previene crear demasiados chunks muy pequeños que agregarían overhead sin beneficio
      minChunkSize: 2 * 1024 * 1024,

      // Cantidad máxima de chunks que pueden descargarse simultáneamente por archivo
      // Limita el número de conexiones HTTP concurrentes para evitar saturar el servidor o la red
      maxConcurrentChunks: 8,

      // Número de reintentos permitidos para cada chunk individual antes de marcarlo como fallido
      // Si un chunk falla múltiples veces, la descarga completa puede fallar o usar descarga simple
      chunkRetries: 5,

      // Verificar si el servidor soporta HTTP Range requests antes de intentar descarga fragmentada
      // Si el servidor no soporta Range, automáticamente se usa descarga simple
      checkRangeSupport: true,

      // Timeout en milisegundos para la verificación de soporte de Range requests
      // Si la verificación toma más tiempo, se asume que no hay soporte
      rangeSupportTimeout: 5000,

      // Forzar que todas las descargas usen método simple incluso si califican para fragmentadas
      // Útil para debugging o cuando hay problemas con servidores específicos
      forceSimpleDownload: false,

      // Intervalo en milisegundos entre actualizaciones de progreso individuales por chunk
      // Intervalos más frecuentes hacen la UI más responsive pero consumen más CPU
      chunkProgressInterval: 500,

      // Eliminar automáticamente los archivos temporales de chunks cuando la descarga se completa
      // Si es false, los archivos temporales se mantienen hasta confirmar la integridad del archivo final
      cleanupOnComplete: true,

      // Preservar los chunks parcialmente descargados cuando se pausa o cancela una descarga
      // Permite reanudar más rápido porque no hay que descargar los chunks desde cero
      preserveOnPause: true,

      // Habilitar ajuste automático de la cantidad de chunks según la velocidad de descarga
      // Si los chunks son lentos, se pueden crear más; si son rápidos, se pueden reducir
      adaptiveConcurrency: true,

      // Pre-asignar espacio en disco para el archivo completo antes de comenzar la descarga
      // Reduce la fragmentación del disco y puede mejorar el rendimiento de escritura
      preallocateFile: true,

      // Intervalo en milisegundos para agrupar actualizaciones de progreso antes de escribir a la BD
      // En lugar de escribir cada actualización individual, se acumulan y escriben en batch
      dbBatchInterval: 2000,

      // Tamaño del buffer de escritura para cada chunk individual en bytes (1 MB por defecto)
      // Se puede ajustar automáticamente según el tamaño del chunk y condiciones de backpressure
      chunkWriteBufferSize: 1024 * 1024,

      // Tamaño del buffer usado durante la fusión de chunks en bytes (16 MB)
      // Buffer más grande = mejor rendimiento pero más uso de memoria durante el merge
      mergeBufferSize: 16 * 1024 * 1024,

      // Tamaño de cada lote procesado durante la fusión de chunks en bytes (8 MB)
      // Procesa en lotes para ceder control periódicamente al event loop y mantener la UI responsive
      mergeBatchSize: 8 * 1024 * 1024,

      // Cantidad de operaciones de lectura/escritura antes de ceder control al event loop durante merge
      // Valores más bajos = UI más responsive pero merge más lento
      mergeYieldInterval: 10,

      // Velocidad objetivo en bytes por segundo que cada chunk debería alcanzar para ajuste adaptativo
      // Si los chunks están por debajo de este valor, se pueden ajustar parámetros de concurrencia
      targetSpeedPerChunk: 5 * 1024 * 1024,

      // Umbral de eventos de backpressure antes de reducir la concurrencia de chunks
      // Si se detecta backpressure persistente, se reduce el número de chunks descargando simultáneamente
      backpressureThreshold: 5,

      // Usar un Worker Thread separado para la operación de fusión de chunks
      // Evita bloquear el event loop principal durante el merge, manteniendo la UI responsive
      useWorkerThread: true,
    },
  },

  // Configuración relacionada con la interfaz de usuario y su rendimiento
  ui: {
    // Tiempo mínimo en milisegundos entre actualizaciones de progreso enviadas por IPC
    // Throttling reduce la carga de comunicación entre procesos sin afectar la percepción del usuario
    progressThrottle: 200,

    // Tiempo de espera en milisegundos antes de ejecutar una búsqueda después de que el usuario deje de escribir
    // Debouncing evita ejecutar búsquedas innecesarias mientras el usuario aún está escribiendo
    searchDebounce: 300,
  },

  // Configuración de rate limiting para prevenir abuso del sistema
  rateLimiting: {
    // Rate limiting para búsquedas en la base de datos
    search: {
      // Número máximo de búsquedas permitidas en la ventana de tiempo
      maxRequests: 10,
      // Tamaño de la ventana de tiempo en milisegundos (1 segundo)
      windowMs: 1000,
      // Intervalo de limpieza en milisegundos (cada minuto)
      cleanupIntervalMs: 60000,
    },
  },

  // Rutas de archivos y directorios utilizados por la aplicación
  paths: {
    // Ruta del directorio de datos del usuario donde se almacenan configuraciones y caché
    userDataPath,
    // Ruta del subdirectorio donde se guardan archivos de configuración
    configPath,
    // Ruta completa a la base de datos de índice Myrient (solo lectura)
    // En producción busca en resources, en desarrollo busca en resources relativo al proyecto
    dbPath: app.isPackaged
      ? path.join(process.resourcesPath, 'myrient.db')
      : path.join(process.cwd(), 'resources', 'myrient.db'),
    // Ruta completa al archivo comprimido de la base de datos
    // Se usa para extraer la BD si no existe el archivo .db descomprimido
    compressed7zPath: app.isPackaged
      ? path.join(process.resourcesPath, 'myrient.7z')
      : path.join(process.cwd(), 'resources', 'myrient.7z'),
    // Ruta completa a la base de datos SQLite que almacena la cola de descargas
    // Base de datos de lectura/escritura que persiste el estado de descargas entre sesiones
    queueDbPath: path.join(configPath, 'downloads.db'),
  },

  // Configuración de seguridad y restricciones de red
  security: {
    // Lista de hosts permitidos desde los cuales se pueden descargar archivos
    // Previene descargas accidentales desde servidores no autorizados
    // La lista está congelada (Object.freeze) para prevenir modificaciones en tiempo de ejecución
    allowedHosts: Object.freeze(['myrient.erista.me']),
  },

  // Límites y validaciones relacionadas con archivos
  files: {
    // Tamaño máximo en bytes permitido para un archivo individual (50 GB)
    // Archivos mayores a este tamaño serán rechazados para prevenir problemas de memoria
    maxFileSize: 50 * 1024 * 1024 * 1024,

    // Margen de tolerancia en bytes al comparar tamaños de archivos existentes con esperados
    // Si la diferencia es menor a este margen, se considera que los archivos tienen el mismo tamaño
    sizeMarginBytes: 10240,
  },

  // Configuración de dimensiones y propiedades de la ventana principal
  window: {
    // Ancho por defecto de la ventana principal en píxeles
    defaultWidth: 1200,

    // Alto por defecto de la ventana principal en píxeles
    defaultHeight: 800,
  },
};
