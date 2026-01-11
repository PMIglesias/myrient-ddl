/**
 * Punto de entrada del Frontend Vue
 *
 * Este archivo inicializa la aplicación Vue y la monta en el DOM.
 * NO confundir con electron/main.js que es el proceso principal de Electron.
 */

import { createApp } from 'vue';
import App from './App.vue';
import logger from './utils/logger';

// Importar estilos globales (el archivo está en src/)
import './style.css';

const vueLogger = logger.child('Vue');

// Crear e inicializar la aplicación Vue
const app = createApp(App);

// Importar función de manejo de errores
import { showErrorToast } from './utils/errorHandler';

// Configurar manejo de errores global
app.config.errorHandler = (err, instance, info) => {
  vueLogger.error('Error en componente:', err);
  vueLogger.error('Componente:', instance?.$?.type?.name || 'Unknown');
  vueLogger.error('Info:', info);

  // Determinar mensaje de error amigable
  let errorTitle = 'Error en componente';
  let errorMessage =
    'Ha ocurrido un error en un componente. La aplicación puede comportarse de manera inesperada.';

  if (err?.message) {
    const msg = err.message.toLowerCase();

    if (msg.includes('network') || msg.includes('fetch') || msg.includes('http')) {
      errorTitle = 'Error de conexión';
      errorMessage = 'No se pudo conectar con el servidor. Verifica tu conexión a internet.';
    } else if (msg.includes('timeout')) {
      errorTitle = 'Timeout';
      errorMessage = 'La operación tardó demasiado tiempo en completarse.';
    } else if (msg.includes('permission') || msg.includes('access')) {
      errorTitle = 'Error de permisos';
      errorMessage = 'No tienes permisos para realizar esta acción.';
    } else if (msg.includes('quota') || msg.includes('storage')) {
      errorTitle = 'Espacio insuficiente';
      errorMessage = 'No hay suficiente espacio de almacenamiento disponible.';
    } else if (msg.includes('cannot read') || msg.includes('undefined') || msg.includes('null')) {
      errorTitle = 'Error de datos';
      errorMessage =
        'Error procesando datos. Algunos componentes pueden no funcionar correctamente.';
    } else {
      errorMessage = `Error: ${err.message.substring(0, 150)}${err.message.length > 150 ? '...' : ''}`;
    }
  }

  // Mostrar toast usando el handler global
  showErrorToast({
    title: errorTitle,
    message: errorMessage,
    type: 'error',
    duration: 8000,
  });
};

// Advertencias en desarrollo
app.config.warnHandler = (msg, instance, trace) => {
  vueLogger.warn('Advertencia:', msg);
  if (trace) vueLogger.warn('Trace:', trace);
};

// Montar la aplicación
app.mount('#app');

vueLogger.info('Aplicación montada correctamente');

// Inicializar listener de logs del backend después de montar
// Esto asegura que window.api esté disponible
setTimeout(() => {
  logger.initBackendListener();
}, 100);
