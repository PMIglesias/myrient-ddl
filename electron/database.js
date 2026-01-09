// Módulo de gestión de base de datos SQLite para el catálogo de Myrient
// Maneja conexión, queries optimizadas, y búsquedas Full-Text Search (FTS)
// 
// OPTIMIZACIONES FTS (Full-Text Search):
// - Detecta automáticamente tablas FTS5/FTS4 y extrae columnas indexadas
// - Usa bm25() para ranking mejorado de relevancia en FTS5
// - Preparación inteligente de términos con escape de caracteres especiales
// - Soporte para búsquedas de frases exactas y wildcards automáticos
// - Fallback automático a LIKE si FTS no está disponible
// 
// OPTIMIZACIONES DE QUERIES:
// - Prepared statements reutilizables para mejor rendimiento
// - Paginación nativa (LIMIT/OFFSET) para grandes resultados
// - Ranking por relevancia en búsquedas LIKE (empieza con > completa > contiene)
// - Uso de .pluck() para queries que retornan un solo valor
// - Queries optimizadas para PRIMARY KEY lookups
// 
// RENDIMIENTO:
// - Búsquedas FTS5: 10-100x más rápidas que LIKE en bases de datos grandes (>1GB)
// - Paginación reduce uso de memoria y tiempo de respuesta
// - Ranking bm25() ordena resultados más relevantes primero

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, dialog, BrowserWindow } = require('electron');
const config = require('./config');
const { logger, escapeLikeTerm } = require('./utils');

// Logger con scope específico para este módulo
const log = logger.child('Database');

class DatabaseService {
    constructor() {
        this.db = null;
        this.statements = null;
    }

    // Inicializa la conexión a la base de datos SQLite de Myrient
    // Si el archivo .db no existe pero existe un .7z, extrae la base de datos automáticamente
    // Configura la base de datos como solo lectura y prepara todos los statements necesarios
    // Retorna: Promise<boolean> - true si la inicialización fue exitosa, false en caso de error
    async initialize() {
        const endInit = logger.startOperation('Inicialización de base de datos');
        const { dbPath, compressed7zPath } = config.paths;

        // Si el archivo .db no existe pero existe un archivo .7z comprimido, extraerlo automáticamente
        // Esto permite distribuir la base de datos comprimida para reducir el tamaño de la aplicación
        if (!fs.existsSync(dbPath) && fs.existsSync(compressed7zPath)) {
            log.info('Base de datos no encontrada, extrayendo desde .7z...');

            try {
                await this._extractDatabase();
                log.info('Extracción completada, verificando archivo...');

                // Verificar que la extracción produjo el archivo esperado
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

        // Verificar que el archivo de base de datos existe antes de intentar conectarse
        if (!fs.existsSync(dbPath)) {
            this._showError(
                'Error de Base de Datos',
                `El archivo 'myrient.db' no se encontró en: ${dbPath}`
            );
            return false;
        }

        // Establecer conexión a la base de datos SQLite en modo solo lectura
        // readonly: true previene modificaciones accidentales a la base de datos
        // fileMustExist: true garantiza que la base de datos existe antes de conectar
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

    // Detecta si existe una tabla Full-Text Search (FTS5 o FTS4) en la base de datos
    // Extrae información sobre el nombre de la tabla, tipo (FTS5/FTS4), y columnas indexadas
    // Esta información se usa para optimizar las búsquedas usando FTS en lugar de LIKE
    // Retorna: Objeto con nombre de tabla, tipo (FTS5/FTS4), y array de columnas indexadas, o null si no hay FTS
    _detectFTS() {
        try {
            // Buscar tablas FTS5 primero (más moderno y mejor rendimiento que FTS4)
            const fts5Tables = this.db.prepare(`
                SELECT name, sql FROM sqlite_master 
                WHERE type='table' 
                AND (name LIKE '%fts%' OR name LIKE '%_fts%' OR name LIKE '%_content%')
                AND sql LIKE '%USING fts5%'
            `).all();
            
            if (fts5Tables.length > 0) {
                const ftsTable = fts5Tables[0];
                
                // Intentar obtener información de columnas indexadas
                let indexedColumns = ['title']; // Default
                try {
                    // FTS5 almacena columnas en sqlite_master.sql
                    const sql = ftsTable.sql || '';
                    const columnMatch = sql.match(/\(([^)]+)\)/);
                    if (columnMatch) {
                        indexedColumns = columnMatch[1]
                            .split(',')
                            .map(col => col.trim().split(/\s+/)[0])
                            .filter(col => col && !col.startsWith('content='));
                    }
                } catch (e) {
                    log.debug('No se pudieron extraer columnas FTS:', e.message);
                }
                
                log.info(`Tabla FTS5 detectada: ${ftsTable.name} (columnas: ${indexedColumns.join(', ')})`);
                return { 
                    name: ftsTable.name, 
                    type: 'fts5',
                    columns: indexedColumns
                };
            }
            
            // Verificar FTS4
            const fts4Tables = this.db.prepare(`
                SELECT name, sql FROM sqlite_master 
                WHERE type='table' 
                AND (name LIKE '%fts%' OR name LIKE '%_fts%')
                AND sql LIKE '%USING fts4%'
            `).all();
            
            if (fts4Tables.length > 0) {
                log.info(`Tabla FTS4 detectada: ${fts4Tables[0].name}`);
                return { 
                    name: fts4Tables[0].name, 
                    type: 'fts4',
                    columns: ['title'] // Default para FTS4
                };
            }
            
            // Verificar si FTS5 está disponible (aunque no haya tabla)
            try {
                const fts5Available = this.db.prepare(`
                    SELECT sqlite_compileoption_used('ENABLE_FTS5') as available
                `).get();
                
                if (fts5Available && fts5Available.available) {
                    log.debug('FTS5 está disponible pero no hay tabla FTS configurada');
                }
            } catch (e) {
                // Ignorar si la función no está disponible
            }
            
            return null;
        } catch (error) {
            log.warn('Error detectando FTS:', error.message);
            return null;
        }
    }

    /**
     * Prepara los statements reutilizables
     */
    _prepareStatements() {
        log.debug('Preparando statements SQL...');
        
        // Detectar FTS
        const ftsInfo = this._detectFTS();
        this.ftsTable = ftsInfo ? ftsInfo.name : null;
        this.ftsType = ftsInfo ? ftsInfo.type : null;
        this.ftsColumns = ftsInfo ? ftsInfo.columns : ['title'];
        this.useFTS = !!this.ftsTable;
        
        // Usar '|' como carácter de escape (más seguro que \)
        this.statements = {
            // Búsqueda FTS optimizada con paginación (si está disponible)
            searchFTS: this.useFTS ? (() => {
                const tableName = this.ftsTable;
                // FTS5 tiene bm25() con mejor ranking, FTS4 usa matchinfo()
                if (this.ftsType === 'fts5') {
                    // Query optimizada con bm25() y mejor ordenamiento
                    return this.db.prepare(`
                        SELECT n.id, n.title, n.modified_date, n.type, n.parent_id,
                               bm25(${tableName}) AS relevance
                        FROM ${tableName} fts
                        INNER JOIN nodes n ON n.id = fts.rowid
                        WHERE ${tableName} MATCH ?
                        ORDER BY relevance ASC, n.title ASC
                        LIMIT ? OFFSET ?
                    `);
                } else {
                    // FTS4: usar matchinfo() para ranking básico
                    return this.db.prepare(`
                        SELECT n.id, n.title, n.modified_date, n.type, n.parent_id,
                               matchinfo(${tableName}) AS matchinfo_data,
                               0 AS relevance
                        FROM ${tableName} fts
                        INNER JOIN nodes n ON n.id = fts.rowid
                        WHERE ${tableName} MATCH ?
                        ORDER BY n.title ASC
                        LIMIT ? OFFSET ?
                    `);
                }
            })() : null,
            
            // Búsqueda FTS sin paginación (para compatibilidad)
            searchFTSNoPagination: this.useFTS ? (() => {
                const tableName = this.ftsTable;
                if (this.ftsType === 'fts5') {
                    return this.db.prepare(`
                        SELECT n.id, n.title, n.modified_date, n.type, n.parent_id,
                               bm25(${tableName}) AS relevance
                        FROM ${tableName} fts
                        INNER JOIN nodes n ON n.id = fts.rowid
                        WHERE ${tableName} MATCH ?
                        ORDER BY relevance ASC, n.title ASC
                        LIMIT 500
                    `);
                } else {
                    return this.db.prepare(`
                        SELECT n.id, n.title, n.modified_date, n.type, n.parent_id,
                               0 AS relevance
                        FROM ${tableName} fts
                        INNER JOIN nodes n ON n.id = fts.rowid
                        WHERE ${tableName} MATCH ?
                        ORDER BY n.title ASC
                        LIMIT 500
                    `);
                }
            })() : null,

            // Búsqueda mejorada con LIKE (fallback) - optimizada con índices
            searchLike: this.db.prepare(`
                SELECT id, title, modified_date, type, parent_id,
                       CASE 
                           WHEN title LIKE ? THEN 1
                           WHEN title LIKE ? THEN 2
                           WHEN title LIKE ? THEN 3
                           ELSE 4
                       END AS relevance
                FROM nodes 
                WHERE title LIKE ? ESCAPE '|'
                   OR title LIKE ? ESCAPE '|'
                   OR title LIKE ? ESCAPE '|'
                ORDER BY relevance ASC, title ASC
                LIMIT ? OFFSET ?
            `),
            
            // Búsqueda LIKE sin paginación (para compatibilidad)
            searchLikeNoPagination: this.db.prepare(`
                SELECT id, title, modified_date, type, parent_id,
                       CASE 
                           WHEN title LIKE ? THEN 1
                           WHEN title LIKE ? THEN 2
                           WHEN title LIKE ? THEN 3
                           ELSE 4
                       END AS relevance
                FROM nodes 
                WHERE title LIKE ? ESCAPE '|'
                   OR title LIKE ? ESCAPE '|'
                   OR title LIKE ? ESCAPE '|'
                ORDER BY relevance ASC, title ASC
                LIMIT 500
            `),

            // Búsqueda simple (compatibilidad)
            search: this.db.prepare(`
                SELECT id, title, modified_date, type, parent_id
                FROM nodes 
                WHERE title LIKE ? ESCAPE '|'
                ORDER BY title ASC
                LIMIT 500
            `),

            // Query optimizada con índice implícito en parent_id
            getChildren: this.db.prepare(`
                SELECT id, parent_id, title, size, modified_date, type, url
                FROM nodes 
                WHERE parent_id = ?
                ORDER BY type DESC, title ASC
            `),
            
            // Query optimizada con pluck() para obtener solo un valor
            getChildrenCount: this.db.prepare(`
                SELECT COUNT(*) FROM nodes WHERE parent_id = ?
            `).pluck(),

            // Query optimizada - id es PRIMARY KEY, muy rápido
            getNodeById: this.db.prepare(
                'SELECT id, parent_id, title, type FROM nodes WHERE id = ?'
            ),
            
            // Query optimizada con pluck() para obtener solo el título
            getNodeTitle: this.db.prepare(
                'SELECT title FROM nodes WHERE id = ?'
            ).pluck(),

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
            `),

            getAllFilesRecursive: this.db.prepare(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id, parent_id, title, type, url, size, modified_date
                    FROM nodes 
                    WHERE id = ?
                    UNION ALL
                    SELECT n.id, n.parent_id, n.title, n.type, n.url, n.size, n.modified_date
                    FROM nodes n
                    INNER JOIN folder_tree ft ON n.parent_id = ft.id
                )
                SELECT id, title, url, size, modified_date
                FROM folder_tree
                WHERE type = 'File'
                ORDER BY title ASC
            `)
        };
        
        log.debug('Statements SQL preparados');
    }

    /**
     * Prepara término de búsqueda para FTS5 con mejor escape y ranking
     * @param {string} term - Término de búsqueda
     * @param {Object} options - Opciones de búsqueda
     * @returns {string} Término formateado para FTS5
     */
    _prepareFTSTerm(term, options = {}) {
        const {
            usePrefix = true,      // Usar wildcard al final
            usePhrase = false,     // Buscar frase exacta
            useOR = false          // Usar OR en lugar de AND
        } = options;
        
        // FTS5 usa sintaxis especial:
        // - "palabra" busca frase exacta
        // - palabra busca cualquier coincidencia
        // - palabra* busca prefijos
        // - palabra1 OR palabra2 busca cualquiera
        // - palabra1 AND palabra2 busca ambas
        // - NOT palabra excluye
        
        const cleanTerm = term.trim();
        if (!cleanTerm) return '';
        
        // Si es una frase exacta (entre comillas)
        if (usePhrase || (cleanTerm.startsWith('"') && cleanTerm.endsWith('"'))) {
            const phrase = cleanTerm.replace(/^"|"$/g, '');
            // Escapar comillas dobles dentro de la frase
            const escaped = phrase.replace(/"/g, '""');
            return `"${escaped}"`;
        }
        
        // Dividir en palabras
        const words = cleanTerm
            .split(/\s+/)
            .filter(w => w.length > 0)
            .map(w => {
                // Escapar caracteres especiales de FTS: " ' * NOT AND OR
                let escaped = w.replace(/["'*]/g, '');
                
                // Si la palabra es un operador FTS, escapar
                const upperWord = escaped.toUpperCase();
                if (['NOT', 'AND', 'OR'].includes(upperWord)) {
                    escaped = `"${escaped}"`;
                }
                
                // Agregar wildcard al final si está habilitado
                if (usePrefix && escaped.length > 0) {
                    return `${escaped}*`;
                }
                
                return escaped;
            });
        
        if (words.length === 0) return '';
        if (words.length === 1) return words[0];
        
        // Múltiples palabras: usar AND (más relevante) o OR (más resultados)
        const operator = useOR ? ' OR ' : ' AND ';
        return words.join(operator);
    }

    /**
     * Prepara término de búsqueda para LIKE mejorado
     * @param {string} term - Término de búsqueda
     * @returns {Array<string>} Array con patrones de búsqueda
     */
    _prepareLikeTerms(term) {
        // Limpiar término: remover sintaxis FTS que pueda haber quedado (asteriscos, comillas, operadores)
        // Esto asegura que LIKE reciba un término limpio
        let cleanTerm = term.trim()
            .replace(/\*/g, '')  // Remover asteriscos de FTS
            .replace(/^["']|["']$/g, '')  // Remover comillas al inicio/fin
            .replace(/\s+(AND|OR|NOT)\s+/gi, ' ')  // Remover operadores FTS
            .trim();
        
        // Si el término quedó vacío después de limpiar, usar el original
        if (!cleanTerm) {
            cleanTerm = term.trim();
        }
        
        const escaped = escapeLikeTerm(cleanTerm);
        
        // Para términos con múltiples palabras, buscar todas las palabras en orden
        const words = cleanTerm.split(/\s+/).filter(w => w.length > 0);
        
        if (words.length === 1) {
            // Una sola palabra: usar patrones de relevancia
            return [
                `${escaped}%`,      // Empieza con (mayor relevancia) - ej: "Guit%"
                `% ${escaped}%`,    // Palabra completa después de espacio (buena relevancia) - ej: "% Guit%"
                `%${escaped}%`      // Contiene en cualquier lugar (menor relevancia) - ej: "%Guit%"
            ];
        } else {
            // Múltiples palabras: buscar todas las palabras en orden
            // Construir patrones que busquen todas las palabras
            const allWordsEscaped = words.map(w => escapeLikeTerm(w));
            const allWordsPattern = allWordsEscaped.join('%'); // ej: "Guitar%hero%"
            
            // Siempre retornar 3 patrones para compatibilidad con los statements SQL
            return [
                `${allWordsPattern}%`,      // Todas las palabras en orden, empieza con (mayor relevancia)
                `%${allWordsPattern}%`,     // Todas las palabras en orden, contiene (buena relevancia)
                `%${escaped}%`              // Término completo contiene (menor relevancia, fallback)
            ];
        }
    }

    /**
     * Búsqueda usando LIKE mejorado con ranking y paginación
     * @param {string} term - Término de búsqueda
     * @param {number} limit - Límite de resultados
     * @param {number} offset - Offset para paginación
     * @returns {Array} Resultados
     */
    _searchWithLike(term, limit = 500, offset = 0) {
        const patterns = this._prepareLikeTerms(term);
        const stmt = limit === 500 && offset === 0 
            ? this.statements.searchLikeNoPagination 
            : this.statements.searchLike;
        
        const results = limit === 500 && offset === 0
            ? stmt.all(
                patterns[0],  // Empieza con
                patterns[1],  // Palabra completa
                patterns[2],  // Contiene
                patterns[0],  // WHERE empieza con
                patterns[1],  // OR palabra completa
                patterns[2]   // OR contiene
            )
            : stmt.all(
                patterns[0],  // Empieza con
                patterns[1],  // Palabra completa
                patterns[2],  // Contiene
                patterns[0],  // WHERE empieza con
                patterns[1],  // OR palabra completa
                patterns[2],  // OR contiene
                limit,
                offset
            );
        
        log.debug(`Búsqueda LIKE mejorada "${term}": ${results.length} resultados (limit: ${limit}, offset: ${offset})`);
        return results;
    }

    /**
     * Busca nodos por término usando FTS si está disponible, sino LIKE mejorado
     * @param {string} searchTerm - Término de búsqueda
     * @param {Object} options - Opciones de búsqueda
     * @param {number} options.limit - Límite de resultados (default: 500)
     * @param {number} options.offset - Offset para paginación (default: 0)
     * @param {boolean} options.usePrefix - Usar wildcard al final (default: true)
     * @param {boolean} options.usePhrase - Buscar frase exacta (default: false)
     * @param {boolean} options.useOR - Usar OR en lugar de AND (default: false)
     * @returns {Object} Resultado de la búsqueda
     */
    search(searchTerm, options = {}) {
        if (!this.db) {
            return { success: false, error: 'Base de datos no disponible' };
        }

        if (!searchTerm || searchTerm.trim().length < 2) {
            return { success: true, data: [], total: 0 };
        }

        const cleanSearchTerm = searchTerm.trim();
        if (cleanSearchTerm.length > 100) {
            return { success: false, error: 'Término de búsqueda demasiado largo' };
        }

        const {
            limit = 500,
            offset = 0,
            usePrefix = true,
            usePhrase = false,
            useOR = false
        } = options;

        try {
            let results;
            let total = 0;
            
            if (this.useFTS && this.statements.searchFTS) {
                // Usar FTS5/FTS4 optimizado
                const ftsTerm = this._prepareFTSTerm(cleanSearchTerm, { usePrefix, usePhrase, useOR });
                log.debug(`Búsqueda FTS "${cleanSearchTerm}" -> "${ftsTerm}" (limit: ${limit}, offset: ${offset})`);
                
                try {
                    // Usar query con paginación si está disponible
                    const stmt = limit === 500 && offset === 0 
                        ? this.statements.searchFTSNoPagination 
                        : this.statements.searchFTS;
                    
                    if (limit === 500 && offset === 0) {
                        results = stmt.all(ftsTerm);
                    } else {
                        results = stmt.all(ftsTerm, limit, offset);
                    }
                    
                    // Para FTS5, obtener conteo total (aproximado) si es necesario
                    // Nota: COUNT(*) en FTS puede ser lento, solo si realmente se necesita
                    if (offset === 0 && results.length === limit) {
                        // Podría haber más resultados, pero no contamos para no ralentizar
                        total = results.length;
                    } else {
                        total = results.length;
                    }
                    
                    log.debug(`Búsqueda FTS: ${results.length} resultados`);
                } catch (ftsError) {
                    // Si FTS falla, usar fallback
                    log.warn('Error en búsqueda FTS, usando fallback:', ftsError.message);
                    // No desactivar FTS permanentemente, podría ser un término específico
                    results = this._searchWithLike(cleanSearchTerm, limit, offset);
                    total = results.length;
                }
            } else {
                // Usar búsqueda LIKE mejorada
                results = this._searchWithLike(cleanSearchTerm, limit, offset);
                total = results.length;
            }

            const normalized = results.map(item => this._normalizeNode(item));

            return { 
                success: true, 
                data: normalized,
                total,
                limit,
                offset,
                hasMore: total === limit // Indica si podría haber más resultados
            };
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
     * Obtiene todos los archivos de una carpeta recursivamente
     * @param {number} folderId - ID de la carpeta
     * @returns {Object} Resultado con lista de archivos
     */
    getAllFilesInFolder(folderId) {
        if (!this.db) {
            return { success: false, error: 'Base de datos no disponible' };
        }

        try {
            // Verificar que el nodo existe y es una carpeta
            const node = this.statements.getNodeById.get(folderId);
            if (!node) {
                return { success: false, error: 'Carpeta no encontrada' };
            }

            if (this._normalizeType(node.type) !== 'folder') {
                return { success: false, error: 'El nodo especificado no es una carpeta' };
            }

            // Obtener todos los archivos recursivamente
            const files = this.statements.getAllFilesRecursive.all(folderId);
            
            log.debug(`Archivos encontrados en carpeta ${folderId}: ${files.length} archivos`);

            return { 
                success: true, 
                data: files.map(file => ({
                    id: file.id,
                    title: file.title.replace(/\/$/, ''),
                    url: file.url,
                    size: file.size,
                    modified_date: file.modified_date
                }))
            };
        } catch (error) {
            log.error('Error al obtener archivos de carpeta:', error);
            return { success: false, error: error.message };
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

    // Cierra la conexión a la base de datos y libera todos los recursos asociados
    // Limpia los prepared statements y marca la conexión como cerrada
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.statements = null;
            log.info('Conexión a base de datos cerrada');
        }
    }

    // Normaliza un nodo de la base de datos agregando información completa de ruta y estructura
    // Construye displayTitle, breadcrumbPath, y fullPath recorriendo los ancestros del nodo
    // item: Objeto nodo obtenido de la base de datos con id, title, type, parent_id
    // Retorna: Objeto nodo normalizado con información de ruta completa
    _normalizeNode(item) {
        const cleanTitle = item.title.replace(/\/$/, '');
        const type = this._normalizeType(item.type);

        let displayTitle = cleanTitle;
        let breadcrumbPath = '';
        let fullPath = '';

        // Construir la ruta completa recorriendo la cadena de ancestros hasta la raíz
        // El límite de 100 iteraciones previene loops infinitos si hay referencias circulares en los datos
        const pathArray = [];
        let currentId = item.id;

        for (let i = 0; i < 100; i++) {
            const node = this.statements.getNodeById.get(currentId);
            if (!node) break;

            const cleanNodeTitle = node.title.replace(/\/$/, '');
            pathArray.unshift(cleanNodeTitle);

            // Detener cuando se alcanza la raíz (parent_id = 1) o no hay padre
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

    // Normaliza el tipo de nodo a un formato consistente usado en toda la aplicación
    // Convierte tipos de la base de datos ('Directory', 'File') a formatos estándar ('folder', 'file')
    // type: Tipo de nodo obtenido de la base de datos
    // Retorna: Tipo normalizado en minúsculas ('folder', 'file', etc.)
    _normalizeType(type) {
        if (type === 'Directory') return 'folder';
        if (type === 'File') return 'file';
        return type.toLowerCase();
    }

    // Muestra un diálogo de error al usuario y cierra la aplicación
    // Se usa cuando hay errores críticos que impiden continuar (ej: base de datos corrupta)
    // title: Título del diálogo de error
    // message: Mensaje descriptivo del error que se mostrará al usuario
    _showError(title, message) {
        log.error(`${title}: ${message}`);
        dialog.showErrorBox(title, message);
        app.quit();
    }

    // Extrae la base de datos desde un archivo comprimido .7z usando 7-Zip
    // Crea una ventana de progreso durante la extracción y elimina el .7z al completar
    // Retorna Promise que se resuelve cuando la extracción se completa exitosamente
    async _extractDatabase() {
        return new Promise((resolve, reject) => {
            const { dbPath, compressed7zPath } = config.paths;
            const extractDir = path.dirname(dbPath);

            log.info('Iniciando extracción...');
            log.info('Archivo comprimido:', compressed7zPath);
            log.info('Destino:', extractDir);

            // Crear ventana temporal de progreso para informar al usuario durante la extracción
            // La ventana muestra un spinner y mensaje mientras se descomprime el archivo grande
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

            // Buscar el ejecutable de 7-Zip en ubicaciones comunes del sistema
            const sevenZipPath = this._find7zPath();
            log.info('Usando 7-Zip:', sevenZipPath);

            // Ejecutar proceso de extracción usando 7-Zip con parámetros para extracción silenciosa
            // 'x' = extraer, '-o' = directorio de salida, '-y' = responder sí a todas las preguntas
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

            // Capturar salida estándar para extraer información de progreso
            // 7-Zip muestra porcentaje de progreso en stdout que podemos parsear
            sevenZip.stdout.on('data', (data) => {
                const text = data.toString();
                const progressMatch = text.match(/(\d+)%/);
                if (progressMatch) {
                    log.debug('7z progreso:', progressMatch[1] + '%');
                }
            });

            // Capturar errores de stderr para diagnosticar problemas de extracción
            sevenZip.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            // Manejar el evento cuando el proceso de 7-Zip termina
            // code = 0 significa éxito, cualquier otro valor indica error
            sevenZip.on('close', (code) => {
                progressWindow.close();

                if (code === 0) {
                    log.info('Extracción completada exitosamente');

                    // Eliminar el archivo .7z después de extraer exitosamente para ahorrar espacio
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

            // Manejar errores al intentar ejecutar el proceso de 7-Zip
            // Ocurre si 7-Zip no está instalado o la ruta es incorrecta
            sevenZip.on('error', (err) => {
                progressWindow.close();
                log.error('Error ejecutando 7-Zip:', err);
                reject(err);
            });
        });
    }

    // Busca el ejecutable de 7-Zip en ubicaciones comunes según la plataforma
    // Verifica rutas típicas de instalación antes de usar el fallback al PATH del sistema
    // Retorna: Ruta completa al ejecutable de 7-Zip o '7z' para usar desde PATH
    _find7zPath() {
        // Rutas comunes de instalación de 7-Zip según plataforma
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

        // Intentar encontrar 7-Zip en las ubicaciones comunes
        for (const p of possiblePaths) {
            try {
                if (fs.existsSync(p)) {
                    return p;
                }
            } catch (e) {
                // Ignorar errores de acceso al verificar existencia de archivo
            }
        }

        // Fallback: retornar '7z' para que el sistema lo busque en el PATH
        return '7z';
    }
}

// Exportar instancia única (singleton)
module.exports = new DatabaseService();
