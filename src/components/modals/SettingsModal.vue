<template>
  <!-- Overlay separado como en el original -->
  <div
    v-if="show"
    class="settings-overlay"
    role="presentation"
    aria-hidden="true"
    @click="$emit('close')"
  />

  <!-- Panel de settings -->
  <div
    v-if="show"
    ref="settingsPanel"
    class="settings-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
  >
    <div class="settings-header">
      <h2 id="settings-title">⚙️ Configuración</h2>
      <button
        class="close-modal-btn"
        aria-label="Cerrar panel de configuración"
        @click="$emit('close')"
      >
        ✕
      </button>
    </div>

    <div class="settings-body">
      <!-- Sección Búsqueda -->
      <div class="settings-section">
        <h3>Búsqueda</h3>
        <div class="setting-item">
          <label>Límite de resultados</label>
          <div class="setting-control">
            <input
              type="number"
              :value="searchLimit"
              min="100"
              max="2000"
              step="100"
              class="number-input"
              @input="$emit('update:searchLimit', Number($event.target.value))"
            >
            <span class="setting-hint">Resultados máximos por búsqueda</span>
          </div>
        </div>
      </div>

      <!-- Sección Descargas -->
      <div class="settings-section">
        <h3>Descargas</h3>
        <div class="setting-item">
          <label>Carpeta de destino</label>
          <div class="setting-control">
            <div class="path-input-group">
              <input
                type="text"
                :value="downloadPath"
                class="path-input"
                placeholder="Ej: C:\Descargas"
                @input="$emit('update:downloadPath', $event.target.value)"
                @blur="$emit('save-settings')"
              >
              <button
                class="select-folder-btn"
                aria-label="Seleccionar carpeta de destino para descargas"
                @click="$emit('select-folder')"
              >
                📁 Seleccionar
              </button>
            </div>
            <span class="setting-hint">Ruta donde se guardarán los archivos</span>
          </div>
        </div>

        <div class="setting-item">
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="preserveStructure"
              class="checkbox-input"
              @change="$emit('update:preserveStructure', $event.target.checked)"
            >
            Mantener estructura de carpetas
          </label>
          <span class="setting-hint">Si está activado, se recreará la estructura de directorios</span>
        </div>

        <div class="setting-item">
          <label>Descargas en paralelo</label>
          <div class="setting-control">
            <input
              type="number"
              :value="maxParallelDownloads"
              min="1"
              max="3"
              step="1"
              class="number-input"
              @input="$emit('update:maxParallelDownloads', Number($event.target.value))"
              @blur="$emit('save-settings')"
            >
            <span class="setting-hint">Máximo permitido: 3 descargas simultáneas</span>
          </div>
        </div>

        <div class="setting-item">
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="showNotifications"
              class="checkbox-input"
              @change="$emit('update:showNotifications', $event.target.checked)"
            >
            Mostrar notificaciones de archivos existentes
          </label>
          <span class="setting-hint">Muestra alertas cuando el archivo ya existe</span>
        </div>

        <div class="setting-item">
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="autoResumeDownloads"
              class="checkbox-input"
              @change="$emit('update:autoResumeDownloads', $event.target.checked)"
            >
            Reanudar descargas automáticamente al iniciar
          </label>
          <span class="setting-hint">Si está desactivado, las descargas en cola quedarán pausadas al reiniciar</span>
        </div>
      </div>

      <!-- Sección Almacenamiento -->
      <div class="settings-section">
        <h3>Almacenamiento</h3>
        <div class="setting-item">
          <label>Favoritos</label>
          <div class="setting-control">
            <button
              class="danger-btn"
              aria-label="Limpiar todos los favoritos guardados"
              @click="$emit('clear-favorites')"
            >
              🗑️ Limpiar todos los favoritos
            </button>
            <span class="setting-hint">{{ favoritesCount }} favorito(s) guardado(s)</span>
          </div>
        </div>

        <div class="setting-item">
          <label>Historial de descargas</label>
          <div class="setting-control">
            <div class="history-controls">
              <button
                class="clean-history-btn"
                title="Eliminar registros de más de 30 días"
                aria-label="Limpiar historial de descargas de más de 30 días"
                @click="$emit('clean-history', 30)"
              >
                🧹 Limpiar historial (30 días)
              </button>
              <button
                class="clean-history-btn small"
                title="Eliminar registros de más de 7 días"
                aria-label="Limpiar historial de descargas de más de 7 días"
                @click="$emit('clean-history', 7)"
              >
                7 días
              </button>
            </div>
            <span class="setting-hint">Elimina registros antiguos de la base de datos para liberar espacio</span>
            <div
              v-if="cleanupStats"
              class="cleanup-stats"
            >
              <span
                v-if="cleanupStats.lastDbCleanup"
                class="stat-item"
              >
                Última limpieza BD: {{ formatDate(cleanupStats.lastDbCleanup) }}
              </span>
              <span
                v-if="cleanupStats.lastMemoryCleanup"
                class="stat-item"
              >
                Última limpieza memoria: {{ formatDate(cleanupStats.lastMemoryCleanup) }}
              </span>
              <span
                v-if="cleanupStats.totalRemoved > 0"
                class="stat-item"
              >
                Total removidas: {{ cleanupStats.totalRemoved }}
              </span>
            </div>
          </div>
        </div>

        <div class="setting-item">
          <label>Límites de historial en memoria</label>
          <div class="setting-control">
            <div class="memory-limits-group">
              <div class="memory-limit-item">
                <label class="memory-limit-label">Máximo total:</label>
                <input
                  type="number"
                  :value="maxHistoryInMemory"
                  min="50"
                  max="500"
                  step="25"
                  class="number-input small"
                  @input="$emit('update:maxHistoryInMemory', Number($event.target.value))"
                  @blur="$emit('save-settings')"
                >
              </div>
              <div class="memory-limit-item">
                <label class="memory-limit-label">Completadas:</label>
                <input
                  type="number"
                  :value="maxCompletedInMemory"
                  min="10"
                  max="200"
                  step="10"
                  class="number-input small"
                  @input="$emit('update:maxCompletedInMemory', Number($event.target.value))"
                  @blur="$emit('save-settings')"
                >
              </div>
              <div class="memory-limit-item">
                <label class="memory-limit-label">Fallidas:</label>
                <input
                  type="number"
                  :value="maxFailedInMemory"
                  min="5"
                  max="100"
                  step="5"
                  class="number-input small"
                  @input="$emit('update:maxFailedInMemory', Number($event.target.value))"
                  @blur="$emit('save-settings')"
                >
              </div>
            </div>
            <span class="setting-hint">Controla cuántas descargas se mantienen en memoria para mejorar el rendimiento</span>
          </div>
        </div>
      </div>

      <!-- Sección Apariencia -->
      <div class="settings-section">
        <h3>Apariencia</h3>
        <div class="setting-item">
          <label>Color primario</label>
          <div class="setting-control">
            <div class="color-picker-group">
              <button
                v-for="(colorConfig, colorKey) in primaryColors"
                :key="colorKey"
                :class="['color-option-btn', { active: primaryColor === colorKey }]"
                :style="{ backgroundColor: colorConfig.value }"
                :title="colorConfig.name"
                :aria-label="`Seleccionar color ${colorConfig.name}`"
                @click="$emit('set-primary-color', colorKey)"
              >
                <span
                  v-if="primaryColor === colorKey"
                  class="color-check"
                >✓</span>
              </button>
            </div>
            <span class="setting-hint">Selecciona el color primario de la interfaz</span>
          </div>
        </div>

        <div class="setting-item">
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="showChunkProgress"
              class="checkbox-input"
              @change="$emit('update:showChunkProgress', $event.target.checked)"
            >
            Mostrar indicador de progreso de chunks
          </label>
          <span class="setting-hint">Muestra el progreso detallado de cada chunk en descargas fragmentadas</span>
        </div>
      </div>

      <!-- Sección Información -->
      <div class="settings-section">
        <h3>Información</h3>
        <div class="setting-item">
          <label>Versión</label>
          <div class="setting-control">
            <span>Myrient Downloader v1.0.0</span>
          </div>
        </div>
        <div class="setting-item">
          <label>Última actualización</label>
          <div class="setting-control">
            <span>{{ lastUpdateDate || 'Cargando...' }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { PRIMARY_COLORS } from '../../composables/useSettings';

// Props
const props = defineProps({
  show: {
    type: Boolean,
    required: true,
  },
  searchLimit: {
    type: Number,
    default: 500,
  },
  downloadPath: {
    type: String,
    default: '',
  },
  preserveStructure: {
    type: Boolean,
    default: true,
  },
  maxParallelDownloads: {
    type: Number,
    default: 3,
  },
  showNotifications: {
    type: Boolean,
    default: true,
  },
  autoResumeDownloads: {
    type: Boolean,
    default: true,
  },
  maxHistoryInMemory: {
    type: Number,
    default: 100,
  },
  maxCompletedInMemory: {
    type: Number,
    default: 50,
  },
  maxFailedInMemory: {
    type: Number,
    default: 20,
  },
  favoritesCount: {
    type: Number,
    default: 0,
  },
  lastUpdateDate: {
    type: String,
    default: '',
  },
  cleanupStats: {
    type: Object,
    default: null,
  },
  primaryColor: {
    type: String,
    default: 'green',
  },
  showChunkProgress: {
    type: Boolean,
    default: true,
  },
});

// Emits
const emit = defineEmits([
  'close',
  'update:searchLimit',
  'update:downloadPath',
  'update:preserveStructure',
  'update:maxParallelDownloads',
  'update:showNotifications',
  'update:autoResumeDownloads',
  'update:maxHistoryInMemory',
  'update:maxCompletedInMemory',
  'update:maxFailedInMemory',
  'update:showChunkProgress',
  'save-settings',
  'select-folder',
  'clear-favorites',
  'clean-history',
  'set-primary-color',
]);

// Exponer colores primarios para el template
const primaryColors = PRIMARY_COLORS;

// Referencias para focus trap
const settingsPanel = ref(null);
let previousActiveElement = null;

// Focus trap para modal
const trapFocus = (e) => {
  if (!props.show || !settingsPanel.value) return;

  const focusableElements = settingsPanel.value.querySelectorAll(
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

// Manejar focus cuando se abre el modal
watch(() => props.show, (isOpen) => {
  if (isOpen) {
    previousActiveElement = document.activeElement;
    // Enfocar el primer elemento enfocable o el botón de cerrar
    setTimeout(() => {
      const closeBtn = settingsPanel.value?.querySelector('.close-modal-btn');
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

onMounted(() => {
  if (props.show) {
    document.addEventListener('keydown', trapFocus);
  }
});

onUnmounted(() => {
  document.removeEventListener('keydown', trapFocus);
});

// Métodos
const formatDate = timestamp => {
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return '-';
  }
};
</script>

<!-- Sin estilos - usa style.css global -->
