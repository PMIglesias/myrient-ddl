/**
 * Gestión de ventanas de la aplicación
 */

const { BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { logger } = require('./utils');

const log = logger.child('Window');

let mainWindow = null;

/**
 * Crea la ventana principal de la aplicación
 */
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
            sandbox: true
        }
    });

    // Configurar headers de seguridad (CSP)
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
                    "worker-src 'none';"
                ]
            }
        });
    });

    // Cargar contenido
    const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];

    if (VITE_DEV_SERVER_URL) {
        // Modo desarrollo
        log.info('Cargando desde servidor de desarrollo:', VITE_DEV_SERVER_URL);
        mainWindow.loadURL(VITE_DEV_SERVER_URL);
    } else {
        // Modo producción
        const indexPath = path.join(app.getAppPath(), 'dist', 'index.html');

        log.info('=== CARGA DE APLICACIÓN ===');
        log.info('__dirname:', __dirname);
        log.info('Buscando en:', indexPath);
        log.info('Existe:', fs.existsSync(indexPath));

        if (!fs.existsSync(indexPath)) {
            // Buscar en rutas alternativas
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

            // Si no se encontró en ninguna ruta
            if (!mainWindow.webContents.getURL()) {
                const errorMsg = `No se encontró index.html\nBuscado en: ${indexPath}`;
                log.error(errorMsg);
                mainWindow.webContents.loadURL(
                    `data:text/html;charset=utf-8,<h1>${errorMsg}</h1>`
                );
            }
        } else {
            mainWindow.loadFile(indexPath);
        }
    }

    // DevTools solo en desarrollo
    if (!app.isPackaged) {
        mainWindow.webContents.openDevTools();
    }

    // Sin menú de aplicación
    Menu.setApplicationMenu(null);

    // Eventos de ventana
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    log.info('Ventana principal creada');
    return mainWindow;
}

/**
 * Obtiene la ventana principal
 */
function getMainWindow() {
    return mainWindow;
}

/**
 * Verifica si la ventana principal existe y no está destruida
 */
function isMainWindowValid() {
    return mainWindow && !mainWindow.isDestroyed();
}

module.exports = {
    createMainWindow,
    getMainWindow,
    isMainWindowValid
};
