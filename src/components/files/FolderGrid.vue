<template>
  <div
    v-if="folders.length > 0"
    id="folders-section"
  >
    <h2 v-if="title">
      {{ title }}
    </h2>
    <div class="folders-grid">
      <div
        v-for="folder in folders"
        :key="folder.id"
        class="folder-wrapper"
      >
        <button
          class="folder-btn"
          :class="{ 'search-folder-btn': isSearchResult }"
          :title="folder.displayTitle || folder.title"
          :aria-label="`Navegar a carpeta ${folder.displayTitle || folder.title}`"
          @click="$emit('navigate', folder)"
        >
          <span
            v-if="folder.breadcrumbPath && isSearchResult"
            class="folder-breadcrumb"
            aria-hidden="true"
          >
            {{ folder.breadcrumbPath }}/
          </span>
          <span class="folder-name">📁 {{ folder.title }}</span>
        </button>
        <button
          class="favorite-star-btn"
          :class="{
            active: isFavorite(folder.id),
            disabled: isFavorite(folder.id),
            visible: showFavoriteAlways,
          }"
          :title="isFavorite(folder.id) ? 'Quitar de favoritos' : 'Agregar a favoritos'"
          :aria-label="isFavorite(folder.id) ? `Quitar carpeta ${folder.title} de favoritos` : `Agregar carpeta ${folder.title} a favoritos`"
          :aria-pressed="isFavorite(folder.id)"
          @click.stop="$emit('toggle-favorite', folder)"
        >
          {{ isFavorite(folder.id) ? '⭐' : '☆' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
// Props
const props = defineProps({
  folders: {
    type: Array,
    required: true,
  },
  title: {
    type: String,
    default: '',
  },
  favoriteIds: {
    type: Set,
    default: () => new Set(),
  },
  isSearchResult: {
    type: Boolean,
    default: false,
  },
  showFavoriteAlways: {
    type: Boolean,
    default: false,
  },
});

// Emits
defineEmits(['navigate', 'toggle-favorite']);

// Métodos
const isFavorite = folderId => {
  return props.favoriteIds.has(folderId);
};
</script>
