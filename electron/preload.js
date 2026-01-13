// Script de preload que actúa como puente seguro entre el proceso principal y el renderer
// Se ejecuta en un contexto aislado y expone una API limitada y validada al proceso renderer
// SEGURIDAD: Todos los canales IPC deben estar en las whitelists y se validan antes de cada invocación
// Esto previene que código malicioso en el renderer acceda a canales IPC no autorizados

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist de canales IPC permitidos para comunicación entre procesos
// Estos canales están validados y solo se permiten los que están explícitamente listados

// Canales permitidos para eventos unidireccionales (solo main -> renderer)
// El renderer solo puede escuchar estos eventos, no enviarlos
const validEventChannels = [
  'download-progress',
  'download-progress-batch',
  'history-cleaned',
  'downloads-restored',
  'error-notification',
  'backend-log',
];

// Canales permitidos para invocaciones bidireccionales (renderer <-> main)
// El renderer puede invocar estos canales y recibir respuestas del proceso principal
const validInvokeChannels = [
  // Operaciones de base de datos de índice Myrient
  'search-db',
  'get-children',
  'get-ancestors',
  'get-node-info',
  'get-db-update-date',
  // Gestión de descargas
  'download-file',
  'download-folder',
  'pause-download',
  'resume-download',
  'cancel-download',
  'retry-download',
  'confirm-overwrite',
  'delete-download',
  'get-download-stats',
  'get-queue-time-estimate',
  'clean-history',
  'clear-history',
  // Lectura y escritura de archivos de configuración
  'read-config-file',
  'write-config-file',
  // Control de ventana
  'window-minimize',
  'window-maximize',
  'window-close',
  // Diálogos del sistema
  'select-folder',
  'open-folder',
  // Logging del frontend
  'frontend-log',
  'save-logs-to-file',
];

// Funciones auxiliares de seguridad que validan todos los accesos IPC
// Garantizan que solo se pueden usar canales previamente autorizados en las whitelists

// Valida que el canal IPC esté autorizado antes de invocar el handler
// Si el canal no está en la whitelist, rechaza la invocación con un error
// channel: Nombre del canal IPC a invocar (debe estar en validInvokeChannels)
// ...args: Argumentos que se pasarán al handler en el proceso principal
// Retorna: Promise que se resuelve con la respuesta del handler o se rechaza si el canal no es válido
const safeInvoke = (channel, ...args) => {
  if (!validInvokeChannels.includes(channel)) {
    console.error(`[Preload] ⛔ Canal IPC no autorizado: ${channel}`);
    return Promise.reject(new Error(`Canal IPC no autorizado: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
};

// Valida y registra un listener para eventos IPC del proceso principal
// Envuelve el callback con manejo de errores para prevenir que errores en el listener rompan la aplicación
// channel: Nombre del canal de eventos (debe estar en validEventChannels)
// callback: Función que se ejecutará cuando se reciba un evento en el canal
// Retorna: Función de cleanup que debe llamarse para remover el listener cuando ya no se necesite
const safeOn = (channel, callback) => {
  if (!validEventChannels.includes(channel)) {
    console.warn(`[Preload] ⚠️ Canal de eventos no válido: ${channel}`);
    // Retornar función vacía para que el código que espera una función de cleanup no falle
    return () => {};
  }

  // Wrapper que captura errores en el callback para evitar que rompan la aplicación
  const listener = (_event, ...args) => {
    try {
      callback(...args);
    } catch (error) {
      console.error(`[Preload] Error en listener de ${channel}:`, error);
    }
  };

  ipcRenderer.on(channel, listener);

  // Retornar función que remueve el listener cuando se llama
  // Es importante llamar esta función para evitar memory leaks
  return () => {
    try {
      ipcRenderer.removeListener(channel, listener);
      console.log(`[Preload] Listener removido: ${channel}`);
    } catch (error) {
      console.error(`[Preload] Error removiendo listener de ${channel}:`, error);
    }
  };
};

// API que se expone al proceso renderer a través de contextBridge
// Todas las funciones pasan por validación de seguridad usando safeInvoke
// El renderer solo puede acceder a esta API, no directamente a ipcRenderer
const api = {
  // Suscripción a eventos unidireccionales del proceso principal
  // Permite al renderer escuchar eventos como actualizaciones de progreso de descargas
  on: safeOn,

  // Operaciones de búsqueda y navegación en la base de datos de índice Myrient
  // Todas estas operaciones son de solo lectura sobre la base de datos principal

  // Busca archivos y carpetas en la base de datos usando el término proporcionado
  // term: Texto de búsqueda que se utilizará para encontrar coincidencias
  search: term => safeInvoke('search-db', term),

  // Obtiene los nodos hijos directos de un nodo padre en la estructura de carpetas
  // parentId: ID numérico del nodo padre del cual obtener los hijos
  getChildren: parentId => safeInvoke('get-children', parentId),

  // Obtiene la cadena de ancestros de un nodo para construir breadcrumbs
  // nodeId: ID numérico del nodo del cual obtener la ruta de ancestros
  getAncestors: nodeId => safeInvoke('get-ancestors', nodeId),

  // Obtiene información básica de un nodo específico (tipo, título, parent_id)
  // nodeId: ID numérico del nodo del cual obtener la información
  getNodeInfo: nodeId => safeInvoke('get-node-info', nodeId),

  // Obtiene la fecha de última actualización de la base de datos de índice
  // Útil para mostrar al usuario cuán actualizada está la información
  getDbUpdateDate: () => safeInvoke('get-db-update-date'),

  // Control de descargas de archivos individuales y carpetas completas
  // Todas las operaciones de descarga se gestionan a través de estos métodos

  // Inicia la descarga de un archivo individual
  // file: Objeto con información del archivo (id, title, downloadPath, etc.)
  download: file => safeInvoke('download-file', file),

  // Inicia la descarga recursiva de todos los archivos contenidos en una carpeta
  // params: Objeto con folderId, downloadPath, preserveStructure, etc.
  downloadFolder: params => safeInvoke('download-folder', params),

  // Pausa temporalmente una descarga activa, preservando los archivos parciales (.part)
  // downloadId: ID numérico de la descarga a pausar
  pauseDownload: downloadId => safeInvoke('pause-download', downloadId),

  // Reanuda una descarga que fue previamente pausada, continuando desde donde se detuvo
  // downloadId: ID numérico de la descarga a reanudar
  resumeDownload: downloadId => safeInvoke('resume-download', downloadId),

  // Cancela permanentemente una descarga y elimina los archivos parciales descargados
  // downloadId: ID numérico de la descarga a cancelar
  cancelDownload: downloadId => safeInvoke('cancel-download', downloadId),

  // Reinicia una descarga que fue cancelada o falló, comenzando desde cero
  // downloadId: ID numérico de la descarga a reiniciar
  retryDownload: downloadId => safeInvoke('retry-download', downloadId),

  // Confirma la sobrescritura de un archivo existente cuando se detecta conflicto
  // downloadId: ID numérico de la descarga que requiere confirmación
  confirmOverwrite: downloadId => safeInvoke('confirm-overwrite', downloadId),

  // Elimina completamente una descarga de la base de datos y el historial
  // downloadId: ID numérico de la descarga a eliminar
  deleteDownload: downloadId => safeInvoke('delete-download', downloadId),

  // Obtiene estadísticas generales sobre el estado de todas las descargas
  // Incluye cantidad de descargas activas, en cola, completadas, etc.
  getDownloadStats: () => safeInvoke('get-download-stats'),

  // Obtiene una estimación del tiempo restante para que una descarga específica comience
  // o el tiempo total estimado para completar todas las descargas en cola
  // downloadId: ID opcional de la descarga específica, o null para estimación total de cola
  getQueueTimeEstimate: (downloadId = null) => safeInvoke('get-queue-time-estimate', downloadId),

  // Limpia el historial de descargas eliminando registros más antiguos que los días especificados
  // daysOld: Número de días de antigüedad mínimo para considerar una descarga como histórica
  cleanHistory: daysOld => safeInvoke('clean-history', daysOld),

  // Limpia todo el historial de descargas (sin importar la fecha)
  clearHistory: () => safeInvoke('clear-history'),

  // Gestión de archivos de configuración JSON almacenados en el directorio de configuración
  // Estos archivos persisten preferencias del usuario entre sesiones

  // Lee el contenido de un archivo de configuración y lo retorna como objeto JavaScript
  // filename: Nombre del archivo de configuración (sin extensión .json)
  readConfigFile: filename => safeInvoke('read-config-file', filename),

  // Escribe un objeto JavaScript como JSON en un archivo de configuración
  // filename: Nombre del archivo de configuración (sin extensión .json)
  // data: Objeto que se serializará a JSON y se guardará en el archivo
  writeConfigFile: (filename, data) => safeInvoke('write-config-file', filename, data),

  // Control de la ventana principal de la aplicación
  // Permite al renderer solicitar cambios en el estado de la ventana

  // Minimiza la ventana principal al taskbar
  minimizeWindow: () => safeInvoke('window-minimize'),

  // Maximiza la ventana si está normal, o la restaura a tamaño normal si está maximizada
  maximizeWindow: () => safeInvoke('window-maximize'),

  // Cierra la ventana principal, lo cual puede iniciar el proceso de cierre de la aplicación
  closeWindow: () => safeInvoke('window-close'),

  // Abre el diálogo nativo del sistema operativo para seleccionar una carpeta
  // Retorna la ruta de la carpeta seleccionada por el usuario o null si canceló
  selectFolder: () => safeInvoke('select-folder'),

  // Abre el explorador de archivos y muestra el archivo o carpeta especificada
  // filePath: Ruta completa al archivo o carpeta que se desea mostrar
  openFolder: filePath => safeInvoke('open-folder', filePath),

  // =====================
  // LOGGING FRONTEND
  // =====================

  // Envía un log del frontend al backend para registro centralizado
  // logEntry: Objeto con información del log (level, scope, message, timestamp, mode)
  log: logEntry => safeInvoke('frontend-log', logEntry),

  // Guarda logs del frontend en un archivo de texto
  // logText: Texto formateado con los logs a guardar
  saveLogsToFile: logText => safeInvoke('save-logs-to-file', logText),
};

// Expone la API de forma segura al objeto global window en el contexto del renderer
// contextBridge garantiza que el renderer no pueda acceder directamente a Node.js o Electron
// Solo puede usar la API expuesta, mejorando la seguridad de la aplicación
contextBridge.exposeInMainWorld('api', api);

// Logs informativos al cargar el preload para verificar que todo está configurado correctamente
// Útiles para debugging durante el desarrollo
console.log('[Preload] ✅ API expuesta correctamente');
console.log('[Preload] Canales de eventos:', validEventChannels.length);
console.log('[Preload] Canales de invocación:', validInvokeChannels.length);
