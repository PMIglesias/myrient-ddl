/**
 * Composable para Virtual Scrolling optimizado
 *
 * Implementa virtualización eficiente para listas grandes:
 * - IntersectionObserver para detección precisa de items visibles
 * - Sistema híbrido: cálculo estimado + validación con IntersectionObserver
 * - Cache de alturas dinámicas con ResizeObserver
 * - Buffering (overscan) para scroll suave
 * - Throttling optimizado con RAF
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
 * @param {Boolean} options.useIntersectionObserver - Usar IntersectionObserver (default: true)
 * @returns {Object} - Estado y métodos del virtual scroll
 */
export function useVirtualScroll(options = {}) {
  const {
    items = ref([]),
    containerRef = ref(null),
    itemHeight = 50,
    overscan = 5,
    minItemsToVirtualize = 50,
    enabled = true,
    useIntersectionObserver = true,
  } = options;

  // Estado
  const scrollTop = ref(0);
  const containerHeight = ref(0);
  const measuredRowHeight = ref(itemHeight);
  const hasStableMeasurement = ref(false);

  // Estado para IntersectionObserver
  const visibleIndices = ref(new Set()); // Índices realmente visibles detectados
  const itemHeights = ref(new Map()); // Cache de alturas reales por índice
  const validatedRange = ref(null); // Rango validado por IntersectionObserver

  // Configuración
  const ROW_HEIGHT_ESTIMATE = itemHeight;
  const OVERSCAN = overscan;
  const MIN_ITEMS_TO_VIRTUALIZE = minItemsToVirtualize;
  const ENABLED = enabled;
  const USE_INTERSECTION =
    useIntersectionObserver && typeof window !== 'undefined' && 'IntersectionObserver' in window;
  const SCROLL_THRESHOLD = itemHeight * 0.5; // Umbral mínimo para recalcular

  // Determinar si usar virtualización
  const shouldVirtualize = computed(() => {
    const itemsValue = items.value;
    const containerValue = containerRef.value;

    return (
      ENABLED &&
      Array.isArray(itemsValue) &&
      itemsValue.length >= MIN_ITEMS_TO_VIRTUALIZE &&
      containerValue !== null &&
      containerValue !== undefined
    );
  });

  // Rango estimado (cálculo rápido basado en scrollTop)
  const estimatedRange = computed(() => {
    if (!shouldVirtualize.value) {
      return { start: 0, end: items.value.length, total: items.value.length };
    }

    const start = Math.max(0, Math.floor(scrollTop.value / measuredRowHeight.value) - OVERSCAN);

    const end = Math.min(
      items.value.length,
      Math.ceil((scrollTop.value + containerHeight.value) / measuredRowHeight.value) + OVERSCAN
    );

    return { start, end, total: items.value.length };
  });

  // Rango visible final (usa validado si está disponible, sino estimado)
  const visibleRange = computed(() => {
    if (!shouldVirtualize.value) {
      return { start: 0, end: items.value.length, total: items.value.length };
    }

    // Si tenemos un rango validado por IntersectionObserver y es válido, usarlo
    if (validatedRange.value && USE_INTERSECTION) {
      const { start, end, timestamp } = validatedRange.value;
      // Usar validado si es reciente (menos de 500ms) o si está dentro del rango estimado
      const isRecent = Date.now() - timestamp < 500;
      const estimated = estimatedRange.value;

      if (isRecent || (start >= estimated.start - OVERSCAN && end <= estimated.end + OVERSCAN)) {
        return { start, end, total: items.value.length };
      }
    }

    // Fallback al rango estimado
    return estimatedRange.value;
  });

  // Items visibles con índice virtual
  const visibleItems = computed(() => {
    const { start, end } = visibleRange.value;
    return items.value.slice(start, end).map((item, index) => ({
      ...item,
      _virtualIndex: start + index,
      _actualIndex: start + index,
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

  // Optimización de scroll con RAF
  let rafId = null;
  let lastScrollTop = 0;
  let scrollTimeout = null;

  const handleScroll = () => {
    if (!containerRef.value || !shouldVirtualize.value) return;

    const currentScrollTop = containerRef.value.scrollTop;
    const scrollDelta = Math.abs(currentScrollTop - lastScrollTop);

    // Solo procesar si el cambio es significativo o no hay RAF pendiente
    if (scrollDelta < SCROLL_THRESHOLD && rafId !== null) {
      return;
    }

    // Cancelar RAF pendiente si existe
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }

    // Programar actualización en el próximo frame
    rafId = requestAnimationFrame(() => {
      scrollTop.value = currentScrollTop;
      lastScrollTop = currentScrollTop;
      rafId = null;

      // Solo recalcular rango validado si el cambio es significativo
      if (scrollDelta > SCROLL_THRESHOLD && USE_INTERSECTION) {
        // El IntersectionObserver se encargará de actualizar el rango
        // Solo invalidamos si el scroll fue muy grande
        if (scrollDelta > measuredRowHeight.value * 3) {
          validatedRange.value = null;
        }
      }
    });
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
          if (
            averageHeight >= ROW_HEIGHT_ESTIMATE * 0.5 &&
            averageHeight <= ROW_HEIGHT_ESTIMATE * 2
          ) {
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
    const scrollRatio = scrollTop.value / (total * measuredRowHeight.value - containerHeight.value);
    return scrollRatio * (containerHeight.value - scrollbarThumbHeight.value);
  });

  // Observadores
  let resizeObserver = null;
  let intersectionObserver = null;
  let itemResizeObservers = new Map(); // ResizeObserver para cada item

  // Handler de intersecciones para IntersectionObserver
  const handleIntersections = entries => {
    let hasChanges = false;

    entries.forEach(entry => {
      const index = parseInt(entry.target.dataset.virtualIndex);
      if (isNaN(index) || index < 0 || index >= items.value.length) return;

      if (entry.isIntersecting) {
        visibleIndices.value.add(index);
        hasChanges = true;

        // Medir altura real si no está en cache
        const height = entry.target.offsetHeight;
        if (height > 0 && height < 500) {
          // Validar altura razonable
          const cachedHeight = itemHeights.value.get(index);

          // Actualizar cache si no existe o hay diferencia significativa
          if (!cachedHeight || Math.abs(cachedHeight - height) > 3) {
            itemHeights.value.set(index, height);
            updateAverageHeight();

            // Observar cambios de altura del item con ResizeObserver
            observeItemHeight(entry.target, index);
          }
        }
      } else {
        if (visibleIndices.value.has(index)) {
          visibleIndices.value.delete(index);
          hasChanges = true;
        }
      }
    });

    // Actualizar rango validado si hay cambios
    if (hasChanges && visibleIndices.value.size > 0) {
      updateValidatedRange();
    }
  };

  // Actualizar rango validado basado en índices visibles
  const updateValidatedRange = () => {
    if (visibleIndices.value.size === 0) {
      validatedRange.value = null;
      return;
    }

    const indices = Array.from(visibleIndices.value).sort((a, b) => a - b);
    const minIndex = Math.max(0, indices[0] - OVERSCAN);
    const maxIndex = Math.min(items.value.length - 1, indices[indices.length - 1] + OVERSCAN);

    validatedRange.value = {
      start: minIndex,
      end: maxIndex + 1,
      total: items.value.length,
      timestamp: Date.now(),
    };
  };

  // Observar altura de un item específico con ResizeObserver
  const observeItemHeight = (element, index) => {
    if (!window.ResizeObserver || !element) return;

    // Limpiar observador anterior si existe
    if (itemResizeObservers.has(index)) {
      itemResizeObservers.get(index).disconnect();
    }

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const height = entry.contentRect.height;
        if (height > 0 && height < 500) {
          const oldHeight = itemHeights.value.get(index);

          // Solo actualizar si hay cambio significativo
          if (!oldHeight || Math.abs(oldHeight - height) > 3) {
            itemHeights.value.set(index, height);
            updateAverageHeight();
          }
        }
      }
    });

    observer.observe(element);
    itemResizeObservers.set(index, observer);
  };

  // Observar elemento con IntersectionObserver (llamado desde componentes)
  const observeElement = (element, index) => {
    if (!USE_INTERSECTION || !intersectionObserver || !element) return;

    element.dataset.virtualIndex = index.toString();
    intersectionObserver.observe(element);

    // También observar altura si no está en cache
    if (!itemHeights.value.has(index)) {
      nextTick(() => {
        observeItemHeight(element, index);
      });
    }
  };

  // Dejar de observar elemento
  const unobserveElement = element => {
    if (intersectionObserver && element) {
      intersectionObserver.unobserve(element);
    }

    const index = parseInt(element?.dataset?.virtualIndex);
    if (!isNaN(index) && itemResizeObservers.has(index)) {
      itemResizeObservers.get(index).disconnect();
      itemResizeObservers.delete(index);
    }
  };

  // Actualizar altura promedio basado en cache
  const updateAverageHeight = () => {
    if (itemHeights.value.size < 2) return;

    const heights = Array.from(itemHeights.value.values());
    const average = heights.reduce((a, b) => a + b, 0) / heights.length;

    // Validar altura promedio
    if (average < ROW_HEIGHT_ESTIMATE * 0.3 || average > ROW_HEIGHT_ESTIMATE * 3) {
      return; // Ignorar valores extremos
    }

    // Solo actualizar si la diferencia es significativa
    const heightDifference = Math.abs(average - measuredRowHeight.value);
    if (heightDifference > 5) {
      if (!hasStableMeasurement.value) {
        measuredRowHeight.value = Math.round(average);
        hasStableMeasurement.value = true;
      } else {
        // Actualizar solo si es menor (evitar crecimiento errático) o diferencia muy grande
        if (average <= measuredRowHeight.value || heightDifference > 15) {
          measuredRowHeight.value = Math.round(average);
        }
      }
    }
  };

  // Inicializar IntersectionObserver
  const initIntersectionObserver = () => {
    if (!USE_INTERSECTION || !containerRef.value || intersectionObserver) return;

    try {
      intersectionObserver = new IntersectionObserver(handleIntersections, {
        root: containerRef.value,
        rootMargin: `${OVERSCAN * measuredRowHeight.value}px`,
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 1.0],
      });
    } catch (error) {
      console.warn('Error inicializando IntersectionObserver:', error);
      // Continuar sin IntersectionObserver
    }
  };

  // Inicializar observadores
  const initObservers = () => {
    if (!containerRef.value) return;

    // ResizeObserver para cambios de tamaño del contenedor
    if (window.ResizeObserver) {
      let lastContainerHeight = containerHeight.value;
      resizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          const newHeight = entry.contentRect.height;
          // Re-inicializar IntersectionObserver si cambió el tamaño significativamente
          if (Math.abs(newHeight - lastContainerHeight) > 50) {
            cleanupIntersectionObserver();
            nextTick(() => initIntersectionObserver());
          }
          containerHeight.value = newHeight;
          lastContainerHeight = newHeight;
        }
      });
      resizeObserver.observe(containerRef.value);
    }

    // Inicializar IntersectionObserver
    initIntersectionObserver();

    // Medir altura cuando cambien los items
    watch(
      () => items.value.length,
      (newLen, oldLen) => {
        if (shouldVirtualize.value) {
          // Resetear medición estable cuando cambian los items significativamente
          if (Math.abs(newLen - oldLen) > 10) {
            hasStableMeasurement.value = false;
            visibleIndices.value.clear();
            validatedRange.value = null;

            // Limpiar cache de alturas de items que ya no existen
            if (newLen < oldLen) {
              itemHeights.value.forEach((height, index) => {
                if (index >= newLen) {
                  itemHeights.value.delete(index);
                  if (itemResizeObservers.has(index)) {
                    itemResizeObservers.get(index).disconnect();
                    itemResizeObservers.delete(index);
                  }
                }
              });
            }
          }

          nextTick(() => {
            measureRowHeight();
          });
        }
      },
      { immediate: false }
    );
  };

  // Limpiar IntersectionObserver
  const cleanupIntersectionObserver = () => {
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    visibleIndices.value.clear();
    validatedRange.value = null;
  };

  // Scroll a un índice específico
  const scrollToIndex = (index, align = 'start') => {
    if (!containerRef.value || !shouldVirtualize.value) return;

    const targetScrollTop = index * measuredRowHeight.value;
    const maxScroll = items.value.length * measuredRowHeight.value - containerHeight.value;

    let finalScrollTop = Math.max(0, Math.min(targetScrollTop, maxScroll));

    if (align === 'center') {
      finalScrollTop = Math.max(0, finalScrollTop - containerHeight.value / 2);
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

    cleanupIntersectionObserver();

    // Limpiar ResizeObservers de items
    itemResizeObservers.forEach(observer => observer.disconnect());
    itemResizeObservers.clear();

    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
      scrollTimeout = null;
    }
  };

  // Observar automáticamente elementos que se renderizan
  const autoObserveElements = () => {
    if (!USE_INTERSECTION || !intersectionObserver || !containerRef.value) return;

    nextTick(() => {
      const container = containerRef.value;
      if (!container) return;

      // Buscar todos los elementos con data-virtual-index
      const elements = container.querySelectorAll('[data-virtual-index]');
      elements.forEach(element => {
        const index = parseInt(element.dataset.virtualIndex);
        if (!isNaN(index) && index >= 0 && index < items.value.length) {
          // Solo observar si no está ya siendo observado
          if (!visibleIndices.value.has(index)) {
            observeElement(element, index);
          }
        }
      });
    });
  };

  // Watch para observar automáticamente cuando cambian los items visibles
  watch(
    visibleItems,
    () => {
      if (USE_INTERSECTION) {
        autoObserveElements();
      }
    },
    { flush: 'post' }
  );

  // Inicialización
  onMounted(() => {
    if (containerRef.value) {
      containerHeight.value = containerRef.value.clientHeight;
      initObservers();
      measureRowHeight();

      // Observar elementos iniciales después de que se rendericen
      if (USE_INTERSECTION) {
        nextTick(() => {
          autoObserveElements();
        });
      }
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
    observeElement, // Nuevo: para observar elementos desde componentes
    unobserveElement, // Nuevo: para dejar de observar elementos
    cleanup,

    // Internos (para debugging/testing)
    _validatedRange: validatedRange,
    _visibleIndices: visibleIndices,
    _itemHeights: itemHeights,
  };
}
