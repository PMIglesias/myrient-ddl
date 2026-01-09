<template>
  <div v-if="files.length > 0" id="files-section">
    <div class="files-header">
      <h2>{{ title }}</h2>
      <div class="header-buttons">
        <button 
          v-if="currentFolderId && !isAtRoot" 
          @click="$emit('download-folder')" 
          class="download-folder-btn"
          title="Descargar todos los archivos de esta carpeta (incluyendo subcarpetas)"
        >
          📦 Descargar carpeta completa
        </button>
        <button 
          v-if="selectedFiles.length > 0" 
          @click="$emit('download-selected')" 
          class="download-selected-btn"
        >
          📥 Descargar seleccionados ({{ selectedFiles.length }})
        </button>
      </div>
    </div>
    
    <div 
      class="table-container" 
      ref="tableContainer" 
      @scroll="handleScroll"
      :style="{ height: shouldVirtualize ? '600px' : 'auto', overflow: shouldVirtualize ? 'auto' : 'visible' }"
    >
      <table>
        <thead>
          <tr>
            <th class="checkbox-col">
              <input 
                type="checkbox" 
                :checked="selectedFiles.length === files.length && files.length > 0"
                @change="$emit('toggle-select-all')"
                title="Seleccionar todos"
              />
            </th>
            <th 
              v-if="sortable"
              @click="$emit('sort', 'title')" 
              class="sortable"
            >
              Nombre
              <span class="sort-arrow" v-if="sortField === 'title'">
                {{ sortDirection === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
            <th v-else>Nombre</th>
            
            <th 
              v-if="showPath && sortable"
              @click="$emit('sort', 'fullPath')" 
              class="sortable location-cell"
            >
              Ubicación
              <span class="sort-arrow" v-if="sortField === 'fullPath'">
                {{ sortDirection === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
            
            <th 
              v-if="sortable"
              @click="$emit('sort', 'modified_date')" 
              class="sortable"
            >
              Fecha Modificación
              <span class="sort-arrow" v-if="sortField === 'modified_date'">
                {{ sortDirection === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
            <th v-else>Fecha Modificación</th>
            
            <th 
              v-if="sortable"
              @click="$emit('sort', 'size')" 
              class="sortable size-cell"
            >
              Tamaño
              <span class="sort-arrow" v-if="sortField === 'size'">
                {{ sortDirection === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
            <th v-else class="size-cell">Tamaño</th>
            
            <th>Descargar</th>
          </tr>
        </thead>
        <tbody :style="{ height: shouldVirtualize ? totalHeight : 'auto' }">
          <!-- Espaciador superior para filas no visibles -->
          <tr v-if="shouldVirtualize && visibleRange.start > 0" style="height: 0;">
            <td :colspan="columnCount" :style="{ height: topSpacerHeight + 'px', padding: 0, border: 'none' }"></td>
          </tr>
          
          <!-- Filas visibles -->
          <tr 
            v-for="file in visibleItems" 
            :key="file.id"
            :data-virtual-index="file._virtualIndex"
            :data-index="file._virtualIndex"
          >
            <td class="checkbox-col" data-label="">
              <input 
                type="checkbox" 
                :checked="selectedFiles.includes(file.id)"
                @change="$emit('toggle-select', file.id)"
              />
            </td>
            <td data-label="Nombre" :title="file.title">{{ file.title }}</td>
            <td v-if="showPath" class="location-cell" data-label="Ubicación" :title="file.fullPath">
              {{ file.fullPath || '-' }}
            </td>
            <td data-label="Fecha Modificación">{{ formatDate(file.modified_date) }}</td>
            <td class="size-cell" data-label="Tamaño">{{ file.size || '-' }}</td>
            <td data-label="Acción">
              <button 
                @click="$emit('download', file)" 
                :disabled="isDownloadDisabled(file.id)"
              >
                {{ getButtonText(file.id) }}
              </button>
            </td>
          </tr>
          
          <!-- Espaciador inferior para filas no visibles -->
          <tr v-if="shouldVirtualize && visibleRange.end < files.length" style="height: 0;">
            <td :colspan="columnCount" :style="{ height: bottomSpacerHeight + 'px', padding: 0, border: 'none' }"></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useVirtualScroll } from '../../composables/useVirtualScroll';

// Props
const props = defineProps({
  files: {
    type: Array,
    required: true
  },
  title: {
    type: String,
    default: 'Archivos'
  },
  selectedFiles: {
    type: Array,
    default: () => []
  },
  downloads: {
    type: Object,
    default: () => ({})
  },
  sortable: {
    type: Boolean,
    default: false
  },
  sortField: {
    type: String,
    default: 'title'
  },
  sortDirection: {
    type: String,
    default: 'asc'
  },
  showPath: {
    type: Boolean,
    default: false
  },
  // Nueva prop para controlar cuándo activar virtualización
  enableVirtualization: {
    type: Boolean,
    default: true
  },
  // Número de filas a renderizar fuera de la vista (buffer)
  overscan: {
    type: Number,
    default: 5
  },
  // ID de la carpeta actual (para descargar carpeta completa)
  currentFolderId: {
    type: Number,
    default: null
  },
  // Indica si estamos en la raíz
  isAtRoot: {
    type: Boolean,
    default: false
  }
});

// Emits
defineEmits([
  'download',
  'download-selected',
  'download-folder',
  'toggle-select',
  'toggle-select-all',
  'sort'
]);

// Referencias
const tableContainer = ref(null);

// Computed: Número de columnas (para colspan)
const columnCount = computed(() => {
  let count = 3; // checkbox, nombre, descargar (siempre presentes)
  if (props.showPath) count++;
  count += 2; // fecha, tamaño (siempre presentes)
  return count;
});

// Virtual Scroll
const {
  shouldVirtualize,
  visibleRange,
  visibleItems,
  topSpacerHeight,
  bottomSpacerHeight,
  totalHeight,
  handleScroll,
  measureRowHeight
} = useVirtualScroll({
  items: computed(() => props.files),
  containerRef: tableContainer,
  itemHeight: 50, // Altura estimada por fila
  overscan: props.overscan || 5,
  minItemsToVirtualize: 50, // Solo virtualizar si hay más de 50 items
  enabled: props.enableVirtualization !== false
});

// Métodos
const formatDate = (dateStr) => {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
};

const isDownloadDisabled = (fileId) => {
  const download = props.downloads[fileId];
  return download && download.state !== 'interrupted';
};

const getButtonText = (fileId) => {
  const download = props.downloads[fileId];
  if (download) {
    if (download.state === 'completed') return '¡Listo!';
    if (download.state === 'progressing') return 'Bajando...';
    if (download.state === 'interrupted') return 'Reintentar';
    if (download.state === 'queued' || download.state === 'starting') return 'En cola...';
  }
  return 'Descargar';
};
</script>

