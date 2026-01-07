<template>
  <div id="header">
    <div class="header-top">
      <h1>Myrient DDL</h1>
      <div class="header-buttons">
        <button 
          @click="$emit('toggle-favorites')" 
          class="favorites-btn" 
          :class="{ active: showingFavorites }"
        >
          ⭐ Favoritos
        </button>
        <button 
          @click="$emit('toggle-downloads')" 
          class="downloads-btn" 
          :class="{ active: showingDownloads }"
        >
          ⬇️ Descargas ({{ downloadCount }})
        </button>
        <button 
          v-if="hasSearchResults" 
          @click="$emit('toggle-filters')" 
          class="filters-btn" 
          :class="{ active: showAdvancedFilters }"
        >
          🔍 Filtros Avanzados
        </button>
      </div>
    </div>
    
    <!-- Breadcrumb -->
    <div id="breadcrumb">
      <button 
        @click="$emit('go-to-root')" 
        :class="{ active: isAtRoot }"
        class="breadcrumb-btn"
      >
        Inicio
      </button>
      <template v-for="node in breadcrumbPath" :key="node.id">
        <span class="breadcrumb-separator">/</span>
        <button 
          @click="$emit('navigate-to', node)" 
          class="breadcrumb-btn"
        >
          {{ node.title }}
        </button>
      </template>
    </div>
  </div>

  <!-- Barra de búsqueda -->
  <div id="search-container">
    <input 
      type="text" 
      id="search-input" 
      :value="searchTerm"
      @input="$emit('update:searchTerm', $event.target.value)"
      @keydown.enter="$emit('search')"
      placeholder="Buscar en Myrient... (mínimo 3 caracteres)"
    >
    <button @click="$emit('search')" :disabled="searchTerm.trim().length < 3">
      🔍 Buscar
    </button>
  </div>
</template>

<script setup>
// Props
defineProps({
  showingFavorites: {
    type: Boolean,
    default: false
  },
  showingDownloads: {
    type: Boolean,
    default: false
  },
  showAdvancedFilters: {
    type: Boolean,
    default: false
  },
  downloadCount: {
    type: Number,
    default: 0
  },
  hasSearchResults: {
    type: Boolean,
    default: false
  },
  breadcrumbPath: {
    type: Array,
    default: () => []
  },
  isAtRoot: {
    type: Boolean,
    default: true
  },
  searchTerm: {
    type: String,
    default: ''
  }
});

// Emits
defineEmits([
  'toggle-favorites',
  'toggle-downloads',
  'toggle-filters',
  'go-to-root',
  'navigate-to',
  'search',
  'update:searchTerm'
]);
</script>

<!-- Sin estilos - usa style.css global -->
