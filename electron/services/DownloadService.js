/**
 * DownloadService - Lógica de negocio para descargas
 * 
 * Encapsula las reglas de negocio relacionadas con:
 * - Validación de descargas
 * - Determinación de estrategia de descarga (simple vs chunked)
 * - Gestión de duplicados
 * - Priorización
 * - Reglas de negocio para pausa/reanudación/cancelación
 */

const BaseService = require('./BaseService');
const config = require('../config');
const { isValidUrl, getNetworkErrorMessage } = require('../utils/validation');
const ChunkedDownloader = require('../ChunkedDownloader');

class DownloadService extends BaseService {
    constructor() {
        super('DownloadService');
        this.chunkedConfig = config.downloads.chunked || {};
    }

    /**
     * Valida los parámetros de una descarga según las reglas de negocio
     * @param {Object} params - Parámetros de descarga
     * @returns {Object} - Resultado de validación
     */
    validateDownloadParams(params) {
        try {
            // Validaciones básicas
            if (!params || typeof params !== 'object') {
                return { valid: false, error: 'Parámetros de descarga requeridos' };
            }

            const { id, title, url, downloadPath, preserveStructure, forceOverwrite } = params;

            // Validar ID
            if (!id || (typeof id !== 'number' && typeof id !== 'string')) {
                return { valid: false, error: 'ID de descarga inválido' };
            }

            // Validar título
            if (!title || typeof title !== 'string' || title.trim().length === 0) {
                return { valid: false, error: 'Título de descarga requerido' };
            }

            // Validar URL (opcional para descargas de carpetas)
            if (url && !isValidUrl(url)) {
                return { valid: false, error: 'URL inválida' };
            }

            // Validar ruta de descarga
            if (!downloadPath || typeof downloadPath !== 'string' || downloadPath.trim().length === 0) {
                return { valid: false, error: 'Ruta de descarga requerida' };
            }

            // Validar preserveStructure (debe ser boolean)
            const preserveStructureValid = preserveStructure === undefined || typeof preserveStructure === 'boolean';

            // Validar forceOverwrite (debe ser boolean)
            const forceOverwriteValid = forceOverwrite === undefined || typeof forceOverwrite === 'boolean';

            if (!preserveStructureValid || !forceOverwriteValid) {
                return { valid: false, error: 'Parámetros booleanos inválidos' };
            }

            // Retornar datos validados y normalizados
            return {
                valid: true,
                data: {
                    id: Number(id),
                    title: title.trim(),
                    url: url ? url.trim() : null,
                    downloadPath: downloadPath.trim(),
                    preserveStructure: preserveStructure !== false, // Default true
                    forceOverwrite: forceOverwrite === true // Default false
                }
            };

        } catch (error) {
            return this.handleError(error, 'validateDownloadParams');
        }
    }

    /**
     * Determina si debe usarse descarga fragmentada según reglas de negocio
     * NOTA: Este método solo verifica reglas de negocio básicas.
     * La verificación de soporte de Range requests se hace en DownloadManager (lógica técnica)
     * @param {string} url - URL del archivo
     * @param {number} fileSize - Tamaño del archivo en bytes
     * @returns {Promise<boolean>} - true si debe usarse chunked download según reglas de negocio
     */
    async shouldUseChunkedDownload(url, fileSize) {
        try {
            this.log.info(`[DownloadService] Evaluando descarga chunked: url=${!!url}, fileSize=${this._formatBytes(fileSize)}`);
            this.log.info(`[DownloadService] Config chunked:`, {
                forceSimpleDownload: this.chunkedConfig.forceSimpleDownload,
                enabled: this.chunkedConfig.enabled,
                sizeThreshold: this._formatBytes(this.chunkedConfig.sizeThreshold || 0),
                maxChunks: this.chunkedConfig.maxChunks,
                minChunkSize: this._formatBytes(this.chunkedConfig.minChunkSize || 0)
            });
            
            // Si chunked está deshabilitado explícitamente, nunca usar
            if (this.chunkedConfig.forceSimpleDownload) {
                this.log.info('[DownloadService] ❌ Descargas fragmentadas deshabilitadas por configuración (forceSimpleDownload)');
                return false;
            }
            
            // Si chunked está explícitamente deshabilitado, nunca usar
            // enabled es true por defecto (se establece en constructor)
            if (this.chunkedConfig.enabled === false) {
                this.log.info('[DownloadService] ❌ Descargas fragmentadas deshabilitadas (enabled=false)');
                return false;
            }

            // Si no hay URL, no se puede verificar soporte de Range requests
            if (!url) {
                this.log.info('[DownloadService] ❌ No hay URL, usando descarga simple');
                return false;
            }

            // Si el archivo es menor al threshold, usar descarga simple
            // Usar sizeThreshold si está configurado, sino threshold
            const threshold = this.chunkedConfig.sizeThreshold || this.chunkedConfig.threshold || (25 * 1024 * 1024); // 25MB default
            if (fileSize < threshold) {
                this.log.info(`[DownloadService] ❌ Archivo (${this._formatBytes(fileSize)}) menor al umbral (${this._formatBytes(threshold)})`);
                return false;
            }

            // Si fileSize es 0 o desconocido, no usar chunked (no se puede dividir)
            if (!fileSize || fileSize <= 0) {
                this.log.info('[DownloadService] ❌ FileSize inválido o cero, usando descarga simple');
                return false;
            }

            // Reglas de negocio adicionales:
            // - Máximo de chunks permitidos
            const maxChunks = this.chunkedConfig.maxChunks || 32;
            const minChunkSize = this.chunkedConfig.minChunkSize || (1024 * 1024); // 1MB minimum

            // Calcular número de chunks estimado
            const optimalChunks = this.calculateOptimalChunks(fileSize);
            const avgChunkSize = fileSize / optimalChunks;

            this.log.info(`[DownloadService] Cálculo de chunks:`, {
                optimalChunks,
                avgChunkSize: this._formatBytes(avgChunkSize),
                minChunkSize: this._formatBytes(minChunkSize),
                maxChunks
            });

            // Si los chunks serían muy pequeños, no usar chunked
            if (avgChunkSize < minChunkSize) {
                this.log.info(`[DownloadService] ❌ Chunks muy pequeños (${this._formatBytes(avgChunkSize)} < ${this._formatBytes(minChunkSize)}), usando descarga simple`);
                return false;
            }

            // Por defecto, usar chunked para archivos grandes
            // NOTA: La verificación de soporte de Range requests se hace en DownloadManager
            this.log.info(`[DownloadService] ✓ Usando descarga FRAGMENTADA: ${this._formatBytes(fileSize)}, ${optimalChunks} chunks`);
            return true;

        } catch (error) {
            this.log.warn('[DownloadService] Error determinando estrategia de descarga, usando simple:', error.message);
            return false; // En caso de error, usar descarga simple (más segura)
        }
    }
    
    /**
     * Formatea bytes para logging
     */
    _formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Calcula el número óptimo de chunks según reglas de negocio
     * @param {number} fileSize - Tamaño del archivo en bytes
     * @returns {number} - Número de chunks recomendado
     */
    calculateOptimalChunks(fileSize) {
        try {
            if (!fileSize || fileSize <= 0) {
                return 1;
            }

            const minChunks = 2;
            const maxChunks = this.chunkedConfig.maxChunks || 32;
            const optimalChunkSize = this.chunkedConfig.optimalChunkSize || (10 * 1024 * 1024); // 10MB

            // Calcular número de chunks basado en tamaño óptimo
            let calculatedChunks = Math.ceil(fileSize / optimalChunkSize);

            // Ajustar dentro de límites
            calculatedChunks = Math.max(minChunks, Math.min(calculatedChunks, maxChunks));

            return calculatedChunks;

        } catch (error) {
            this.log.warn('Error calculando chunks óptimos, usando valor por defecto:', error.message);
            return 4; // Valor por defecto seguro
        }
    }

    /**
     * Valida si una descarga puede ser iniciada según reglas de negocio
     * @param {Object} downloadParams - Parámetros de descarga
     * @param {Object} currentStats - Estadísticas actuales del sistema
     * @returns {Object} - Resultado de validación
     */
    canStartDownload(downloadParams, currentStats) {
        try {
            // Validar parámetros primero
            const validation = this.validateDownloadParams(downloadParams);
            if (!validation.valid) {
                return {
                    canStart: false,
                    reason: validation.error
                };
            }

            // Verificar límites de concurrencia
            const maxConcurrent = currentStats?.maxConcurrent || config.downloads.maxConcurrent || 3;
            const activeCount = (currentStats?.downloading || 0) + (currentStats?.paused || 0);

            if (activeCount >= maxConcurrent) {
                return {
                    canStart: false,
                    reason: 'Límite de descargas simultáneas alcanzado',
                    shouldQueue: true,
                    queuePosition: (currentStats?.queued || 0) + 1
                };
            }

            // Si hay slots disponibles, puede iniciar
            return {
                canStart: true,
                reason: 'Slots disponibles'
            };

        } catch (error) {
            return {
                canStart: false,
                reason: this.handleError(error, 'canStartDownload').error
            };
        }
    }

    /**
     * Determina la prioridad de una descarga según reglas de negocio
     * @param {Object} downloadParams - Parámetros de descarga
     * @returns {number} - Prioridad (mayor número = mayor prioridad)
     */
    calculatePriority(downloadParams) {
        try {
            let priority = 1; // Default: normal

            // Reglas de negocio para priorización:
            // - Archivos pequeños pueden tener mayor prioridad
            // - Descargas con forceOverwrite pueden tener menor prioridad
            // - Descargas urgentes (si se implementa un flag) tienen mayor prioridad

            // Por ahora, todas las descargas tienen prioridad normal
            // Esto puede extenderse en el futuro

            return priority;

        } catch (error) {
            this.log.warn('Error calculando prioridad, usando valor por defecto:', error.message);
            return 1;
        }
    }

    /**
     * Verifica si una descarga es duplicada según reglas de negocio
     * @param {Object} downloadParams - Parámetros de descarga
     * @param {Array} existingDownloads - Lista de descargas existentes
     * @returns {Object} - Resultado de verificación
     */
    isDuplicate(downloadParams, existingDownloads) {
        try {
            if (!existingDownloads || !Array.isArray(existingDownloads)) {
                return { isDuplicate: false };
            }

            const { id, title, url, downloadPath } = downloadParams;

            // Verificar duplicados por ID
            const duplicateById = existingDownloads.find(d => d.id === id);
            if (duplicateById) {
                return {
                    isDuplicate: true,
                    reason: 'ID duplicado',
                    existingDownload: duplicateById
                };
            }

            // Verificar duplicados por URL (si aplica)
            if (url) {
                const duplicateByUrl = existingDownloads.find(d => d.url === url && d.downloadPath === downloadPath);
                if (duplicateByUrl) {
                    return {
                        isDuplicate: true,
                        reason: 'URL y ruta duplicados',
                        existingDownload: duplicateByUrl
                    };
                }
            }

            // Verificar duplicados por título y ruta
            const duplicateByTitleAndPath = existingDownloads.find(
                d => d.title === title && d.downloadPath === downloadPath
            );
            if (duplicateByTitleAndPath) {
                return {
                    isDuplicate: true,
                    reason: 'Título y ruta duplicados',
                    existingDownload: duplicateByTitleAndPath
                };
            }

            return { isDuplicate: false };

        } catch (error) {
            this.log.warn('Error verificando duplicados, permitiendo descarga:', error.message);
            return { isDuplicate: false }; // En caso de error, permitir (más permisivo)
        }
    }

    /**
     * Genera el mensaje de error apropiado para una descarga fallida
     * @param {Error} error - Error ocurrido
     * @returns {string} - Mensaje de error amigable
     */
    getDownloadErrorMessage(error) {
        return getNetworkErrorMessage(error);
    }

    /**
     * Normaliza la ruta de guardado según reglas de negocio
     * @param {string} downloadPath - Ruta base de descarga
     * @param {string} title - Título del archivo
     * @param {boolean} preserveStructure - Si debe preservar estructura de carpetas
     * @param {string} relativePath - Ruta relativa (para carpetas)
     * @returns {string} - Ruta normalizada
     */
    normalizeSavePath(downloadPath, title, preserveStructure = true, relativePath = '') {
        try {
            const path = require('path');
            const { sanitizeFilename } = require('../utils');

            // Normalizar ruta base
            let savePath = path.resolve(downloadPath);

            // Si preserveStructure y hay relativePath, incluir estructura de carpetas
            if (preserveStructure && relativePath) {
                // Limpiar relativePath de caracteres peligrosos
                const cleanRelativePath = relativePath
                    .split(path.sep)
                    .map(segment => sanitizeFilename(segment))
                    .filter(segment => segment.length > 0)
                    .join(path.sep);

                if (cleanRelativePath) {
                    savePath = path.join(savePath, cleanRelativePath);
                }
            }

            // Limpiar nombre de archivo
            const cleanTitle = sanitizeFilename(title);
            savePath = path.join(savePath, cleanTitle);

            return savePath;

        } catch (error) {
            this.log.error('Error normalizando ruta, usando ruta simple:', error.message);
            const path = require('path');
            const { sanitizeFilename } = require('../utils');
            return path.join(path.resolve(downloadPath), sanitizeFilename(title));
        }
    }

    /**
     * Valida los parámetros de descarga de carpeta según las reglas de negocio
     * @param {Object} params - Parámetros de descarga de carpeta
     * @returns {Object} - Resultado de validación
     */
    validateDownloadFolderParams(params) {
        try {
            // Validaciones básicas
            if (!params || typeof params !== 'object') {
                return { valid: false, error: 'Parámetros de descarga de carpeta requeridos' };
            }

            const { folderId, downloadPath, preserveStructure, forceOverwrite } = params;

            // Validar ID de carpeta
            if (!folderId || (typeof folderId !== 'number' && typeof folderId !== 'string')) {
                return { valid: false, error: 'ID de carpeta inválido' };
            }

            // Convertir a número si es string
            const folderIdNum = typeof folderId === 'string' ? parseInt(folderId, 10) : folderId;

            // Validar que sea un número válido y positivo
            if (isNaN(folderIdNum) || folderIdNum <= 0 || !Number.isInteger(folderIdNum)) {
                return { valid: false, error: 'ID de carpeta debe ser un número entero positivo' };
            }

            // Validar ruta de descarga (opcional pero si está presente debe ser válida)
            if (downloadPath !== undefined && downloadPath !== null) {
                if (typeof downloadPath !== 'string') {
                    return { valid: false, error: 'Ruta de descarga debe ser una cadena de texto' };
                }

                if (downloadPath.trim().length === 0) {
                    return { valid: false, error: 'Ruta de descarga no puede estar vacía' };
                }

                // Validar longitud máxima
                const maxPathLength = 1000; // Límite razonable para rutas
                if (downloadPath.length > maxPathLength) {
                    return { valid: false, error: `Ruta de descarga demasiado larga (máximo ${maxPathLength} caracteres)` };
                }
            }

            // Validar preserveStructure (debe ser boolean si está presente)
            const preserveStructureValid = preserveStructure === undefined || typeof preserveStructure === 'boolean';

            // Validar forceOverwrite (debe ser boolean si está presente)
            const forceOverwriteValid = forceOverwrite === undefined || typeof forceOverwrite === 'boolean';

            if (!preserveStructureValid || !forceOverwriteValid) {
                return { valid: false, error: 'Parámetros booleanos inválidos' };
            }

            // Retornar datos validados y normalizados
            return {
                valid: true,
                data: {
                    folderId: folderIdNum,
                    downloadPath: downloadPath ? downloadPath.trim() : null,
                    preserveStructure: preserveStructure !== false, // Default true para carpetas
                    forceOverwrite: forceOverwrite === true // Default false
                }
            };

        } catch (error) {
            return this.handleError(error, 'validateDownloadFolderParams');
        }
    }

    /**
     * Valida si una carpeta puede ser descargada según reglas de negocio
     * @param {Object} folderParams - Parámetros de descarga de carpeta
     * @param {number} fileCount - Número de archivos en la carpeta
     * @param {Object} currentStats - Estadísticas actuales del sistema
     * @returns {Object} - Resultado de validación
     */
    canDownloadFolder(folderParams, fileCount = 0, currentStats = {}) {
        try {
            // Validar parámetros primero
            const validation = this.validateDownloadFolderParams(folderParams);
            if (!validation.valid) {
                return {
                    canDownload: false,
                    reason: validation.error
                };
            }

            // Validar número de archivos
            if (!fileCount || fileCount <= 0) {
                return {
                    canDownload: false,
                    reason: 'La carpeta no contiene archivos para descargar'
                };
            }

            // Verificar límites de descarga de carpetas
            // Usar límite razonable: 1000 archivos por carpeta (configurable si existe)
            const maxFilesPerFolder = config.downloads?.maxFilesPerFolder || 1000;
            if (fileCount > maxFilesPerFolder) {
                return {
                    canDownload: false,
                    reason: `La carpeta contiene demasiados archivos (${fileCount}). El límite es ${maxFilesPerFolder} archivos por carpeta`,
                    fileCount,
                    maxFilesPerFolder
                };
            }

            // Verificar límites de cola total
            // Usar límite razonable: 1000 descargas en cola (configurable si existe)
            const maxQueueSize = config.downloads?.maxQueueSize || 1000;
            const currentQueueSize = currentStats.queuedInMemory || currentStats.queued || 0;
            const availableQueueSlots = maxQueueSize - currentQueueSize;

            if (fileCount > availableQueueSlots) {
                return {
                    canDownload: false,
                    reason: `No hay suficiente espacio en la cola. La carpeta tiene ${fileCount} archivos pero solo hay ${availableQueueSlots} slots disponibles`,
                    fileCount,
                    availableQueueSlots,
                    maxQueueSize
                };
            }

            // Si pasa todas las validaciones, puede descargar
            return {
                canDownload: true,
                reason: 'Carpeta válida para descarga',
                fileCount,
                estimatedQueueSlots: fileCount
            };

        } catch (error) {
            return {
                canDownload: false,
                reason: this.handleError(error, 'canDownloadFolder').error
            };
        }
    }

    /**
     * Prepara parámetros de descarga para archivos individuales en una carpeta
     * @param {Object} folderParams - Parámetros de descarga de carpeta
     * @param {Object} fileInfo - Información del archivo
     * @returns {Object} - Parámetros de descarga normalizados para el archivo
     */
    prepareFileDownloadParams(folderParams, fileInfo) {
        try {
            // Validar parámetros de carpeta
            const folderValidation = this.validateDownloadFolderParams(folderParams);
            if (!folderValidation.valid) {
                throw new Error(folderValidation.error);
            }

            const validatedFolderParams = folderValidation.data;

            // Validar información del archivo
            if (!fileInfo || typeof fileInfo !== 'object') {
                throw new Error('Información de archivo requerida');
            }

            const { id, title } = fileInfo;

            // Validar ID y título del archivo
            if (!id || (typeof id !== 'number' && typeof id !== 'string')) {
                throw new Error('ID de archivo inválido');
            }

            const fileId = typeof id === 'string' ? parseInt(id, 10) : id;
            if (isNaN(fileId) || fileId <= 0 || !Number.isInteger(fileId)) {
                throw new Error('ID de archivo debe ser un número entero positivo');
            }

            if (!title || typeof title !== 'string' || title.trim().length === 0) {
                throw new Error('Título de archivo requerido');
            }

            // Preparar parámetros de descarga para el archivo individual
            const downloadParams = {
                id: fileId,
                title: title.trim(),
                downloadPath: validatedFolderParams.downloadPath,
                preserveStructure: validatedFolderParams.preserveStructure,
                forceOverwrite: validatedFolderParams.forceOverwrite,
                url: fileInfo.url || null, // URL opcional (puede ser null para carpetas)
                priority: this.calculatePriority({
                    id: fileId,
                    title: title.trim(),
                    downloadPath: validatedFolderParams.downloadPath
                })
            };

            return {
                success: true,
                params: downloadParams
            };

        } catch (error) {
            return {
                success: false,
                error: this.handleError(error, 'prepareFileDownloadParams').error
            };
        }
    }

    /**
     * Calcula estadísticas de descarga de carpeta
     * @param {Object} folderParams - Parámetros de descarga de carpeta
     * @param {Array} files - Lista de archivos en la carpeta
     * @param {Object} existingDownloads - Descargas existentes (para verificar duplicados)
     * @returns {Object} - Estadísticas de la descarga de carpeta
     */
    calculateFolderDownloadStats(folderParams, files = [], existingDownloads = []) {
        try {
            if (!files || !Array.isArray(files)) {
                return {
                    totalFiles: 0,
                    validFiles: 0,
                    duplicateFiles: 0,
                    newDownloads: 0,
                    totalSize: 0,
                    averageSize: 0
                };
            }

            let validFiles = 0;
            let duplicateFiles = 0;
            let newDownloads = 0;
            let totalSize = 0;

            // Verificar cada archivo
            for (const file of files) {
                // Verificar si el archivo es válido
                if (!file.id || !file.title) {
                    continue;
                }

                validFiles++;
                totalSize += file.size || 0;

                // Verificar si es duplicado
                const downloadParams = {
                    id: file.id,
                    title: file.title,
                    downloadPath: folderParams.downloadPath
                };

                const duplicateCheck = this.isDuplicate(downloadParams, existingDownloads);
                if (duplicateCheck.isDuplicate) {
                    duplicateFiles++;
                } else {
                    newDownloads++;
                }
            }

            const averageSize = validFiles > 0 ? totalSize / validFiles : 0;

            return {
                totalFiles: files.length,
                validFiles,
                duplicateFiles,
                newDownloads,
                totalSize,
                averageSize: Math.round(averageSize),
                canDownload: newDownloads > 0,
                validation: this.canDownloadFolder(folderParams, validFiles, {})
            };

        } catch (error) {
            this.log.error('Error calculando estadísticas de carpeta:', error.message);
            return {
                totalFiles: 0,
                validFiles: 0,
                duplicateFiles: 0,
                newDownloads: 0,
                totalSize: 0,
                averageSize: 0,
                canDownload: false,
                error: error.message
            };
        }
    }
}

module.exports = DownloadService;
