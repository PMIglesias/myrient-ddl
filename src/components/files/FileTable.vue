<template>
  <div v-if="files.length > 0" id="files-section">
    <div class="files-header">
      <h2>{{ title }}</h2>
      <button 
        v-if="selectedFiles.length > 0" 
        @click="$emit('download-selected')" 
        class="download-selected-btn"
      >
        📥 Descargar seleccionados ({{ selectedFiles.length }})
      </button>
    </div>
    
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
      <tbody>
        <tr v-for="file in files" :key="file.id">
          <td class="checkbox-col">
            <input 
              type="checkbox" 
              :checked="selectedFiles.includes(file.id)"
              @change="$emit('toggle-select', file.id)"
            />
          </td>
          <td :title="file.title">{{ file.title }}</td>
          <td v-if="showPath" class="location-cell" :title="file.fullPath">
            {{ file.fullPath || '-' }}
          </td>
          <td>{{ formatDate(file.modified_date) }}</td>
          <td class="size-cell">{{ file.size || '-' }}</td>
          <td>
            <button 
              @click="$emit('download', file)" 
              :disabled="isDownloadDisabled(file.id)"
            >
              {{ getButtonText(file.id) }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
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
  }
});

// Emits
defineEmits([
  'download',
  'download-selected',
  'toggle-select',
  'toggle-select-all',
  'sort'
]);

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

