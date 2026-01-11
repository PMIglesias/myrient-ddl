/**
 * @fileoverview Schemas de validación usando Zod para validación robusta de parámetros IPC
 * @module schemas
 *
 * Centraliza todas las validaciones en un solo lugar para mantener consistencia.
 * Los schemas se usan en los handlers IPC para validar entrada antes de procesarla,
 * proporcionando mensajes de error claros y transformación automática de datos.
 *
 * Todos los schemas incluyen:
 * - Validación de tipos y rangos
 * - Transformación automática (trim, normalización)
 * - Mensajes de error descriptivos desde constantes
 *
 * @author Myrient Downloader
 * @version 2.0.0
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} success - Si la validación fue exitosa
 * @property {*} [data] - Datos validados y transformados (si success es true)
 * @property {string} [error] - Mensaje de error formateado (si success es false)
 */

const { z } = require('zod');
const { VALIDATIONS } = require('../constants/validations');

// Schemas de validación para operaciones relacionadas con la base de datos de índice

// Schema para validar términos de búsqueda en la base de datos
// Verifica longitud mínima y máxima, y normaliza el término removiendo espacios
const searchSchema = z.object({
  searchTerm: z
    .string()
    .min(2, VALIDATIONS.SEARCH.TERM_MIN_LENGTH)
    .max(100, VALIDATIONS.SEARCH.TERM_MAX_LENGTH)
    .transform(val => val.trim()),
});

// Schema para validar IDs de nodos en la base de datos
// Usado en múltiples handlers: get-children, get-ancestors, get-node-info
// Asegura que el ID sea un número entero positivo válido
const nodeIdSchema = z
  .number()
  .int(VALIDATIONS.ID.MUST_BE_INTEGER)
  .positive(VALIDATIONS.ID.MUST_BE_POSITIVE);

// Schemas de validación para operaciones relacionadas con descargas de archivos

// Schema para validar todos los parámetros requeridos y opcionales de una descarga
// Valida ID, título, y opcionales como ruta de descarga, preservación de estructura, y sobrescritura
const downloadParamsSchema = z.object({
  id: z
    .number()
    .int(VALIDATIONS.ID.MUST_BE_INTEGER)
    .positive(VALIDATIONS.ID.DOWNLOAD_MUST_BE_POSITIVE_ALT),

  title: z
    .string()
    .min(1, VALIDATIONS.TITLE.CANNOT_BE_EMPTY)
    .max(500, VALIDATIONS.TITLE.TOO_LONG)
    .transform(val => val.trim()),

  downloadPath: z.string().max(1000, VALIDATIONS.PATH.TOO_LONG).optional().nullable(),

  preserveStructure: z.boolean().optional().default(false),

  forceOverwrite: z.boolean().optional().default(false),
});

// Schema para validar IDs de descargas individuales
// Usado en handlers como cancel-download, pause-download, resume-download, etc.
const downloadIdSchema = z
  .number()
  .int(VALIDATIONS.ID.DOWNLOAD_MUST_BE_INTEGER)
  .positive(VALIDATIONS.ID.DOWNLOAD_MUST_BE_POSITIVE);

// Schemas de validación para operaciones con archivos de configuración

// Schema para validar nombres de archivos de configuración con restricciones de seguridad
// Previene path traversal y asegura que solo se acceda a archivos JSON con nombres seguros
const configFilenameSchema = z
  .string()
  .min(1, VALIDATIONS.FILE.FILENAME_CANNOT_BE_EMPTY)
  .max(100, VALIDATIONS.FILE.FILENAME_TOO_LONG)
  .regex(/^[a-zA-Z0-9_-]+\.json$/, VALIDATIONS.FILE.FILENAME_INVALID_FORMAT);

// Schema genérico para datos de configuración que acepta cualquier objeto JSON válido
// Verifica que los datos sean serializables a JSON para prevenir errores al guardar
const configDataSchema = z.record(z.unknown()).refine(data => {
  try {
    JSON.stringify(data);
    return true;
  } catch {
    return false;
  }
}, VALIDATIONS.DATA.MUST_BE_SERIALIZABLE);

// =====================
// FUNCIÓN DE VALIDACIÓN GENÉRICA
// =====================

/**
 * Valida datos contra un schema de Zod
 *
 * Función genérica que valida cualquier dato contra un schema de Zod y retorna
 * un resultado estandarizado. Formatea errores de Zod en mensajes legibles.
 *
 * @param {z.ZodSchema} schema - Schema de Zod a usar para validación
 * @param {*} data - Datos a validar
 * @returns {ValidationResult} Resultado de validación con datos transformados o error
 *
 * @example
 * // Validar con schema personalizado
 * const mySchema = z.string().min(5);
 * const result = validate(mySchema, 'hello');
 * // result.success = true
 * // result.data = 'hello'
 *
 * // Validar datos inválidos
 * const result2 = validate(mySchema, 'hi');
 * // result2.success = false
 * // result2.error = 'String must contain at least 5 character(s)'
 */
function validate(schema, data) {
  try {
    const result = schema.safeParse(data);

    if (result.success) {
      return {
        success: true,
        data: result.data,
      };
    } else {
      // Formatear errores de Zod de forma legible
      const errorMessages = result.error.errors.map(err => {
        const path = err.path.length > 0 ? `${err.path.join('.')}: ` : '';
        return `${path}${err.message}`;
      });

      return {
        success: false,
        error: errorMessages.join('; '),
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `${VALIDATIONS.GENERIC.VALIDATION_ERROR}: ${error.message}`,
    };
  }
}

// =====================
// FUNCIONES DE VALIDACIÓN ESPECÍFICAS
// =====================

/**
 * Valida un término de búsqueda usando schema de Zod
 *
 * Verifica que el término tenga longitud válida (2-100 caracteres) y lo normaliza
 * removiendo espacios al inicio y final. Usa el schema searchSchema configurado.
 *
 * @param {string} searchTerm - Término de búsqueda a validar
 * @returns {ValidationResult} Resultado de validación con término normalizado
 *
 * @example
 * // Validar término correcto
 * const result = validateSearch('archivo zip');
 * // result.success = true
 * // result.data = { searchTerm: 'archivo zip' } (trimmeado)
 *
 * // Validar término muy corto
 * const invalid = validateSearch('a');
 * // invalid.success = false
 * // invalid.error = 'Término de búsqueda debe tener al menos 2 caracteres'
 */
function validateSearch(searchTerm) {
  return validate(searchSchema, { searchTerm });
}

/**
 * Valida un ID de nodo usando schema de Zod
 *
 * Verifica que sea un número entero positivo válido. Usado para validar
 * IDs de nodos, carpetas, y archivos en la base de datos de Myrient.
 *
 * @param {*} nodeId - ID de nodo a validar
 * @returns {ValidationResult} Resultado de validación con ID validado
 *
 * @example
 * // Validar ID correcto
 * const result = validateNodeId(12345);
 * // result.success = true
 * // result.data = 12345
 *
 * // Validar ID inválido
 * const invalid = validateNodeId(-1);
 * // invalid.success = false
 * // invalid.error = 'Number must be greater than 0'
 */
function validateNodeId(nodeId) {
  return validate(nodeIdSchema, nodeId);
}

/**
 * Valida parámetros de descarga usando schema de Zod
 *
 * Valida todos los parámetros requeridos y opcionales de una descarga,
 * incluyendo ID, título, ruta, y opciones. Normaliza el título (trim)
 * y aplica valores por defecto a opciones booleanas.
 *
 * @param {Object} params - Parámetros de descarga a validar
 * @returns {ValidationResult} Resultado de validación con parámetros normalizados
 *
 * @example
 * // Validar parámetros correctos
 * const result = validateDownloadParams({
 *   id: 12345,
 *   title: 'archivo.zip',
 *   downloadPath: 'C:/Downloads',
 *   preserveStructure: true
 * });
 * // result.success = true
 * // result.data = { id: 12345, title: 'archivo.zip', preserveStructure: true, forceOverwrite: false }
 *
 * // Validar parámetros inválidos
 * const invalid = validateDownloadParams({
 *   id: null,
 *   title: '',
 *   downloadPath: 'x'.repeat(2000) // Demasiado largo
 * });
 * // invalid.success = false
 * // invalid.error = 'id: Expected number, received null; title: String must contain at least 1 character(s)'
 */
function validateDownloadParams(params) {
  return validate(downloadParamsSchema, params);
}

/**
 * Valida ID de descarga
 */
function validateDownloadId(downloadId) {
  return validate(downloadIdSchema, downloadId);
}

/**
 * Valida nombre de archivo de configuración
 */
function validateConfigFilename(filename) {
  return validate(configFilenameSchema, filename);
}

/**
 * Valida datos de configuración
 */
function validateConfigData(data) {
  return validate(configDataSchema, data);
}

// =====================
// EXPORTACIONES
// =====================

module.exports = {
  // Schemas (por si se necesitan directamente)
  schemas: {
    search: searchSchema,
    nodeId: nodeIdSchema,
    downloadParams: downloadParamsSchema,
    downloadId: downloadIdSchema,
    configFilename: configFilenameSchema,
    configData: configDataSchema,
  },

  // Función genérica
  validate,

  // Funciones específicas
  validateSearch,
  validateNodeId,
  validateDownloadParams,
  validateDownloadId,
  validateConfigFilename,
  validateConfigData,
};
