/**
 * useSearch - Composable para búsqueda
 * 
 * Maneja:
 * - Término de búsqueda con debounce
 * - Resultados de búsqueda
 * - Ordenamiento de resultados
 * 
 * ✅ VERSIÓN 1: Para estructura src/services/api.js
 */

import { ref, computed, watch } from 'vue';
import { search as apiSearch } from '../services/api';  // ✅ Ruta correcta para services/
import { useSettings } from './useSettings';

// Estado global (singleton)
const searchTerm = ref('');
const searchResults = ref([]);
const isSearching = ref(false);
const sortField = ref('title');
const sortDirection = ref('asc');

// Timeout para debounce
let searchTimeout = null;

// Flag para evitar múltiples watchers
let watcherInitialized = false;

// Referencia a la función executeSearch para el watcher
let executeSearchRef = null;

/**
 * Composable de búsqueda
 */
export function useSearch() {
    const { searchLimit } = useSettings();

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
     */
    const executeSearch = async () => {
        const term = searchTerm.value.trim();

        if (term.length < 3) {
            searchResults.value = [];
            return;
        }

        isSearching.value = true;

        try {
            const response = await apiSearch(term);
            
            if (response.success) {
                // Limitar resultados según configuración (usar searchLimit del closure)
                searchResults.value = response.data.slice(0, searchLimit.value);
                console.log(`[useSearch] Encontrados: ${response.data.length}, mostrando: ${searchResults.value.length}`);
            } else {
                console.error('[useSearch] Error en búsqueda:', response.error);
                searchResults.value = [];
            }
        } catch (error) {
            console.error('[useSearch] Excepción en búsqueda:', error);
            searchResults.value = [];
        } finally {
            isSearching.value = false;
        }
    };

    // Guardar referencia para el watcher
    executeSearchRef = executeSearch;

    /**
     * Búsqueda con debounce (para input en tiempo real)
     * @param {number} delay - Delay en ms (default: 300)
     */
    const searchWithDebounce = (delay = 300) => {
        if (searchTimeout) {
            clearTimeout(searchTimeout);
        }

        searchTimeout = setTimeout(() => {
            if (executeSearchRef) {
                executeSearchRef();
            }
            searchTimeout = null;
        }, delay);
    };

    /**
     * Búsqueda inmediata (para botón de buscar)
     */
    const search = () => {
        if (searchTimeout) {
            clearTimeout(searchTimeout);
            searchTimeout = null;
        }
        executeSearch();
    };

    /**
     * Limpia los resultados de búsqueda
     */
    const clearSearch = () => {
        searchTerm.value = '';
        searchResults.value = [];
        if (searchTimeout) {
            clearTimeout(searchTimeout);
            searchTimeout = null;
        }
    };

    /**
     * Cambia el campo de ordenamiento
     * @param {string} field - Campo por el cual ordenar
     */
    const setSortField = (field) => {
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
    const isSortedBy = (field) => sortField.value === field;

    /**
     * Obtiene el indicador de dirección para un campo
     * @param {string} field - Campo a verificar
     * @returns {string} Flecha o vacío
     */
    const getSortIndicator = (field) => {
        if (sortField.value !== field) return '';
        return sortDirection.value === 'asc' ? '↑' : '↓';
    };

    // =====================
    // WATCHERS
    // =====================

    // Inicializar watcher solo una vez (después de que executeSearchRef esté definido)
    if (!watcherInitialized && executeSearchRef) {
        watch(searchTerm, (newTerm) => {
            if (newTerm.trim().length >= 3) {
                searchWithDebounce(300);
            } else {
                // Si el término es muy corto, limpiar resultados
                if (searchTimeout) {
                    clearTimeout(searchTimeout);
                    searchTimeout = null;
                }
                searchResults.value = [];
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
        if (searchTimeout) {
            clearTimeout(searchTimeout);
            searchTimeout = null;
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
        cleanup
    };
}

export default useSearch;
