/**
 * useToasts - Composable para notificaciones toast
 *
 * Maneja notificaciones temporales que se muestran al usuario
 */

import { ref } from 'vue';

// Estado global (singleton)
const toasts = ref([]);
let toastIdCounter = 0;
const MAX_TOASTS = 6;

/**
 * Composable de toasts
 */
export function useToasts() {
  /**
   * Muestra un toast
   * @param {Object} options - Opciones del toast
   * @param {string} options.title - Título del toast
   * @param {string} [options.message] - Mensaje adicional
   * @param {string} [options.type] - Tipo: 'info', 'success', 'warning', 'error'
   * @param {number} [options.duration] - Duración en ms (0 = no auto-cerrar)
   * @returns {number} ID del toast
   */
  const showToast = options => {
    // Limitar el número de notificaciones en pantalla
    if (toasts.value.length >= MAX_TOASTS) {
      // Remover la notificación más antigua para hacer espacio
      toasts.value.shift();
    }

    const id = ++toastIdCounter;
    const toast = {
      id,
      title: options.title || 'Notificación',
      message: options.message || '',
      type: options.type || 'info',
      duration: options.duration !== undefined ? options.duration : 5000,
    };

    toasts.value.push(toast);

    // Auto-cerrar si tiene duración
    if (toast.duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, toast.duration);
    }

    return id;
  };

  /**
   * Remueve un toast
   * @param {number} id - ID del toast
   */
  const removeToast = id => {
    const index = toasts.value.findIndex(t => t.id === id);
    if (index >= 0) {
      toasts.value.splice(index, 1);
    }
  };

  /**
   * Limpia todos los toasts
   */
  const clearToasts = () => {
    toasts.value = [];
  };

  return {
    toasts,
    showToast,
    removeToast,
    clearToasts,
  };
}

export default useToasts;
