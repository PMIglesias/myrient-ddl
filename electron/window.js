// Módulo de gestión de ventanas de la aplicación Electron
// Maneja la creación, configuración y ciclo de vida de la ventana principal

const { BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { logger } = require('./utils');

const log = logger.child('Window');

let mainWindow = null;

// Crea y configura la ventana principal de la aplicación
// Configura las opciones de seguridad, CSP, y carga el contenido apropiado según el modo
// Retorna la instancia de BrowserWindow creada
function createMainWindow() {
  log.info('Creando ventana principal...');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Configura Content Security Policy (CSP) para restringir recursos permitidos
  // Previene cargar scripts, estilos o recursos de orígenes no autorizados
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
            "script-src 'self'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: https://myrient.erista.me; " +
            "connect-src 'self' https://myrient.erista.me; " +
            "font-src 'self' data:; " +
            "worker-src 'none';",
        ],
      },
    });
  });

  // Determina si cargar desde servidor de desarrollo o archivo local
  const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

  if (VITE_DEV_SERVER_URL) {
    // Modo desarrollo: conectar al servidor de desarrollo de Vite para hot-reload
    log.info('Cargando desde servidor de desarrollo:', VITE_DEV_SERVER_URL);
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // Modo producción: cargar desde el archivo index.html compilado
    const indexPath = path.join(app.getAppPath(), 'dist', 'index.html');

    log.info('=== CARGA DE APLICACIÓN ===');
    log.info('__dirname:', __dirname);
    log.info('Buscando en:', indexPath);
    log.info('Existe:', fs.existsSync(indexPath));

    if (!fs.existsSync(indexPath)) {
      // Si el archivo no está en la ruta esperada, buscar en ubicaciones alternativas
      // Esto es necesario porque la estructura puede variar entre desarrollo y empaquetado
      const alternatives = [
        path.join(app.getAppPath(), 'dist', 'index.html'),
        path.join(process.resourcesPath, 'dist', 'index.html'),
        path.join(__dirname, '../dist/index.html'),
      ];

      for (const altPath of alternatives) {
        log.debug('Intento alternativo:', altPath, 'Existe:', fs.existsSync(altPath));
        if (fs.existsSync(altPath)) {
          log.info('Usando:', altPath);
          mainWindow.loadFile(altPath);
          break;
        }
      }

      // Si no se encontró el archivo en ninguna ubicación, mostrar mensaje de error
      if (!mainWindow.webContents.getURL()) {
        const errorMsg = `No se encontró index.html\nBuscado en: ${indexPath}`;
        log.error(errorMsg);
        mainWindow.webContents.loadURL(`data:text/html;charset=utf-8,<h1>${errorMsg}</h1>`);
      }
    } else {
      mainWindow.loadFile(indexPath);
    }
  }

  // Abrir DevTools automáticamente solo en modo desarrollo para facilitar debugging
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  // Redirigir mensajes de la consola de Chromium al logger de la aplicación
  // Esto permite ver errores de JS y logs nativos en la consola interna de la app
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = {
      0: 'debug', // info/log
      1: 'info',  // info
      2: 'warn',  // warning
      3: 'error'  // error
    };
    const levelName = levels[level] || 'info';
    
    // Evitar bucles infinitos filtrando mensajes que ya vienen del logger IPC
    if (message.includes('backend-log')) return;

    const consoleLog = logger.child('Chromium');
    consoleLog[levelName](`${message} (${path.basename(sourceId)}:${line})`);
  });

  // Deshabilitar el menú de aplicación para una interfaz más limpia
  Menu.setApplicationMenu(null);

  // Limpiar referencia cuando la ventana se cierre
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  log.info('Ventana principal creada');
  return mainWindow;
}

// Retorna la instancia de la ventana principal si existe
// Retorna null si no hay ventana creada
function getMainWindow() {
  return mainWindow;
}

// Verifica si la ventana principal existe y está disponible
// Útil para evitar errores al intentar usar una ventana destruida
function isMainWindowValid() {
  return mainWindow && !mainWindow.isDestroyed();
}

module.exports = {
  createMainWindow,
  getMainWindow,
  isMainWindowValid,
};
