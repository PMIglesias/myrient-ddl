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
  favoritesCount: {
    type: Number,
    default: 0
  },
  lastUpdateDate: {
    type: String,
    default: ''
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
  'save-settings',
  'select-folder',
  'clear-favorites'
]);
</script>

<!-- Sin estilos - usa style.css global -->
