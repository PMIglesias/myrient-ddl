/**
 * useSettings - Composable para gestión de configuración
 * 
 * Maneja:
 * - Configuración de descargas (ruta, estructura, paralelas)
 * - Preferencias de UI (tema, notificaciones)
 * - Persistencia en archivos JSON
 */

import { ref, watch } from 'vue';
import { readConfigFile, writeConfigFile, selectFolder } from '../services/api';

// Estado global (singleton) para compartir entre componentes
const downloadPath = ref('');
const preserveStructure = ref(true);
const showNotifications = ref(true);
const maxParallelDownloads = ref(3);
const searchLimit = ref(500);
const isDarkMode = ref(true);
const autoResumeDownloads = ref(true); // Por defecto true para mantener comportamiento actual
const primaryColor = ref('green'); // Color primario por defecto: verde

// Configuración de límites de memoria para historial
const maxHistoryInMemory = ref(100);
const maxCompletedInMemory = ref(50);
const maxFailedInMemory = ref(20);

// Configuración de UI
const showChunkProgress = ref(true); // Mostrar indicador de chunks por defecto

// Colores primarios disponibles
export const PRIMARY_COLORS = {
    green: { name: 'Verde', value: '#4CAF50', hover: '#45a049' },
    blue: { name: 'Azul', value: '#2196F3', hover: '#1976D2' },
    red: { name: 'Rojo', value: '#f44336', hover: '#d32f2f' },
    purple: { name: 'Púrpura', value: '#9c27b0', hover: '#7b1fa2' },
    orange: { name: 'Naranja', value: '#ff9800', hover: '#f57c00' },
    cyan: { name: 'Cian', value: '#00bcd4', hover: '#0097a7' }
};

// Flag para evitar guardar durante la carga inicial
let isLoading = false;

/**
 * Composable de configuración
 */
export function useSettings() {
    
    // =====================
    // CARGA DE CONFIGURACIÓN
    // =====================
    
    /**
     * Carga la configuración de descargas desde archivo
     */
    const loadDownloadSettings = async () => {
        isLoading = true;
        try {
            const result = await readConfigFile('download-settings.json');
            if (result.success && result.data) {
                downloadPath.value = result.data.downloadPath || '';
                preserveStructure.value = result.data.preserveStructure !== false;
                showNotifications.value = result.data.showNotifications !== false;
                maxParallelDownloads.value = result.data.maxParallelDownloads || 3;
                searchLimit.value = result.data.searchLimit || 500;
                autoResumeDownloads.value = result.data.autoResumeDownloads !== false; // Por defecto true
                maxHistoryInMemory.value = result.data.maxHistoryInMemory || 100;
                maxCompletedInMemory.value = result.data.maxCompletedInMemory || 50;
                maxFailedInMemory.value = result.data.maxFailedInMemory || 20;
                showChunkProgress.value = result.data.showChunkProgress !== false; // Por defecto true
            }
        } catch (error) {
            console.error('[useSettings] Error cargando configuración:', error);
        } finally {
            isLoading = false;
        }
    };

    /**
     * Carga preferencias de UI
     */
    const loadUIPreferences = async () => {
        try {
            const result = await readConfigFile('ui-preferences.json');
            if (result.success && result.data) {
                isDarkMode.value = result.data.isDarkMode !== false;
                if (result.data.primaryColor && PRIMARY_COLORS[result.data.primaryColor]) {
                    primaryColor.value = result.data.primaryColor;
                }
                // showChunkProgress puede estar en ui-preferences o en download-settings
                if (result.data.showChunkProgress !== undefined) {
                    showChunkProgress.value = result.data.showChunkProgress !== false;
                }
            }
            updatePrimaryColor();
        } catch (error) {
            console.error('[useSettings] Error cargando preferencias UI:', error);
        }
    };

    // =====================
    // GUARDADO DE CONFIGURACIÓN
    // =====================

    /**
     * Guarda la configuración de descargas
     */
    const saveDownloadSettings = async () => {
        if (isLoading) return; // No guardar durante carga inicial
        
        try {
            await writeConfigFile('download-settings.json', {
                downloadPath: downloadPath.value,
                preserveStructure: preserveStructure.value,
                showNotifications: showNotifications.value,
                maxParallelDownloads: maxParallelDownloads.value,
                searchLimit: searchLimit.value,
                autoResumeDownloads: autoResumeDownloads.value,
                maxHistoryInMemory: maxHistoryInMemory.value,
                maxCompletedInMemory: maxCompletedInMemory.value,
                maxFailedInMemory: maxFailedInMemory.value
                // showChunkProgress se guarda en ui-preferences, no en download-settings
            });
        } catch (error) {
            console.error('[useSettings] Error guardando configuración:', error);
        }
    };

    /**
     * Guarda preferencias de UI
     */
    const saveUIPreferences = async () => {
        try {
            await writeConfigFile('ui-preferences.json', {
                isDarkMode: isDarkMode.value,
                primaryColor: primaryColor.value,
                showChunkProgress: showChunkProgress.value
            });
            updatePrimaryColor();
        } catch (error) {
            console.error('[useSettings] Error guardando preferencias UI:', error);
        }
    };

    // =====================
    // ACCIONES
    // =====================

    /**
     * Abre diálogo para seleccionar carpeta de descargas
     */
    const selectDownloadFolder = async () => {
        try {
            const result = await selectFolder();
            if (result.success && result.path) {
                downloadPath.value = result.path;
                await saveDownloadSettings();
            }
        } catch (error) {
            console.error('[useSettings] Error seleccionando carpeta:', error);
        }
    };

    /**
     * Alterna entre modo oscuro y claro
     */
    const toggleTheme = () => {
        isDarkMode.value = !isDarkMode.value;
        updateThemeClass();
        saveUIPreferences();
    };

    /**
     * Actualiza la clase del body según el tema
     */
    const updateThemeClass = () => {
        if (typeof document !== 'undefined') {
            document.body.classList.toggle('light-mode', !isDarkMode.value);
        }
    };

    /**
     * Actualiza el color primario en CSS
     */
    const updatePrimaryColor = () => {
        if (typeof document !== 'undefined' && typeof document.documentElement !== 'undefined') {
            const colorConfig = PRIMARY_COLORS[primaryColor.value] || PRIMARY_COLORS.green;
            document.documentElement.style.setProperty('--primary-color', colorConfig.value);
            document.documentElement.style.setProperty('--primary-color-hover', colorConfig.hover);
        }
    };

    /**
     * Cambia el color primario
     */
    const setPrimaryColor = (color) => {
        if (PRIMARY_COLORS[color]) {
            primaryColor.value = color;
            updatePrimaryColor();
            saveUIPreferences();
        }
    };

    /**
     * Inicializa la configuración
     */
    const initSettings = async () => {
        await Promise.all([
            loadDownloadSettings(),
            loadUIPreferences()
        ]);
        updateThemeClass();
        updatePrimaryColor();
    };

    // =====================
    // WATCHERS AUTOMÁTICOS
    // =====================

    // Auto-guardar cuando cambian valores de descargas
    watch([preserveStructure, showNotifications, maxParallelDownloads, searchLimit, autoResumeDownloads, maxHistoryInMemory, maxCompletedInMemory, maxFailedInMemory], () => {
        saveDownloadSettings();
    }, { deep: false });

    // Auto-guardar cuando cambian preferencias de UI
    watch([isDarkMode, primaryColor, showChunkProgress], () => {
        saveUIPreferences();
    }, { deep: false });

    // =====================
    // RETURN
    // =====================

    return {
        // Estado reactivo
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

        // Métodos de carga
        loadDownloadSettings,
        loadUIPreferences,
        initSettings,

        // Métodos de guardado
        saveDownloadSettings,
        saveUIPreferences,

        // Acciones
        selectDownloadFolder,
        toggleTheme,
        updateThemeClass,
        setPrimaryColor,
        updatePrimaryColor
    };
}

// Export por defecto para uso simple
export default useSettings;
