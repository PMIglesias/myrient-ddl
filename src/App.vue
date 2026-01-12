<template>
  <div
    id="container"
    :class="{ 'light-mode': !isDarkMode }"
    role="main"
    aria-label="Aplicación Myrient Downloader"
  >
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
      @open-logs="showLogsConsole = true"
    />

    <!-- Header con Búsqueda y Breadcrumb -->
    <SearchHeader
      v-model:search-term="searchTerm"
      :showing-favorites="showingFavorites"
      :showing-downloads="showingDownloads"
      :show-advanced-filters="showAdvancedFilters"
      :download-count="allDownloads.length"
      :has-search-results="searchResults.length > 0"
      :breadcrumb-path="breadcrumbPath"
      :is-at-root="isAtRoot"
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
      <ErrorBoundary
        v-if="showingFavorites"
        component-name="FavoritesSection"
        fallback-message="Error cargando favoritos. Puedes continuar usando la aplicación normalmente."
      >
        <FavoritesSection
          :folders="favoriteFolders"
          @navigate="navigateToNode"
          @remove="toggleFavorite"
        />
      </ErrorBoundary>

      <!-- Panel de Descargas -->
      <ErrorBoundary
        v-else-if="showingDownloads"
        component-name="DownloadsPanel"
        fallback-message="Error cargando el panel de descargas. Las descargas pueden continuar funcionando en segundo plano."
      >
        <DownloadsPanel
          :downloads="allDownloads"
          :speed-stats="speedStats"
          :pending-confirmations="pendingConfirmations"
          :selected-downloads="selectedDownloads"
          :selected-history-downloads="selectedHistoryDownloads"
          :show-empty="true"
          :show-chunk-progress="showChunkProgress"
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
      </ErrorBoundary>

      <!-- Contenido de navegación normal -->
      <ErrorBoundary
        v-else-if="searchResults.length === 0"
        component-name="NavigationContent"
        fallback-message="Error cargando el contenido. Intenta navegar a otra ubicación o recargar la página."
      >
        <div role="region" aria-label="Navegación de carpetas y archivos">
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

        <!-- Estado vacío -->
        <div
          v-if="folders.length === 0 && files.length === 0"
          class="empty-state"
          role="status"
          aria-live="polite"
        >
          <div class="empty-state-icon" aria-hidden="true">
            📂
          </div>
          <h3>Ubicación vacía</h3>
          <p>
            No hay carpetas ni archivos en esta ubicación. Navega por las carpetas para encontrar
            contenido.
          </p>
        </div>
        </div>
      </ErrorBoundary>

      <!-- Resultados de Búsqueda -->
      <ErrorBoundary
        v-else
        component-name="SearchResults"
        fallback-message="Error mostrando resultados de búsqueda. Intenta realizar la búsqueda nuevamente."
      >
        <div
          id="search-results"
          role="region"
          aria-label="Resultados de búsqueda"
        >
          <h2>Resultados de búsqueda</h2>

          <!-- Indicador de búsqueda en progreso -->
          <div
            v-if="isSearching"
            class="search-loading"
            role="status"
            aria-live="polite"
            aria-label="Búsqueda en progreso"
          >
            <div class="search-spinner" aria-hidden="true" />
            <p>Buscando...</p>
          </div>

          <!-- Indicador de búsqueda cancelada -->
          <div
            v-if="!isSearching && isSearchCancelled && searchResults.length === 0"
            class="search-cancelled"
            role="alert"
            aria-live="polite"
          >
            <div class="search-cancelled-icon" aria-hidden="true">
              ⚠️
            </div>
            <p>Búsqueda cancelada. Intenta realizar una nueva búsqueda.</p>
          </div>

          <!-- Resultados (solo mostrar si no está buscando) -->
          <template v-else>
            <!-- Carpetas encontradas -->
            <FolderGrid
              v-if="filteredSearchFolders.length > 0"
              :folders="filteredSearchFolders"
              title="Carpetas"
              :favorite-ids="favoriteIds"
              :is-search-result="true"
              @navigate="navigateToNode"
              @toggle-favorite="toggleFavorite"
            />

            <!-- Archivos encontrados -->
            <FileTable
              v-if="filteredSearchFiles.length > 0"
              :files="filteredSearchFiles"
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

            <!-- Sin resultados -->
            <div
              v-if="!isSearching && filteredSearchFolders.length === 0 && filteredSearchFiles.length === 0"
              class="search-no-results"
              role="status"
              aria-live="polite"
            >
              <p>No se encontraron resultados para "{{ searchTerm }}"</p>
            </div>
          </template>
        </div>
      </ErrorBoundary>
    </div>

    <!-- Modal de Configuración -->
    <SettingsModal
      v-model:search-limit="searchLimit"
      v-model:download-path="downloadPath"
      v-model:preserve-structure="preserveStructure"
      v-model:max-parallel-downloads="maxParallelDownloads"
      v-model:show-notifications="showNotifications"
      v-model:auto-resume-downloads="autoResumeDownloads"
      v-model:max-history-in-memory="maxHistoryInMemory"
      v-model:max-completed-in-memory="maxCompletedInMemory"
      v-model:max-failed-in-memory="maxFailedInMemory"
      v-model:show-chunk-progress="showChunkProgress"
      :show="showSettings"
      :favorites-count="favorites.length"
      :last-update-date="formattedUpdateDate"
      :cleanup-stats="cleanupStats"
      :primary-color="primaryColor"
      @close="showSettings = false"
      @save-settings="saveDownloadSettings"
      @select-folder="selectDownloadFolder"
      @clear-favorites="clearFavorites"
      @clean-history="handleCleanHistory"
      @set-primary-color="setPrimaryColor"
    />

    <!-- Consola de Logs -->
    <LogsConsole
      :show="showLogsConsole"
      @close="showLogsConsole = false"
    />

    <!-- Notificaciones de Confirmación -->
    <ConfirmationToasts
      :confirmations="pendingConfirmations"
      @confirm="confirmOverwrite"
      @cancel="cancelOverwrite"
    />

    <!-- Toast Notifications -->
    <ToastNotifications
      :toasts="toasts"
      @remove="removeToast"
    />

    <!-- Panel de Filtros Avanzados -->
    <FiltersPanel
      v-if="showAdvancedFilters"
      :search-results="searchResults"
      @close="toggleAdvancedFilters"
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
  ToastNotifications,
  ErrorBoundary,
  FiltersPanel,
} from './components';
import LogsConsole from './components/LogsConsole.vue';

// Composables
import { useSettings } from './composables/useSettings';
import { useFavorites } from './composables/useFavorites';
import { useNavigation } from './composables/useNavigation';
import { useSearch } from './composables/useSearch';
import { useFilters } from './composables/useFilters';
import { useDownloads } from './composables/useDownloads';
import { useToasts } from './composables/useToasts';
import { useErrorHandling } from './composables/useErrorHandling';

// Registrar handler global de errores
import { registerGlobalToastHandler } from './utils/errorHandler';

// API
import { getDbUpdateDate, cleanHistory } from './services/api';

// Utils
import logger from './utils/logger';
import { APP_ERRORS, HISTORY_ERRORS, GENERAL_ERRORS } from './constants/errors';
import {
  SUCCESS_MESSAGES,
  INFO_MESSAGES,
  formatHistoryCleaned,
  formatHistoryCleanedOld,
  formatMemoryOptimized,
} from './constants/messages';

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
  showChunkProgress,
  primaryColor,
  initSettings,
  saveDownloadSettings,
  selectDownloadFolder,
  toggleTheme,
  setPrimaryColor,
} = useSettings();

const {
  favorites,
  showingFavorites,
  favoriteFolders,
  favoriteIds,
  loadFavorites,
  toggleFavorite,
  clearFavorites,
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
  navigateToNode: navigateToNodeOriginal,
  goToRoot: goToRootOriginal,
  goBack: goBackOriginal,
  initNavigation,
} = useNavigation();

// Wrappers de navegación que ocultan los paneles
const navigateToNode = async node => {
  showingFavorites.value = false;
  showingDownloads.value = false;
  // Limpiar búsqueda si hay resultados activos (navegar sale del modo búsqueda)
  if (searchResults.value.length > 0) {
    clearSearch();
  }
  await navigateToNodeOriginal(node);
};

const goToRoot = async () => {
  showingFavorites.value = false;
  showingDownloads.value = false;
  // Limpiar búsqueda si hay resultados activos
  if (searchResults.value.length > 0) {
    clearSearch();
  }
  await goToRootOriginal();
};

const goBack = async () => {
  showingFavorites.value = false;
  showingDownloads.value = false;
  await goBackOriginal();
};

const {
  searchTerm,
  searchResults,
  isSearching,
  isSearchCancelled,
  sortField,
  sortDirection,
  searchFolders,
  searchFiles,
  search,
  clearSearch,
  setSortField,
  cleanup: cleanupSearch,
} = useSearch();

const {
  showAdvancedFilters,
  loadFilterPresets,
  toggleFiltersPanel: toggleAdvancedFilters,
  applyFilters,
} = useFilters();

// Selección de archivos de búsqueda (local)
const selectedSearchFiles = ref([]);

const toggleSearchFileSelection = fileId => {
  const index = selectedSearchFiles.value.indexOf(fileId);
  if (index >= 0) {
    selectedSearchFiles.value.splice(index, 1);
  } else {
    selectedSearchFiles.value.push(fileId);
  }
};

const toggleSelectAllSearch = () => {
  if (selectedSearchFiles.value.length === filteredSearchFiles.value.length) {
    selectedSearchFiles.value = [];
  } else {
    selectedSearchFiles.value = filteredSearchFiles.value.map(f => f.id);
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
  cleanup: cleanupDownloads,
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
const showLogsConsole = ref(false);
const selectedFiles = ref([]);
const lastUpdateDate = ref(null);

// Toasts
const { toasts, showToast, removeToast } = useToasts();

// Registrar el handler de toasts global para el errorHandler
registerGlobalToastHandler(showToast);

// Manejo de errores del proceso principal
const { init: initErrorHandling, cleanup: cleanupErrorHandling } = useErrorHandling();

// Estadísticas de limpieza
const cleanupStats = ref({
  lastMemoryCleanup: null,
  lastDbCleanup: null,
  totalRemoved: 0,
  totalKept: 0,
});

// =====================
// COMPUTED
// =====================

const formattedUpdateDate = computed(() => {
  if (!lastUpdateDate.value) return null;
  return new Date(lastUpdateDate.value).toLocaleDateString();
});

// Aplicar filtros avanzados a los resultados de búsqueda
const filteredSearchFolders = computed(() => {
  if (!applyFilters) return searchFolders.value;
  return applyFilters(searchFolders.value);
});

const filteredSearchFiles = computed(() => {
  if (!applyFilters) return searchFiles.value;
  return applyFilters(searchFiles.value);
});

// =====================
// MÉTODOS
// =====================

const handleSearch = () => {
  if (searchTerm.value.trim().length >= 3) {
    search();
  }
};

const toggleFileSelection = fileId => {
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
  const filesToDownload = filteredSearchFiles.value.filter(f => selectedSearchFiles.value.includes(f.id));
  filesToDownload.forEach(file => download(file));
  selectedSearchFiles.value = [];
};

const downloadCurrentFolder = async () => {
  const appLogger = logger.child('App');

  if (isAtRoot.value) {
    appLogger.warn(APP_ERRORS.DOWNLOAD_ROOT_FAILED);
    return;
  }

  if (!currentNodeId.value) {
    appLogger.error(APP_ERRORS.NO_CURRENT_FOLDER);
    return;
  }

  try {
    // Obtener información de la carpeta actual
    const folderInfo =
      breadcrumbPath.value.length > 0
        ? {
            id: currentNodeId.value,
            title: breadcrumbPath.value[breadcrumbPath.value.length - 1].title,
          }
        : { id: currentNodeId.value, title: INFO_MESSAGES.CARPETA_ACTUAL };

    const result = await downloadFolder(folderInfo);

    if (result.success) {
      appLogger.info(
        `Descarga de carpeta iniciada: ${result.added} archivos agregados de ${result.totalFiles} totales`
      );
    } else {
      appLogger.error(APP_ERRORS.DOWNLOAD_ROOT_FAILED, result.error);
    }
  } catch (error) {
    appLogger.error('Excepción descargando carpeta:', error);
  }
};

const loadUpdateDate = async () => {
  const appLogger = logger.child('App');
  try {
    const result = await getDbUpdateDate();
    if (result.success) {
      lastUpdateDate.value = result.data;
    }
  } catch (error) {
    appLogger.error('Error cargando fecha de actualización:', error);
  }
};

const handleCleanHistory = async daysOld => {
  try {
    const result = await cleanHistory(daysOld);
    if (result.success) {
      showToast({
        title: SUCCESS_MESSAGES.HISTORY_CLEANED,
        message: formatHistoryCleaned(result.count),
        type: 'success',
        duration: 5000,
      });
      cleanupStats.value.lastDbCleanup = Date.now();
    } else {
      showToast({
        title: HISTORY_ERRORS.CLEAN_FAILED,
        message: result.error || GENERAL_ERRORS.UNKNOWN,
        type: 'error',
        duration: 5000,
      });
    }
  } catch (error) {
    const appLogger = logger.child('App');
    appLogger.error('Error limpiando historial:', error);
    showToast({
      title: HISTORY_ERRORS.CLEAN_FAILED,
      message: error.message || GENERAL_ERRORS.UNKNOWN,
      type: 'error',
      duration: 5000,
    });
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
// EVENT HANDLERS
// =====================

// Handlers para eventos de limpieza
const handleHistoryCleaned = event => {
  const { count } = event.detail;
  if (showNotifications.value && count > 0) {
    showToast({
      title: SUCCESS_MESSAGES.HISTORY_CLEANED,
      message: formatHistoryCleanedOld(count),
      type: 'info',
      duration: 5000,
    });
    cleanupStats.value.lastDbCleanup = Date.now();
  }
};

const handleMemoryCleaned = event => {
  const { removed, kept, total } = event.detail;
  if (showNotifications.value && removed > 0) {
    showToast({
      title: SUCCESS_MESSAGES.MEMORY_OPTIMIZED,
      message: formatMemoryOptimized(removed, kept),
      type: 'success',
      duration: 4000,
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

  // Inicializar manejo de errores del proceso principal
  initErrorHandling();

  // Escuchar eventos de limpieza de historial
  window.addEventListener('history-cleaned', handleHistoryCleaned);
  window.addEventListener('memory-cleaned', handleMemoryCleaned);
});

onUnmounted(() => {
  // Limpiar event listeners
  window.removeEventListener('history-cleaned', handleHistoryCleaned);
  window.removeEventListener('memory-cleaned', handleMemoryCleaned);

  // Limpiar manejo de errores
  cleanupErrorHandling();

  // Limpiar composables
  cleanupDownloads();
  cleanupSearch();
});
</script>
