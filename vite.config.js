import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

/**
 * Configuración de Vite para Electron + Vue
 * 
 * ESTRUCTURA:
 * - Frontend Vue: src/ (App.vue, components/, composables/, services/)
 * - Backend Electron: electron/ (main.js, preload.js)
 * - Los archivos de backend (database.js, downloadManager.js, etc.) están en la raíz
 */

export default defineConfig({
    plugins: [
        vue(),
        electron([
            {
                // Proceso principal de Electron
                entry: 'electron/main.js',
                vite: {
                    build: {
                        outDir: 'dist-electron',
                        rollupOptions: {
                            external: ['better-sqlite3', 'electron']
                        }
                    }
                }
            },
            {
                // Script de preload
                entry: 'electron/preload.js',
                onstart(options) {
                    // Recargar el renderer cuando cambie el preload
                    options.reload();
                }
            }
        ]),
        renderer()
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src')
        }
    },
    build: {
        // Asegurar compatibilidad con Electron
        target: 'esnext',
        minify: 'esbuild'
    },
    server: {
        // Puerto de desarrollo
        port: 5173,
        strictPort: true
    }
});
