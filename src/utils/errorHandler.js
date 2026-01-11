/**
 * Manejo global de errores para Vue
 *
 * Centraliza el manejo de errores y evita dependencias circulares
 */

let globalToastHandler = null;

/**
 * Registra el handler de toasts global
 * @param {Function} showToast - Función para mostrar toasts
 */
export function registerGlobalToastHandler(showToast) {
  globalToastHandler = showToast;
}

/**
 * Obtiene el handler de toasts global
 * @returns {Function|null}
 */
export function getGlobalToastHandler() {
  return globalToastHandler;
}

/**
 * Muestra un error usando el handler global de toasts
 * @param {Object} options - Opciones del toast
 */
export function showErrorToast(options) {
  if (globalToastHandler) {
    try {
      globalToastHandler(options);
    } catch (error) {
      console.error('Error mostrando toast de error:', error);
    }
  } else {
    // Fallback: intentar importar dinámicamente
    import('../composables/useToasts.js')
      .then(({ useToasts }) => {
        const { showToast } = useToasts();
        showToast(options);
      })
      .catch(importError => {
        console.error('Error importando useToasts:', importError);
        // Fallback final: mostrar en consola
        console.error('Error:', options.title, options.message);
      });
  }
}
