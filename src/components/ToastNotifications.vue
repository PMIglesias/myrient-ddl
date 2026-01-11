<template>
  <div class="toast-notifications">
    <TransitionGroup name="toast-slide">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        :class="['toast', `toast-${toast.type}`]"
        @click="removeToast(toast.id)"
      >
        <div class="toast-icon">
          <span v-if="toast.type === 'info'">ℹ️</span>
          <span v-else-if="toast.type === 'success'">✓</span>
          <span v-else-if="toast.type === 'warning'">⚠️</span>
          <span v-else-if="toast.type === 'error'">✗</span>
        </div>
        <div class="toast-content">
          <div class="toast-title">
            {{ toast.title }}
          </div>
          <div
            v-if="toast.message"
            class="toast-message"
          >
            {{ toast.message }}
          </div>
        </div>
        <button
          class="toast-close"
          aria-label="Cerrar notificación"
          @click.stop="removeToast(toast.id)"
        >
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

// Props
const props = defineProps({
  toasts: {
    type: Array,
    default: () => [],
  },
});

// Emits
const emit = defineEmits(['remove']);

// Métodos
const removeToast = id => {
  emit('remove', id);
};
</script>

<style scoped>
.toast-notifications {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 10001;
  display: flex;
  flex-direction: column-reverse;
  gap: 10px;
  max-width: 400px;
  pointer-events: none;
}

.toast {
  background: #2b2b2b;
  border-radius: 6px;
  padding: 12px 16px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border-left: 4px solid #4caf50;
  min-width: 300px;
  transition: all 0.3s ease;
}

.toast:hover {
  transform: translateX(-4px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
}

.toast-info {
  border-left-color: #2196f3;
}

.toast-success {
  border-left-color: #4caf50;
}

.toast-warning {
  border-left-color: #ff9800;
}

.toast-error {
  border-left-color: #f44336;
}

.toast-icon {
  font-size: 20px;
  flex-shrink: 0;
  margin-top: 2px;
}

.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-title {
  font-weight: 600;
  color: #fff;
  font-size: 14px;
  margin-bottom: 4px;
}

.toast-message {
  color: #ccc;
  font-size: 12px;
  line-height: 1.4;
}

.toast-close {
  background: transparent;
  border: none;
  color: #999;
  font-size: 20px;
  cursor: pointer;
  padding: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.2s;
  margin-top: -2px;
}

.toast-close:hover {
  color: #fff;
}

/* Animaciones */
.toast-slide-enter-active {
  transition: all 0.3s ease-out;
}

.toast-slide-leave-active {
  transition: all 0.2s ease-in;
}

.toast-slide-enter-from {
  transform: translateX(400px);
  opacity: 0;
}

.toast-slide-leave-to {
  transform: translateX(400px);
  opacity: 0;
}

/* Modo claro */
.light-mode .toast {
  background: #f5f5f5;
  border-left-color: #4caf50;
}

.light-mode .toast-info {
  border-left-color: #2196f3;
}

.light-mode .toast-success {
  border-left-color: #4caf50;
}

.light-mode .toast-warning {
  border-left-color: #ff9800;
}

.light-mode .toast-error {
  border-left-color: #f44336;
}

.light-mode .toast-title {
  color: #333;
}

.light-mode .toast-message {
  color: #666;
}

.light-mode .toast-close {
  color: #999;
}

.light-mode .toast-close:hover {
  color: #333;
}
</style>
