import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
// Main-Process entry file of the Electron App.
// https://vitejs.dev/config/
// Notify the Renderer-Process to reload when the Preload-Scripts build is complete
export default defineConfig({
  plugins: [
    vue(),
    electron([
      { entry: 'electron/main.js' },
      { entry: 'electron/preload.js', onstart(options) { options.reload() } }
    ]),
    renderer(),
  ],
})
