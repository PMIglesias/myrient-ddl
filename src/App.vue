<template>
  <div id="container" :class="{ 'light-mode': !isDarkMode }">
    <!-- Barra de Título -->
    <TitleBar
      :is-at-root="isAtRoot"
      :location-path="locationPath"
      :is-dark-mode="isDarkMode"
      :active-download-count="activeDownloadCount"
      :current-download-name="currentDownloadName"
      :average-download-speed="averageDownloadSpeed"
      @go-back="goBack"
      @toggle-theme="toggleTheme"
      @open-settings="showSettings = true"
    />

    <!-- Header con Búsqueda y Breadcrumb -->
    <SearchHeader
      :showing-favorites="showingFavorites"
      :showing-downloads="showingDownloads"
      :show-advanced-filters="showAdvancedFilters"
      :download-count="allDownloads.length"
      :has-search-results="searchResults.length > 0"
      :breadcrumb-path="breadcrumbPath"
      :is-at-root="isAtRoot"
      v-model:search-term="searchTerm"
      @toggle-favorites="toggleFavoritesPanel"
      @toggle-downloads="toggleDownloadsPanel"
      @toggle-filters="toggleAdvancedFilters"
      @go-to-root="goToRoot"
      @navigate-to="navigateToNode"
      @search="handleSearch"
    />

    <!-- Contenido Principal -->
    <div id="content-container">
      <!-- Sección de Favoritos -->
      <FavoritesSection
        v-if="showingFavorites"
        :folders="favoriteFolders"
        @navigate="navigateToNode"
        @remove="toggleFavorite"
      />

      <!-- Panel de Descargas -->
      <DownloadsPanel
        v-else-if="showingDownloads"
        :downloads="allDownloads"
        :speed-stats="speedStats"
        :pending-confirmations="pendingConfirmations"
        :selected-downloads="selectedDownloads"
        :selected-history-downloads="selectedHistoryDownloads"
        :show-empty="true"
        @clear-downloads="clearDownloads"
        @confirm-all="confirmOverwriteAll"
        @cancel-all="cancelOverwriteAll"
        @toggle-select-all-history="toggleSelectAllHistoryDownloads"
        @toggle-select-history="toggleSelectHistoryDownload"
        @confirm-overwrite="confirmOverwrite"
        @cancel-overwrite="cancelOverwrite"
        @pause="pauseDownload"
        @resume="resumeDownload"
        @cancel="cancelDownload"
        @retry="retryDownload"
      />

      <!-- Contenido de navegación normal -->
      <template v-else-if="searchResults.length === 0">
        <!-- Carpetas -->
        <FolderGrid
          v-if="folders.length > 0"
          :folders="folders"
          title="Carpetas"
          :favorite-ids="favoriteIds"
          @navigate="navigateToNode"
          @toggle-favorite="toggleFavorite"
        />

        <!-- Archivos -->
        <FileTable
          v-if="files.length > 0"
          :files="files"
          :selected-files="selectedFiles"
          :downloads="downloads"
          @download="download"
          @download-selected="downloadSelectedFiles"
          @toggle-select="toggleFileSelection"
          @toggle-select-all="toggleSelectAllFiles"
        />

        <!-- Estado vacío -->
        <div v-if="folders.length === 0 && files.length === 0" class="empty-state">
          <p>No hay carpetas ni archivos en esta ubicación.</p>
        </div>
      </template>

      <!-- Resultados de Búsqueda -->
      <template v-else>
        <div id="search-results">
          <h2>Resultados de búsqueda</h2>

          <!-- Carpetas encontradas -->
          <FolderGrid
            v-if="searchFolders.length > 0"
            :folders="searchFolders"
            title="Carpetas"
            :favorite-ids="favoriteIds"
            :is-search-result="true"
            @navigate="navigateToNode"
            @toggle-favorite="toggleFavorite"
          />

          <!-- Archivos encontrados -->
          <FileTable
            v-if="searchFiles.length > 0"
            :files="searchFiles"
            title="Archivos"
            :selected-files="selectedSearchFiles"
            :downloads="downloads"
            :sortable="true"
            :sort-field="sortField"
            :sort-direction="sortDirection"
            :show-path="true"
            @download="download"
            @download-selected="downloadSelectedSearchFiles"
            @toggle-select="toggleSearchFileSelection"
            @toggle-select-all="toggleSelectAllSearch"
            @sort="setSortField"
          />
        </div>
      </template>
    </div>

    <!-- Modal de Configuración -->
    <SettingsModal
      :show="showSettings"
      v-model:search-limit="searchLimit"
      v-model:download-path="downloadPath"
      v-model:preserve-structure="preserveStructure"
      v-model:max-parallel-downloads="maxParallelDownloads"
      v-model:show-notifications="showNotifications"
      :favorites-count="favorites.length"
      :last-update-date="formattedUpdateDate"
      @close="showSettings = false"
      @save-settings="saveDownloadSettings"
      @select-folder="selectDownloadFolder"
      @clear-favorites="clearFavorites"
    />

    <!-- Notificaciones de Confirmación -->
    <ConfirmationToasts
      :confirmations="pendingConfirmations"
      @confirm="confirmOverwrite"
      @cancel="cancelOverwrite"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';

// Componentes
import {
  TitleBar,
  SearchHeader,
  FolderGrid,
  FileTable,
  DownloadsPanel,
  ConfirmationToasts,
  SettingsModal,
  FavoritesSection
} from './components';

// Composables
import { useSettings } from './composables/useSettings';
import { useFavorites } from './composables/useFavorites';
import { useNavigation } from './composables/useNavigation';
import { useSearch } from './composables/useSearch';
import { useFilters } from './composables/useFilters';
import { useDownloads } from './composables/useDownloads';

// API
import { getDbUpdateDate } from './services/api';

// =====================
// COMPOSABLES
// =====================

const {
  downloadPath,
  preserveStructure,
  showNotifications,
  maxParallelDownloads,
  searchLimit,
  isDarkMode,
  initSettings,
  saveDownloadSettings,
  selectDownloadFolder,
  toggleTheme
} = useSettings();

const {
  favorites,
  showingFavorites,
  favoriteFolders,
  favoriteIds,
  loadFavorites,
  toggleFavorite,
  clearFavorites
} = useFavorites();

// Toggle para panel de favoritos
const toggleFavoritesPanel = () => {
  showingFavorites.value = !showingFavorites.value;
  if (showingFavorites.value) {
    showingDownloads.value = false;
  }
};

const {
  currentNodeId,
  allChildren,
  breadcrumbPath,
  folders,
  files,
  locationPath,
  isAtRoot,
  loadChildren,
  navigateToNode,
  goToRoot,
  goBack,
  initNavigation
} = useNavigation();

const {
  searchTerm,
  searchResults,
  sortField,
  sortDirection,
  searchFolders,
  searchFiles,
  search,
  clearSearch,
  setSortField,
  cleanup: cleanupSearch
} = useSearch();

const {
  showAdvancedFilters,
  loadFilterPresets,
  toggleFiltersPanel: toggleAdvancedFilters
} = useFilters();

// Selección de archivos de búsqueda (local)
const selectedSearchFiles = ref([]);

const toggleSearchFileSelection = (fileId) => {
  const index = selectedSearchFiles.value.indexOf(fileId);
  if (index >= 0) {
    selectedSearchFiles.value.splice(index, 1);
  } else {
    selectedSearchFiles.value.push(fileId);
  }
};

const toggleSelectAllSearch = () => {
  if (selectedSearchFiles.value.length === searchFiles.value.length) {
    selectedSearchFiles.value = [];
  } else {
    selectedSearchFiles.value = searchFiles.value.map(f => f.id);
  }
};

const {
  downloads,
  speedStats,
  pendingConfirmations,
  showingDownloads,
  selectedDownloads,
  selectedHistoryDownloads,
  allDownloads,
  activeDownloadCount,
  averageDownloadSpeed,
  currentDownloadName,
  download,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  retryDownload,
  confirmOverwrite,
  cancelOverwrite,
  confirmOverwriteAll,
  cancelOverwriteAll,
  toggleSelectHistoryDownload,
  toggleSelectAllHistoryDownloads,
  clearDownloads,
  initDownloads,
  cleanup: cleanupDownloads
} = useDownloads();

// Toggle para panel de descargas (local porque showingDownloads es ref compartido)
const toggleDownloadsPanel = () => {
  showingDownloads.value = !showingDownloads.value;
  if (showingDownloads.value) {
    showingFavorites.value = false;
  }
};

// =====================
// ESTADO LOCAL
// =====================

const showSettings = ref(false);
const selectedFiles = ref([]);
const lastUpdateDate = ref(null);

// =====================
// COMPUTED
// =====================

const formattedUpdateDate = computed(() => {
  if (!lastUpdateDate.value) return null;
  return new Date(lastUpdateDate.value).toLocaleDateString();
});

// =====================
// MÉTODOS
// =====================

const handleSearch = () => {
  if (searchTerm.value.trim().length >= 3) {
    search(searchLimit.value);
  }
};

const toggleFileSelection = (fileId) => {
  const index = selectedFiles.value.indexOf(fileId);
  if (index >= 0) {
    selectedFiles.value.splice(index, 1);
  } else {
    selectedFiles.value.push(fileId);
  }
};

const toggleSelectAllFiles = () => {
  if (selectedFiles.value.length === files.value.length) {
    selectedFiles.value = [];
  } else {
    selectedFiles.value = files.value.map(f => f.id);
  }
};

const downloadSelectedFiles = () => {
  const filesToDownload = files.value.filter(f => selectedFiles.value.includes(f.id));
  filesToDownload.forEach(file => download(file));
  selectedFiles.value = [];
};

const downloadSelectedSearchFiles = () => {
  const filesToDownload = searchFiles.value.filter(f => selectedSearchFiles.value.includes(f.id));
  filesToDownload.forEach(file => download(file));
  selectedSearchFiles.value = [];
};

const loadUpdateDate = async () => {
  try {
    const result = await getDbUpdateDate();
    if (result.success) {
      lastUpdateDate.value = result.data;
    }
  } catch (error) {
    console.error('Error cargando fecha de actualización:', error);
  }
};

// =====================
// WATCHERS
// =====================

// Limpiar resultados de búsqueda al navegar
watch(currentNodeId, () => {
  if (searchResults.value.length > 0) {
    clearSearch();
  }
});

// =====================
// LIFECYCLE
// =====================

onMounted(async () => {
  // Inicializar composables
  await initSettings();
  await loadFavorites();
  await loadFilterPresets();
  await initNavigation();
  await initDownloads();
  await loadUpdateDate();
});

onUnmounted(() => {
  cleanupDownloads();
  cleanupSearch();
});
</script>
