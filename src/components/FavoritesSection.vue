<template>
  <div
    v-if="folders.length > 0"
    id="favorites-section"
  >
    <h2>Favoritos</h2>
    <div class="folders-grid">
      <div
        v-for="folder in folders"
        :key="folder.id"
        class="folder-wrapper"
      >
        <button
          class="folder-btn"
          :title="folder.title"
          :aria-label="`Navegar a carpeta favorita ${folder.title}`"
          @click="$emit('navigate', folder)"
        >
          📁 {{ folder.title }}
        </button>
        <button
          class="favorite-star-btn visible"
          title="Quitar de favoritos"
          :aria-label="`Quitar carpeta ${folder.title} de favoritos`"
          @click.stop="$emit('remove', folder)"
        >
          ⭐
        </button>
      </div>
    </div>
  </div>

  <div
    v-else
    class="empty-state"
  >
    <div class="empty-state-icon">
      ⭐
    </div>
    <h3>Sin favoritos</h3>
    <p>
      No tienes carpetas favoritas aún. Agrega carpetas usando la estrella ⭐ al pasar el mouse
      sobre ellas.
    </p>
  </div>
</template>

<script setup>
// Props
defineProps({
  folders: {
    type: Array,
    required: true,
  },
});

// Emits
defineEmits(['navigate', 'remove']);
</script>
