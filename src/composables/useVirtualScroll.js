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
  const hasStableMeasurement = ref(false); // Flag para indicar si ya tenemos una medición estable

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

    // NO medir altura durante el scroll para evitar cambios erráticos
    // La medición se hace solo al inicio y cuando cambian los items o el tamaño del contenedor
  };

  // Medir altura real de las filas
  const measureRowHeight = () => {
    if (!containerRef.value || !shouldVirtualize.value) return;

    nextTick(() => {
      const container = containerRef.value;
      if (!container) return;

      // Buscar múltiples filas visibles para obtener un promedio más preciso
      const rows = container.querySelectorAll('[data-virtual-index]');
      if (rows.length === 0) return;

      // Calcular altura promedio de las filas visibles (mínimo 3, máximo 10)
      const rowsToMeasure = Math.min(Math.max(3, rows.length), 10);
      let totalHeight = 0;
      let validMeasurements = 0;

      for (let i = 0; i < rowsToMeasure && i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        const height = rect.height;
        
        // Ignorar medidas inválidas o extremas (fuera de rango razonable)
        if (height > 0 && height < 200 && height >= ROW_HEIGHT_ESTIMATE * 0.5) {
          totalHeight += height;
          validMeasurements++;
        }
      }

      // Solo actualizar si tenemos suficientes mediciones válidas
      if (validMeasurements >= 2) {
        const averageHeight = totalHeight / validMeasurements;
        
        // Solo actualizar si la diferencia es significativa y la nueva altura es razonable
        const heightDifference = Math.abs(averageHeight - measuredRowHeight.value);
        
        // Si aún no tenemos una medición estable, ser más permisivo
        if (!hasStableMeasurement.value) {
          // Primera medición: aceptar si está dentro de un rango razonable
          if (averageHeight >= ROW_HEIGHT_ESTIMATE * 0.5 && 
              averageHeight <= ROW_HEIGHT_ESTIMATE * 2) {
            measuredRowHeight.value = Math.round(averageHeight);
            hasStableMeasurement.value = true;
          }
        } else {
          // Mediciones posteriores: ser más conservador
          // Solo actualizar si:
          // 1. La nueva altura es menor o igual (evitar crecimiento)
          // 2. O la diferencia es muy grande (> 15px) y la nueva altura es razonable
          const shouldUpdate = 
            (averageHeight <= measuredRowHeight.value && heightDifference > 3) ||
            (heightDifference > 15 && 
             averageHeight >= ROW_HEIGHT_ESTIMATE * 0.5 && 
             averageHeight <= ROW_HEIGHT_ESTIMATE * 2);
          
          if (shouldUpdate) {
            measuredRowHeight.value = Math.round(averageHeight);
          }
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
        // Resetear medición estable cuando cambian los items
        hasStableMeasurement.value = false;
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
