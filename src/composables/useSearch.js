/**
 * @fileoverview useSearch - Composable para búsqueda en el catálogo
 * @module useSearch
 *
 * Maneja la búsqueda de archivos y carpetas en el catálogo de Myrient:
 * - Término de búsqueda con debounce para evitar búsquedas excesivas
 * - Resultados de búsqueda reactivos
 * - Ordenamiento de resultados por diferentes campos
 * - Cancelación de búsquedas en progreso
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} SearchResult
 * @property {number} id - ID único del resultado
 * @property {string} title - Título del archivo o carpeta
 * @property {string} type - Tipo: 'file' | 'folder'
 * @property {number} [size] - Tamaño en bytes (solo para archivos)
 * @property {string} [url] - URL de descarga (solo para archivos)
 */

import { ref, computed, watch } from 'vue';
import { search as apiSearch } from '../services/api'; // ✅ Ruta correcta para services/
import { useSettings } from './useSettings';

// Estado global (singleton)
const searchTerm = ref('');
const searchResults = ref([]);
const isSearching = ref(false);
const isSearchCancelled = ref(false); // Indica si la búsqueda actual fue cancelada
const sortField = ref('title');
const sortDirection = ref('asc');

// Timeout para debounce
let searchTimeout = null;

// AbortController para cancelar búsquedas en progreso
let currentSearchAbortController = null;
let currentSearchId = 0; // ID único para cada búsqueda para detectar búsquedas obsoletas

// Flag para evitar múltiples watchers
let watcherInitialized = false;

// Referencia a la función executeSearch para el watcher
let executeSearchRef = null;

/**
 * Composable para gestión de búsqueda en el catálogo
 *
 * Proporciona una API reactiva para buscar archivos y carpetas en el catálogo
 * de Myrient. Incluye debounce automático, cancelación de búsquedas, y ordenamiento
 * de resultados. Los resultados se actualizan automáticamente cuando cambia el término.
 *
 * @returns {Object} Objeto con estado, computed properties y métodos de búsqueda
 * @returns {Ref<string>} returns.searchTerm - Término de búsqueda actual (reactivo)
 * @returns {Ref<Array<SearchResult>>} returns.searchResults - Resultados de búsqueda (reactivo)
 * @returns {Ref<boolean>} returns.isSearching - Si hay una búsqueda en progreso
 * @returns {ComputedRef<boolean>} returns.hasSearchResults - Si hay resultados
 * @returns {ComputedRef<Array>} returns.searchFolders - Carpetas en los resultados
 * @returns {ComputedRef<Array>} returns.searchFiles - Archivos en los resultados (ordenados)
 * @returns {ComputedRef<number>} returns.totalResults - Total de resultados
 * @returns {Function} returns.executeSearch - Ejecuta una búsqueda manualmente
 * @returns {Function} returns.clearSearch - Limpia los resultados de búsqueda
 * @returns {Function} returns.setSortField - Cambia el campo de ordenamiento
 * @returns {Function} returns.setSortDirection - Cambia la dirección de ordenamiento
 *
 * @example
 * // En un componente Vue
 * import { useSearch } from '@/composables/useSearch';
 *
 * export default {
 *   setup() {
 *     const {
 *       searchTerm,
 *       searchResults,
 *       isSearching,
 *       hasSearchResults,
 *       searchFiles,
 *       searchFolders,
 *       clearSearch
 *     } = useSearch();
 *
 *     // El término de búsqueda se actualiza automáticamente con debounce
 *
 *     return {
 *       searchTerm,
 *       searchResults,
 *       isSearching,
 *       hasSearchResults,
 *       searchFiles,
 *       searchFolders,
 *       clearSearch
 *     };
 *   }
 * };
 */
export function useSearch() {
  const { searchLimit, searchDebounce } = useSettings();

  // =====================
  // COMPUTED
  // =====================

  /**
   * Indica si hay resultados de búsqueda activos
   */
  const hasSearchResults = computed(() => searchResults.value.length > 0);

  /**
   * Carpetas en los resultados de búsqueda
   */
  const searchFolders = computed(() => {
    return searchResults.value
      .filter(item => item.type === 'folder')
      .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  });

  /**
   * Archivos en los resultados de búsqueda (ordenados)
   */
  const searchFiles = computed(() => {
    const files = searchResults.value.filter(item => item.type === 'file');

    return files.sort((a, b) => {
      let aVal = a[sortField.value];
      let bVal = b[sortField.value];

      // Manejar valores nulos
      if (aVal === null || aVal === undefined) aVal = '';
      if (bVal === null || bVal === undefined) bVal = '';

      // Ordenar strings case-insensitive
      if (typeof aVal === 'string') {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      }

      let comparison = 0;
      if (aVal < bVal) comparison = -1;
      else if (aVal > bVal) comparison = 1;

      return sortDirection.value === 'asc' ? comparison : -comparison;
    });
  });

  /**
   * Total de resultados
   */
  const totalResults = computed(() => searchResults.value.length);

  // =====================
  // MÉTODOS
  // =====================

  /**
   * Ejecuta la búsqueda
   * @param {number} searchId - ID único de esta búsqueda para detectar si fue cancelada
   */
  const executeSearch = async (searchId = null) => {
    const term = searchTerm.value.trim();

    if (term.length < 3) {
      searchResults.value = [];
      isSearching.value = false;
      isSearchCancelled.value = false;
      return;
    }

    // Generar ID único si no se proporciona
    const thisSearchId = searchId !== null ? searchId : ++currentSearchId;

    // Marcar búsqueda anterior como cancelada si existe una búsqueda en progreso
    if (currentSearchAbortController) {
      isSearchCancelled.value = true;
      console.log('[useSearch] Búsqueda anterior cancelada');
    }

    // Crear nuevo identificador para esta búsqueda
    currentSearchAbortController = { searchId: thisSearchId };
    isSearching.value = true;
    isSearchCancelled.value = false;

    try {
      const response = await apiSearch(term);

      // Verificar si esta búsqueda fue cancelada por una nueva búsqueda
      // Esto ocurre si el currentSearchId cambió durante la ejecución
      if (thisSearchId !== currentSearchId) {
        console.log('[useSearch] Búsqueda obsoleta ignorada (se inició una nueva)');
        isSearchCancelled.value = true;
        // No actualizar resultados si esta búsqueda es obsoleta
        return;
      }

      // Verificar si el término de búsqueda cambió (usuario siguió escribiendo)
      if (term !== searchTerm.value.trim()) {
        console.log('[useSearch] Término de búsqueda cambió, ignorando resultados obsoletos');
        isSearchCancelled.value = true;
        return;
      }

      if (response.success) {
        // Limitar resultados según configuración (usar searchLimit del closure)
        searchResults.value = response.data.slice(0, searchLimit.value);
        console.log(
          `[useSearch] Encontrados: ${response.data.length}, mostrando: ${searchResults.value.length}`
        );
        isSearchCancelled.value = false;
      } else {
        console.error('[useSearch] Error en búsqueda:', response.error);
        searchResults.value = [];
        isSearchCancelled.value = false;
      }
    } catch (error) {
      // Verificar si esta búsqueda sigue siendo válida antes de reportar error
      if (thisSearchId !== currentSearchId || term !== searchTerm.value.trim()) {
        console.log('[useSearch] Búsqueda obsoleta, ignorando error');
        isSearchCancelled.value = true;
        return;
      }
      console.error('[useSearch] Excepción en búsqueda:', error);
      searchResults.value = [];
      isSearchCancelled.value = false;
    } finally {
      // Solo actualizar estado si esta sigue siendo la búsqueda actual
      if (thisSearchId === currentSearchId && term === searchTerm.value.trim()) {
        isSearching.value = false;
        if (currentSearchAbortController?.searchId === thisSearchId) {
          currentSearchAbortController = null;
        }
      } else {
        // Esta búsqueda fue reemplazada, marcar como cancelada
        isSearchCancelled.value = true;
      }
    }
  };

  // Guardar referencia para el watcher
  executeSearchRef = executeSearch;

  /**
   * Búsqueda con debounce (para input en tiempo real)
   * Usa el delay configurado en useSettings
   */
  const searchWithDebounce = () => {
    // Cancelar timeout anterior si existe
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }

    // Cancelar búsqueda en progreso si existe (incrementar ID marca búsqueda anterior como obsoleta)
    if (currentSearchAbortController) {
      currentSearchAbortController = null;
      isSearchCancelled.value = true;
    }

    // Obtener delay configurado (con fallback a 300ms si no está disponible)
    const delay = searchDebounce.value || 300;
    const searchId = ++currentSearchId;

    searchTimeout = setTimeout(() => {
      if (executeSearchRef) {
        executeSearchRef(searchId);
      }
      searchTimeout = null;
    }, delay);
  };

  /**
   * Búsqueda inmediata (para botón de buscar)
   */
  const search = () => {
    // Cancelar debounce pendiente
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }

    // Cancelar búsqueda en progreso si existe (incrementar ID marca búsqueda anterior como obsoleta)
    if (currentSearchAbortController) {
      currentSearchAbortController = null;
      isSearchCancelled.value = true;
    }

    const searchId = ++currentSearchId;
    executeSearch(searchId);
  };

  /**
   * Limpia los resultados de búsqueda
   */
  const clearSearch = () => {
    searchTerm.value = '';
    searchResults.value = [];
    isSearchCancelled.value = false;

    // Cancelar debounce pendiente
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }

    // Cancelar búsqueda en progreso si existe
    if (currentSearchAbortController) {
      currentSearchAbortController = null;
    }
  };

  /**
   * Cambia el campo de ordenamiento
   * @param {string} field - Campo por el cual ordenar
   */
  const setSortField = field => {
    if (sortField.value === field) {
      // Si es el mismo campo, invertir dirección
      sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
    } else {
      sortField.value = field;
      sortDirection.value = 'asc';
    }
  };

  /**
   * Indica si un campo está activo para ordenamiento
   * @param {string} field - Campo a verificar
   */
  const isSortedBy = field => sortField.value === field;

  /**
   * Obtiene el indicador de dirección para un campo
   * @param {string} field - Campo a verificar
   * @returns {string} Flecha o vacío
   */
  const getSortIndicator = field => {
    if (sortField.value !== field) return '';
    return sortDirection.value === 'asc' ? '↑' : '↓';
  };

  // =====================
  // WATCHERS
  // =====================

  // Inicializar watcher solo una vez (después de que executeSearchRef esté definido)
  if (!watcherInitialized && executeSearchRef) {
    // Watcher reactivo que se actualiza cuando cambia searchTerm o searchDebounce
    // El watcher se crea dentro de la función para tener acceso al closure con searchDebounce
    watch([searchTerm, () => searchDebounce.value], ([newTerm, debounceDelay]) => {
      if (newTerm.trim().length >= 3) {
        // Usar el delay configurado (reactivo)
        // searchWithDebounce() obtendrá el valor actualizado de searchDebounce del closure
        searchWithDebounce();
      } else {
        // Si el término es muy corto, limpiar resultados
        if (searchTimeout) {
          clearTimeout(searchTimeout);
          searchTimeout = null;
        }
        // Cancelar búsqueda en progreso
        if (currentSearchAbortController) {
          currentSearchAbortController = null;
          isSearchCancelled.value = true;
        }
        searchResults.value = [];
        isSearchCancelled.value = false;
      }
    });
    watcherInitialized = true;
  }

  // =====================
  // CLEANUP
  // =====================

  /**
   * Limpia recursos (llamar en onUnmounted)
   */
  const cleanup = () => {
    // Cancelar debounce pendiente
    if (searchTimeout) {
      clearTimeout(searchTimeout);
      searchTimeout = null;
    }

    // Cancelar búsqueda en progreso
    if (currentSearchAbortController) {
      currentSearchAbortController = null;
    }
  };

  // =====================
  // RETURN
  // =====================

  return {
    // Estado reactivo
    searchTerm,
    searchResults,
    isSearching,
    isSearchCancelled,
    sortField,
    sortDirection,

    // Computed
    hasSearchResults,
    searchFolders,
    searchFiles,
    totalResults,

    // Métodos
    search,
    searchWithDebounce,
    executeSearch,
    clearSearch,
    setSortField,
    isSortedBy,
    getSortIndicator,
    cleanup,
  };
}

export default useSearch;
