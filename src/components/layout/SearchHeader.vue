<template>
  <div id="header">
    <div class="header-top">
      <h1>Myrient DDL</h1>
      <div class="header-buttons">
        <button
          class="favorites-btn"
          :class="{ active: showingFavorites }"
          aria-label="Mostrar u ocultar favoritos"
          :aria-pressed="showingFavorites"
          @click="$emit('toggle-favorites')"
        >
          ⭐ Favoritos
        </button>
        <button
          class="downloads-btn"
          :class="{ active: showingDownloads }"
          aria-label="Mostrar u ocultar panel de descargas"
          :aria-pressed="showingDownloads"
          @click="$emit('toggle-downloads')"
        >
          ⬇️ Descargas ({{ downloadCount }})
        </button>
        <button
          v-if="hasSearchResults"
          class="filters-btn"
          :class="{ active: showAdvancedFilters }"
          aria-label="Mostrar u ocultar filtros avanzados"
          :aria-pressed="showAdvancedFilters"
          @click="$emit('toggle-filters')"
        >
          🔍 Filtros Avanzados
        </button>
      </div>
    </div>

    <!-- Breadcrumb -->
    <nav
      id="breadcrumb"
      role="navigation"
      aria-label="Navegación de ruta"
    >
      <button
        :class="{ active: isAtRoot }"
        class="breadcrumb-btn"
        :aria-label="isAtRoot ? 'Página de inicio (actual)' : 'Ir a página de inicio'"
        :aria-current="isAtRoot ? 'page' : undefined"
        @click="$emit('go-to-root')"
      >
        Inicio
      </button>
      <template
        v-for="(node, index) in breadcrumbPath"
        :key="node.id"
      >
        <span
          class="breadcrumb-separator"
          aria-hidden="true"
        >/</span>
        <button
          class="breadcrumb-btn"
          :aria-label="`Navegar a ${node.title}${index === breadcrumbPath.length - 1 ? ' (ubicación actual)' : ''}`"
          :aria-current="index === breadcrumbPath.length - 1 ? 'page' : undefined"
          @click="$emit('navigate-to', node)"
        >
          {{ node.title }}
        </button>
      </template>
    </nav>
  </div>

  <!-- Barra de búsqueda -->
  <div
    id="search-container"
    role="search"
    aria-label="Búsqueda en Myrient"
  >
    <input
      id="search-input"
      type="text"
      :value="searchTerm"
      placeholder="Buscar en Myrient... (mínimo 3 caracteres)"
      aria-label="Campo de búsqueda"
      aria-describedby="search-hint"
      aria-required="true"
      @input="$emit('update:searchTerm', $event.target.value)"
      @keydown.enter="$emit('search')"
    >
    <span
      id="search-hint"
      class="sr-only"
    >Ingresa al menos 3 caracteres para buscar</span>
    <button
      :disabled="searchTerm.trim().length < 3"
      aria-label="Realizar búsqueda"
      :aria-disabled="searchTerm.trim().length < 3"
      @click="$emit('search')"
    >
      🔍 Buscar
    </button>
  </div>
</template>

<script setup>
// Props
defineProps({
  showingFavorites: {
    type: Boolean,
    default: false,
  },
  showingDownloads: {
    type: Boolean,
    default: false,
  },
  showAdvancedFilters: {
    type: Boolean,
    default: false,
  },
  downloadCount: {
    type: Number,
    default: 0,
  },
  hasSearchResults: {
    type: Boolean,
    default: false,
  },
  breadcrumbPath: {
    type: Array,
    default: () => [],
  },
  isAtRoot: {
    type: Boolean,
    default: true,
  },
  searchTerm: {
    type: String,
    default: '',
  },
});

// Emits
defineEmits([
  'toggle-favorites',
  'toggle-downloads',
  'toggle-filters',
  'go-to-root',
  'navigate-to',
  'search',
  'update:searchTerm',
]);
</script>

<!-- Sin estilos - usa style.css global -->
