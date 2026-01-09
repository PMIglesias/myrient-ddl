// Schemas de validación usando Zod para validación robusta de parámetros IPC
// Centraliza todas las validaciones en un solo lugar para mantener consistencia
// Los schemas se usan en los handlers IPC para validar entrada antes de procesarla

const { z } = require('zod');

// Schemas de validación para operaciones relacionadas con la base de datos de índice

// Schema para validar términos de búsqueda en la base de datos
// Verifica longitud mínima y máxima, y normaliza el término removiendo espacios
const searchSchema = z.object({
    searchTerm: z.string()
        .min(2, 'El término de búsqueda debe tener al menos 2 caracteres')
        .max(100, 'El término de búsqueda es demasiado largo')
        .transform(val => val.trim())
});

// Schema para validar IDs de nodos en la base de datos
// Usado en múltiples handlers: get-children, get-ancestors, get-node-info
// Asegura que el ID sea un número entero positivo válido
const nodeIdSchema = z.number()
    .int('El ID debe ser un número entero')
    .positive('El ID debe ser positivo');

// Schemas de validación para operaciones relacionadas con descargas de archivos

// Schema para validar todos los parámetros requeridos y opcionales de una descarga
// Valida ID, título, y opcionales como ruta de descarga, preservación de estructura, y sobrescritura
const downloadParamsSchema = z.object({
    id: z.number()
        .int('El ID debe ser un número entero')
        .positive('El ID debe ser un numero positivo'),
    
    title: z.string()
        .min(1, 'El título no puede estar vacío')
        .max(500, 'El título es demasiado largo (máximo 500 caracteres)')
        .transform(val => val.trim()),
    
    downloadPath: z.string()
        .max(1000, 'La ruta es demasiado larga')
        .optional()
        .nullable(),
    
    preserveStructure: z.boolean()
        .optional()
        .default(false),
    
    forceOverwrite: z.boolean()
        .optional()
        .default(false)
});

// Schema para validar IDs de descargas individuales
// Usado en handlers como cancel-download, pause-download, resume-download, etc.
const downloadIdSchema = z.number()
    .int('El ID de descarga debe ser un número entero')
    .positive('El ID de descarga debe ser positivo');

// Schemas de validación para operaciones con archivos de configuración

// Schema para validar nombres de archivos de configuración con restricciones de seguridad
// Previene path traversal y asegura que solo se acceda a archivos JSON con nombres seguros
const configFilenameSchema = z.string()
    .min(1, 'El nombre de archivo no puede estar vacío')
    .max(100, 'El nombre de archivo es demasiado largo')
    .regex(
        /^[a-zA-Z0-9_-]+\.json$/,
        'El nombre de archivo debe terminar en .json y solo contener letras, números, guiones y guiones bajos'
    );

// Schema genérico para datos de configuración que acepta cualquier objeto JSON válido
// Verifica que los datos sean serializables a JSON para prevenir errores al guardar
const configDataSchema = z.record(z.unknown())
    .refine(
        (data) => {
            try {
                JSON.stringify(data);
                return true;
            } catch {
                return false;
            }
        },
        'Los datos deben ser serializables a JSON'
    );

// =====================
// FUNCIÓN DE VALIDACIÓN GENÉRICA
// =====================

/**
 * Valida datos contra un schema de Zod
 */
function validate(schema, data) {
    try {
        const result = schema.safeParse(data);
        
        if (result.success) {
            return {
                success: true,
                data: result.data
            };
        } else {
            // Formatear errores de Zod de forma legible
            const errorMessages = result.error.errors.map(err => {
                const path = err.path.length > 0 ? `${err.path.join('.')}: ` : '';
                return `${path}${err.message}`;
            });
            
            return {
                success: false,
                error: errorMessages.join('; ')
            };
        }
    } catch (error) {
        return {
            success: false,
            error: `Error de validación: ${error.message}`
        };
    }
}

// =====================
// FUNCIONES DE VALIDACIÓN ESPECÍFICAS
// =====================

/**
 * Valida parámetros de búsqueda
 */
function validateSearch(searchTerm) {
    return validate(searchSchema, { searchTerm });
}

/**
 * Valida ID de nodo
 */
function validateNodeId(nodeId) {
    return validate(nodeIdSchema, nodeId);
}

/**
 * Valida parámetros de descarga
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
        configData: configDataSchema
    },
    
    // Función genérica
    validate,
    
    // Funciones específicas
    validateSearch,
    validateNodeId,
    validateDownloadParams,
    validateDownloadId,
    validateConfigFilename,
    validateConfigData
};
