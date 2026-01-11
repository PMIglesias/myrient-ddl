/**
 * useFilters - Composable para filtros avanzados
 *
 * Maneja:
 * - Filtros por texto (incluir/excluir)
 * - Filtros por etiquetas (regiones, idiomas, versiones)
 * - Presets de filtros guardados
 * - Persistencia de presets
 */

import { ref, computed, watch } from 'vue';
import { readConfigFile, writeConfigFile } from '../services/api';

// Estado global (singleton)
const showAdvancedFilters = ref(false);
const advancedFilters = ref({
  includeText: [],
  excludeText: [],
  includeTags: {
    regions: [],
    languages: [],
    versions: [],
    other: [],
  },
  excludeTags: {
    regions: [],
    languages: [],
    versions: [],
    other: [],
  },
});

// Presets
const filterPresets = ref({});
const currentFilterPreset = ref('');

// Inputs temporales para formularios
const tempIncludeText = ref('');
const tempExcludeText = ref('');

// Patrones para clasificación de etiquetas
const TAG_PATTERNS = {
  regions: [
    'USA',
    'Europe',
    'Japan',
    'World',
    'Asia',
    'Australia',
    'Brazil',
    'Canada',
    'China',
    'France',
    'Germany',
    'Italy',
    'Korea',
    'Netherlands',
    'Spain',
    'Sweden',
    'UK',
  ],
  languages: [
    'En',
    'Es',
    'Fr',
    'De',
    'It',
    'Ja',
    'Ko',
    'Pt',
    'Zh',
    'Nl',
    'Sv',
    'No',
    'Da',
    'Fi',
    'Pl',
    'Ru',
  ],
  versions: ['Rev', 'v1', 'v2', 'Beta', 'Proto', 'Demo', 'Sample', 'Promo', 'Alt', 'Unl'],
};

/**
 * Composable de filtros
 */
export function useFilters() {
  // =====================
  // HELPERS
  // =====================

  /**
   * Extrae etiquetas de un título
   * @param {string} title - Título del archivo
   * @returns {string[]} Array de etiquetas
   */
  const extractTags = title => {
    const tagMatch = title.match(/\(([^)]+)\)/g);
    if (!tagMatch) return [];
    return tagMatch.map(t => t.replace(/[()]/g, '').trim());
  };

  /**
   * Clasifica una etiqueta en su categoría
   * @param {string} tag - Etiqueta a clasificar
   * @returns {string} Categoría ('regions', 'languages', 'versions', 'other')
   */
  const classifyTag = tag => {
    if (TAG_PATTERNS.regions.some(r => tag.includes(r))) return 'regions';
    if (TAG_PATTERNS.languages.some(l => tag === l || tag.startsWith(l + ','))) return 'languages';
    if (TAG_PATTERNS.versions.some(v => tag.includes(v))) return 'versions';
    return 'other';
  };

  // =====================
  // COMPUTED
  // =====================

  /**
   * Indica si hay filtros activos
   */
  const hasActiveFilters = computed(() => {
    const f = advancedFilters.value;
    return (
      f.includeText.length > 0 ||
      f.excludeText.length > 0 ||
      f.includeTags.regions.length > 0 ||
      f.includeTags.languages.length > 0 ||
      f.includeTags.versions.length > 0 ||
      f.includeTags.other.length > 0 ||
      f.excludeTags.regions.length > 0 ||
      f.excludeTags.languages.length > 0 ||
      f.excludeTags.versions.length > 0 ||
      f.excludeTags.other.length > 0
    );
  });

  /**
   * Cuenta de filtros activos
   */
  const activeFilterCount = computed(() => {
    const f = advancedFilters.value;
    return (
      f.includeText.length +
      f.excludeText.length +
      f.includeTags.regions.length +
      f.includeTags.languages.length +
      f.includeTags.versions.length +
      f.includeTags.other.length +
      f.excludeTags.regions.length +
      f.excludeTags.languages.length +
      f.excludeTags.versions.length +
      f.excludeTags.other.length
    );
  });

  // =====================
  // FILTRADO
  // =====================

  /**
   * Aplica filtros a un array de resultados
   * @param {Array} items - Items a filtrar
   * @returns {Array} Items filtrados
   */
  const applyFilters = items => {
    if (!hasActiveFilters.value) return items;

    return items.filter(item => {
      const title = item.title.toLowerCase();
      const tags = extractTags(item.title);

      // 1. Filtros de texto (inclusión)
      if (advancedFilters.value.includeText.length > 0) {
        const includeMatch = advancedFilters.value.includeText.some(text =>
          title.includes(text.toLowerCase())
        );
        if (!includeMatch) return false;
      }

      // 2. Filtros de texto (exclusión)
      if (advancedFilters.value.excludeText.length > 0) {
        const excludeMatch = advancedFilters.value.excludeText.some(text =>
          title.includes(text.toLowerCase())
        );
        if (excludeMatch) return false;
      }

      // 3. Filtros de etiquetas (inclusión)
      const includeTagsActive =
        advancedFilters.value.includeTags.regions.length > 0 ||
        advancedFilters.value.includeTags.languages.length > 0 ||
        advancedFilters.value.includeTags.versions.length > 0 ||
        advancedFilters.value.includeTags.other.length > 0;

      if (includeTagsActive) {
        const hasRequiredTag = tags.some(tag => {
          return (
            advancedFilters.value.includeTags.regions.includes(tag) ||
            advancedFilters.value.includeTags.languages.includes(tag) ||
            advancedFilters.value.includeTags.versions.includes(tag) ||
            advancedFilters.value.includeTags.other.includes(tag)
          );
        });
        if (!hasRequiredTag) return false;
      }

      // 4. Filtros de etiquetas (exclusión)
      const hasExcludedTag = tags.some(tag => {
        return (
          advancedFilters.value.excludeTags.regions.includes(tag) ||
          advancedFilters.value.excludeTags.languages.includes(tag) ||
          advancedFilters.value.excludeTags.versions.includes(tag) ||
          advancedFilters.value.excludeTags.other.includes(tag)
        );
      });
      if (hasExcludedTag) return false;

      return true;
    });
  };

  /**
   * Obtiene las etiquetas disponibles de un conjunto de items
   * @param {Array} items - Items de donde extraer etiquetas
   * @returns {Object} Etiquetas agrupadas por categoría
   */
  const getAvailableTags = items => {
    const tags = {
      regions: new Set(),
      languages: new Set(),
      versions: new Set(),
      other: new Set(),
    };

    items.forEach(item => {
      const itemTags = extractTags(item.title);
      itemTags.forEach(tag => {
        const category = classifyTag(tag);
        tags[category].add(tag);
      });
    });

    return {
      regions: Array.from(tags.regions).sort(),
      languages: Array.from(tags.languages).sort(),
      versions: Array.from(tags.versions).sort(),
      other: Array.from(tags.other).sort(),
    };
  };

  // =====================
  // GESTIÓN DE TEXTO
  // =====================

  /**
   * Añade texto a la lista de inclusión
   */
  const addIncludeText = () => {
    const text = tempIncludeText.value.trim();
    if (text && !advancedFilters.value.includeText.includes(text)) {
      advancedFilters.value.includeText.push(text);
    }
    tempIncludeText.value = '';
  };

  /**
   * Quita texto de la lista de inclusión
   * @param {number} index - Índice a quitar
   */
  const removeIncludeText = index => {
    advancedFilters.value.includeText.splice(index, 1);
  };

  /**
   * Añade texto a la lista de exclusión
   */
  const addExcludeText = () => {
    const text = tempExcludeText.value.trim();
    if (text && !advancedFilters.value.excludeText.includes(text)) {
      advancedFilters.value.excludeText.push(text);
    }
    tempExcludeText.value = '';
  };

  /**
   * Quita texto de la lista de exclusión
   * @param {number} index - Índice a quitar
   */
  const removeExcludeText = index => {
    advancedFilters.value.excludeText.splice(index, 1);
  };

  // =====================
  // GESTIÓN DE ETIQUETAS
  // =====================

  /**
   * Selecciona todas las etiquetas de una categoría
   * @param {string} category - Categoría (regions, languages, etc.)
   * @param {string} type - Tipo ('include' o 'exclude')
   * @param {string[]} availableTags - Tags disponibles en esa categoría
   */
  const selectAllTags = (category, type, availableTags) => {
    const target =
      type === 'include' ? advancedFilters.value.includeTags : advancedFilters.value.excludeTags;

    const opposite =
      type === 'include' ? advancedFilters.value.excludeTags : advancedFilters.value.includeTags;

    // Seleccionar todos los que no estén en el opuesto
    target[category] = availableTags.filter(tag => !opposite[category].includes(tag));
  };

  /**
   * Deselecciona todas las etiquetas de una categoría
   * @param {string} category - Categoría
   * @param {string} type - Tipo ('include' o 'exclude')
   */
  const clearTagCategory = (category, type) => {
    const target =
      type === 'include' ? advancedFilters.value.includeTags : advancedFilters.value.excludeTags;

    target[category] = [];
  };

  // =====================
  // PRESETS
  // =====================

  /**
   * Carga presets desde archivo
   */
  const loadFilterPresets = async () => {
    try {
      const result = await readConfigFile('filter-presets.json');
      if (result.success && result.data) {
        filterPresets.value = result.data;
      }
    } catch (error) {
      console.error('[useFilters] Error cargando presets:', error);
    }
  };

  /**
   * Guarda presets en archivo
   */
  const saveFilterPresets = async () => {
    try {
      await writeConfigFile('filter-presets.json', filterPresets.value);
    } catch (error) {
      console.error('[useFilters] Error guardando presets:', error);
    }
  };

  /**
   * Guarda el preset actual
   */
  const savePreset = () => {
    const name = currentFilterPreset.value.trim();
    if (!name) {
      console.warn('[useFilters] Nombre de preset vacío');
      return;
    }

    filterPresets.value[name] = JSON.parse(JSON.stringify(advancedFilters.value));
    saveFilterPresets();
    console.log('[useFilters] Preset guardado:', name);
  };

  /**
   * Carga un preset guardado
   */
  const loadPreset = () => {
    const name = currentFilterPreset.value;
    if (!name || !filterPresets.value[name]) return;

    advancedFilters.value = JSON.parse(JSON.stringify(filterPresets.value[name]));
    console.log('[useFilters] Preset cargado:', name);
  };

  /**
   * Elimina un preset
   * @param {string} name - Nombre del preset
   */
  const deletePreset = name => {
    if (filterPresets.value[name]) {
      delete filterPresets.value[name];
      saveFilterPresets();
      if (currentFilterPreset.value === name) {
        currentFilterPreset.value = '';
      }
    }
  };

  // =====================
  // LIMPIEZA
  // =====================

  /**
   * Limpia todos los filtros
   */
  const clearAllFilters = () => {
    advancedFilters.value = {
      includeText: [],
      excludeText: [],
      includeTags: {
        regions: [],
        languages: [],
        versions: [],
        other: [],
      },
      excludeTags: {
        regions: [],
        languages: [],
        versions: [],
        other: [],
      },
    };
    currentFilterPreset.value = '';
  };

  /**
   * Toggle panel de filtros
   */
  const toggleFiltersPanel = () => {
    showAdvancedFilters.value = !showAdvancedFilters.value;
  };

  // =====================
  // RETURN
  // =====================

  return {
    // Estado reactivo
    showAdvancedFilters,
    advancedFilters,
    filterPresets,
    currentFilterPreset,
    tempIncludeText,
    tempExcludeText,

    // Computed
    hasActiveFilters,
    activeFilterCount,

    // Helpers
    extractTags,
    classifyTag,

    // Filtrado
    applyFilters,
    getAvailableTags,

    // Gestión de texto
    addIncludeText,
    removeIncludeText,
    addExcludeText,
    removeExcludeText,

    // Gestión de etiquetas
    selectAllTags,
    clearTagCategory,

    // Presets
    loadFilterPresets,
    saveFilterPresets,
    savePreset,
    loadPreset,
    deletePreset,

    // Limpieza
    clearAllFilters,
    toggleFiltersPanel,
  };
}

export default useFilters;
