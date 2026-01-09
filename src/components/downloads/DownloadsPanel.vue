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

    <div 
      class="downloads-table-container" 
      ref="downloadsContainer"
      @scroll="handleScroll"
      :style="{ height: shouldVirtualize ? '600px' : 'auto', overflow: shouldVirtualize ? 'auto' : 'visible' }"
    >
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
            <th>Tiempo Estimado</th>
            <th>Ubicación</th>
            <th v-if="pendingConfirmations.length > 0">Observación</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody :style="{ height: shouldVirtualize ? totalHeight : 'auto' }">
          <!-- Espaciador superior para filas no visibles -->
          <tr v-if="shouldVirtualize && visibleRange.start > 0" style="height: 0;">
            <td :colspan="columnCount" :style="{ height: topSpacerHeight + 'px', padding: 0, border: 'none' }"></td>
          </tr>
          
          <!-- Filas visibles -->
          <tr 
            v-for="download in visibleItems" 
            :key="download.id"
            :data-virtual-index="download._virtualIndex"
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
            <div class="process-content">
              <!-- Progreso general -->
              <div v-if="download.queueStatus === 'downloading' || download.state === 'progressing' || download.state === 'merging'" class="progress-container">
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
              
              <!-- Indicador de progreso granular para chunks (solo si está habilitado) -->
              <ChunkProgressIndicator
                v-if="shouldShowChunkProgress(download)"
                :chunked="download.chunked || false"
                :chunk-progress="download.chunkProgress && Array.isArray(download.chunkProgress) ? download.chunkProgress : []"
                :active-chunks="download.activeChunks || 0"
                :completed-chunks="download.completedChunks || 0"
                :total-chunks="download.totalChunks || 0"
                :merge-progress="download.mergeProgress !== undefined ? download.mergeProgress : (download.merging ? download.percent : undefined)"
                :merge-speed="download.mergeSpeed"
                :current-chunk="download.currentChunk"
                :bytes-processed="download.bytesProcessed"
              />
            </div>
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
            <span v-else-if="download.queueStatus === 'downloading' || download.state === 'progressing'" class="status-badge status-downloading">
              ⬇️ Descargando
            </span>
            <span v-else-if="download.state === 'merging' || download.merging" class="status-badge status-merging">
              🔄 Fusionando
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
          <td class="download-date" data-label="Tiempo Estimado">
            {{ getEstimatedTime(download) }}
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
        
        <!-- Espaciador inferior para filas no visibles -->
        <tr v-if="shouldVirtualize && visibleRange.end < downloads.length" style="height: 0;">
          <td :colspan="columnCount" :style="{ height: bottomSpacerHeight + 'px', padding: 0, border: 'none' }"></td>
        </tr>
      </tbody>
    </table>
    </div>
  </div>

  <!-- Estado vacío -->
  <div v-else-if="showEmpty" class="empty-state">
    <div class="empty-state-icon">⬇️</div>
    <h3>No hay descargas</h3>
    <p>Selecciona archivos de la lista para comenzar a descargar. Las descargas aparecerán aquí.</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useVirtualScroll } from '../../composables/useVirtualScroll';
import ChunkProgressIndicator from './ChunkProgressIndicator.vue';

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
  },
  showChunkProgress: {
    type: Boolean,
    default: true
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

// Referencias
const downloadsContainer = ref(null);
const timeEstimates = ref(new Map()); // Map<downloadId, timeEstimate>
let updateTimer = null;

// Computed: Número de columnas (para colspan)
const columnCount = computed(() => {
  let count = 8; // checkbox, nombre, proceso, estado, velocidad, fecha, ubicación, acciones
  if (props.pendingConfirmations.length > 0) count++; // observación
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
  handleScroll
} = useVirtualScroll({
  items: computed(() => props.downloads),
  containerRef: downloadsContainer,
  itemHeight: 60, // Altura estimada por fila (más alta que FileTable)
  overscan: 5,
  minItemsToVirtualize: 30, // Virtualizar con menos items que archivos
  enabled: true
});

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

// Verificar si se debe mostrar el indicador de chunks
const shouldShowChunkProgress = (download) => {
  // Verificar que showChunkProgress esté habilitado
  if (!props.showChunkProgress) {
    return false;
  }
  
  // Verificar que sea descarga chunked o esté fusionando
  const isChunked = download.chunked || download.merging;
  if (!isChunked) {
    return false;
  }
  
  // Verificar que tenga información de chunks (totalChunks o chunkProgress)
  // Ser más permisivo: mostrar si hay totalChunks > 0 O si hay chunkProgress (incluso vacío)
  const hasTotalChunks = download.totalChunks && download.totalChunks > 0;
  const hasChunkProgress = download.chunkProgress && Array.isArray(download.chunkProgress);
  const hasChunkInfo = hasTotalChunks || hasChunkProgress;
  
  // Si no se muestra, log para debug
  if (!hasChunkInfo) {
    console.debug('[DownloadsPanel] ChunkProgress no se muestra:', {
      id: download.id,
      showChunkProgress: props.showChunkProgress,
      chunked: download.chunked,
      merging: download.merging,
      totalChunks: download.totalChunks,
      chunkProgress: download.chunkProgress,
      hasTotalChunks,
      hasChunkProgress,
      hasChunkInfo
    });
  }
  
  return hasChunkInfo;
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

// Obtener estimación de tiempo para una descarga
const getEstimatedTime = (download) => {
  // Para descargas en cola: mostrar tiempo hasta que comience
  if (download.queueStatus === 'queued' || download.state === 'queued') {
    const estimate = timeEstimates.value.get(download.id);
    
    if (!estimate) {
      return 'Calculando...';
    }

    // Si puede empezar de inmediato
    if (estimate.canStartImmediately) {
      return 'Inmediato';
    }

    // Si no se puede estimar (falta velocidad)
    if (estimate.requiresSpeed || estimate.estimatedSeconds === null) {
      return 'Requiere velocidad';
    }

    // Formatear tiempo hasta inicio
    return formatEstimatedTime(estimate.estimatedSeconds, estimate.estimatedMinutes, estimate.estimatedHours);
  }
  
  // Para descargas activas (descargando o fusionando): mostrar tiempo restante de finalización
  if (download.queueStatus === 'downloading' || 
      download.state === 'progressing' || 
      download.state === 'merging' || 
      download.merging) {
    
    // remainingTime viene del backend en segundos
    const remainingSeconds = download.remainingTime;
    
    if (!remainingSeconds || remainingSeconds <= 0 || !isFinite(remainingSeconds)) {
      return 'Calculando...';
    }
    
    // Formatear tiempo restante
    return formatRemainingTime(remainingSeconds);
  }
  
  // Para otras descargas (pausadas, completadas, error, etc.)
  return '-';
};

// Formatear tiempo estimado de manera legible (para descargas en cola)
const formatEstimatedTime = (seconds, minutes, hours) => {
  if (hours && hours >= 1) {
    const h = Math.floor(hours);
    const m = Math.floor(minutes % 60);
    if (m > 0) {
      return `~${h}h ${m}m`;
    }
    return `~${h}h`;
  } else if (minutes && minutes >= 1) {
    const m = Math.floor(minutes);
    const s = Math.floor(seconds % 60);
    if (s > 0 && m < 10) {
      return `~${m}m ${s}s`;
    }
    return `~${m}m`;
  } else if (seconds && seconds > 0) {
    return `~${Math.floor(seconds)}s`;
  }
  
  return '-';
};

// Formatear tiempo restante de finalización (para descargas activas)
const formatRemainingTime = (seconds) => {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) {
    return '-';
  }
  
  const hours = seconds / 3600;
  const minutes = seconds / 60;
  
  if (hours >= 1) {
    const h = Math.floor(hours);
    const m = Math.floor((seconds % 3600) / 60);
    if (m > 0) {
      return `${h}h ${m}m`;
    }
    return `${h}h`;
  } else if (minutes >= 1) {
    const m = Math.floor(minutes);
    const s = Math.floor(seconds % 60);
    if (s > 0 && m < 60) {
      return `${m}m ${s}s`;
    }
    return `${m}m`;
  } else {
    return `${Math.floor(seconds)}s`;
  }
};

// Actualizar estimaciones de tiempo
const updateTimeEstimates = async () => {
  try {
    // Obtener todas las descargas en cola
    const queuedDownloads = props.downloads.filter(d => 
      d.queueStatus === 'queued' || d.state === 'queued'
    );

    if (queuedDownloads.length === 0) {
      timeEstimates.value.clear();
      return;
    }

    // Obtener estimación para cada descarga en cola
    for (const download of queuedDownloads) {
      try {
        const result = await window.api.getQueueTimeEstimate(download.id);
        
        if (result.success && result.timeUntilStart) {
          timeEstimates.value.set(download.id, result.timeUntilStart);
        } else {
          // Si falla, intentar obtener estimación total de cola
          const totalResult = await window.api.getQueueTimeEstimate();
          if (totalResult.success && totalResult.queueTimeEstimate) {
            // Para descargas en cola, usar la estimación total dividida por posición
            // Esto es una aproximación, pero mejor que nada
            const position = queuedDownloads.findIndex(d => d.id === download.id) + 1;
            const totalEstimate = totalResult.queueTimeEstimate;
            
            if (totalEstimate.totalEstimatedSeconds !== null) {
              // Estimar tiempo basado en posición en cola
              const avgTimePerDownload = totalEstimate.totalEstimatedSeconds / queuedDownloads.length;
              const estimatedSeconds = avgTimePerDownload * position;
              
              timeEstimates.value.set(download.id, {
                estimatedSeconds,
                estimatedMinutes: estimatedSeconds / 60,
                estimatedHours: estimatedSeconds / 3600,
                canStartImmediately: false,
                positionInQueue: position
              });
            }
          }
        }
      } catch (error) {
        console.error(`Error obteniendo estimación para descarga ${download.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Error actualizando estimaciones de tiempo:', error);
  }
};

// Watcher para actualizar estimaciones cuando cambian las descargas en cola
watch(() => props.downloads.filter(d => d.queueStatus === 'queued' || d.state === 'queued'), 
  (newQueued, oldQueued) => {
    // Si hay cambios en las descargas en cola, actualizar estimaciones
    const newIds = new Set(newQueued.map(d => d.id));
    const oldIds = new Set((oldQueued || []).map(d => d.id));
    
    // Si hay nuevas descargas o se eliminaron, actualizar
    if (newIds.size !== oldIds.size || 
        [...newIds].some(id => !oldIds.has(id)) ||
        [...oldIds].some(id => !newIds.has(id))) {
      updateTimeEstimates();
    }
  },
  { deep: true }
);

// Inicializar actualización periódica de estimaciones
onMounted(() => {
  // Actualizar inmediatamente
  updateTimeEstimates();
  
  // Actualizar cada 5 segundos
  updateTimer = setInterval(() => {
    updateTimeEstimates();
  }, 5000);
});

// Limpiar timer al desmontar
onUnmounted(() => {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
});
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

/* Contenedor de tabla con scroll virtual */
.downloads-table-container {
  overflow: auto;
  border: 1px solid #444;
  border-radius: 6px;
  max-height: 600px;
}

.downloads-table-container::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

.downloads-table-container::-webkit-scrollbar-track {
  background: #2a2a2a;
  border-radius: 6px;
}

.downloads-table-container::-webkit-scrollbar-thumb {
  background: #555;
  border-radius: 6px;
}

.downloads-table-container::-webkit-scrollbar-thumb:hover {
  background: #666;
}

/* Centrar encabezados de tabla */
.downloads-table {
  width: 100%;
  border-collapse: collapse;
}

.downloads-table thead {
  position: sticky;
  top: 0;
  background-color: #2a2a2a;
  z-index: 10;
}

.downloads-table thead th {
  text-align: center;
  padding: 12px 15px;
  font-weight: 600;
  color: var(--primary-color);
  border-bottom: 2px solid #444;
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

/* Estado de merging */
.status-merging {
  background-color: #9c27b0;
  color: white;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.status-merging:hover {
  background-color: #7b1fa2;
}

/* Ajustar tamaño de columna de proceso para mostrar chunks */
.download-process {
  min-width: 200px;
  max-width: 300px;
  vertical-align: top;
  padding: 12px 15px;
}

.process-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.progress-container {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.progress-container progress {
  flex: 1;
  height: 8px;
}

.progress-text {
  font-size: 12px;
  color: #999;
  white-space: nowrap;
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
