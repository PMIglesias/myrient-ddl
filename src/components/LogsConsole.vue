<template>
  <!-- Overlay -->
  <div
    v-if="show"
    class="logs-overlay"
    role="presentation"
    aria-hidden="true"
    @click="$emit('close')"
  />

  <!-- Panel de consola -->
  <div
    v-if="show"
    ref="logsPanel"
    class="logs-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="logs-title"
  >
    <div class="logs-header">
      <h2 id="logs-title">📋 Consola de Logs</h2>
      <div class="logs-header-actions">
        <button
          class="btn-clear"
          title="Limpiar logs"
          aria-label="Limpiar todos los logs de la consola"
          @click="clearLogs"
        >
          🗑️ Limpiar
        </button>
        <button
          class="btn-export"
          title="Exportar logs"
          aria-label="Exportar logs a archivo"
          @click="exportLogs"
        >
          💾 Exportar
        </button>
        <button
          class="close-modal-btn"
          aria-label="Cerrar consola de logs"
          @click="$emit('close')"
        >
          ✕
        </button>
      </div>
    </div>

    <div class="logs-controls">
      <div class="filter-group">
        <label>Nivel:</label>
        <select
          v-model="filters.level"
          class="filter-select"
        >
          <option value="">
            Todos
          </option>
          <option value="DEBUG">
            Debug
          </option>
          <option value="INFO">
            Info
          </option>
          <option value="WARN">
            Warn
          </option>
          <option value="ERROR">
            Error
          </option>
        </select>
      </div>

      <div class="filter-group">
        <label>Scope:</label>
        <select
          v-model="filters.scope"
          class="filter-select"
        >
          <option value="">
            Todos
          </option>
          <option
            v-for="scope in availableScopes"
            :key="scope"
            :value="scope"
          >
            {{ scope }}
          </option>
        </select>
      </div>

      <div class="filter-group">
        <label>
          <input
            v-model="autoScroll"
            type="checkbox"
            class="checkbox-input"
          >
          Auto-scroll
        </label>
      </div>
    </div>

    <div
      ref="logsContainer"
      class="logs-body"
    >
      <div
        v-for="(log, index) in filteredLogs"
        :key="index"
        :class="['log-entry', `log-${log.level.toLowerCase()}`]"
      >
        <span class="log-time">{{ formatTime(log.timestamp) }}</span>
        <span class="log-mode">[{{ log.mode === 'development' ? 'DEV' : 'PROD' }}]</span>
        <span class="log-level">{{ log.level }}</span>
        <span
          v-if="log.scope"
          class="log-scope"
        >[{{ log.scope }}]</span>
        <span class="log-message">{{ formatMessage(log.message) }}</span>
      </div>

      <div
        v-if="filteredLogs.length === 0"
        class="logs-empty"
      >
        No hay logs disponibles
      </div>
    </div>

    <div class="logs-footer">
      <span class="logs-count"> {{ filteredLogs.length }} / {{ allLogs.length }} logs </span>
    </div>
  </div>
</template>

<script>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import logger from '../utils/logger';

export default {
  name: 'LogsConsole',
  props: {
    show: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const logsContainer = ref(null);
    const logsPanel = ref(null);
    const autoScroll = ref(true);
    const filters = ref({
      level: '',
      scope: '',
    });

    const allLogs = ref([]);
    let unsubscribe = null;
    let previousActiveElement = null;

    // Focus trap para modal
    const trapFocus = (e) => {
      if (!props.show || !logsPanel.value) return;

      const focusableElements = logsPanel.value.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (e.key === 'Tab') {
        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement?.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement?.focus();
          }
        }
      }

      if (e.key === 'Escape') {
        props.show && emit('close');
      }
    };

    // Obtener logs actuales y suscribirse a nuevos
    const loadLogs = () => {
      allLogs.value = logger.getLogs();

      // Suscribirse a nuevos logs
      unsubscribe = logger.onLog(newLog => {
        allLogs.value.push(newLog);

        // Mantener límite
        if (allLogs.value.length > 1000) {
          allLogs.value.shift();
        }

        // Auto-scroll si está habilitado
        if (autoScroll.value) {
          nextTick(() => {
            scrollToBottom();
          });
        }
      });
    };

    // Obtener scopes únicos disponibles
    const availableScopes = computed(() => {
      const scopes = new Set();
      allLogs.value.forEach(log => {
        if (log.scope) {
          scopes.add(log.scope);
        }
      });
      return Array.from(scopes).sort();
    });

    // Filtrar logs según filtros seleccionados
    const filteredLogs = computed(() => {
      let logs = [...allLogs.value];

      if (filters.value.level) {
        logs = logs.filter(log => log.level === filters.value.level);
      }

      if (filters.value.scope) {
        logs = logs.filter(log => log.scope === filters.value.scope);
      }

      return logs;
    });

    // Formatear timestamp
    const formatTime = timestamp => {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      });
    };

    // Formatear mensaje
    const formatMessage = message => {
      if (Array.isArray(message)) {
        return message
          .map(msg => {
            if (typeof msg === 'object') {
              if (msg.type === 'error') {
                return `Error: ${msg.message}${msg.stack ? '\n' + msg.stack : ''}`;
              }
              return JSON.stringify(msg, null, 2);
            }
            return String(msg);
          })
          .join(' ');
      }
      return String(message);
    };

    // Scroll al final
    const scrollToBottom = () => {
      if (logsContainer.value) {
        logsContainer.value.scrollTop = logsContainer.value.scrollHeight;
      }
    };

    // Limpiar logs
    const clearLogs = () => {
      if (confirm('¿Estás seguro de que quieres limpiar todos los logs?')) {
        logger.clearLogs();
        allLogs.value = [];
      }
    };

    // Exportar logs
    const exportLogs = async () => {
      try {
        const result = await logger.saveLogsToFile({
          level: filters.value.level || undefined,
          scope: filters.value.scope || undefined,
        });

        if (result.success) {
          const { formatLogsExported } = await import('../constants/messages');
          alert(formatLogsExported(result.path));
        } else {
          alert(`Error al exportar logs:\n${result.error}`);
        }
      } catch (error) {
        alert(`Error al exportar logs:\n${error.message}`);
      }
    };

    // Manejar focus cuando se abre el modal
    watch(() => props.show, (isOpen) => {
      if (isOpen) {
        previousActiveElement = document.activeElement;
        // Enfocar el primer elemento enfocable o el botón de cerrar
        setTimeout(() => {
          const closeBtn = logsPanel.value?.querySelector('.close-modal-btn');
          closeBtn?.focus();
        }, 0);
        document.addEventListener('keydown', trapFocus);
      } else {
        document.removeEventListener('keydown', trapFocus);
        // Restaurar focus al elemento anterior
        if (previousActiveElement) {
          previousActiveElement.focus();
        }
      }
    });

    // Cargar logs al montar
    onMounted(() => {
      loadLogs();
      nextTick(() => {
        scrollToBottom();
      });
      if (props.show) {
        document.addEventListener('keydown', trapFocus);
      }
    });

    // Desuscribirse al desmontar
    onUnmounted(() => {
      if (unsubscribe) {
        unsubscribe();
      }
      document.removeEventListener('keydown', trapFocus);
    });

    // Auto-scroll cuando cambian los logs filtrados
    watch(filteredLogs, () => {
      if (autoScroll.value) {
        nextTick(() => {
          scrollToBottom();
        });
      }
    });

    return {
      logsContainer,
      logsPanel,
      autoScroll,
      filters,
      allLogs,
      availableScopes,
      filteredLogs,
      formatTime,
      formatMessage,
      clearLogs,
      exportLogs,
    };
  },
};
</script>

<style scoped>
.logs-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  z-index: 9998;
}

.logs-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 90vw;
  max-width: 1200px;
  height: 80vh;
  background: #2d2d2d;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  color: rgba(255, 255, 255, 0.87);
}

.light-mode .logs-panel {
  background: #ffffff;
  color: #333;
  border: 1px solid #ddd;
}

.logs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.light-mode .logs-header {
  border-bottom-color: #ddd;
}

.logs-header h2 {
  margin: 0;
  font-size: 1.25rem;
}

.logs-header-actions {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
}

.btn-clear,
.btn-export {
  padding: var(--spacing-sm) var(--spacing-md);
  background: #3d3d3d;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-md);
  color: rgba(255, 255, 255, 0.87);
  cursor: pointer;
  font-size: 0.875rem;
  transition: background 0.2s;
}

.light-mode .btn-clear,
.light-mode .btn-export {
  background: #f5f5f5;
  border-color: #ddd;
  color: #333;
}

.btn-clear:hover,
.btn-export:hover {
  background: #4d4d4d;
}

.light-mode .btn-clear:hover,
.light-mode .btn-export:hover {
  background: #e5e5e5;
}

.close-modal-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.87);
  font-size: 1.5rem;
  cursor: pointer;
  padding: var(--spacing-xs);
  line-height: 1;
  transition: color 0.2s;
}

.light-mode .close-modal-btn {
  color: #333;
}

.close-modal-btn:hover {
  color: #fff;
}

.logs-controls {
  display: flex;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-wrap: wrap;
}

.light-mode .logs-controls {
  border-bottom-color: #ddd;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.filter-group label {
  font-size: 0.875rem;
  white-space: nowrap;
}

.filter-select {
  padding: var(--spacing-xs) var(--spacing-sm);
  background: #3d3d3d;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-md);
  color: rgba(255, 255, 255, 0.87);
  font-size: 0.875rem;
  cursor: pointer;
}

.light-mode .filter-select {
  background: #fff;
  border-color: #ddd;
  color: #333;
}

.checkbox-input {
  margin-right: var(--spacing-xs);
  cursor: pointer;
}

.logs-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md);
  font-family: 'Courier New', monospace;
  font-size: 0.813rem;
  line-height: 1.6;
}

.log-entry {
  display: flex;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  word-break: break-word;
}

.light-mode .log-entry {
  border-bottom-color: rgba(0, 0, 0, 0.05);
}

.log-entry:last-child {
  border-bottom: none;
}

.log-time {
  color: #888;
  min-width: 90px;
  flex-shrink: 0;
}

.light-mode .log-time {
  color: #666;
}

.log-mode {
  color: #666;
  min-width: 50px;
  flex-shrink: 0;
  font-weight: 500;
}

.light-mode .log-mode {
  color: #999;
}

.log-level {
  min-width: 60px;
  flex-shrink: 0;
  font-weight: 600;
}

.log-debug .log-level {
  color: #888;
}

.log-info .log-level {
  color: #4caf50;
}

.log-warn .log-level {
  color: #ff9800;
}

.log-error .log-level {
  color: #f44336;
}

.log-scope {
  color: #9c27b0;
  min-width: 100px;
  flex-shrink: 0;
  font-weight: 500;
}

.light-mode .log-scope {
  color: #7b1fa2;
}

.log-message {
  flex: 1;
  color: rgba(255, 255, 255, 0.87);
}

.light-mode .log-message {
  color: #333;
}

.logs-empty {
  text-align: center;
  padding: var(--spacing-xl);
  color: #888;
}

.logs-footer {
  padding: var(--spacing-md);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 0.875rem;
  color: rgba(255, 255, 255, 0.6);
}

.light-mode .logs-footer {
  border-top-color: #ddd;
  color: #666;
}

.logs-count {
  font-weight: 500;
}
</style>
