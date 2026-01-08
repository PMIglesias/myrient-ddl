/**
 * useDownloadState - Estado global compartido para descargas
 * 
 * Singleton que mantiene el estado compartido entre todos los composables de descargas
 */

import { ref } from 'vue';

// =====================
// ESTADO GLOBAL (SINGLETON)
// =====================

export const downloads = ref({});
export const downloadQueue = ref([]);
export const speedStats = ref(new Map());
export const pendingConfirmations = ref([]);
export const showingDownloads = ref(false);
export const selectedDownloads = ref(new Set());
export const selectedHistoryDownloads = ref(new Set());
export const currentDownloadIndex = ref(0);

// Control de race conditions - Sistema Mutex mejorado
export const startingDownloads = new Set();

// Mutex para procesamiento de cola (evita race conditions)
export const queueMutex = {
    isProcessing: false,    // ¿Está procesando actualmente?
    hasPendingWork: false,  // ¿Hay trabajo pendiente mientras procesa?
    debounceTimeout: null   // Timeout para agrupar llamadas rápidas
};

// =====================
// GESTIÓN DE TIMEOUTS SEGUROS
// =====================

const activeTimeouts = new Set();
let isMounted = false;

export const timeoutManager = {
    get isMounted() {
        return isMounted;
    },
    
    set isMounted(value) {
        isMounted = value;
    },
    
    safeSetTimeout(callback, delay) {
        const timeoutId = setTimeout(() => {
            activeTimeouts.delete(timeoutId);
            if (isMounted) callback();
        }, delay);
        activeTimeouts.add(timeoutId);
        return timeoutId;
    },
    
    safeClearTimeout(timeoutId) {
        if (timeoutId) {
            clearTimeout(timeoutId);
            activeTimeouts.delete(timeoutId);
        }
    },
    
    clearAllTimeouts() {
        activeTimeouts.forEach(id => clearTimeout(id));
        activeTimeouts.clear();
    }
};

// =====================
// CONFIGURACIÓN DE LÍMITES DE MEMORIA
// =====================

// Valores por defecto (se pueden sobrescribir desde useSettings)
export const MEMORY_LIMITS = {
    MAX_HISTORY_IN_MEMORY: 100,        // Máximo total de descargas en memoria
    MAX_COMPLETED_IN_MEMORY: 50,       // Máximo de descargas completadas a mantener
    MAX_FAILED_IN_MEMORY: 20           // Máximo de descargas fallidas/canceladas a mantener
};

// =====================
// EXPORT DEFAULT
// =====================

export default {
    downloads,
    downloadQueue,
    speedStats,
    pendingConfirmations,
    showingDownloads,
    selectedDownloads,
    selectedHistoryDownloads,
    currentDownloadIndex,
    startingDownloads,
    queueMutex,
    timeoutManager,
    MEMORY_LIMITS
};
