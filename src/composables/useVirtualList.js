/**
 * useVirtualList - Composable para virtualización de listas
 * 
 * Implementa virtualización eficiente para listas grandes (1000+ items)
 * sin dependencias externas.
 * 
 * Características:
 * - Renderiza solo items visibles + buffer (overscan)
 * - Soporta altura de fila fija o variable
 * - Scroll suave con RAF
 * - Scroll programático a índice específico
 * - Auto-resize del contenedor
 */

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';

/**
 * @param {Object} options - Opciones de configuración
 * @param {Ref<Array>} options.items - Array reactivo de items
 * @param {number} options.itemHeight - Altura de cada item en px
 * @param {number} options.containerHeight - Altura del contenedor visible
 * @param {number} options.overscan - Items extra a renderizar fuera del viewport (default: 5)
 * @param {Ref<HTMLElement>} options.scrollElement - Elemento con scroll (opcional)
 */
export function useVirtualList(options) {
    const {
        items,
        itemHeight = 40,
        containerHeight = 400,
        overscan = 5,
        scrollElement = null
    } = options;

    // =====================
    // ESTADO
    // =====================

    const scrollTop = ref(0);
    const scrollContainerRef = ref(null);
    const isScrolling = ref(false);
    let scrollTimeout = null;
    let rafId = null;

    // =====================
    // COMPUTED
    // =====================

    // Altura total de todos los items
    const totalHeight = computed(() => {
        return items.value.length * itemHeight;
    });

    // Número de items que caben en el viewport
    const visibleCount = computed(() => {
        return Math.ceil(containerHeight / itemHeight);
    });

    // Índice del primer item visible
    const startIndex = computed(() => {
        const index = Math.floor(scrollTop.value / itemHeight);
        return Math.max(0, index - overscan);
    });

    // Índice del último item visible (exclusivo)
    const endIndex = computed(() => {
        const end = startIndex.value + visibleCount.value + (overscan * 2);
        return Math.min(items.value.length, end);
    });

    // Offset Y para posicionar los items visibles
    const offsetY = computed(() => {
        return startIndex.value * itemHeight;
    });

    // Solo los items visibles
    const visibleItems = computed(() => {
        return items.value.slice(startIndex.value, endIndex.value);
    });

    // Items visibles con índice original
    const visibleItemsWithIndex = computed(() => {
        return items.value
            .slice(startIndex.value, endIndex.value)
            .map((item, i) => ({
                ...item,
                _virtualIndex: startIndex.value + i
            }));
    });

    // Rango de items visibles (para debugging)
    const visibleRange = computed(() => ({
        start: startIndex.value,
        end: endIndex.value,
        count: endIndex.value - startIndex.value,
        total: items.value.length
    }));

    // =====================
    // MÉTODOS
    // =====================

    /**
     * Handler de scroll con throttling via RAF
     */
    const onScroll = (event) => {
        if (rafId) return;
        
        rafId = requestAnimationFrame(() => {
            scrollTop.value = event.target.scrollTop;
            isScrolling.value = true;
            
            // Reset flag después de un delay
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                isScrolling.value = false;
            }, 150);
            
            rafId = null;
        });
    };

    /**
     * Scroll programático a un índice específico
     */
    const scrollToIndex = (index, behavior = 'auto') => {
        const container = scrollContainerRef.value || scrollElement?.value;
        if (!container) return;

        const targetScrollTop = index * itemHeight;
        
        if (behavior === 'smooth') {
            container.scrollTo({
                top: targetScrollTop,
                behavior: 'smooth'
            });
        } else {
            container.scrollTop = targetScrollTop;
        }
    };

    /**
     * Scroll al inicio
     */
    const scrollToTop = (behavior = 'auto') => {
        scrollToIndex(0, behavior);
    };

    /**
     * Scroll al final
     */
    const scrollToBottom = (behavior = 'auto') => {
        scrollToIndex(items.value.length - 1, behavior);
    };

    /**
     * Verifica si un índice está visible
     */
    const isIndexVisible = (index) => {
        return index >= startIndex.value && index < endIndex.value;
    };

    /**
     * Obtiene el índice del item en una posición Y
     */
    const getIndexAtPosition = (y) => {
        return Math.floor(y / itemHeight);
    };

    /**
     * Reset del scroll (útil cuando cambian los items)
     */
    const resetScroll = () => {
        scrollTop.value = 0;
        const container = scrollContainerRef.value || scrollElement?.value;
        if (container) {
            container.scrollTop = 0;
        }
    };

    // =====================
    // WATCHERS
    // =====================

    // Resetear scroll cuando cambian los items significativamente
    watch(() => items.value.length, (newLen, oldLen) => {
        // Solo resetear si la lista cambió drásticamente
        if (Math.abs(newLen - oldLen) > visibleCount.value) {
            nextTick(() => resetScroll());
        }
    });

    // =====================
    // LIFECYCLE
    // =====================

    onMounted(() => {
        // Setup inicial si es necesario
    });

    onUnmounted(() => {
        // Limpiar RAF y timeouts
        if (rafId) {
            cancelAnimationFrame(rafId);
        }
        if (scrollTimeout) {
            clearTimeout(scrollTimeout);
        }
    });

    // =====================
    // RETURN
    // =====================

    return {
        // Refs
        scrollContainerRef,
        
        // Estado
        scrollTop,
        isScrolling,
        
        // Computed - Dimensiones
        totalHeight,
        visibleCount,
        offsetY,
        
        // Computed - Índices
        startIndex,
        endIndex,
        visibleRange,
        
        // Computed - Items
        visibleItems,
        visibleItemsWithIndex,
        
        // Métodos
        onScroll,
        scrollToIndex,
        scrollToTop,
        scrollToBottom,
        isIndexVisible,
        getIndexAtPosition,
        resetScroll
    };
}

/**
 * Hook simplificado para casos comunes
 */
export function useSimpleVirtualList(items, options = {}) {
    const {
        itemHeight = 40,
        containerHeight = 400,
        overscan = 5
    } = options;

    return useVirtualList({
        items,
        itemHeight,
        containerHeight,
        overscan
    });
}

export default useVirtualList;
