<template>
  <div id="container" :class="{ 'light-mode': !isDarkMode }">
    <!-- Barra de TÃ­tulo -->
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

    <!-- Header con BÃºsqueda y Breadcrumb -->
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
      <!-- SecciÃ³n de Favoritos -->
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
        @cancel-all-downloads="cancelAllDownloads"
        @confirm-all="confirmOverwriteAll"
        @cancel-all="cancelOverwriteAll"
        @toggle-select-all-history="toggleSelectAllHistoryDownloads"
        @toggle-select-history="toggleSelectHistoryDownload"
        @confirm-overwrite="confirmOverwrite"
        @cancel-overwrite="cancelOverwrite"
        @pause-all="pauseAllDownloads"
        @resume-all="resumeAllDownloads"
        @pause="pauseDownload"
        @resume="resumeDownload"
        @cancel="cancelDownload"
        @retry="retryDownload"
        @remove="removeFromHistory"
      />

      <!-- Contenido de navegaciÃ³n normal -->
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
          :current-folder-id="currentNodeId"
          :is-at-root="isAtRoot"
          @download="download"
          @download-selected="downloadSelectedFiles"
          @download-folder="downloadCurrentFolder"
          @toggle-select="toggleFileSelection"
          @toggle-select-all="toggleSelectAllFiles"
        />

        <!-- Estado vacÃ­o -->
        <div v-if="folders.length === 0 && files.length === 0" class="empty-state">
          <div class="empty-state-icon">📂</div>
          <h3>Ubicación vacía</h3>
          <p>No hay carpetas ni archivos en esta ubicación. Navega por las carpetas para encontrar contenido.</p>
        </div>
      </template>

      <!-- Resultados de BÃºsqueda -->
      <template v-else>
        <div id="search-results">
          <h2>Resultados de bÃºsqueda</h2>

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

    <!-- Modal de ConfiguraciÃ³n -->
    <SettingsModal
      :show="showSettings"
      v-model:search-limit="searchLimit"
      v-model:download-path="downloadPath"
      v-model:preserve-structure="preserveStructure"
      v-model:max-parallel-downloads="maxParallelDownloads"
      v-model:show-notifications="showNotifications"
      v-model:auto-resume-downloads="autoResumeDownloads"
      v-model:max-history-in-memory="maxHistoryInMemory"
      v-model:max-completed-in-memory="maxCompletedInMemory"
      v-model:max-failed-in-memory="maxFailedInMemory"
      :favorites-count="favorites.length"
      :last-update-date="formattedUpdateDate"
      :cleanup-stats="cleanupStats"
      @close="showSettings = false"
      @save-settings="saveDownloadSettings"
      @select-folder="selectDownloadFolder"
      @clear-favorites="clearFavorites"
      @clean-history="handleCleanHistory"
    />

    <!-- Notificaciones de ConfirmaciÃ³n -->
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
  FavoritesSection,
  ToastNotifications
} from './components';

// Composables
import { useSettings } from './composables/useSettings';
import { useFavorites } from './composables/useFavorites';
import { useNavigation } from './composables/useNavigation';
import { useSearch } from './composables/useSearch';
import { useFilters } from './composables/useFilters';
import { useDownloads } from './composables/useDownloads';
import { useToasts } from './composables/useToasts';

// API
import { getDbUpdateDate, cleanHistory } from './services/api';

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
  autoResumeDownloads,
  maxHistoryInMemory,
  maxCompletedInMemory,
  maxFailedInMemory,
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

// SelecciÃ³n de archivos de bÃºsqueda (local)
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
  downloadFolder,
  pauseDownload,
  resumeDownload,
  pauseAllDownloads,
  resumeAllDownloads,
  cancelDownload,
  retryDownload,
  confirmOverwrite,
  cancelOverwrite,
  confirmOverwriteAll,
  cancelOverwriteAll,
  toggleSelectHistoryDownload,
  toggleSelectAllHistoryDownloads,
  clearDownloads,
  cancelAllDownloads,
  removeFromHistory,
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

// Toasts
const { toasts, showToast, removeToast } = useToasts();

// Estadísticas de limpieza
const cleanupStats = ref({
  lastMemoryCleanup: null,
  lastDbCleanup: null,
  totalRemoved: 0,
  totalKept: 0
});

// =====================
// COMPUTED
// =====================

const formattedUpdateDate = computed(() => {
  if (!lastUpdateDate.value) return null;
  return new Date(lastUpdateDate.value).toLocaleDateString();
});

// =====================
// MÃ‰TODOS
// =====================

const handleSearch = () => {
  if (searchTerm.value.trim().length >= 3) {
    search();
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

const downloadCurrentFolder = async () => {
  if (isAtRoot.value) {
    console.warn('[App] No se puede descargar la raíz');
    return;
  }

  if (!currentNodeId.value) {
    console.error('[App] No hay carpeta actual para descargar');
    return;
  }

  try {
    // Obtener información de la carpeta actual
    const folderInfo = breadcrumbPath.value.length > 0 
      ? { id: currentNodeId.value, title: breadcrumbPath.value[breadcrumbPath.value.length - 1].title }
      : { id: currentNodeId.value, title: 'Carpeta actual' };

    const result = await downloadFolder(folderInfo);
    
    if (result.success) {
      console.log(`[App] Descarga de carpeta iniciada: ${result.added} archivos agregados de ${result.totalFiles} totales`);
    } else {
      console.error('[App] Error descargando carpeta:', result.error);
    }
  } catch (error) {
    console.error('[App] Excepción descargando carpeta:', error);
  }
};

const loadUpdateDate = async () => {
  try {
    const result = await getDbUpdateDate();
    if (result.success) {
      lastUpdateDate.value = result.data;
    }
  } catch (error) {
    console.error('Error cargando fecha de actualizaciÃ³n:', error);
  }
};

const handleCleanHistory = async (daysOld) => {
  try {
    const result = await cleanHistory(daysOld);
    if (result.success) {
      showToast({
        title: 'Historial limpiado',
        message: `${result.count} registro(s) eliminado(s) de la base de datos`,
        type: 'success',
        duration: 5000
      });
      cleanupStats.value.lastDbCleanup = Date.now();
    } else {
      showToast({
        title: 'Error al limpiar historial',
        message: result.error || 'Error desconocido',
        type: 'error',
        duration: 5000
      });
    }
  } catch (error) {
    console.error('Error limpiando historial:', error);
    showToast({
      title: 'Error al limpiar historial',
      message: error.message || 'Error desconocido',
      type: 'error',
      duration: 5000
    });
  }
};

// =====================
// WATCHERS
// =====================

// Limpiar resultados de bÃºsqueda al navegar
watch(currentNodeId, () => {
  if (searchResults.value.length > 0) {
    clearSearch();
  }
});

// =====================
// EVENT HANDLERS
// =====================

// Handlers para eventos de limpieza
const handleHistoryCleaned = (event) => {
  const { count } = event.detail;
  if (showNotifications.value && count > 0) {
    showToast({
      title: 'Historial limpiado',
      message: `${count} registro(s) antiguo(s) eliminado(s) de la base de datos`,
      type: 'info',
      duration: 5000
    });
    cleanupStats.value.lastDbCleanup = Date.now();
  }
};

const handleMemoryCleaned = (event) => {
  const { removed, kept, total } = event.detail;
  if (showNotifications.value && removed > 0) {
    showToast({
      title: 'Memoria optimizada',
      message: `${removed} descarga(s) antigua(s) removida(s). ${kept} mantenida(s) en memoria.`,
      type: 'success',
      duration: 4000
    });
    cleanupStats.value.lastMemoryCleanup = Date.now();
    cleanupStats.value.totalRemoved += removed;
    cleanupStats.value.totalKept = kept;
  }
};

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

  // Escuchar eventos de limpieza de historial
  window.addEventListener('history-cleaned', handleHistoryCleaned);
  window.addEventListener('memory-cleaned', handleMemoryCleaned);
});

onUnmounted(() => {
  // Limpiar event listeners
  window.removeEventListener('history-cleaned', handleHistoryCleaned);
  window.removeEventListener('memory-cleaned', handleMemoryCleaned);
  
  // Limpiar composables
  cleanupDownloads();
  cleanupSearch();
});
</script>
