/**
 * Constantes de Mensajes de Validación - Backend
 *
 * Centraliza todos los mensajes de validación usados en schemas Zod
 * y funciones de validación del backend.
 * Facilita la internacionalización futura y mantiene consistencia.
 */

// =====================
// VALIDACIONES DE BÚSQUEDA
// =====================

const SEARCH_VALIDATIONS = {
  TERM_MIN_LENGTH: 'El término de búsqueda debe tener al menos 2 caracteres',
  TERM_MAX_LENGTH: 'El término de búsqueda es demasiado largo',
};

// =====================
// VALIDACIONES DE ID
// =====================

const ID_VALIDATIONS = {
  MUST_BE_INTEGER: 'El ID debe ser un número entero',
  MUST_BE_POSITIVE: 'El ID debe ser positivo',
  DOWNLOAD_MUST_BE_INTEGER: 'El ID de descarga debe ser un número entero',
  DOWNLOAD_MUST_BE_POSITIVE: 'El ID de descarga debe ser positivo',
  DOWNLOAD_MUST_BE_POSITIVE_ALT: 'El ID debe ser un numero positivo', // Variante con "numero"
};

// =====================
// VALIDACIONES DE TÍTULO
// =====================

const TITLE_VALIDATIONS = {
  CANNOT_BE_EMPTY: 'El título no puede estar vacío',
  TOO_LONG: 'El título es demasiado largo (máximo 500 caracteres)',
};

// =====================
// VALIDACIONES DE RUTA
// =====================

const PATH_VALIDATIONS = {
  TOO_LONG: 'La ruta es demasiado larga',
  NOT_A_DIRECTORY: 'La ruta existe pero no es un directorio',
};

// =====================
// VALIDACIONES DE ARCHIVO
// =====================

const FILE_VALIDATIONS = {
  FILENAME_CANNOT_BE_EMPTY: 'El nombre de archivo no puede estar vacío',
  FILENAME_TOO_LONG: 'El nombre de archivo es demasiado largo',
  FILENAME_INVALID_FORMAT:
    'El nombre de archivo debe terminar en .json y solo contener letras, números, guiones y guiones bajos',
};

// =====================
// VALIDACIONES DE DATOS
// =====================

const DATA_VALIDATIONS = {
  MUST_BE_SERIALIZABLE: 'Los datos deben ser serializables a JSON',
};

// =====================
// VALIDACIONES GENÉRICAS
// =====================

const GENERIC_VALIDATIONS = {
  VALIDATION_ERROR: 'Error de validación',
};

// =====================
// EXPORTACIÓN
// =====================

const VALIDATIONS = {
  SEARCH: SEARCH_VALIDATIONS,
  ID: ID_VALIDATIONS,
  TITLE: TITLE_VALIDATIONS,
  PATH: PATH_VALIDATIONS,
  FILE: FILE_VALIDATIONS,
  DATA: DATA_VALIDATIONS,
  GENERIC: GENERIC_VALIDATIONS,
};

module.exports = {
  VALIDATIONS,
  SEARCH_VALIDATIONS,
  ID_VALIDATIONS,
  TITLE_VALIDATIONS,
  PATH_VALIDATIONS,
  FILE_VALIDATIONS,
  DATA_VALIDATIONS,
  GENERIC_VALIDATIONS,
};
