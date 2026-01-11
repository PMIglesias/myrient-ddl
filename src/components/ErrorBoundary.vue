<template>
  <div>
    <div
      v-if="hasError"
      class="error-boundary"
    >
      <div class="error-boundary-content">
        <div class="error-icon">
          ⚠️
        </div>
        <h2 class="error-title">
          Algo salió mal
        </h2>
        <p class="error-message">
          {{ errorMessage }}
        </p>

        <!-- Mostrar detalles del error en desarrollo -->
        <details
          v-if="isDev && errorDetails"
          class="error-details"
        >
          <summary>Detalles técnicos (solo desarrollo)</summary>
          <pre class="error-stack">{{ errorDetails }}</pre>
        </details>

        <div class="error-actions">
          <button
            class="error-button error-button-primary"
            aria-label="Reintentar operación después del error"
            @click="handleRetry"
          >
            Reintentar
          </button>
          <button
            class="error-button error-button-secondary"
            aria-label="Recargar la página completa"
            @click="handleReload"
          >
            Recargar página
          </button>
          <button
            v-if="allowDismiss"
            class="error-button error-button-secondary"
            aria-label="Continuar a pesar del error (puede causar problemas)"
            @click="handleDismiss"
          >
            Continuar de todos modos
          </button>
        </div>
      </div>
    </div>
    <template v-else>
      <slot />
    </template>
  </div>
</template>

<script setup>
import { ref, onErrorCaptured, computed } from 'vue';
import logger from '../utils/logger';

const props = defineProps({
  /**
   * Mensaje de error personalizado para mostrar al usuario
   */
  fallbackMessage: {
    type: String,
    default: 'Ha ocurrido un error inesperado. Por favor, intenta nuevamente.',
  },
  /**
   * Si es true, permite cerrar el error y continuar (peligroso)
   */
  allowDismiss: {
    type: Boolean,
    default: false,
  },
  /**
   * Función de recuperación personalizada. Si retorna true, el error se considera recuperado
   */
  onError: {
    type: Function,
    default: null,
  },
  /**
   * Nombre del componente para logging
   */
  componentName: {
    type: String,
    default: 'Unknown',
  },
});

const emit = defineEmits(['error', 'retry', 'recovered']);

const hasError = ref(false);
const error = ref(null);
const errorInfo = ref(null);
const retryCount = ref(0);
const maxRetries = 3;

const isDev = computed(() => import.meta.env.DEV);

const errorMessage = computed(() => {
  if (props.fallbackMessage) {
    return props.fallbackMessage;
  }

  if (error.value) {
    // Mensajes amigables basados en el tipo de error
    if (error.value.message) {
      const msg = error.value.message.toLowerCase();

      if (msg.includes('network') || msg.includes('fetch') || msg.includes('http')) {
        return 'Error de conexión. Verifica tu conexión a internet e intenta nuevamente.';
      }

      if (msg.includes('timeout')) {
        return 'La operación tardó demasiado. Por favor, intenta nuevamente.';
      }

      if (msg.includes('permission') || msg.includes('access')) {
        return 'No tienes permisos para realizar esta acción.';
      }

      if (msg.includes('quota') || msg.includes('storage')) {
        return 'No hay suficiente espacio de almacenamiento disponible.';
      }
    }

    return error.value.message || 'Ha ocurrido un error inesperado.';
  }

  return 'Ha ocurrido un error inesperado. Por favor, intenta nuevamente.';
});

const errorDetails = computed(() => {
  if (!error.value) return null;

  const details = [];
  if (error.value.message) details.push(`Mensaje: ${error.value.message}`);
  if (error.value.stack) details.push(`\nStack:\n${error.value.stack}`);
  if (errorInfo.value) details.push(`\nInfo: ${errorInfo.value}`);

  return details.join('\n');
});

/**
 * Captura errores en componentes hijos
 */
onErrorCaptured((err, instance, info) => {
  const boundaryLogger = logger.child(`ErrorBoundary:${props.componentName}`);

  boundaryLogger.error('Error capturado en ErrorBoundary:', {
    error: err,
    message: err?.message,
    stack: err?.stack,
    component: instance?.$?.type?.name || 'Unknown',
    info,
  });

  error.value = err;
  errorInfo.value = info;
  hasError.value = true;
  retryCount.value++;

  // Emitir evento de error
  emit('error', {
    error: err,
    instance,
    info,
    retryCount: retryCount.value,
  });

  // Intentar recuperación automática si hay función onError
  if (props.onError) {
    try {
      const recovered = props.onError(err, instance, info, retryCount.value);
      if (recovered === true || recovered === Promise.resolve(true)) {
        boundaryLogger.info('Error recuperado automáticamente por onError callback');
        handleRecovery();
        return false; // Prevenir propagación
      }
    } catch (recoveryError) {
      boundaryLogger.error('Error en función de recuperación:', recoveryError);
    }
  }

  // Recuperación automática para errores recuperables
  if (retryCount.value < maxRetries && isRecoverableError(err)) {
    boundaryLogger.info(
      `Error recuperable detectado. Reintentando automáticamente (${retryCount.value}/${maxRetries})...`
    );
    setTimeout(() => {
      handleRetry();
    }, 1000 * retryCount.value); // Backoff exponencial
    return false; // Prevenir propagación del error
  }

  // No prevenir propagación para errores críticos o después de max retries
  return true;
});

/**
 * Determina si un error es recuperable
 */
function isRecoverableError(err) {
  if (!err) return false;

  const message = err.message?.toLowerCase() || '';
  const errorType = err.name?.toLowerCase() || '';

  // Errores de red son generalmente recuperables
  if (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('connection') ||
    message.includes('timeout') ||
    errorType.includes('network')
  ) {
    return true;
  }

  // Errores de tipo pueden ser recuperables si son de validación
  if (
    errorType.includes('typeerror') &&
    (message.includes('undefined') || message.includes('null') || message.includes('cannot read'))
  ) {
    // Solo si no es un error crítico de estructura
    return !message.includes('render') && !message.includes('component');
  }

  // Por defecto, considerar no recuperable
  return false;
}

/**
 * Maneja el reintento
 */
function handleRetry() {
  const boundaryLogger = logger.child(`ErrorBoundary:${props.componentName}`);
  boundaryLogger.info('Reintentando después de error...');

  emit('retry', {
    error: error.value,
    retryCount: retryCount.value,
  });

  // Resetear estado
  handleRecovery();
}

/**
 * Maneja la recuperación (resetea el estado de error)
 */
function handleRecovery() {
  hasError.value = false;
  error.value = null;
  errorInfo.value = null;
  emit('recovered');
}

/**
 * Recarga la página
 */
function handleReload() {
  window.location.reload();
}

/**
 * Descarta el error y continúa (solo si allowDismiss es true)
 */
function handleDismiss() {
  if (!props.allowDismiss) return;

  const boundaryLogger = logger.child(`ErrorBoundary:${props.componentName}`);
  boundaryLogger.warn(
    'Usuario descartó error y continúa. Esto puede causar comportamiento inesperado.'
  );

  handleRecovery();
}

// Exponer método para resetear desde fuera
defineExpose({
  reset: handleRecovery,
  hasError: computed(() => hasError.value),
});
</script>

<style scoped>
.error-boundary {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  padding: 40px 20px;
  background: rgba(43, 43, 43, 0.95);
  border-radius: 8px;
  margin: 20px;
  border: 2px solid #f44336;
}

.error-boundary-content {
  text-align: center;
  max-width: 500px;
}

.error-icon {
  font-size: 64px;
  margin-bottom: 20px;
  animation: shake 0.5s ease-in-out;
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-10px);
  }
  75% {
    transform: translateX(10px);
  }
}

.error-title {
  color: #f44336;
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 12px;
}

.error-message {
  color: #ccc;
  font-size: 16px;
  line-height: 1.6;
  margin-bottom: 24px;
}

.error-details {
  margin: 20px 0;
  text-align: left;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  padding: 12px;
}

.error-details summary {
  color: #999;
  cursor: pointer;
  user-select: none;
  margin-bottom: 8px;
}

.error-details summary:hover {
  color: #ccc;
}

.error-stack {
  color: #999;
  font-size: 11px;
  font-family: 'Courier New', monospace;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}

.error-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 24px;
}

.error-button {
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 120px;
}

.error-button-primary {
  background: #4caf50;
  color: white;
}

.error-button-primary:hover {
  background: #45a049;
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(76, 175, 80, 0.3);
}

.error-button-secondary {
  background: #555;
  color: white;
}

.error-button-secondary:hover {
  background: #666;
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
}

.error-button:active {
  transform: translateY(0);
}

/* Modo claro */
.light-mode .error-boundary {
  background: rgba(245, 245, 245, 0.95);
  border-color: #f44336;
}

.light-mode .error-title {
  color: #d32f2f;
}

.light-mode .error-message {
  color: #666;
}

.light-mode .error-details {
  background: rgba(0, 0, 0, 0.05);
}

.light-mode .error-details summary {
  color: #666;
}

.light-mode .error-details summary:hover {
  color: #333;
}

.light-mode .error-stack {
  color: #666;
}

.light-mode .error-button-secondary {
  background: #e0e0e0;
  color: #333;
}

.light-mode .error-button-secondary:hover {
  background: #d0d0d0;
}
</style>
