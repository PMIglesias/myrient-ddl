<template>
  <div
    id="titlebar"
    class="titlebar"
  >
    <div class="titlebar-content">
      <button
        v-if="!isAtRoot"
        class="back-btn"
        title="Volver"
        aria-label="Volver a la carpeta anterior"
        @click="$emit('go-back')"
      >
        &lt;
      </button>
      <span class="titlebar-title">Myrient Downloader</span>
      <span
        v-if="locationPath"
        class="location-path"
      >{{ locationPath }}</span>
    </div>

    <div class="titlebar-controls">
      <!-- Indicador de velocidad -->
      <div
        v-if="activeDownloadCount > 0"
        class="speed-indicator"
        :title="`${currentDownloadName || 'Descargando...'}${currentDownloadName ? ' - ' + activeDownloadCount + ' activa(s)' : ''}`"
      >
        <span class="speed-icon">⬇️</span>
        <span class="speed-info">
          <span class="download-name scrolling-text">{{
            currentDownloadName || 'Descargando...'
          }}</span>
          <span class="speed-value">{{ averageDownloadSpeed.toFixed(2) }} MB/s</span>
        </span>
      </div>

      <!-- Botones de control -->
      <button
        class="titlebar-btn theme-btn"
        :title="isDarkMode ? 'Modo Claro' : 'Modo Oscuro'"
        :aria-label="isDarkMode ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'"
        :aria-pressed="isDarkMode"
        @click="$emit('toggle-theme')"
      >
        {{ isDarkMode ? '☀️' : '🌙' }}
      </button>

      <button
        class="titlebar-btn logs-btn"
        title="Consola de Logs"
        aria-label="Abrir consola de logs"
        @click="$emit('open-logs')"
      >
        📋
      </button>

      <button
        class="titlebar-btn settings-btn"
        title="Configuración"
        aria-label="Abrir panel de configuración"
        @click="$emit('open-settings')"
      >
        ⚙️
      </button>

      <button
        class="titlebar-btn minimize-btn"
        title="Minimizar"
        aria-label="Minimizar ventana"
        @click="minimizeWindow"
      >
        -
      </button>

      <button
        class="titlebar-btn maximize-btn"
        :title="isMaximized ? 'Restaurar' : 'Maximizar'"
        :aria-label="isMaximized ? 'Restaurar ventana' : 'Maximizar ventana'"
        @click="maximizeWindow"
      >
        {{ isMaximized ? '▭' : '□' }}
      </button>

      <button
        class="titlebar-btn close-btn"
        title="Cerrar"
        aria-label="Cerrar ventana"
        @click="closeWindow"
      >
        ✕
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import {
  minimizeWindow as apiMinimize,
  maximizeWindow as apiMaximize,
  closeWindow as apiClose,
} from '../../services/api';

// Props
const props = defineProps({
  isAtRoot: {
    type: Boolean,
    default: true,
  },
  locationPath: {
    type: String,
    default: '',
  },
  isDarkMode: {
    type: Boolean,
    default: true,
  },
  activeDownloadCount: {
    type: Number,
    default: 0,
  },
  currentDownloadName: {
    type: String,
    default: '',
  },
  averageDownloadSpeed: {
    type: Number,
    default: 0,
  },
});

// Emits
defineEmits(['go-back', 'toggle-theme', 'open-settings', 'open-logs']);

// Estado local
const isMaximized = ref(false);

// Métodos de ventana
const minimizeWindow = () => {
  apiMinimize();
};

const maximizeWindow = () => {
  apiMaximize();
  isMaximized.value = !isMaximized.value;
};

const closeWindow = () => {
  apiClose();
};
</script>

<!-- Sin estilos - usa style.css global -->
