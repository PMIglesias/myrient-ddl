<template>
  <div
    v-if="shouldShow"
    class="chunk-progress-container"
  >
    <!-- Información general de chunks -->
    <div class="chunk-summary">
      <span class="chunk-stats">
        {{ completedChunks }}/{{ totalChunks }} chunks
        <span
          v-if="activeChunks > 0"
          class="active-chunks"
        >({{ activeChunks }} activos)</span>
      </span>
    </div>

    <!-- Visualización de chunks (expandible) -->
    <div class="chunks-visualization">
      <div
        v-for="chunk in sortedChunks"
        :key="chunk.index"
        class="chunk-item"
        :class="getChunkClass(chunk)"
        :title="getChunkTooltip(chunk)"
      >
        <div
          v-if="chunk.progress > 0"
          class="chunk-bar"
          :style="{ 
            width: chunk.progress * 100 + '%',
            transition: chunk.progress >= 1 ? 'width 0.3s ease' : 'none'
          }"
        />
        <span class="chunk-index">{{ chunk.index }}</span>
        <span
          v-if="chunk.speed > 0"
          class="chunk-speed"
        >
          {{ formatSpeed(chunk.speed) }}
        </span>
      </div>
    </div>

    <!-- Indicador de merge si está fusionando -->
    <div
      v-if="mergeProgress !== undefined"
      class="merge-progress"
    >
      <div class="merge-info">
        <span class="merge-label">🔄 Fusionando chunks...</span>
        <span class="merge-percent">{{ Math.round(mergeProgress * 100) }}%</span>
      </div>
      <div class="merge-bar">
        <div
          class="merge-bar-fill"
          :style="{ width: mergeProgress * 100 + '%' }"
        />
      </div>
      <div
        v-if="mergeSpeed"
        class="merge-speed"
      >
        {{ formatSpeed(mergeSpeed) }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  chunked: {
    type: Boolean,
    default: false,
  },
  chunkProgress: {
    type: Array,
    default: () => [],
  },
  activeChunks: {
    type: Number,
    default: 0,
  },
  completedChunks: {
    type: Number,
    default: 0,
  },
  totalChunks: {
    type: Number,
    default: 0,
  },
  mergeProgress: {
    type: Number,
    default: undefined,
  },
  mergeSpeed: {
    type: Number,
    default: undefined, // bytes/seg
  },
  currentChunk: {
    type: Number,
    default: undefined,
  },
  bytesProcessed: {
    type: Number,
    default: undefined,
  },
});

// Determinar si se debe mostrar el componente
const shouldShow = computed(() => {
  // Mostrar si está fusionando (mergeProgress está definido)
  if (props.mergeProgress !== undefined) {
    return true;
  }

  // Mostrar si hay totalChunks > 0 (indica que es una descarga chunked)
  if (props.totalChunks && props.totalChunks > 0) {
    return true;
  }

  // Mostrar si hay chunkProgress con datos (incluso si está vacío, puede estar inicializándose)
  if (props.chunkProgress && Array.isArray(props.chunkProgress) && props.chunkProgress.length > 0) {
    return true;
  }

  // Mostrar si chunked está explícitamente en true
  if (props.chunked) {
    return true;
  }

  return false;
});

// Ordenar chunks por índice
const sortedChunks = computed(() => {
  if (
    !props.chunkProgress ||
    !Array.isArray(props.chunkProgress) ||
    props.chunkProgress.length === 0
  ) {
    // Si no hay chunkProgress pero hay totalChunks, crear array de chunks pendientes
    if (props.totalChunks > 0) {
      return Array.from({ length: props.totalChunks }, (_, i) => ({
        index: i,
        progress: 0,
        speed: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        state: 'pending',
      }));
    }
    return [];
  }

  return [...props.chunkProgress].sort((a, b) => a.index - b.index);
});

// Obtener clase CSS para chunk según su estado
const getChunkClass = chunk => {
  if (chunk.progress >= 1) return 'chunk-completed';
  if (chunk.progress > 0) return 'chunk-active';
  return 'chunk-pending';
};

// Tooltip informativo para cada chunk
const getChunkTooltip = chunk => {
  const progress = Math.round(chunk.progress * 100);
  const speed = chunk.speed > 0 ? formatSpeed(chunk.speed) : 'esperando';
  return `Chunk ${chunk.index}: ${progress}% - ${speed}`;
};

// Formatear velocidad
const formatSpeed = speed => {
  if (speed === 0 || speed === undefined || speed === null) return '-';

  // Asumir que speed ya está en MB/s si viene del backend
  // Si es muy grande (> 1000), probablemente está en bytes/seg
  let mbps = speed;
  if (speed > 1000) {
    // Convertir de bytes/seg a MB/s
    mbps = speed / (1024 * 1024);
  }

  if (mbps < 0.1) {
    // Mostrar en KB/s si es muy lento
    const kbps = mbps * 1024;
    return `${kbps.toFixed(1)} KB/s`;
  }

  return `${mbps.toFixed(2)} MB/s`;
};
</script>

<style scoped>
.chunk-progress-container {
  margin-top: 8px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
  display: block;
  visibility: visible;
  opacity: 1;
}

.chunk-summary {
  margin-bottom: 8px;
  color: #ccc;
  font-size: 12px;
}

.chunk-stats {
  font-weight: 500;
}

.active-chunks {
  color: var(--primary-color);
  font-weight: 600;
}

.chunks-visualization {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 8px;
  min-height: 28px;
}

.chunk-item {
  position: relative;
  width: 26px;
  height: 26px;
  background: #2a2a2a;
  border: 1px solid #555;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.chunk-item:hover {
  transform: scale(1.1);
  z-index: 10;
  border-color: var(--primary-color);
}

.chunk-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 100%;
  background: var(--primary-color);
  transition: width 0.3s ease;
  opacity: 0.7;
}

.chunk-completed .chunk-bar {
  background: #4caf50;
  opacity: 1;
}

.chunk-active .chunk-bar {
  background: var(--primary-color);
  animation: pulse 1.5s ease-in-out infinite;
}

.chunk-pending {
  opacity: 0.5;
}

.chunk-index {
  position: relative;
  z-index: 1;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

.chunk-speed {
  display: none;
  position: absolute;
  top: -20px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  background: rgba(0, 0, 0, 0.9);
  padding: 2px 4px;
  border-radius: 3px;
  font-size: 10px;
  color: #fff;
  pointer-events: none;
}

.chunk-item:hover .chunk-speed {
  display: block;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.7;
  }
  50% {
    opacity: 1;
  }
}

/* Indicador de merge */
.merge-progress {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #444;
}

.merge-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
  font-size: 11px;
}

.merge-label {
  color: #fff;
  font-weight: 500;
}

.merge-percent {
  color: var(--primary-color);
  font-weight: 600;
}

.merge-bar {
  width: 100%;
  height: 6px;
  background: #2a2a2a;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 4px;
}

.merge-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary-color), #4caf50);
  transition: width 0.3s ease;
  animation: merge-pulse 1.5s ease-in-out infinite;
}

@keyframes merge-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.8;
  }
}

.merge-speed {
  text-align: right;
  font-size: 10px;
  color: #999;
}

/* Modo claro */
.light-mode .chunk-progress-container {
  background: rgba(255, 255, 255, 0.1);
}

.light-mode .chunk-item {
  background: #e0e0e0;
  border-color: #ccc;
}

.light-mode .chunk-index {
  color: #333;
  text-shadow: none;
}

.light-mode .merge-bar {
  background: #e0e0e0;
}

.light-mode .chunk-summary {
  color: #666;
}
</style>
