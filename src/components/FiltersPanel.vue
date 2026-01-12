<template>
  <div>
    <!-- Overlay -->
    <div
      class="filters-overlay"
      @click="$emit('close')"
    />

    <!-- Panel -->
    <div class="filters-panel">
      <!-- Header -->
      <div class="filters-header">
        <h2>Filtros Avanzados</h2>
        <button
          class="btn-close"
          aria-label="Cerrar panel de filtros"
          @click="$emit('close')"
        >
          ✕
        </button>
      </div>

      <!-- Body -->
      <div class="filters-body">
        <!-- Presets -->
        <div class="filters-section">
          <h3>Presets</h3>
          <div class="preset-controls">
            <select
              v-model="currentPreset"
              class="preset-select"
              @change="handleLoadPreset"
            >
              <option value="">
                Seleccionar preset...
              </option>
              <option
                v-for="(preset, name) in filterPresets"
                :key="name"
                :value="name"
              >
                {{ name }}
              </option>
            </select>
            <div class="preset-save">
              <input
                v-model="presetName"
                type="text"
                class="preset-name-input"
                placeholder="Nombre del preset..."
                @keydown.enter="handleSavePreset"
              >
              <button
                class="btn-save-preset"
                @click="handleSavePreset"
              >
                Guardar
              </button>
            </div>
            <button
              v-if="currentPreset"
              class="btn-delete-preset"
              @click="handleDeletePreset"
            >
              Eliminar preset actual
            </button>
          </div>
        </div>

        <!-- Filtros de Texto -->
        <div class="filters-section">
          <h3>Filtros de Texto</h3>

          <!-- Incluir Texto -->
          <div class="filter-subsection">
            <h4>Incluir (debe contener)</h4>
            <div class="text-filter-input">
              <input
                v-model="tempIncludeText"
                type="text"
                class="text-input"
                placeholder="Texto a incluir..."
                @keydown.enter="addIncludeText"
              >
              <button
                class="btn-add"
                @click="addIncludeText"
              >
                Agregar
              </button>
            </div>
            <div
              v-if="advancedFilters.includeText.length > 0"
              class="text-list"
            >
              <div
                v-for="(text, index) in advancedFilters.includeText"
                :key="index"
                class="text-item"
              >
                <span>{{ text }}</span>
                <button
                  class="btn-remove"
                  @click="removeIncludeText(index)"
                >
                  ✕
                </button>
              </div>
            </div>
            <div
              v-else
              class="empty-list"
            >
              Ningún filtro de inclusión
            </div>
          </div>

          <!-- Excluir Texto -->
          <div class="filter-subsection">
            <h4>Excluir (no debe contener)</h4>
            <div class="text-filter-input">
              <input
                v-model="tempExcludeText"
                type="text"
                class="text-input"
                placeholder="Texto a excluir..."
                @keydown.enter="addExcludeText"
              >
              <button
                class="btn-add"
                @click="addExcludeText"
              >
                Agregar
              </button>
            </div>
            <div
              v-if="advancedFilters.excludeText.length > 0"
              class="text-list"
            >
              <div
                v-for="(text, index) in advancedFilters.excludeText"
                :key="index"
                class="text-item"
              >
                <span>{{ text }}</span>
                <button
                  class="btn-remove"
                  @click="removeExcludeText(index)"
                >
                  ✕
                </button>
              </div>
            </div>
            <div
              v-else
              class="empty-list"
            >
              Ningún filtro de exclusión
            </div>
          </div>
        </div>

        <!-- Filtros por Sets y Proyectos de Preservación -->
        <div class="filters-section">
          <h3>Sets y Proyectos de Preservación</h3>
          <template v-if="availableConsoles && availableConsoles.length > 0">
            <div class="filter-subsection">
              <p class="filter-description">
                Selecciona los sets o proyectos de preservación que deseas incluir en los resultados. El filtro se aplica basándose en el nombre de la carpeta del primer nivel.
              </p>
              <div class="tag-list">
                <label
                  v-for="console in availableConsoles"
                  :key="console"
                  class="tag-checkbox"
                >
                  <input
                    :checked="advancedFilters.consoles.includes(console)"
                    type="checkbox"
                    @change="toggleConsole(console)"
                  >
                  <span>{{ console }}</span>
                </label>
              </div>
              <div
                v-if="advancedFilters.consoles.length > 0"
                class="text-list"
                style="margin-top: 10px;"
              >
                <div
                  v-for="(console, index) in advancedFilters.consoles"
                  :key="index"
                  class="text-item"
                >
                  <span>{{ console }}</span>
                  <button
                    class="btn-remove"
                    @click="removeConsole(index)"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <button
                v-if="advancedFilters.consoles.length > 0"
                class="btn-clear-list"
                @click="clearConsoles"
              >
                Limpiar selección
              </button>
            </div>
          </template>
          <div
            v-else
            class="empty-list"
          >
            Realiza una búsqueda para ver sets y proyectos de preservación disponibles
          </div>
        </div>

        <!-- Filtros por Etiquetas -->
        <div class="filters-section">
          <h3>Filtros por Etiquetas</h3>

          <template v-if="availableTags">
            <!-- Regiones -->
            <div
              v-if="availableTags.regions.length > 0"
              class="filter-category"
            >
              <h4>Regiones</h4>
              <div class="tag-panels">
                <div class="tag-panel">
                  <div class="panel-header">
                    <span>Incluir</span>
                    <button
                      class="btn-select-all"
                      @click="selectAllTags('regions', 'include', availableTags.regions)"
                    >
                      Todos
                    </button>
                  </div>
                  <div class="tag-list">
                    <label
                      v-for="tag in availableTags.regions"
                      :key="tag"
                      class="tag-checkbox"
                    >
                      <input
                        :checked="advancedFilters.includeTags.regions.includes(tag)"
                        type="checkbox"
                        :disabled="advancedFilters.excludeTags.regions.includes(tag)"
                        @change="toggleTag('regions', 'include', tag)"
                      >
                      <span>{{ tag }}</span>
                    </label>
                  </div>
                </div>
                <div class="tag-panel">
                  <div class="panel-header">
                    <span>Excluir</span>
                    <button
                      class="btn-select-all"
                      @click="selectAllTags('regions', 'exclude', availableTags.regions)"
                    >
                      Todos
                    </button>
                  </div>
                  <div class="tag-list">
                    <label
                      v-for="tag in availableTags.regions"
                      :key="tag"
                      class="tag-checkbox"
                    >
                      <input
                        :checked="advancedFilters.excludeTags.regions.includes(tag)"
                        type="checkbox"
                        :disabled="advancedFilters.includeTags.regions.includes(tag)"
                        @change="toggleTag('regions', 'exclude', tag)"
                      >
                      <span>{{ tag }}</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <!-- Idiomas -->
            <div
              v-if="availableTags.languages.length > 0"
              class="filter-category"
            >
              <h4>Idiomas</h4>
              <div class="tag-panels">
                <div class="tag-panel">
                  <div class="panel-header">
                    <span>Incluir</span>
                    <button
                      class="btn-select-all"
                      @click="selectAllTags('languages', 'include', availableTags.languages)"
                    >
                      Todos
                    </button>
                  </div>
                  <div class="tag-list">
                    <label
                      v-for="tag in availableTags.languages"
                      :key="tag"
                      class="tag-checkbox"
                    >
                      <input
                        :checked="advancedFilters.includeTags.languages.includes(tag)"
                        type="checkbox"
                        :disabled="advancedFilters.excludeTags.languages.includes(tag)"
                        @change="toggleTag('languages', 'include', tag)"
                      >
                      <span>{{ tag }}</span>
                    </label>
                  </div>
                </div>
                <div class="tag-panel">
                  <div class="panel-header">
                    <span>Excluir</span>
                    <button
                      class="btn-select-all"
                      @click="selectAllTags('languages', 'exclude', availableTags.languages)"
                    >
                      Todos
                    </button>
                  </div>
                  <div class="tag-list">
                    <label
                      v-for="tag in availableTags.languages"
                      :key="tag"
                      class="tag-checkbox"
                    >
                      <input
                        :checked="advancedFilters.excludeTags.languages.includes(tag)"
                        type="checkbox"
                        :disabled="advancedFilters.includeTags.languages.includes(tag)"
                        @change="toggleTag('languages', 'exclude', tag)"
                      >
                      <span>{{ tag }}</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <!-- Versiones -->
            <div
              v-if="availableTags.versions.length > 0"
              class="filter-category"
            >
              <h4>Versiones</h4>
              <div class="tag-panels">
                <div class="tag-panel">
                  <div class="panel-header">
                    <span>Incluir</span>
                    <button
                      class="btn-select-all"
                      @click="selectAllTags('versions', 'include', availableTags.versions)"
                    >
                      Todos
                    </button>
                  </div>
                  <div class="tag-list">
                    <label
                      v-for="tag in availableTags.versions"
                      :key="tag"
                      class="tag-checkbox"
                    >
                      <input
                        :checked="advancedFilters.includeTags.versions.includes(tag)"
                        type="checkbox"
                        :disabled="advancedFilters.excludeTags.versions.includes(tag)"
                        @change="toggleTag('versions', 'include', tag)"
                      >
                      <span>{{ tag }}</span>
                    </label>
                  </div>
                </div>
                <div class="tag-panel">
                  <div class="panel-header">
                    <span>Excluir</span>
                    <button
                      class="btn-select-all"
                      @click="selectAllTags('versions', 'exclude', availableTags.versions)"
                    >
                      Todos
                    </button>
                  </div>
                  <div class="tag-list">
                    <label
                      v-for="tag in availableTags.versions"
                      :key="tag"
                      class="tag-checkbox"
                    >
                      <input
                        :checked="advancedFilters.excludeTags.versions.includes(tag)"
                        type="checkbox"
                        :disabled="advancedFilters.includeTags.versions.includes(tag)"
                        @change="toggleTag('versions', 'exclude', tag)"
                      >
                      <span>{{ tag }}</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <!-- Otras etiquetas -->
            <div
              v-if="availableTags.other.length > 0"
              class="filter-category"
            >
              <h4>Otras Etiquetas</h4>
              <div class="tag-panels">
                <div class="tag-panel">
                  <div class="panel-header">
                    <span>Incluir</span>
                    <button
                      class="btn-select-all"
                      @click="selectAllTags('other', 'include', availableTags.other)"
                    >
                      Todos
                    </button>
                  </div>
                  <div class="tag-list">
                    <label
                      v-for="tag in availableTags.other"
                      :key="tag"
                      class="tag-checkbox"
                    >
                      <input
                        :checked="advancedFilters.includeTags.other.includes(tag)"
                        type="checkbox"
                        :disabled="advancedFilters.excludeTags.other.includes(tag)"
                        @change="toggleTag('other', 'include', tag)"
                      >
                      <span>{{ tag }}</span>
                    </label>
                  </div>
                </div>
                <div class="tag-panel">
                  <div class="panel-header">
                    <span>Excluir</span>
                    <button
                      class="btn-select-all"
                      @click="selectAllTags('other', 'exclude', availableTags.other)"
                    >
                      Todos
                    </button>
                  </div>
                  <div class="tag-list">
                    <label
                      v-for="tag in availableTags.other"
                      :key="tag"
                      class="tag-checkbox"
                    >
                      <input
                        :checked="advancedFilters.excludeTags.other.includes(tag)"
                        type="checkbox"
                        :disabled="advancedFilters.includeTags.other.includes(tag)"
                        @change="toggleTag('other', 'exclude', tag)"
                      >
                      <span>{{ tag }}</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <div
            v-else
            class="empty-list"
          >
            Realiza una búsqueda para ver etiquetas disponibles
          </div>
        </div>

        <!-- Estadísticas -->
        <div class="stats-section">
          <div class="filter-stats">
            <div class="stat-item">
              <span class="stat-label">Filtros activos:</span>
              <span class="stat-value">{{ activeFilterCount }}</span>
            </div>
          </div>
          <button
            v-if="hasActiveFilters"
            class="btn-clear-filters"
            @click="handleClearFilters"
          >
            Limpiar Todos los Filtros
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useFilters } from '../composables/useFilters';

const props = defineProps({
  searchResults: {
    type: Array,
    default: () => [],
  },
});

defineEmits(['close']);

const {
  advancedFilters,
  filterPresets,
  currentFilterPreset,
  tempIncludeText,
  tempExcludeText,
  hasActiveFilters,
  activeFilterCount,
  getAvailableTags,
  getAvailableConsoles,
  addIncludeText: addIncludeTextOriginal,
  removeIncludeText: removeIncludeTextOriginal,
  addExcludeText: addExcludeTextOriginal,
  removeExcludeText: removeExcludeTextOriginal,
  selectAllTags: selectAllTagsOriginal,
  savePreset: savePresetOriginal,
  loadPreset: loadPresetOriginal,
  deletePreset: deletePresetOriginal,
  clearAllFilters: clearAllFiltersOriginal,
} = useFilters();

// Estado local
const presetName = ref('');
const currentPreset = ref('');

// Etiquetas disponibles de los resultados de búsqueda
const availableTags = computed(() => {
  if (props.searchResults.length === 0) return null;
  return getAvailableTags(props.searchResults);
});

// Consolas disponibles de los resultados de búsqueda
const availableConsoles = computed(() => {
  if (props.searchResults.length === 0) return null;
  return getAvailableConsoles(props.searchResults);
});

// Sincronizar currentPreset con currentFilterPreset
watch(
  () => currentFilterPreset.value,
  newValue => {
    currentPreset.value = newValue;
  },
  { immediate: true }
);

// Métodos
const addIncludeText = () => {
  addIncludeTextOriginal();
};

const removeIncludeText = index => {
  removeIncludeTextOriginal(index);
};

const addExcludeText = () => {
  addExcludeTextOriginal();
};

const removeExcludeText = index => {
  removeExcludeTextOriginal(index);
};

const toggleTag = (category, type, tag) => {
  const target =
    type === 'include' ? advancedFilters.value.includeTags : advancedFilters.value.excludeTags;
  const opposite =
    type === 'include' ? advancedFilters.value.excludeTags : advancedFilters.value.includeTags;

  const index = target[category].indexOf(tag);
  if (index >= 0) {
    target[category].splice(index, 1);
  } else {
    // Remover del opuesto si está ahí
    const oppositeIndex = opposite[category].indexOf(tag);
    if (oppositeIndex >= 0) {
      opposite[category].splice(oppositeIndex, 1);
    }
    target[category].push(tag);
  }
};

const selectAllTags = (category, type, availableTags) => {
  selectAllTagsOriginal(category, type, availableTags);
};

const handleSavePreset = () => {
  if (!presetName.value.trim()) return;
  currentFilterPreset.value = presetName.value.trim();
  savePresetOriginal();
  currentPreset.value = presetName.value.trim();
  presetName.value = '';
};

const handleLoadPreset = () => {
  if (!currentPreset.value) return;
  currentFilterPreset.value = currentPreset.value;
  loadPresetOriginal();
};

const handleDeletePreset = () => {
  if (!currentPreset.value) return;
  deletePresetOriginal(currentPreset.value);
  currentPreset.value = '';
  presetName.value = '';
};

const toggleConsole = consoleName => {
  const index = advancedFilters.value.consoles.indexOf(consoleName);
  if (index >= 0) {
    advancedFilters.value.consoles.splice(index, 1);
  } else {
    advancedFilters.value.consoles.push(consoleName);
  }
};

const removeConsole = index => {
  advancedFilters.value.consoles.splice(index, 1);
};

const clearConsoles = () => {
  advancedFilters.value.consoles = [];
};

const handleClearFilters = () => {
  clearAllFiltersOriginal();
  currentPreset.value = '';
  presetName.value = '';
};
</script>

<style scoped>
.btn-close {
  background: none;
  border: none;
  color: #ddd;
  font-size: 24px;
  cursor: pointer;
  padding: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.btn-close:hover {
  background-color: #444;
  color: #fff;
}

.btn-delete-preset {
  margin-top: 8px;
  padding: 6px 12px;
  background-color: #f44336;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.2s;
  width: 100%;
}

.btn-delete-preset:hover {
  background-color: #d32f2f;
}
</style>
