<template>
  <div class="confirmation-notifications">
    <TransitionGroup name="slide-fade">
      <div 
        v-for="confirmation in visibleConfirmations" 
        :key="confirmation.id" 
        class="confirmation-toast"
      >
        <div class="toast-content">
          <div class="toast-title-line">
            <div class="toast-title-left">
              <span class="toast-icon">⚠️</span>
              <span class="toast-label">Archivo existente</span>
            </div>
            <span class="toast-filename">{{ confirmation.title }}</span>
          </div>
          <div class="toast-sizes-line">
            <span class="size-description">{{ getSizeComparison(confirmation) }}</span>
          </div>
          <div class="toast-actions-line">
            <span class="toast-question">¿Sobrescribir?</span>
            <button @click="$emit('confirm', confirmation.id)" class="toast-btn toast-btn-yes">
              ✓ Sí
            </button>
            <button @click="$emit('cancel', confirmation.id)" class="toast-btn toast-btn-no">
              ✗ No
            </button>
          </div>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { computed } from 'vue';

// Props
const props = defineProps({
  confirmations: {
    type: Array,
    required: true
  }
});

// Emits
defineEmits(['confirm', 'cancel']);

// Computed
const visibleConfirmations = computed(() => {
  return props.confirmations.filter(c => c.showNotification);
});

// Métodos
const getSizeComparison = (confirmation) => {
  const { existingSize, expectedSize } = confirmation;
  
  if (!existingSize || !expectedSize) return 'Tamaño desconocido';
  
  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const diff = existingSize - expectedSize;
  
  if (Math.abs(diff) < 1024) {
    return `Tamaños iguales (${formatSize(existingSize)})`;
  }
  
  if (diff > 0) {
    return `Existente mayor: ${formatSize(existingSize)} vs ${formatSize(expectedSize)}`;
  }
  
  return `Existente menor: ${formatSize(existingSize)} vs ${formatSize(expectedSize)}`;
};
</script>

