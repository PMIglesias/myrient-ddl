<template>
  <!-- Overlay separado como en el original -->
  <div v-if="show" class="settings-overlay" @click="$emit('close')"></div>
  
  <!-- Panel de settings -->
  <div v-if="show" class="settings-panel">
    <div class="settings-header">
      <h2>⚙️ Configuración</h2>
      <button @click="$emit('close')" class="close-modal-btn">✕</button>
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
              @input="$emit('update:searchLimit', Number($event.target.value))"
              min="100" 
              max="2000" 
              step="100"
              class="number-input"
            />
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
                @input="$emit('update:downloadPath', $event.target.value)"
                @blur="$emit('save-settings')"
                class="path-input"
                placeholder="Ej: C:\Descargas"
              />
              <button @click="$emit('select-folder')" class="select-folder-btn">
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
              @change="$emit('update:preserveStructure', $event.target.checked)"
              class="checkbox-input"
            />
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
              @input="$emit('update:maxParallelDownloads', Number($event.target.value))"
              @blur="$emit('save-settings')"
              min="1" 
              max="3" 
              step="1"
              class="number-input"
            />
            <span class="setting-hint">Máximo permitido: 3 descargas simultáneas</span>
          </div>
        </div>

        <div class="setting-item">
          <label class="checkbox-label">
            <input 
              type="checkbox" 
              :checked="showNotifications"
              @change="$emit('update:showNotifications', $event.target.checked)"
              class="checkbox-input"
            />
            Mostrar notificaciones de archivos existentes
          </label>
          <span class="setting-hint">Muestra alertas cuando el archivo ya existe</span>
        </div>

        <div class="setting-item">
          <label class="checkbox-label">
            <input 
              type="checkbox" 
              :checked="autoResumeDownloads"
              @change="$emit('update:autoResumeDownloads', $event.target.checked)"
              class="checkbox-input"
            />
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
            <button @click="$emit('clear-favorites')" class="danger-btn">
              🗑️ Limpiar todos los favoritos
            </button>
            <span class="setting-hint">{{ favoritesCount }} favorito(s) guardado(s)</span>
          </div>
        </div>

        <div class="setting-item">
          <label>Historial de descargas</label>
          <div class="setting-control">
            <div class="history-controls">
              <button @click="$emit('clean-history', 30)" class="clean-history-btn" title="Eliminar registros de más de 30 días">
                🧹 Limpiar historial (30 días)
              </button>
              <button @click="$emit('clean-history', 7)" class="clean-history-btn small" title="Eliminar registros de más de 7 días">
                7 días
              </button>
            </div>
            <span class="setting-hint">Elimina registros antiguos de la base de datos para liberar espacio</span>
            <div v-if="cleanupStats" class="cleanup-stats">
              <span v-if="cleanupStats.lastDbCleanup" class="stat-item">
                Última limpieza BD: {{ formatDate(cleanupStats.lastDbCleanup) }}
              </span>
              <span v-if="cleanupStats.lastMemoryCleanup" class="stat-item">
                Última limpieza memoria: {{ formatDate(cleanupStats.lastMemoryCleanup) }}
              </span>
              <span v-if="cleanupStats.totalRemoved > 0" class="stat-item">
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
                  @input="$emit('update:maxHistoryInMemory', Number($event.target.value))"
                  @blur="$emit('save-settings')"
                  min="50" 
                  max="500" 
                  step="25"
                  class="number-input small"
                />
              </div>
              <div class="memory-limit-item">
                <label class="memory-limit-label">Completadas:</label>
                <input 
                  type="number" 
                  :value="maxCompletedInMemory"
                  @input="$emit('update:maxCompletedInMemory', Number($event.target.value))"
                  @blur="$emit('save-settings')"
                  min="10" 
                  max="200" 
                  step="10"
                  class="number-input small"
                />
              </div>
              <div class="memory-limit-item">
                <label class="memory-limit-label">Fallidas:</label>
                <input 
                  type="number" 
                  :value="maxFailedInMemory"
                  @input="$emit('update:maxFailedInMemory', Number($event.target.value))"
                  @blur="$emit('save-settings')"
                  min="5" 
                  max="100" 
                  step="5"
                  class="number-input small"
                />
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
                @click="$emit('set-primary-color', colorKey)"
                :class="['color-option-btn', { active: primaryColor === colorKey }]"
                :style="{ backgroundColor: colorConfig.value }"
                :title="colorConfig.name"
                :aria-label="`Seleccionar color ${colorConfig.name}`"
              >
                <span v-if="primaryColor === colorKey" class="color-check">✓</span>
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
              @change="$emit('update:showChunkProgress', $event.target.checked)"
              class="checkbox-input"
            />
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
import { PRIMARY_COLORS } from '../../composables/useSettings';

// Props
defineProps({
  show: {
    type: Boolean,
    required: true
  },
  searchLimit: {
    type: Number,
    default: 500
  },
  downloadPath: {
    type: String,
    default: ''
  },
  preserveStructure: {
    type: Boolean,
    default: true
  },
  maxParallelDownloads: {
    type: Number,
    default: 3
  },
  showNotifications: {
    type: Boolean,
    default: true
  },
  autoResumeDownloads: {
    type: Boolean,
    default: true
  },
  maxHistoryInMemory: {
    type: Number,
    default: 100
  },
  maxCompletedInMemory: {
    type: Number,
    default: 50
  },
  maxFailedInMemory: {
    type: Number,
    default: 20
  },
  favoritesCount: {
    type: Number,
    default: 0
  },
  lastUpdateDate: {
    type: String,
    default: ''
  },
  cleanupStats: {
    type: Object,
    default: null
  },
  primaryColor: {
    type: String,
    default: 'green'
  },
  showChunkProgress: {
    type: Boolean,
    default: true
  }
});

// Emits
defineEmits([
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
  'set-primary-color'
]);

// Exponer colores primarios para el template
const primaryColors = PRIMARY_COLORS;

// Métodos
const formatDate = (timestamp) => {
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return '-';
  }
};
</script>

<!-- Sin estilos - usa style.css global -->
