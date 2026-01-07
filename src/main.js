/**
 * Punto de entrada del Frontend Vue
 * 
 * Este archivo inicializa la aplicación Vue y la monta en el DOM.
 * NO confundir con electron/main.js que es el proceso principal de Electron.
 */

import { createApp } from 'vue';
import App from './App.vue';

// Importar estilos globales (el archivo está en src/)
import './style.css';

// Crear e inicializar la aplicación Vue
const app = createApp(App);

// Configurar manejo de errores global
app.config.errorHandler = (err, instance, info) => {
    console.error('[Vue Error]', err);
    console.error('Componente:', instance);
    console.error('Info:', info);
};

// Advertencias en desarrollo
app.config.warnHandler = (msg, instance, trace) => {
    console.warn('[Vue Warning]', msg);
    if (trace) console.warn('Trace:', trace);
};

// Montar la aplicación
app.mount('#app');

console.log('[Vue] Aplicación montada correctamente');
