/**
 * Composable para Virtual Scrolling optimizado
 * 
 * Implementa virtualización eficiente para listas grandes:
 * - Cálculo dinámico de altura de filas
 * - Buffering (overscan) para scroll suave
 * - Throttling de eventos de scroll
 * - ResizeObserver para ajuste automático
 * - Soporte para alturas variables
 */

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';

/**
 * Composable de Virtual Scrolling
 * @param {Object} options - Opciones de configuración
 * @param {Ref<Array>} options.items - Array reactivo de items
 * @param {Ref<HTMLElement>} options.containerRef - Referencia al contenedor scrollable
 * @param {Number} options.itemHeight - Altura estimada de cada item (px)
 * @param {Number} options.overscan - Número de items a renderizar fuera de la vista
 * @param {Number} options.minItemsToVirtualize - Mínimo de items para activar virtualización
 * @param {Boolean} options.enabled - Habilitar/deshabilitar virtualización
 * @returns {Object} - Estado y métodos del virtual scroll
 */
export function useVirtualScroll(options = {}) {
  const {
    items = ref([]),
    containerRef = ref(null),
    itemHeight = 50,
    overscan = 5,
    minItemsToVirtualize = 50,
    enabled = true
  } = options;

  // Estado
  const scrollTop = ref(0);
  const containerHeight = ref(0);
  const measuredRowHeight = ref(itemHeight);
  const isMeasuring = ref(false);

  // Configuración
  const ROW_HEIGHT_ESTIMATE = itemHeight;
  const OVERSCAN = overscan;
  const MIN_ITEMS_TO_VIRTUALIZE = minItemsToVirtualize;
  const ENABLED = enabled;

  // Determinar si usar virtualización
  const shouldVirtualize = computed(() => {
    const itemsValue = items.value;
    const containerValue = containerRef.value;
    
    return ENABLED && 
           Array.isArray(itemsValue) &&
           itemsValue.length >= MIN_ITEMS_TO_VIRTUALIZE &&
           containerValue !== null &&
           containerValue !== undefined;
  });

  // Calcular rango visible de items
  const visibleRange = computed(() => {
    if (!shouldVirtualize.value) {
      return { start: 0, end: items.value.length, total: items.value.length };
    }

    const start = Math.max(
      0,
      Math.floor(scrollTop.value / measuredRowHeight.value) - OVERSCAN
    );
    
    const end = Math.min(
      items.value.length,
      Math.ceil((scrollTop.value + containerHeight.value) / measuredRowHeight.value) + OVERSCAN
    );

    return { start, end, total: items.value.length };
  });

  // Items visibles con índice virtual
  const visibleItems = computed(() => {
    const { start, end } = visibleRange.value;
    return items.value.slice(start, end).map((item, index) => ({
      ...item,
      _virtualIndex: start + index,
      _actualIndex: start + index
    }));
  });

  // Altura del espaciador superior
  const topSpacerHeight = computed(() => {
    if (!shouldVirtualize.value) return 0;
    return visibleRange.value.start * measuredRowHeight.value;
  });

  // Altura del espaciador inferior
  const bottomSpacerHeight = computed(() => {
    if (!shouldVirtualize.value) return 0;
    const { end, total } = visibleRange.value;
    return (total - end) * measuredRowHeight.value;
  });

  // Altura total estimada del contenido
  const totalHeight = computed(() => {
    if (!shouldVirtualize.value) return 'auto';
    return `${items.value.length * measuredRowHeight.value}px`;
  });

  // Throttle para eventos de scroll (mejorar rendimiento)
  let scrollTimeout = null;
  const handleScroll = () => {
    if (!containerRef.value || !shouldVirtualize.value) return;

    // Actualizar scrollTop inmediatamente para respuesta rápida
    scrollTop.value = containerRef.value.scrollTop;

    // Medir altura de filas periódicamente durante el scroll
    if (!isMeasuring.value) {
      isMeasuring.value = true;
      measureRowHeight();
      setTimeout(() => {
        isMeasuring.value = false;
      }, 100);
    }
  };

  // Medir altura real de las filas
  const measureRowHeight = () => {
    if (!containerRef.value || !shouldVirtualize.value) return;

    nextTick(() => {
      const container = containerRef.value;
      if (!container) return;

      // Buscar primera fila visible
      const firstRow = container.querySelector('[data-virtual-index]');
      if (firstRow) {
        const rect = firstRow.getBoundingClientRect();
        const height = rect.height;
        
        if (height > 0 && Math.abs(height - measuredRowHeight.value) > 2) {
          // Solo actualizar si la diferencia es significativa (>2px)
          measuredRowHeight.value = height;
        }
      }
    });
  };

  // Scrollbar thumb height (para indicador visual)
  const scrollbarThumbHeight = computed(() => {
    if (!shouldVirtualize.value || !containerRef.value) return 0;
    const { total } = visibleRange.value;
    const viewportRatio = containerHeight.value / (total * measuredRowHeight.value);
    return Math.max(20, containerHeight.value * viewportRatio);
  });

  // Scrollbar thumb position
  const scrollbarThumbPosition = computed(() => {
    if (!shouldVirtualize.value || !containerRef.value) return 0;
    const { total } = visibleRange.value;
    const scrollRatio = scrollTop.value / ((total * measuredRowHeight.value) - containerHeight.value);
    return scrollRatio * (containerHeight.value - scrollbarThumbHeight.value);
  });

  // Observadores
  let resizeObserver = null;
  let intersectionObserver = null;

  // Inicializar observadores
  const initObservers = () => {
    if (!containerRef.value) return;

    // ResizeObserver para cambios de tamaño del contenedor
    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          containerHeight.value = entry.contentRect.height;
          measureRowHeight();
        }
      });
      resizeObserver.observe(containerRef.value);
    }

    // Medir altura cuando cambien los items
    watch(() => items.value.length, () => {
      if (shouldVirtualize.value) {
        nextTick(() => {
          measureRowHeight();
        });
      }
    }, { immediate: false });
  };

  // Scroll a un índice específico
  const scrollToIndex = (index, align = 'start') => {
    if (!containerRef.value || !shouldVirtualize.value) return;

    const targetScrollTop = index * measuredRowHeight.value;
    const maxScroll = (items.value.length * measuredRowHeight.value) - containerHeight.value;

    let finalScrollTop = Math.max(0, Math.min(targetScrollTop, maxScroll));

    if (align === 'center') {
      finalScrollTop = Math.max(0, finalScrollTop - (containerHeight.value / 2));
    } else if (align === 'end') {
      finalScrollTop = Math.max(0, finalScrollTop - containerHeight.value);
    }

    containerRef.value.scrollTop = finalScrollTop;
    scrollTop.value = finalScrollTop;
  };

  // Scroll a la parte superior
  const scrollToTop = () => {
    scrollToIndex(0);
  };

  // Scroll a la parte inferior
  const scrollToBottom = () => {
    if (!shouldVirtualize.value) return;
    scrollToIndex(items.value.length - 1, 'end');
  };

  // Limpiar observadores
  const cleanup = () => {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
      scrollTimeout = null;
    }
  };

  // Inicialización
  onMounted(() => {
    if (containerRef.value) {
      containerHeight.value = containerRef.value.clientHeight;
      initObservers();
      measureRowHeight();
    }
  });

  onUnmounted(() => {
    cleanup();
  });

  return {
    // Estado
    scrollTop,
    containerHeight,
    measuredRowHeight,
    shouldVirtualize,
    
    // Computed
    visibleRange,
    visibleItems,
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight,
    scrollbarThumbHeight,
    scrollbarThumbPosition,
    
    // Métodos
    handleScroll,
    measureRowHeight,
    scrollToIndex,
    scrollToTop,
    scrollToBottom,
    cleanup
  };
}
