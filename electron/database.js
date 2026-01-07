/**
 * Módulo de base de datos SQLite
 * Maneja la conexión y queries a la base de datos de Myrient
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, dialog, BrowserWindow } = require('electron');
const config = require('./config');
const { logger, escapeLikeTerm } = require('./utils');

// log con scope
const log = logger.child('Database');

class DatabaseService {
    constructor() {
        this.db = null;
        this.statements = null;
    }

    /**
     * Inicializa la base de datos
     * el returns {Promise<boolean>} da true si se inicializó correctamente la wea de base de datos
     */
    async initialize() {
        const endInit = logger.startOperation('Inicialización de base de datos');
        const { dbPath, compressed7zPath } = config.paths;

        // Si no existe el .db pero existe el .7z, extraer
        if (!fs.existsSync(dbPath) && fs.existsSync(compressed7zPath)) {
            log.info('Base de datos no encontrada, extrayendo desde .7z...');

            try {
                await this._extractDatabase();
                log.info('Extracción completada, verificando archivo...');

                if (!fs.existsSync(dbPath)) {
                    this._showError(
                        'Error de Extracción',
                        `La extracción se completó pero no se encontró myrient.db en: ${dbPath}`
                    );
                    return false;
                }
            } catch (error) {
                log.error('Error durante la extracción:', error);
                this._showError(
                    'Error al Extraer Base de Datos',
                    `No se pudo extraer la base de datos:\n\n${error.message}\n\nAsegúrate de tener 7-Zip instalado.`
                );
                return false;
            }
        }

        // Verificar que existe el archivo
        if (!fs.existsSync(dbPath)) {
            this._showError(
                'Error de Base de Datos',
                `El archivo 'myrient.db' no se encontró en: ${dbPath}`
            );
            return false;
        }

        // Conectar a la base de datos
        try {
            this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
            this._prepareStatements();
            
            endInit(`conectada en ${dbPath}`);
            return true;
        } catch (error) {
            log.error('Error al conectar con la base de datos:', error);
            this._showError(
                'Error al Conectar DB',
                `No se pudo abrir la base de datos: ${error.message}`
            );
            return false;
        }
    }

    /**
     * Prepara los statements reutilizables
     */
    _prepareStatements() {
        log.debug('Preparando statements SQL...');
        
        this.statements = {
            search: this.db.prepare(`
                SELECT id, title, modified_date, type, parent_id
                FROM nodes 
                WHERE title LIKE ? ESCAPE '\\\\'
                ORDER BY title ASC
                LIMIT 500
            `),

            getChildren: this.db.prepare(`
                SELECT id, parent_id, title, size, modified_date, type, url
                FROM nodes 
                WHERE parent_id = ?
                ORDER BY type DESC, title ASC
            `),

            getNodeById: this.db.prepare(
                'SELECT id, parent_id, title, type FROM nodes WHERE id = ?'
            ),

            getNodeWithUrl: this.db.prepare(
                'SELECT url, title FROM nodes WHERE id = ?'
            ),

            getAncestors: this.db.prepare(`
                WITH RECURSIVE ancestors AS (
                    SELECT id, parent_id, title, 0 as depth 
                    FROM nodes 
                    WHERE id = (SELECT parent_id FROM nodes WHERE id = ?)
                    UNION ALL
                    SELECT n.id, n.parent_id, n.title, a.depth + 1 as depth 
                    FROM nodes n
                    INNER JOIN ancestors a ON a.parent_id = n.id
                )
                SELECT title FROM ancestors WHERE id != 1 ORDER BY depth DESC
            `),

            getLatestModifiedDate: this.db.prepare(`
                SELECT modified_date 
                FROM nodes 
                WHERE parent_id = 1 
                AND type = 'Directory'
                AND modified_date IS NOT NULL
                ORDER BY modified_date DESC 
                LIMIT 1
            `)
        };
        
        log.debug('Statements SQL preparados');
    }

    /**
     * Busca nodos por término
     * el param {string} searchTerm es el término de búsqueda
     * y el returns {Object} da resultado de la búsqueda
     */
    search(searchTerm) {
        if (!this.db) {
            return { success: false, error: 'Base de datos no disponible' };
        }

        if (!searchTerm || searchTerm.trim().length < 2) {
            return { success: true, data: [] };
        }

        const cleanSearchTerm = searchTerm.trim();
        if (cleanSearchTerm.length > 100) {
            return { success: false, error: 'Término de búsqueda demasiado largo' };
        }

        try {
            const escapedTerm = escapeLikeTerm(cleanSearchTerm);
            const results = this.statements.search.all(`%${escapedTerm}%`);

            log.debug(`Búsqueda "${cleanSearchTerm}": ${results.length} resultados`);

            const normalized = results.map(item => this._normalizeNode(item));

            return { success: true, data: normalized };
        } catch (error) {
            log.error('Error en la búsqueda:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Obtiene los hijos de un nodo
     * el param {number} parentId nos da el ID del nodo padre
     * el returns {Object} nos muestra el resultado
     */
    getChildren(parentId) {
        if (!this.db) {
            return { success: false, error: 'Base de datos no disponible' };
        }

        try {
            const results = this.statements.getChildren.all(parentId);
            const normalized = results.map(item => ({
                ...item,
                title: item.title.replace(/\/$/, ''),
                type: this._normalizeType(item.type)
            }));

            log.debug(`Hijos de nodo ${parentId}: ${results.length} items`);

            return { success: true, data: normalized };
        } catch (error) {
            log.error('Error al obtener hijos:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Obtiene los ancestros de un nodo (para breadcrumb)
     * el param {number} nodeId nos da ID del nodo
     * El returns {Object} nos da los Resultado
     */
    getAncestors(nodeId) {
        if (!this.db) {
            return { success: false, error: 'Base de datos no disponible' };
        }

        try {
            const ancestors = [];
            let currentId = nodeId;

            // Obtener el nodo actual primero
            const currentNode = this.statements.getNodeById.get(nodeId);
            if (!currentNode) {
                return { success: false, error: 'Nodo no encontrado' };
            }

            ancestors.push({
                id: currentNode.id,
                title: currentNode.title.replace(/\/$/, '')
            });

            currentId = currentNode.parent_id;

            // Recorrer ancestros
            for (let i = 0; i < 100 && currentId; i++) {
                if (currentId === 1) break;

                const node = this.statements.getNodeById.get(currentId);
                if (!node) break;

                ancestors.unshift({
                    id: node.id,
                    title: node.title.replace(/\/$/, '')
                });
                currentId = node.parent_id;
            }

            return { success: true, data: ancestors };
        } catch (error) {
            log.error('Error al obtener ancestros:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Obtiene información de un nodo
     */
    getNodeInfo(nodeId) {
        if (!this.db) {
            return { success: false, error: 'Base de datos no disponible' };
        }

        try {
            const node = this.statements.getNodeById.get(nodeId);
            if (!node) {
                return { success: false, error: 'Nodo no encontrado' };
            }
            return { success: true, data: node };
        } catch (error) {
            log.error('Error al obtener info del nodo:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Obtiene URL y título de un archivo para descarga
     */
    getFileDownloadInfo(nodeId) {
        if (!this.db) return null;

        try {
            return this.statements.getNodeWithUrl.get(nodeId);
        } catch (error) {
            log.error('Error al obtener info de descarga:', error);
            return null;
        }
    }

    /**
     * Obtiene los ancestros de un archivo para construir la ruta
     */
    getFileAncestorPath(nodeId) {
        if (!this.db) return [];

        try {
            return this.statements.getAncestors.all(nodeId);
        } catch (error) {
            log.error('Error al obtener ruta de ancestros:', error);
            return [];
        }
    }

    /**
     * Obtiene la fecha de última actualización de la DB
     */
    getUpdateDate() {
        if (!this.db) {
            return { success: false, error: 'Base de datos no disponible' };
        }

        try {
            const result = this.statements.getLatestModifiedDate.get();
            return {
                success: true,
                data: result?.modified_date || null
            };
        } catch (error) {
            log.error('Error al obtener fecha de actualización:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Cierra la puta conexión a la base de datos
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.statements = null;
            log.info('Conexión a base de datos cerrada');
        }
    }

    /**
     * Normaliza el nodo añadiendo toda la información de ruta
     */
    _normalizeNode(item) {
        const cleanTitle = item.title.replace(/\/$/, '');
        const type = this._normalizeType(item.type);

        let displayTitle = cleanTitle;
        let breadcrumbPath = '';
        let fullPath = '';

        // Construir la ruta completa
        const pathArray = [];
        let currentId = item.id;

        for (let i = 0; i < 100; i++) {
            const node = this.statements.getNodeById.get(currentId);
            if (!node) break;

            const cleanNodeTitle = node.title.replace(/\/$/, '');
            pathArray.unshift(cleanNodeTitle);

            if (node.parent_id === 1 || !node.parent_id) break;
            currentId = node.parent_id;
        }

        if (type === 'folder') {
            displayTitle = pathArray.join(' / ');
            if (pathArray.length > 1) {
                breadcrumbPath = pathArray.slice(0, -1).join('/');
            }
        } else if (type === 'file') {
            if (pathArray.length > 1) {
                fullPath = pathArray.slice(0, -1).join('/');
            }
        }

        return {
            ...item,
            title: cleanTitle,
            displayTitle,
            breadcrumbPath,
            fullPath,
            type
        };
    }

    /**
     * Normaliza el tipo de nodo
     */
    _normalizeType(type) {
        if (type === 'Directory') return 'folder';
        if (type === 'File') return 'file';
        return type.toLowerCase();
    }

    /**
     * Muestra un diálogo de error cuando falla algo
     */
    _showError(title, message) {
        log.error(`${title}: ${message}`);
        dialog.showErrorBox(title, message);
        app.quit();
    }

    /**
     * Esto extrae la base de datos desde el archivo 7z
     */
    async _extractDatabase() {
        return new Promise((resolve, reject) => {
            const { dbPath, compressed7zPath } = config.paths;
            const extractDir = path.dirname(dbPath);

            log.info('Iniciando extracción...');
            log.info('Archivo comprimido:', compressed7zPath);
            log.info('Destino:', extractDir);

            // Crear ventana de progreso
            const progressWindow = new BrowserWindow({
                width: 400,
                height: 150,
                frame: false,
                transparent: false,
                resizable: false,
                alwaysOnTop: true,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true
                }
            });

            progressWindow.loadURL(`data:text/html;charset=utf-8,
                <html>
                    <head>
                        <style>
                            body {
                                margin: 0; padding: 20px;
                                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                                background: #1a1a1a; color: #fff;
                                display: flex; flex-direction: column;
                                justify-content: center; align-items: center;
                                height: 100vh;
                            }
                            h2 { margin: 0 0 10px 0; font-size: 18px; }
                            p { margin: 5px 0; color: #aaa; font-size: 14px; }
                            .spinner {
                                border: 4px solid #333; border-top: 4px solid #4CAF50;
                                border-radius: 50%; width: 40px; height: 40px;
                                animation: spin 1s linear infinite; margin-top: 15px;
                            }
                            @keyframes spin {
                                0% { transform: rotate(0deg); }
                                100% { transform: rotate(360deg); }
                            }
                        </style>
                    </head>
                    <body>
                        <h2>Myrient DDL</h2>
                        <p>Descomprimiendo base de datos...</p>
                        <p style="font-size: 12px;">Esto puede tardar unos minutos</p>
                        <div class="spinner"></div>
                    </body>
                </html>
            `);

            // Buscar 7z
            const sevenZipPath = this._find7zPath();
            log.info('Usando 7-Zip:', sevenZipPath);

            // Ejecutar extracción
            const sevenZip = spawn(sevenZipPath, [
                'x',
                compressed7zPath,
                `-o${extractDir}`,
                '-y'
            ], {
                shell: false,
                windowsHide: true
            });

            let errorOutput = '';

            sevenZip.stdout.on('data', (data) => {
                const text = data.toString();
                const progressMatch = text.match(/(\d+)%/);
                if (progressMatch) {
                    log.debug('7z progreso:', progressMatch[1] + '%');
                }
            });

            sevenZip.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            sevenZip.on('close', (code) => {
                progressWindow.close();

                if (code === 0) {
                    log.info('Extracción completada exitosamente');

                    // Eliminar archivo .7z
                    try {
                        fs.unlinkSync(compressed7zPath);
                        log.info('Archivo .7z eliminado');
                    } catch (err) {
                        log.warn('No se pudo eliminar .7z:', err.message);
                    }

                    resolve(true);
                } else {
                    log.error('Error en extracción, código:', code);
                    reject(new Error(`7-Zip falló con código ${code}: ${errorOutput}`));
                }
            });

            sevenZip.on('error', (err) => {
                progressWindow.close();
                log.error('Error ejecutando 7-Zip:', err);
                reject(err);
            });
        });
    }

    /**
     * Busca la ruta del ejecutable 7z
     */
    _find7zPath() {
        const possiblePaths = process.platform === 'darwin' ? [
            '/usr/local/bin/7z',
            '/opt/homebrew/bin/7z',
            path.join(process.resourcesPath, '7z'),
            '7z'
        ] : [
            'C:\\Program Files\\7-Zip\\7z.exe',
            'C:\\Program Files (x86)\\7-Zip\\7z.exe',
            path.join(process.resourcesPath, '7z.exe'),
            '7z'
        ];

        for (const p of possiblePaths) {
            try {
                if (fs.existsSync(p)) {
                    return p;
                }
            } catch (e) {
                // Ignorar
            }
        }

        return '7z'; // Fallback al PATH del sistema
    }
}

// Exportar instancia única (singleton)
module.exports = new DatabaseService();
