<template>
  <div v-if="downloads.length > 0" id="downloads-section">
    <div class="downloads-header">
      <h2>Lista de Descargas</h2>
      <div class="header-actions">
        <button 
          v-if="hasActiveOrQueuedDownloads"
          @click="$emit('pause-all')" 
          class="btn-header btn-pause-all" 
          title="Pausar toda la cola"
        >
          ⏸ Pausar Todo
        </button>
        <button 
          v-if="hasPausedOrCancelledDownloads"
          @click="$emit('resume-all')" 
          class="btn-header btn-resume-all" 
          title="Reanudar toda la cola"
        >
          ▶ Reanudar Todo
        </button>
        <button 
          v-if="hasOnlyActiveOrQueuedDownloads"
          @click="$emit('cancel-all-downloads')" 
          class="btn-header btn-cancel-all" 
          title="Detener y eliminar todas las descargas activas"
        >
          ⏹ Eliminar Todo
        </button>
        <button 
          v-else-if="hasAnyDownloads"
          @click="$emit('clear-downloads')" 
          class="btn-clear-downloads" 
          title="Limpiar descargas completadas y detenidas"
        >
          🗑️ Limpiar Lista
        </button>
      </div>
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
          <td class="checkbox-col" data-label="">
            <input 
              type="checkbox" 
              :checked="selectedHistoryDownloads.has(download.id)"
              @change="$emit('toggle-select-history', download.id)"
              class="checkbox-input"
            />
          </td>
          <td class="download-name" data-label="Nombre" :title="download.title">{{ download.title }}</td>
          <td class="download-process" data-label="Proceso">
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
          <td class="download-status" data-label="Estado">
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
          <td class="download-speed" data-label="Velocidad">
            <span v-if="speedStats.has(download.id)" class="speed-badge">
              {{ speedStats.get(download.id).speed.toFixed(2) }} MB/s
            </span>
            <span v-else>-</span>
          </td>
          <td class="download-date" data-label="Fecha">
            {{ formatDate(download.completedAt || download.addedAt) }}
          </td>
          <td class="download-path" data-label="Ubicación" :title="download.savePath">
            {{ getDirectoryPath(download.savePath) }}
          </td>
          <td v-if="pendingConfirmations.length > 0" class="download-observation" data-label="Observación">
            <span v-if="download.state === 'waiting'" class="observation-text">
              Archivo ya existe
            </span>
            <span v-else>-</span>
          </td>
          <td class="download-actions" data-label="Acciones">
            <!-- Botones según estado -->
            <div class="action-buttons-row">
              <!-- Esperando confirmación de sobrescritura -->
              <template v-if="download.state === 'waiting'">
                <button @click="$emit('confirm-overwrite', download.id)" class="btn-action btn-confirm" title="Sobrescribir archivo">
                  <span class="btn-icon">✓</span>
                </button>
                <button @click="$emit('cancel-overwrite', download.id)" class="btn-action btn-cancel" title="Cancelar descarga">
                  <span class="btn-icon">✗</span>
                </button>
              </template>
              
              <!-- Descargando activamente -->
              <template v-else-if="download.queueStatus === 'downloading'">
                <button @click="$emit('pause', download.id)" class="btn-action btn-pause" title="Pausar descarga">
                  <span class="btn-icon">⏸</span>
                </button>
                <button @click="$emit('cancel', download.id)" class="btn-action btn-cancel" title="Detener y cancelar descarga">
                  <span class="btn-icon">⏹</span>
                </button>
              </template>
              
              <!-- Pausada - mostrar opción de reanudar -->
              <template v-else-if="download.queueStatus === 'paused'">
                <button @click="$emit('resume', download.id)" class="btn-action btn-resume" title="Reanudar descarga">
                  <span class="btn-icon">▶</span>
                </button>
                <button @click="$emit('cancel', download.id)" class="btn-action btn-cancel" title="Cancelar descarga">
                  <span class="btn-icon">⏹</span>
                </button>
              </template>
              
              <!-- En cola - permitir reiniciar o cancelar -->
              <template v-else-if="download.queueStatus === 'queued'">
                <button @click="$emit('retry', download.id)" class="btn-action btn-resume" title="Reiniciar descarga">
                  <span class="btn-icon">🔄</span>
                </button>
                <button @click="$emit('cancel', download.id)" class="btn-action btn-cancel" title="Cancelar descarga">
                  <span class="btn-icon">⏹</span>
                </button>
              </template>
              
              <!-- Cancelada/Detenida - opciones de reiniciar o eliminar -->
              <template v-else-if="download.state === 'cancelled' || download.queueStatus === 'cancelled'">
                <button @click="$emit('retry', download.id)" class="btn-action btn-resume" title="Reiniciar descarga">
                  <span class="btn-icon">🔄</span>
                </button>
                <button @click="$emit('remove', download.id)" class="btn-action btn-delete" title="Eliminar de la lista">
                  <span class="btn-icon">🗑️</span>
                </button>
              </template>
              
              <!-- Error/Interrumpida - opciones de reintentar o eliminar -->
              <template v-else-if="download.queueStatus === 'error'">
                <button @click="$emit('retry', download.id)" class="btn-action btn-resume" title="Reintentar descarga">
                  <span class="btn-icon">🔄</span>
                </button>
                <button @click="$emit('remove', download.id)" class="btn-action btn-delete" title="Eliminar de la lista">
                  <span class="btn-icon">🗑️</span>
                </button>
              </template>
              
              <!-- Completada - solo opción de eliminar -->
              <template v-else-if="download.queueStatus === 'completed'">
                <button @click="$emit('remove', download.id)" class="btn-action btn-delete" title="Eliminar de la lista">
                  <span class="btn-icon">🗑️</span>
                </button>
              </template>
              
              <!-- Sin acciones disponibles -->
              <template v-else>
                <span class="no-actions">-</span>
              </template>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- Estado vacío -->
  <div v-else-if="showEmpty" class="empty-state">
    <div class="empty-state-icon">⬇️</div>
    <h3>No hay descargas</h3>
    <p>Selecciona archivos de la lista para comenzar a descargar. Las descargas aparecerán aquí.</p>
  </div>
</template>

<script setup>
import { computed } from 'vue';

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
  'cancel-all-downloads',
  'pause-all',
  'resume-all',
  'confirm-all',
  'cancel-all',
  'toggle-select-all-history',
  'toggle-select-history',
  'confirm-overwrite',
  'cancel-overwrite',
  'pause',
  'resume',
  'cancel',
  'retry',
  'remove' // Nuevo emit para eliminar
]);

// Computed properties para controlar visibilidad de botones
const hasAnyDownloads = computed(() => {
  return props.downloads.length > 0;
});

const hasActiveOrQueuedDownloads = computed(() => {
  return props.downloads.some(d => 
    d.queueStatus === 'downloading' || 
    d.queueStatus === 'queued' ||
    d.state === 'progressing' ||
    d.state === 'starting' ||
    d.state === 'queued'
  );
});

const hasPausedOrCancelledDownloads = computed(() => {
  return props.downloads.some(d => 
    d.state === 'paused' ||
    d.state === 'cancelled' ||
    d.queueStatus === 'paused' ||
    d.queueStatus === 'cancelled'
  );
});

const hasOnlyActiveOrQueuedDownloads = computed(() => {
  // Verificar si solo hay descargas activas o en cola (sin completadas/detenidas)
  const hasActiveOrQueued = props.downloads.some(d => 
    d.queueStatus === 'downloading' || 
    d.queueStatus === 'queued' ||
    d.state === 'progressing' ||
    d.state === 'starting' ||
    d.state === 'queued'
  );
  
  const hasCompletedOrStopped = props.downloads.some(d => 
    d.queueStatus === 'completed' ||
    d.queueStatus === 'error' ||
    d.queueStatus === 'cancelled' ||
    d.state === 'completed' ||
    d.state === 'interrupted' ||
    d.state === 'cancelled'
  );
  
  // Solo mostrar "Eliminar Todo" si hay activas/en cola Y no hay completadas/detenidas
  return hasActiveOrQueued && !hasCompletedOrStopped;
});

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

<style scoped>
/* Header de descargas */
.downloads-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.btn-header {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.btn-header:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.btn-header:focus {
  outline: 2px solid currentColor;
  outline-offset: 2px;
  box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(0, 0, 0, 0.3);
}

.btn-header:active {
  transform: translateY(0);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
}

.btn-pause-all {
  background-color: #ff9800;
  color: white;
}

.btn-pause-all:hover {
  background-color: #e68900;
  box-shadow: 0 2px 8px rgba(255, 152, 0, 0.4);
}

.btn-resume-all {
  background-color: #2196f3;
  color: white;
}

.btn-resume-all:hover {
  background-color: #0b7dda;
  box-shadow: 0 2px 8px rgba(33, 150, 243, 0.4);
}

.btn-cancel-all {
  background-color: #f44336;
  color: white;
}

.btn-cancel-all:hover {
  background-color: #da190b;
  box-shadow: 0 2px 8px rgba(244, 67, 54, 0.4);
}

/* Centrar encabezados de tabla */
.downloads-table thead th {
  text-align: center;
}

.downloads-table thead th.checkbox-col {
  text-align: center;
}

/* Layout horizontal para botones de acción */
.action-buttons-row {
  display: flex;
  flex-direction: row;
  gap: 6px;
  align-items: center;
  justify-content: center;
  flex-wrap: nowrap;
}

.btn-action {
  min-width: 36px;
  max-width: 36px;
  width: 36px;
  min-height: 36px;
  max-height: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  transition: all 0.2s ease;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 0;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  box-sizing: border-box;
}

.btn-icon {
  font-size: 18px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-text {
  display: none;
}

.btn-action:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.btn-action:active {
  transform: translateY(0);
}

.btn-icon {
  font-size: 16px;
  line-height: 1;
}

.btn-text {
  font-size: 13px;
  line-height: 1;
}

/* Botón de confirmar/aceptar */
.btn-confirm {
  background-color: #4caf50;
  color: white;
}

.btn-confirm:hover {
  background-color: #45a049;
  box-shadow: 0 2px 8px rgba(76, 175, 80, 0.4);
}

/* Botón de pausar */
.btn-pause {
  background-color: #ff9800;
  color: white;
}

.btn-pause:hover {
  background-color: #e68900;
  box-shadow: 0 2px 8px rgba(255, 152, 0, 0.4);
}

/* Botón de reanudar/reiniciar */
.btn-resume {
  background-color: #2196f3;
  color: white;
}

.btn-resume:hover {
  background-color: #0b7dda;
  box-shadow: 0 2px 8px rgba(33, 150, 243, 0.4);
}

/* Botón de cancelar/detener */
.btn-cancel {
  background-color: #f44336;
  color: white;
}

.btn-cancel:hover {
  background-color: #da190b;
  box-shadow: 0 2px 8px rgba(244, 67, 54, 0.4);
}

/* Botón de eliminar */
.btn-delete {
  background-color: #9e9e9e;
  color: white;
}

.btn-delete:hover {
  background-color: #757575;
  box-shadow: 0 2px 8px rgba(158, 158, 158, 0.4);
}

.no-actions {
  color: #999;
  font-size: 14px;
  font-style: italic;
}

/* Responsive: en pantallas pequeñas, solo mostrar iconos */
@media (max-width: 768px) {
  .btn-text {
    display: none;
  }
  
  .btn-action {
    min-width: 36px;
    padding: 6px;
  }
}
</style>
