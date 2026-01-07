<template>
  <div v-if="downloads.length > 0" id="downloads-section">
    <div class="downloads-header">
      <h2>Lista de Descargas</h2>
      <button @click="$emit('clear-downloads')" class="btn-clear-downloads" title="Limpiar lista">
        🗑️ Limpiar Lista
      </button>
    </div>

    <!-- Acciones masivas para confirmaciones -->
    <div v-if="selectedDownloads.size > 0" class="bulk-actions">
      <span class="bulk-info">{{ selectedDownloads.size }} seleccionada(s)</span>
      <button @click="$emit('confirm-all')" class="btn-bulk btn-bulk-yes">✓ Aceptar seleccionadas</button>
      <button @click="$emit('cancel-all')" class="btn-bulk btn-bulk-no">✗ Cancelar seleccionadas</button>
    </div>

    <table class="downloads-table">
      <thead>
        <tr>
          <th class="checkbox-col">
            <input 
              type="checkbox" 
              :checked="selectedHistoryDownloads.size === downloads.length && downloads.length > 0"
              @change="$emit('toggle-select-all-history', $event)"
              class="checkbox-input"
              title="Seleccionar todo"
            />
          </th>
          <th>Nombre del Archivo</th>
          <th>Proceso</th>
          <th>Estado</th>
          <th>Velocidad</th>
          <th>Fecha</th>
          <th>Ubicación</th>
          <th v-if="pendingConfirmations.length > 0">Observación</th>
          <th>Acciones</th>
        </tr>
      </thead>
      <tbody>
        <tr 
          v-for="download in downloads" 
          :key="download.id" 
          :class="'download-row-' + download.queueStatus"
        >
          <td class="checkbox-col">
            <input 
              type="checkbox" 
              :checked="selectedHistoryDownloads.has(download.id)"
              @change="$emit('toggle-select-history', download.id)"
              class="checkbox-input"
            />
          </td>
          <td class="download-name" :title="download.title">{{ download.title }}</td>
          <td class="download-process">
            <div v-if="download.queueStatus === 'downloading'" class="progress-container">
              <progress :value="download.percent || 0" max="1"></progress>
              <span class="progress-text">{{ getPercentage(download) }}%</span>
            </div>
            <div v-else-if="download.queueStatus === 'paused'" class="progress-container">
              <progress :value="download.percent || 0" max="1"></progress>
              <span class="progress-text">{{ getPercentage(download) }}%</span>
            </div>
            <span v-else-if="download.queueStatus === 'queued'">-</span>
            <span v-else-if="download.queueStatus === 'completed'">100%</span>
            <span v-else-if="download.queueStatus === 'error'">-</span>
          </td>
          <td class="download-status">
            <span v-if="download.state === 'waiting'" class="status-badge status-waiting">
              ⏸️ Esperando confirmación
            </span>
            <span v-else-if="download.state === 'paused'" class="status-badge status-paused">
              ⏸ Pausada
            </span>
            <span v-else-if="download.state === 'cancelled'" class="status-badge status-cancelled">
              ⏹ Detenida
            </span>
            <span v-else-if="download.queueStatus === 'queued'" class="status-badge status-queued">
              ⏳ En cola
            </span>
            <span v-else-if="download.queueStatus === 'downloading'" class="status-badge status-downloading">
              ⬇️ Descargando
            </span>
            <span v-else-if="download.queueStatus === 'completed'" class="status-badge status-completed">
              ✅ Completado
            </span>
            <span v-else-if="download.queueStatus === 'error'" class="status-badge status-error" :title="download.error">
              ❌ Error: {{ download.error }}
            </span>
          </td>
          <td class="download-speed">
            <span v-if="speedStats.has(download.id)" class="speed-badge">
              {{ speedStats.get(download.id).speed.toFixed(2) }} MB/s
            </span>
            <span v-else>-</span>
          </td>
          <td class="download-date">
            {{ formatDate(download.completedAt || download.addedAt) }}
          </td>
          <td class="download-path" :title="download.savePath">
            {{ getDirectoryPath(download.savePath) }}
          </td>
          <td v-if="pendingConfirmations.length > 0" class="download-observation">
            <span v-if="download.state === 'waiting'" class="observation-text">
              Archivo ya existe
            </span>
            <span v-else>-</span>
          </td>
          <td class="download-actions">
            <!-- Botones según estado -->
            <template v-if="download.state === 'waiting'">
              <button @click="$emit('confirm-overwrite', download.id)" class="btn-action btn-confirm" title="Sobrescribir">
                ✓
              </button>
              <button @click="$emit('cancel-overwrite', download.id)" class="btn-action btn-cancel" title="Cancelar">
                ✗
              </button>
            </template>
            <template v-else-if="download.queueStatus === 'downloading'">
              <button @click="$emit('pause', download.id)" class="btn-action btn-pause" title="Pausar">
                ⏸
              </button>
              <button @click="$emit('cancel', download.id)" class="btn-action btn-cancel" title="Cancelar">
                ✗
              </button>
            </template>
            <template v-else-if="download.queueStatus === 'paused'">
              <button @click="$emit('resume', download.id)" class="btn-action btn-resume" title="Reanudar">
                ▶
              </button>
              <button @click="$emit('cancel', download.id)" class="btn-action btn-cancel" title="Cancelar">
                ✗
              </button>
            </template>
            <template v-else-if="download.queueStatus === 'error'">
              <button @click="$emit('retry', download.id)" class="btn-action btn-resume" title="Reintentar">
                🔄
              </button>
            </template>
            <template v-else-if="download.queueStatus === 'queued'">
              <button @click="$emit('cancel', download.id)" class="btn-action btn-cancel" title="Cancelar">
                ✗
              </button>
            </template>
            <template v-else>
              <span class="no-actions">-</span>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Estado vacío -->
  <div v-else-if="showEmpty" class="empty-state">
    <p>No hay descargas. Selecciona archivos para comenzar.</p>
  </div>
</template>

<script setup>
// Props
const props = defineProps({
  downloads: {
    type: Array,
    required: true
  },
  speedStats: {
    type: Map,
    default: () => new Map()
  },
  pendingConfirmations: {
    type: Array,
    default: () => []
  },
  selectedDownloads: {
    type: Set,
    default: () => new Set()
  },
  selectedHistoryDownloads: {
    type: Set,
    default: () => new Set()
  },
  showEmpty: {
    type: Boolean,
    default: false
  }
});

// Emits
defineEmits([
  'clear-downloads',
  'confirm-all',
  'cancel-all',
  'toggle-select-all-history',
  'toggle-select-history',
  'confirm-overwrite',
  'cancel-overwrite',
  'pause',
  'resume',
  'cancel',
  'retry'
]);

// Métodos
const getPercentage = (download) => {
  return Math.round((download.percent || 0) * 100);
};

const formatDate = (timestamp) => {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString();
};

const getDirectoryPath = (fullPath) => {
  if (!fullPath) return '-';
  const lastSep = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'));
  return lastSep > 0 ? fullPath.substring(0, lastSep) : fullPath;
};
</script>

