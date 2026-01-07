/**
 * useFavorites - Composable para gestión de favoritos
 * 
 * Maneja:
 * - Lista de carpetas favoritas
 * - Persistencia en archivo JSON
 * - Añadir/quitar favoritos
 */

import { ref, computed } from 'vue';
import { readConfigFile, writeConfigFile } from '../services/api';

// Estado global (singleton)
const favorites = ref([]);
const showingFavorites = ref(false);

/**
 * Composable de favoritos
 */
export function useFavorites() {
    
    // =====================
    // COMPUTED
    // =====================

    /**
     * Lista de carpetas favoritas (solo tipo folder)
     */
    const favoriteFolders = computed(() => {
        return favorites.value.filter(f => f.type === 'folder');
    });

    /**
     * Set de IDs de favoritos para búsqueda rápida O(1)
     */
    const favoriteIds = computed(() => {
        return new Set(favorites.value.map(f => f.id));
    });

    // =====================
    // CARGA Y GUARDADO
    // =====================

    /**
     * Carga favoritos desde archivo
     */
    const loadFavorites = async () => {
        try {
            const result = await readConfigFile('favorites.json');
            if (result.success && result.data) {
                favorites.value = Array.isArray(result.data) ? result.data : [];
            } else {
                favorites.value = [];
            }
        } catch (error) {
            console.error('[useFavorites] Error cargando favoritos:', error);
            favorites.value = [];
        }
    };

    /**
     * Guarda favoritos en archivo
     */
    const saveFavorites = async () => {
        try {
            await writeConfigFile('favorites.json', favorites.value);
        } catch (error) {
            console.error('[useFavorites] Error guardando favoritos:', error);
        }
    };

    // =====================
    // ACCIONES
    // =====================

    /**
     * Verifica si un nodo es favorito
     * @param {number} nodeId - ID del nodo
     * @returns {boolean}
     */
    const isFavorite = (nodeId) => {
        return favoriteIds.value.has(nodeId);
    };

    /**
     * Añade o quita un nodo de favoritos
     * @param {Object} node - Nodo a toggle (debe tener id, title, type)
     */
    const toggleFavorite = (node) => {
        if (!node || !node.id) {
            console.warn('[useFavorites] Nodo inválido');
            return;
        }

        const index = favorites.value.findIndex(f => f.id === node.id);
        
        if (index >= 0) {
            // Quitar de favoritos
            favorites.value.splice(index, 1);
            console.log('[useFavorites] Quitado de favoritos:', node.title);
        } else {
            // Añadir a favoritos
            favorites.value.push({
                id: node.id,
                title: node.title,
                type: node.type || 'folder'
            });
            console.log('[useFavorites] Añadido a favoritos:', node.title);
        }

        saveFavorites();
    };

    /**
     * Añade un nodo a favoritos (si no existe)
     * @param {Object} node - Nodo a añadir
     */
    const addFavorite = (node) => {
        if (!isFavorite(node.id)) {
            toggleFavorite(node);
        }
    };

    /**
     * Quita un nodo de favoritos (si existe)
     * @param {number} nodeId - ID del nodo a quitar
     */
    const removeFavorite = (nodeId) => {
        const index = favorites.value.findIndex(f => f.id === nodeId);
        if (index >= 0) {
            favorites.value.splice(index, 1);
            saveFavorites();
        }
    };

    /**
     * Limpia todos los favoritos
     */
    const clearFavorites = () => {
        favorites.value = [];
        saveFavorites();
    };

    /**
     * Muestra/oculta la sección de favoritos
     */
    const toggleFavoritesPanel = () => {
        showingFavorites.value = !showingFavorites.value;
    };

    // =====================
    // RETURN
    // =====================

    return {
        // Estado reactivo
        favorites,
        showingFavorites,

        // Computed
        favoriteFolders,
        favoriteIds,

        // Métodos
        loadFavorites,
        saveFavorites,
        isFavorite,
        toggleFavorite,
        addFavorite,
        removeFavorite,
        clearFavorites,
        toggleFavoritesPanel
    };
}

export default useFavorites;
