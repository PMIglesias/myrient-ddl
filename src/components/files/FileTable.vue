<template>
  <div
    v-if="files.length > 0"
    id="files-section"
  >
    <div class="files-header">
      <h2>{{ title }}</h2>
      <div class="header-buttons">
        <button
          v-if="currentFolderId && !isAtRoot"
          class="download-folder-btn"
          title="Descargar todos los archivos de esta carpeta (incluyendo subcarpetas)"
          aria-label="Descargar todos los archivos de esta carpeta incluyendo subcarpetas"
          @click="$emit('download-folder')"
        >
          📦 Descargar carpeta completa
        </button>
        <button
          v-if="selectedFiles.length > 0"
          class="download-selected-btn"
          :aria-label="`Descargar ${selectedFiles.length} archivo${selectedFiles.length > 1 ? 's' : ''} seleccionado${selectedFiles.length > 1 ? 's' : ''}`"
          @click="$emit('download-selected')"
        >
          📥 Descargar seleccionados ({{ selectedFiles.length }})
        </button>
      </div>
    </div>

    <div
      ref="tableContainer"
      class="table-container"
      role="region"
      aria-label="Tabla de archivos"
      :style="{
        height: shouldVirtualize ? '600px' : 'auto',
        overflow: shouldVirtualize ? 'auto' : 'visible',
      }"
      @scroll="handleScroll"
    >
      <table
        role="table"
        aria-label="Lista de archivos"
      >
        <thead>
          <tr>
            <th class="checkbox-col">
              <input
                type="checkbox"
                :checked="selectedFiles.length === files.length && files.length > 0"
                title="Seleccionar todos"
                aria-label="Seleccionar todos los archivos"
                @change="$emit('toggle-select-all')"
              >
            </th>
            <th
              v-if="sortable"
              class="sortable"
              role="columnheader"
              :aria-sort="sortField === 'title' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"
              :aria-label="sortField === 'title' ? `Nombre, ordenado ${sortDirection === 'asc' ? 'ascendente' : 'descendente'}` : 'Nombre, ordenar'"
              tabindex="0"
              @click="$emit('sort', 'title')"
              @keydown.enter="$emit('sort', 'title')"
              @keydown.space.prevent="$emit('sort', 'title')"
            >
              Nombre
              <span
                v-if="sortField === 'title'"
                class="sort-arrow"
                aria-hidden="true"
              >
                {{ sortDirection === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
            <th v-else>
              Nombre
            </th>

            <th
              v-if="showPath && sortable"
              class="sortable location-cell"
              role="columnheader"
              :aria-sort="sortField === 'fullPath' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"
              :aria-label="sortField === 'fullPath' ? `Ubicación, ordenado ${sortDirection === 'asc' ? 'ascendente' : 'descendente'}` : 'Ubicación, ordenar'"
              tabindex="0"
              @click="$emit('sort', 'fullPath')"
              @keydown.enter="$emit('sort', 'fullPath')"
              @keydown.space.prevent="$emit('sort', 'fullPath')"
            >
              Ubicación
              <span
                v-if="sortField === 'fullPath'"
                class="sort-arrow"
                aria-hidden="true"
              >
                {{ sortDirection === 'asc' ? '↑' : '↓' }}
              </span>
            </th>

            <th
              v-if="sortable"
              class="sortable"
              role="columnheader"
              :aria-sort="sortField === 'modified_date' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"
              :aria-label="sortField === 'modified_date' ? `Fecha de modificación, ordenado ${sortDirection === 'asc' ? 'ascendente' : 'descendente'}` : 'Fecha de modificación, ordenar'"
              tabindex="0"
              @click="$emit('sort', 'modified_date')"
              @keydown.enter="$emit('sort', 'modified_date')"
              @keydown.space.prevent="$emit('sort', 'modified_date')"
            >
              Fecha Modificación
              <span
                v-if="sortField === 'modified_date'"
                class="sort-arrow"
                aria-hidden="true"
              >
                {{ sortDirection === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
            <th v-else>
              Fecha Modificación
            </th>

            <th
              v-if="sortable"
              class="sortable size-cell"
              role="columnheader"
              :aria-sort="sortField === 'size' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'"
              :aria-label="sortField === 'size' ? `Tamaño, ordenado ${sortDirection === 'asc' ? 'ascendente' : 'descendente'}` : 'Tamaño, ordenar'"
              tabindex="0"
              @click="$emit('sort', 'size')"
              @keydown.enter="$emit('sort', 'size')"
              @keydown.space.prevent="$emit('sort', 'size')"
            >
              Tamaño
              <span
                v-if="sortField === 'size'"
                class="sort-arrow"
                aria-hidden="true"
              >
                {{ sortDirection === 'asc' ? '↑' : '↓' }}
              </span>
            </th>
            <th
              v-else
              class="size-cell"
            >
              Tamaño
            </th>

            <th>Descargar</th>
          </tr>
        </thead>
        <tbody :style="{ height: shouldVirtualize ? totalHeight : 'auto' }">
          <!-- Espaciador superior para filas no visibles -->
          <tr
            v-if="shouldVirtualize && visibleRange.start > 0"
            style="height: 0"
          >
            <td
              :colspan="columnCount"
              :style="{ height: topSpacerHeight + 'px', padding: 0, border: 'none' }"
            />
          </tr>

          <!-- Filas visibles -->
          <tr
            v-for="file in visibleItems"
            :key="file.id"
            :data-virtual-index="file._virtualIndex"
            :data-index="file._virtualIndex"
            role="row"
            tabindex="0"
            @keydown.enter="$emit('download', file)"
            @keydown.space.prevent="$emit('download', file)"
          >
            <td
              class="checkbox-col"
              data-label=""
            >
              <input
                type="checkbox"
                :checked="selectedFiles.includes(file.id)"
                :aria-label="`Seleccionar archivo ${file.title}`"
                @change="$emit('toggle-select', file.id)"
              >
            </td>
            <td
              data-label="Nombre"
              :title="file.title"
            >
              {{ file.title }}
            </td>
            <td
              v-if="showPath"
              class="location-cell"
              data-label="Ubicación"
              :title="file.fullPath"
            >
              {{ file.fullPath || '-' }}
            </td>
            <td data-label="Fecha Modificación">
              {{ formatDate(file.modified_date) }}
            </td>
            <td
              class="size-cell"
              data-label="Tamaño"
            >
              {{ file.size || '-' }}
            </td>
            <td data-label="Acción">
              <button
                :disabled="isDownloadDisabled(file.id)"
                :aria-label="`${getButtonText(file.id)} archivo ${file.title}`"
                :aria-disabled="isDownloadDisabled(file.id)"
                @click="$emit('download', file)"
              >
                {{ getButtonText(file.id) }}
              </button>
            </td>
          </tr>

          <!-- Espaciador inferior para filas no visibles -->
          <tr
            v-if="shouldVirtualize && visibleRange.end < files.length"
            style="height: 0"
          >
            <td
              :colspan="columnCount"
              :style="{ height: bottomSpacerHeight + 'px', padding: 0, border: 'none' }"
            />
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
    required: true,
  },
  title: {
    type: String,
    default: 'Archivos',
  },
  selectedFiles: {
    type: Array,
    default: () => [],
  },
  downloads: {
    type: Object,
    default: () => ({}),
  },
  sortable: {
    type: Boolean,
    default: false,
  },
  sortField: {
    type: String,
    default: 'title',
  },
  sortDirection: {
    type: String,
    default: 'asc',
  },
  showPath: {
    type: Boolean,
    default: false,
  },
  // Nueva prop para controlar cuándo activar virtualización
  enableVirtualization: {
    type: Boolean,
    default: true,
  },
  // Número de filas a renderizar fuera de la vista (buffer)
  overscan: {
    type: Number,
    default: 5,
  },
  // ID de la carpeta actual (para descargar carpeta completa)
  currentFolderId: {
    type: Number,
    default: null,
  },
  // Indica si estamos en la raíz
  isAtRoot: {
    type: Boolean,
    default: false,
  },
});

// Emits
defineEmits([
  'download',
  'download-selected',
  'download-folder',
  'toggle-select',
  'toggle-select-all',
  'sort',
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
  measureRowHeight,
} = useVirtualScroll({
  items: computed(() => props.files),
  containerRef: tableContainer,
  itemHeight: 50, // Altura estimada por fila
  overscan: props.overscan || 5,
  minItemsToVirtualize: 50, // Solo virtualizar si hay más de 50 items
  enabled: props.enableVirtualization !== false,
});

// Métodos
const formatDate = dateStr => {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
};

const formatBytes = bytes => {
  // Manejar null, undefined, o valores no numéricos
  if (bytes === null || bytes === undefined || bytes === '') return '-';
  
  // Convertir a número - intentar parseInt primero para valores enteros, luego parseFloat
  let numBytes;
  if (typeof bytes === 'string') {
    // Si es string, intentar convertir
    numBytes = bytes.trim() === '' ? NaN : Number(bytes);
  } else {
    numBytes = Number(bytes);
  }
  
  // Validar que sea un número válido y positivo
  if (isNaN(numBytes) || !isFinite(numBytes) || numBytes < 0) return '-';
  
  if (numBytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  
  // Calcular el índice de la unidad apropiada
  // Si el valor es menor a 1024, el índice será 0 (bytes)
  const i = Math.floor(Math.log(numBytes) / Math.log(k));
  
  // Asegurar que el índice esté en el rango válido
  const unitIndex = Math.max(0, Math.min(i, sizes.length - 1));
  const size = numBytes / Math.pow(k, unitIndex);
  
  // Formatear con máximo 2 decimales, pero sin decimales innecesarios
  const formattedSize = size % 1 === 0 ? size.toFixed(0) : size.toFixed(2);
  
  return formattedSize + ' ' + sizes[unitIndex];
};

const isDownloadDisabled = fileId => {
  const download = props.downloads[fileId];
  return download && download.state !== 'interrupted';
};

const getButtonText = fileId => {
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
