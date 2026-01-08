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

// Configuración de límites de memoria para historial
const maxHistoryInMemory = ref(100);
const maxCompletedInMemory = ref(50);
const maxFailedInMemory = ref(20);

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
            }
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
                isDarkMode: isDarkMode.value
            });
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
     * Inicializa la configuración
     */
    const initSettings = async () => {
        await Promise.all([
            loadDownloadSettings(),
            loadUIPreferences()
        ]);
        updateThemeClass();
    };

    // =====================
    // WATCHERS AUTOMÁTICOS
    // =====================

    // Auto-guardar cuando cambian valores críticos
    watch([preserveStructure, showNotifications, maxParallelDownloads, searchLimit, autoResumeDownloads, maxHistoryInMemory, maxCompletedInMemory, maxFailedInMemory], () => {
        saveDownloadSettings();
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
        updateThemeClass
    };
}

// Export por defecto para uso simple
export default useSettings;
