import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

// Configuración de Vite para la aplicación Electron + Vue
// Define los plugins, aliases y opciones de build para el bundling de la aplicación
// Frontend: src/ contiene los componentes Vue y composables
// Backend: electron/ contiene el proceso principal y scripts de preload

export default defineConfig({
  plugins: [
    vue(),
    electron([
      {
        // Proceso principal de Electron que maneja la lógica de backend
        entry: 'electron/main.js',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // Excluir dependencias nativas del bundling para evitar problemas de compatibilidad
              external: ['better-sqlite3', 'electron'],
            },
          },
        },
      },
      {
        // Script de preload que actúa como bridge seguro entre el proceso main y renderer
        entry: 'electron/preload.js',
        onstart(options) {
          // Recargar automáticamente la ventana cuando el preload cambie durante desarrollo
          options.reload();
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      // Alias '@' apunta al directorio src/ para imports más limpios
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    // Usar ESnext para máxima compatibilidad con características modernas de JavaScript
    target: 'esnext',
    // Minificar con esbuild para mejor rendimiento durante el build
    minify: 'esbuild',
  },
  server: {
    // Puerto del servidor de desarrollo de Vite
    port: 5173,
    // No permitir usar otro puerto si este está ocupado
    strictPort: true,
  },
});
