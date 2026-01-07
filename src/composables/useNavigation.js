/**
 * useNavigation - Composable para navegación por carpetas
 * 
 * Maneja:
 * - Nodo actual y sus hijos
 * - Breadcrumb (ruta de navegación)
 * - Historial de navegación
 */

import { ref, computed } from 'vue';
import { getChildren, getAncestors, getNodeInfo } from '../services/api';

// Estado global (singleton)
const currentNodeId = ref(1); // 1 = raíz
const currentParentId = ref(null);
const allChildren = ref([]);
const breadcrumbPath = ref([]);
const statusMessage = ref('');
const navigationHistory = ref([]);

/**
 * Composable de navegación
 */
export function useNavigation() {

    // =====================
    // COMPUTED
    // =====================

    /**
     * Carpetas del nodo actual (ordenadas alfabéticamente)
     */
    const folders = computed(() => {
        return allChildren.value
            .filter(item => item.type === 'folder')
            .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    });

    /**
     * Archivos del nodo actual
     */
    const files = computed(() => {
        return allChildren.value.filter(item => item.type === 'file');
    });

    /**
     * Ruta de ubicación como string
     */
    const locationPath = computed(() => {
        if (breadcrumbPath.value.length === 0) return '';
        return breadcrumbPath.value.map(n => n.title).join(' / ');
    });

    /**
     * Indica si estamos en la raíz
     */
    const isAtRoot = computed(() => currentNodeId.value === 1);

    /**
     * Indica si podemos ir hacia atrás
     */
    const canGoBack = computed(() => {
        return currentNodeId.value !== 1 || navigationHistory.value.length > 0;
    });

    // =====================
    // CARGA DE DATOS
    // =====================

    /**
     * Carga los hijos del nodo actual
     */
    const loadChildren = async () => {
        try {
            statusMessage.value = 'Cargando...';
            
            const response = await getChildren(currentNodeId.value);
            
            if (response.success) {
                allChildren.value = response.data;

                // Obtener info del nodo actual para conocer su parent_id
                if (currentNodeId.value !== 1) {
                    const nodeInfo = await getNodeInfo(currentNodeId.value);
                    if (nodeInfo.success) {
                        currentParentId.value = nodeInfo.data.parent_id;
                    }
                } else {
                    currentParentId.value = null;
                }

                // Cargar breadcrumb
                await loadBreadcrumb();
                statusMessage.value = '';
            } else {
                statusMessage.value = `Error: ${response.error}`;
            }
        } catch (error) {
            statusMessage.value = `Error al cargar: ${error.message}`;
            console.error('[useNavigation] Error cargando hijos:', error);
        }
    };

    /**
     * Carga la ruta de navegación (breadcrumb)
     */
    const loadBreadcrumb = async () => {
        if (currentNodeId.value === 1) {
            breadcrumbPath.value = [];
            return;
        }

        try {
            const response = await getAncestors(currentNodeId.value);
            if (response.success) {
                breadcrumbPath.value = response.data;
            }
        } catch (error) {
            console.error('[useNavigation] Error cargando breadcrumb:', error);
        }
    };

    // =====================
    // NAVEGACIÓN
    // =====================

    /**
     * Navega a un nodo específico
     * @param {Object} node - Nodo destino (debe tener id)
     */
    const navigateToNode = async (node) => {
        if (!node || !node.id) {
            console.warn('[useNavigation] Nodo inválido para navegación');
            return;
        }

        // Guardar en historial si es diferente
        if (currentNodeId.value !== node.id) {
            navigationHistory.value.push(currentNodeId.value);
            // Limitar historial a últimos 50
            if (navigationHistory.value.length > 50) {
                navigationHistory.value.shift();
            }
        }

        currentNodeId.value = node.id;
        await loadChildren();
    };

    /**
     * Navega a un nodo por ID
     * @param {number} nodeId - ID del nodo destino
     */
    const navigateToId = async (nodeId) => {
        await navigateToNode({ id: nodeId });
    };

    /**
     * Vuelve a la raíz
     */
    const goToRoot = async () => {
        if (currentNodeId.value !== 1) {
            navigationHistory.value.push(currentNodeId.value);
        }
        currentNodeId.value = 1;
        await loadChildren();
    };

    /**
     * Vuelve al nodo padre
     */
    const goBack = async () => {
        if (currentParentId.value) {
            // Usar el parent del nodo actual
            await navigateToId(currentParentId.value);
        } else if (navigationHistory.value.length > 0) {
            // Usar historial
            const previousId = navigationHistory.value.pop();
            currentNodeId.value = previousId;
            await loadChildren();
        } else if (currentNodeId.value !== 1) {
            // Fallback a raíz
            await goToRoot();
        }
    };

    /**
     * Vuelve al nodo anterior del historial
     */
    const goBackInHistory = async () => {
        if (navigationHistory.value.length > 0) {
            const previousId = navigationHistory.value.pop();
            currentNodeId.value = previousId;
            await loadChildren();
        }
    };

    /**
     * Limpia el historial de navegación
     */
    const clearHistory = () => {
        navigationHistory.value = [];
    };

    // =====================
    // INICIALIZACIÓN
    // =====================

    /**
     * Inicializa la navegación cargando la raíz
     */
    const initNavigation = async () => {
        currentNodeId.value = 1;
        await loadChildren();
    };

    // =====================
    // RETURN
    // =====================

    return {
        // Estado reactivo
        currentNodeId,
        currentParentId,
        allChildren,
        breadcrumbPath,
        statusMessage,
        navigationHistory,

        // Computed
        folders,
        files,
        locationPath,
        isAtRoot,
        canGoBack,

        // Métodos de carga
        loadChildren,
        loadBreadcrumb,

        // Navegación
        navigateToNode,
        navigateToId,
        goToRoot,
        goBack,
        goBackInHistory,
        clearHistory,
        initNavigation
    };
}

export default useNavigation;
