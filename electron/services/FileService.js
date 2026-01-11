/**
 * @fileoverview FileService - Lógica de negocio para operaciones de archivos
 * @module FileService
 *
 * Encapsula las reglas de negocio relacionadas con:
 * - Validación de rutas de archivos
 * - Normalización de rutas
 * - Validación de nombres de archivos
 * - Reglas de negocio para estructura de carpetas
 * - Verificación de archivos existentes
 * - Construcción de rutas de guardado
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} FileValidationResult
 * @property {boolean} valid - Si la validación fue exitosa
 * @property {string} [data] - Datos validados (ruta o nombre sanitizado)
 * @property {string} [original] - Valor original antes de validar
 * @property {string} [error] - Mensaje de error si valid es false
 */

/**
 * @typedef {Object} FileCheckResult
 * @property {boolean} exists - Si el archivo existe
 * @property {number} [actualSize] - Tamaño actual del archivo en bytes
 * @property {number} expectedSize - Tamaño esperado en bytes
 * @property {number} [sizeDifference] - Diferencia entre tamaños
 * @property {boolean} [similarSize] - Si los tamaños son similares (dentro del margen)
 * @property {boolean} [shouldOverwrite] - Si se debe sobrescribir según reglas
 */

const BaseService = require('./BaseService');
const path = require('path');
const fs = require('fs');
const { sanitizeFilename } = require('../utils');

/**
 * Servicio de lógica de negocio para operaciones de archivos
 *
 * Implementa las reglas de negocio relacionadas con validación y manipulación
 * de rutas de archivos, nombres de archivos, y estructura de carpetas.
 *
 * @class FileService
 * @extends BaseService
 *
 * @example
 * const fileService = serviceManager.getFileService();
 *
 * // Validar ruta de archivo
 * const validation = fileService.validateFilePath('C:/Downloads/archivo.zip');
 * if (validation.valid) {
 *   console.log('Ruta válida:', validation.data);
 * }
 *
 * // Validar nombre de archivo
 * const nameValidation = fileService.validateFilename('archivo:nombre.zip');
 * if (nameValidation.valid) {
 *   console.log('Nombre sanitizado:', nameValidation.data);
 * }
 */
class FileService extends BaseService {
  /**
   * Crea una nueva instancia de FileService
   *
   * @constructor
   */
  constructor() {
    super('FileService');
  }

  /**
   * Valida una ruta de archivo según reglas de negocio
   *
   * Verifica que la ruta sea válida, la normaliza, y previene que se use
   * la raíz del sistema como ruta (seguridad).
   *
   * @param {string} filePath - Ruta de archivo a validar
   * @returns {FileValidationResult} Resultado de validación con ruta normalizada
   *
   * @example
   * // Validar ruta válida
   * const validation = fileService.validateFilePath('C:/Downloads/archivo.zip');
   * // validation.valid = true
   * // validation.data = 'C:\\Downloads\\archivo.zip' (normalizado)
   *
   * // Validar ruta inválida (raíz del sistema)
   * const invalid = fileService.validateFilePath('C:/');
   * // invalid.valid = false
   * // invalid.error = 'No se puede usar la raíz del sistema como ruta'
   */
  validateFilePath(filePath) {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return {
          valid: false,
          error: 'Ruta de archivo requerida',
        };
      }

      // Normalizar ruta
      const normalized = path.resolve(filePath);

      // Verificar que la ruta no esté vacía después de normalizar
      if (!normalized || normalized.trim().length === 0) {
        return {
          valid: false,
          error: 'Ruta de archivo inválida',
        };
      }

      // Validar que la ruta no sea el root del sistema (seguridad)
      if (normalized === path.parse(normalized).root) {
        return {
          valid: false,
          error: 'No se puede usar la raíz del sistema como ruta',
        };
      }

      return {
        valid: true,
        data: normalized,
        original: filePath,
      };
    } catch (error) {
      return this.handleError(error, 'validateFilePath');
    }
  }

  /**
   * Normaliza una ruta de archivo según reglas de negocio
   * @param {string} filePath - Ruta de archivo
   * @returns {string} - Ruta normalizada
   */
  normalizeFilePath(filePath) {
    try {
      if (!filePath || typeof filePath !== 'string') {
        return '';
      }

      // Resolver ruta absoluta
      const resolved = path.resolve(filePath);

      // Normalizar separadores según el sistema operativo
      return path.normalize(resolved);
    } catch (error) {
      this.log.warn('Error normalizando ruta de archivo:', error.message);
      return filePath || ''; // Retornar original en caso de error
    }
  }

  /**
   * Valida un nombre de archivo según reglas de negocio
   *
   * Sanitiza el nombre de archivo removiendo caracteres prohibidos, verifica
   * la longitud máxima, y asegura que el nombre no esté vacío después de sanitizar.
   *
   * @param {string} filename - Nombre de archivo a validar
   * @returns {FileValidationResult} Resultado de validación con nombre sanitizado
   *
   * @example
   * // Validar nombre válido
   * const validation = fileService.validateFilename('archivo.zip');
   * // validation.valid = true
   * // validation.data = 'archivo.zip'
   *
   * // Validar nombre con caracteres prohibidos
   * const invalid = fileService.validateFilename('archivo:nombre|test.zip');
   * // validation.valid = true
   * // validation.data = 'archivo_nombre_test.zip' (sanitizado)
   *
   * // Validar nombre demasiado largo
   * const tooLong = fileService.validateFilename('a'.repeat(300));
   * // tooLong.valid = false
   * // tooLong.error = 'Nombre de archivo demasiado largo (máximo 255 caracteres)'
   */
  validateFilename(filename) {
    try {
      if (!filename || typeof filename !== 'string') {
        return {
          valid: false,
          error: 'Nombre de archivo requerido',
        };
      }

      // Sanitizar nombre de archivo
      const sanitized = sanitizeFilename(filename);

      // Verificar que el nombre no esté vacío después de sanitizar
      if (!sanitized || sanitized.trim().length === 0) {
        return {
          valid: false,
          error: 'Nombre de archivo inválido después de sanitizar',
        };
      }

      // Validar longitud máxima
      const maxLength = 255; // Límite común de sistemas de archivos
      if (sanitized.length > maxLength) {
        return {
          valid: false,
          error: `Nombre de archivo demasiado largo (máximo ${maxLength} caracteres)`,
        };
      }

      // Validar caracteres prohibidos (ya debería estar sanitizado, pero por seguridad)
      const prohibitedChars = /[<>:"|?*\\\/]/;
      if (prohibitedChars.test(sanitized)) {
        return {
          valid: false,
          error: 'Nombre de archivo contiene caracteres prohibidos',
        };
      }

      return {
        valid: true,
        data: sanitized,
        original: filename,
      };
    } catch (error) {
      return this.handleError(error, 'validateFilename');
    }
  }

  /**
   * Construye una ruta de guardado según reglas de negocio
   *
   * Combina la ruta base con el nombre de archivo y opcionalmente una ruta relativa
   * para preservar la estructura de carpetas. Valida y sanitiza todos los componentes
   * de la ruta antes de construir la ruta final.
   *
   * @param {string} basePath - Ruta base de descarga (ej: 'C:/Downloads')
   * @param {string} filename - Nombre del archivo (ej: 'archivo.zip')
   * @param {boolean} [preserveStructure=true] - Si debe preservar estructura de carpetas
   * @param {string} [relativePath=''] - Ruta relativa para estructura de carpetas (ej: 'Sistema/Software')
   * @returns {Object} Resultado con ruta construida: { success: boolean, savePath?: string, error?: string }
   *
   * @example
   * // Ruta simple sin estructura
   * const result1 = fileService.buildSavePath(
   *   'C:/Downloads',
   *   'archivo.zip',
   *   false
   * );
   * // result1.success = true
   * // result1.savePath = 'C:/Downloads/archivo.zip'
   *
   * // Ruta con estructura de carpetas
   * const result2 = fileService.buildSavePath(
   *   'C:/Downloads',
   *   'archivo.zip',
   *   true,
   *   'Sistema/Software'
   * );
   * // result2.success = true
   * // result2.savePath = 'C:/Downloads/Sistema/Software/archivo.zip'
   */
  buildSavePath(basePath, filename, preserveStructure = true, relativePath = '') {
    try {
      // Validar ruta base
      const baseValidation = this.validateFilePath(basePath);
      if (!baseValidation.valid) {
        return {
          success: false,
          error: baseValidation.error,
        };
      }

      const normalizedBase = baseValidation.data;

      // Validar nombre de archivo
      const filenameValidation = this.validateFilename(filename);
      if (!filenameValidation.valid) {
        return {
          success: false,
          error: filenameValidation.error,
        };
      }

      const sanitizedFilename = filenameValidation.data;

      // Construir ruta completa
      let savePath = normalizedBase;

      // Si preserveStructure y hay relativePath, incluir estructura de carpetas
      if (preserveStructure && relativePath) {
        // Validar y sanitizar cada segmento de la ruta relativa
        const segments = relativePath
          .split(path.sep)
          .map(segment => {
            const validation = this.validateFilename(segment);
            return validation.valid ? validation.data : null;
          })
          .filter(segment => segment !== null && segment.length > 0);

        if (segments.length > 0) {
          savePath = path.join(savePath, ...segments);
        }
      }

      // Agregar nombre de archivo
      savePath = path.join(savePath, sanitizedFilename);

      // Normalizar ruta final
      savePath = this.normalizeFilePath(savePath);

      return {
        success: true,
        savePath,
        basePath: normalizedBase,
        filename: sanitizedFilename,
        directory: path.dirname(savePath),
      };
    } catch (error) {
      return this.handleError(error, 'buildSavePath');
    }
  }

  /**
   * Prepara un directorio para guardar archivos según reglas de negocio
   * @param {string} directoryPath - Ruta del directorio
   * @returns {Object} - Resultado de la operación
   */
  async prepareDirectory(directoryPath) {
    try {
      // Validar ruta
      const validation = this.validateFilePath(directoryPath);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      const normalizedPath = validation.data;

      // Verificar si el directorio ya existe
      try {
        const stats = await fs.promises.stat(normalizedPath);
        if (!stats.isDirectory()) {
          return {
            success: false,
            error: require('../constants/validations').VALIDATIONS.PATH.NOT_A_DIRECTORY,
          };
        }

        // Verificar permisos de escritura
        try {
          await fs.promises.access(normalizedPath, fs.constants.W_OK);
        } catch (accessError) {
          return {
            success: false,
            error: 'No se tienen permisos de escritura en el directorio',
          };
        }

        return {
          success: true,
          directory: normalizedPath,
          created: false,
        };
      } catch (statError) {
        // El directorio no existe, intentar crearlo
        if (statError.code === 'ENOENT') {
          try {
            await fs.promises.mkdir(normalizedPath, { recursive: true });

            // Verificar que se creó correctamente
            const verifyStats = await fs.promises.stat(normalizedPath);
            if (!verifyStats.isDirectory()) {
              return {
                success: false,
                error: 'No se pudo crear el directorio',
              };
            }

            return {
              success: true,
              directory: normalizedPath,
              created: true,
            };
          } catch (mkdirError) {
            return {
              success: false,
              error: `Error creando directorio: ${mkdirError.message}`,
            };
          }
        }

        // Otro error al verificar
        return {
          success: false,
          error: `Error verificando directorio: ${statError.message}`,
        };
      }
    } catch (error) {
      return this.handleError(error, 'prepareDirectory');
    }
  }

  /**
   * Verifica si un archivo existe según reglas de negocio
   * @param {string} filePath - Ruta del archivo
   * @returns {Promise<Object>} - Información del archivo
   */
  async checkFileExists(filePath) {
    try {
      // Validar ruta
      const validation = this.validateFilePath(filePath);
      if (!validation.valid) {
        return {
          exists: false,
          error: validation.error,
        };
      }

      const normalizedPath = validation.data;

      try {
        const stats = await fs.promises.stat(normalizedPath);

        return {
          exists: true,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          path: normalizedPath,
          stats,
        };
      } catch (statError) {
        if (statError.code === 'ENOENT') {
          return {
            exists: false,
            path: normalizedPath,
          };
        }

        return {
          exists: false,
          error: `Error verificando archivo: ${statError.message}`,
          path: normalizedPath,
        };
      }
    } catch (error) {
      return this.handleError(error, 'checkFileExists');
    }
  }

  /**
   * Calcula información de un archivo para verificación de duplicados
   * @param {string} filePath - Ruta del archivo
   * @param {number} expectedSize - Tamaño esperado
   * @returns {Promise<Object>} - Información para verificación
   */
  async getFileCheckInfo(filePath, expectedSize = 0) {
    try {
      const fileInfo = await this.checkFileExists(filePath);

      if (!fileInfo.exists || !fileInfo.isFile) {
        return {
          exists: false,
          shouldOverwrite: false,
          sizeDifference: 0,
        };
      }

      const actualSize = fileInfo.size || 0;
      const sizeDifference = Math.abs(actualSize - expectedSize);
      const config = require('../config');
      const sizeMargin = config.files?.sizeMarginBytes || 10240; // 10KB por defecto (según config)
      const similarSize = sizeDifference <= sizeMargin;

      // Reglas de negocio:
      // - Si el archivo existe y tiene tamaño similar, considerar para sobrescritura
      // - Si el tamaño es muy diferente, puede ser un archivo diferente

      return {
        exists: true,
        shouldOverwrite: similarSize && expectedSize > 0,
        actualSize,
        expectedSize,
        sizeDifference,
        similarSize,
        path: filePath,
      };
    } catch (error) {
      this.log.warn('Error obteniendo información de archivo:', error.message);
      return {
        exists: false,
        shouldOverwrite: false,
        sizeDifference: 0,
        error: error.message,
      };
    }
  }
}

module.exports = FileService;
