/**
 * @fileoverview ScraperEngine - Motor de scraping web para Myrient
 * @module ScraperEngine
 *
 * Realiza scraping del sitio web de Myrient para obtener listados de directorios
 * en tiempo real. Parsea HTML y extrae información de archivos y carpetas.
 *
 * Características:
 * - Parsing robusto de tablas HTML
 * - Manejo de URLs codificadas y relativas
 * - Rate limiting para evitar baneos
 * - Fallback automático si parsing falla
 * - Extracción de metadatos (tamaño, fecha)
 *
 * @author Myrient Downloader
 * @version 1.0.0
 */

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { URL } = require('url');
const RateLimiter = require('./RateLimiter');
const { logger } = require('../../utils');
const config = require('../../config');

/**
 * Motor de scraping web para obtener datos de Myrient en tiempo real
 *
 * Parsea el HTML del sitio web de Myrient y extrae información de archivos
 * y directorios. Maneja rate limiting, errores, y proporciona fallbacks.
 *
 * @class ScraperEngine
 *
 * @example
 * const scraper = new ScraperEngine();
 * const result = await scraper.getChildren('https://myrient.erista.me/files/MAME/');
 * if (result.success) {
 *   console.log(`Encontrados ${result.data.length} elementos`);
 * }
 */
class ScraperEngine {
  /**
   * Crea una nueva instancia de ScraperEngine
   *
   * @constructor
   */
  constructor() {
    this.baseUrl = 'https://myrient.erista.me/files/';
    this.rateLimiter = new RateLimiter({
      maxConcurrent: config.scraper?.rateLimit?.maxConcurrent || 3,
      minTime: config.scraper?.rateLimit?.minTime || 500,
    });
    this.log = logger.child('ScraperEngine');
    this.userAgent =
      config.scraper?.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  /**
   * Obtiene hijos de un directorio por URL o parent_id
   *
   * Si se proporciona un parent_id numérico, primero obtiene la URL desde la DB.
   * Luego realiza el scraping del directorio y retorna los nodos encontrados.
   *
   * @param {number|string} urlOrParentId - URL del directorio o ID del nodo padre
   * @returns {Promise<Object>} Resultado con array de nodos
   * @returns {boolean} returns.success - Si la operación fue exitosa
   * @returns {Array} returns.data - Array de nodos encontrados
   * @returns {string} returns.source - 'web' (indica que viene de scraping)
   *
   * @example
   * // Obtener hijos por URL
   * const result = await scraper.getChildren('https://myrient.erista.me/files/MAME/');
   *
   * // Obtener hijos por ID (requiere DB)
   * const result = await scraper.getChildren(12345);
   */
  async getChildren(urlOrParentId) {
    let url;

    // Si es un número, es un ID - necesitamos obtener la URL
    if (typeof urlOrParentId === 'number') {
      const dbEngine = require('./DBEngine');
      const nodeInfo = await dbEngine.getNodeInfo(urlOrParentId);
      if (!nodeInfo.success || !nodeInfo.data?.url) {
        throw new Error(`No se pudo obtener URL para nodo ${urlOrParentId}`);
      }
      url = nodeInfo.data.url;
    } else {
      url = urlOrParentId;
    }

    // Normalizar URL
    if (!url.startsWith('http')) {
      url = new URL(url, this.baseUrl).href;
    }

    this.log.debug(`Scrapeando directorio: ${url}`);

    try {
      const html = await this.rateLimiter.schedule(async () => {
        return await this._fetchHTML(url);
      });

      const nodes = await this._parseDirectoryListing(html, url);

      return {
        success: true,
        data: nodes,
        source: 'web',
      };
    } catch (error) {
      this.log.error(`Error scrapeando ${url}:`, error);
      throw error;
    }
  }

  /**
   * Obtiene ancestros de un nodo desde URL
   *
   * Construye la cadena de ancestros recorriendo la ruta de la URL.
   *
   * @param {number|string} urlOrNodeId - URL del nodo o ID del nodo
   * @returns {Promise<Object>} Resultado con array de ancestros
   */
  async getAncestors(urlOrNodeId) {
    if (typeof urlOrNodeId === 'number') {
      const dbEngine = require('./DBEngine');
      return await dbEngine.getAncestors(urlOrNodeId);
    }

    const url = new URL(urlOrNodeId, this.baseUrl);
    const pathParts = url.pathname.split('/').filter(p => p);

    const ancestors = [];
    let currentPath = '';

    for (const part of pathParts) {
      currentPath += '/' + part;
      ancestors.push({
        id: null,
        title: decodeURIComponent(part),
        url: new URL(currentPath, this.baseUrl).href,
      });
    }

    return {
      success: true,
      data: ancestors,
      source: 'web',
    };
  }

  /**
   * Obtiene información de un nodo desde URL
   *
   * @param {number|string} urlOrNodeId - URL del nodo o ID del nodo
   * @returns {Promise<Object>} Resultado con información del nodo
   */
  async getNodeInfo(urlOrNodeId) {
    if (typeof urlOrNodeId === 'number') {
      const dbEngine = require('./DBEngine');
      return await dbEngine.getNodeInfo(urlOrNodeId);
    }

    const url = new URL(urlOrNodeId, this.baseUrl);
    const pathParts = url.pathname.split('/').filter(p => p);
    const title = pathParts.length > 0 ? decodeURIComponent(pathParts[pathParts.length - 1]) : 'Root';

    // Determinar tipo: si la URL termina en /, es carpeta
    const isDirectory = url.pathname.endsWith('/');

    return {
      success: true,
      data: {
        id: null,
        title: title,
        url: url.href,
        type: isDirectory ? 'folder' : 'file',
      },
      source: 'web',
    };
  }

  /**
   * Búsqueda web (no disponible en Myrient)
   *
   * Myrient no tiene búsqueda web pública, así que esta función siempre
   * lanza un error. El DataProvider debería hacer fallback a DB.
   *
   * @param {string} term - Término de búsqueda
   * @param {Object} options - Opciones de búsqueda
   * @throws {Error} Siempre lanza error indicando que búsqueda web no está disponible
   */
  async search(term, options = {}) {
    throw new Error('Búsqueda web no disponible en Myrient. Use modo DB o navegue manualmente.');
  }

  /**
   * Fetch HTML con headers apropiados
   *
   * Realiza una petición HTTP GET al URL especificado con headers
   * que simulan un navegador real para evitar bloqueos.
   *
   * @private
   * @param {string} url - URL a obtener
   * @returns {Promise<string>} HTML obtenido
   * @throws {Error} Si la petición falla o el status no es OK
   */
  async _fetchHTML(url) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: config.scraper?.timeout || 30000,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  }

  /**
   * Parsea el listado de directorio HTML de Myrient
   *
   * Estructura esperada:
   * ```html
   * <table>
   *   <tbody>
   *     <tr>
   *       <td><a href="...">Nombre</a></td>
   *       <td>Tamaño</td>
   *       <td>Fecha</td>
   *     </tr>
   *   </tbody>
   * </table>
   * ```
   *
   * @private
   * @param {string} html - HTML a parsear
   * @param {string} baseUrl - URL base para resolver URLs relativas
   * @returns {Promise<Array>} Array de nodos parseados
   */
  async _parseDirectoryListing(html, baseUrl) {
    const $ = cheerio.load(html);
    const nodes = [];
    const baseUrlObj = new URL(baseUrl);

    // Selector principal: filas de la tabla (excluyendo header)
    const rows = $('table tbody tr, table tr').filter((i, elem) => {
      // Excluir fila de header si existe
      const $row = $(elem);
      const firstCell = $row.find('td, th').first();
      return firstCell.length > 0 && !firstCell.find('a[href*="?C="]').length;
    });

    this.log.debug(`Encontradas ${rows.length} filas en el listado`);

    rows.each((i, row) => {
      try {
        const $row = $(row);
        const cells = $row.find('td');

        if (cells.length < 3) {
          this.log.debug(`Fila ${i} tiene menos de 3 celdas, omitiendo`);
          return;
        }

        // Primera celda: enlace con nombre
        const $link = cells.eq(0).find('a').first();
        if (!$link.length) {
          this.log.debug(`Fila ${i} no tiene enlace, omitiendo`);
          return;
        }

        const href = $link.attr('href');
        const linkText = $link.text().trim();

        if (!href) {
          return;
        }

        // Ignorar "Parent directory"
        if (linkText === 'Parent directory' || href === '../' || href.startsWith('../')) {
          this.log.debug(`Ignorando Parent directory`);
          return;
        }

        // Resolver URL completa
        let fullUrl;
        try {
          fullUrl = new URL(href, baseUrl).href;
        } catch (error) {
          this.log.warn(`Error resolviendo URL ${href}:`, error.message);
          return;
        }

        // Determinar si es directorio o archivo
        const isDirectory = href.endsWith('/') || fullUrl.endsWith('/');

        // Decodificar nombre (puede tener %20, %27, etc.)
        let title = linkText;
        try {
          // Intentar decodificar el texto del enlace
          title = decodeURIComponent(title);
        } catch {
          // Si falla, usar el texto tal cual
        }

        // Remover barra final del título si es directorio
        if (isDirectory && title.endsWith('/')) {
          title = title.slice(0, -1);
        }

        // Segunda celda: tamaño
        const sizeText = cells.eq(1).text().trim();
        const size = this._parseSize(sizeText);

        // Tercera celda: fecha
        const dateText = cells.eq(2).text().trim();
        const modified = this._parseDate(dateText);

        // Crear nodo
        const node = {
          id: null, // No tenemos ID en modo web
          parent_id: null,
          title: title,
          type: isDirectory ? 'folder' : 'file',
          size: size,
          modified_date: modified,
          url: fullUrl,
        };

        nodes.push(node);
        this.log.debug(`Parseado: ${node.title} (${node.type})`);

      } catch (error) {
        this.log.warn(`Error parseando fila ${i}:`, error.message);
        // Continuar con siguiente fila
      }
    });

    // Si no encontramos nada con el selector principal, intentar fallback
    if (nodes.length === 0) {
      this.log.warn('No se encontraron nodos con selector principal, intentando fallback...');
      return await this._parseDirectoryListingFallback(html, baseUrl);
    }

    // Ordenar: carpetas primero, luego archivos, ambos alfabéticamente
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return a.title.localeCompare(b.title, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });

    this.log.info(
      `Parseados ${nodes.length} nodos (${nodes.filter(n => n.type === 'folder').length} carpetas, ${nodes.filter(n => n.type === 'file').length} archivos)`
    );

    return nodes;
  }

  /**
   * Parser de fallback para estructuras HTML alternativas
   *
   * Se usa si el parser principal no encuentra resultados. Intenta
   * parsear con selectores más genéricos (listas, enlaces directos).
   *
   * @private
   * @param {string} html - HTML a parsear
   * @param {string} baseUrl - URL base para resolver URLs relativas
   * @returns {Array} Array de nodos parseados
   */
  async _parseDirectoryListingFallback(html, baseUrl) {
    const $ = cheerio.load(html);
    const nodes = [];

    // Intentar con lista
    $('ul li a, ol li a').each((i, elem) => {
      const $link = $(elem);
      const href = $link.attr('href');
      const text = $link.text().trim();

      if (!href || !text || href.startsWith('#')) {
        return;
      }

      // Ignorar Parent directory
      if (text === 'Parent directory' || href === '../') {
        return;
      }

      const isDirectory = href.endsWith('/');
      let fullUrl;
      try {
        fullUrl = new URL(href, baseUrl).href;
      } catch {
        return;
      }

      let title = text;
      if (isDirectory && title.endsWith('/')) {
        title = title.slice(0, -1);
      }

      nodes.push({
        id: null,
        parent_id: null,
        title: title,
        type: isDirectory ? 'folder' : 'file',
        size: null,
        modified_date: null,
        url: fullUrl,
      });
    });

    // Si aún no hay nada, intentar todos los enlaces
    if (nodes.length === 0) {
      $('a[href]').each((i, elem) => {
        const $link = $(elem);
        const href = $link.attr('href');
        const text = $link.text().trim();

        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.includes('?C=')) {
          return;
        }

        if (text === 'Parent directory' || href === '../') {
          return;
        }

        const isDirectory = href.endsWith('/');
        let fullUrl;
        try {
          fullUrl = new URL(href, baseUrl).href;
        } catch {
          return;
        }

        let title = text || href.split('/').filter(p => p).pop() || 'Unknown';
        if (isDirectory && title.endsWith('/')) {
          title = title.slice(0, -1);
        }

        nodes.push({
          id: null,
          parent_id: null,
          title: title,
          type: isDirectory ? 'folder' : 'file',
          size: null,
          modified_date: null,
          url: fullUrl,
        });
      });
    }

    return nodes;
  }

  /**
   * Parsea tamaño de texto a bytes
   *
   * Formatos soportados:
   * - "1.5 GB" → 1610612736 bytes
   * - "500 MB" → 524288000 bytes
   * - "1024 KB" → 1048576 bytes
   * - "1024" → 1024 bytes
   * - "-" → null (directorio)
   *
   * @private
   * @param {string} sizeText - Texto del tamaño
   * @returns {number|null} Tamaño en bytes o null si no se puede parsear
   */
  _parseSize(sizeText) {
    if (!sizeText || sizeText.trim() === '-' || sizeText.trim() === '') {
      return null;
    }

    const cleanText = sizeText.trim().toUpperCase();

    // Intentar parsear como número con unidad
    const match = cleanText.match(/^([\d.]+)\s*([KMGT]?B?)$/);
    if (match) {
      const value = parseFloat(match[1]);
      const unit = (match[2] || 'B').toUpperCase();

      const multipliers = {
        B: 1,
        KB: 1024,
        MB: 1024 * 1024,
        GB: 1024 * 1024 * 1024,
        TB: 1024 * 1024 * 1024 * 1024,
      };

      const multiplier = multipliers[unit] || 1;
      return Math.floor(value * multiplier);
    }

    // Intentar parsear como número simple (bytes)
    const numberMatch = cleanText.match(/^[\d.]+$/);
    if (numberMatch) {
      return Math.floor(parseFloat(cleanText));
    }

    this.log.debug(`No se pudo parsear tamaño: "${sizeText}"`);
    return null;
  }

  /**
   * Parsea fecha de texto a timestamp
   *
   * Formatos soportados:
   * - "02-Dec-2025 13:43" → timestamp
   * - "02-Dec-2025" → timestamp (hora 00:00)
   * - "-" → null
   *
   * @private
   * @param {string} dateText - Texto de la fecha
   * @returns {number|null} Timestamp en milisegundos o null si no se puede parsear
   */
  _parseDate(dateText) {
    if (!dateText || dateText.trim() === '-' || dateText.trim() === '') {
      return null;
    }

    const cleanText = dateText.trim();

    // Formato: "02-Dec-2025 13:43" o "02-Dec-2025"
    const dateMatch = cleanText.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (dateMatch) {
      const day = parseInt(dateMatch[1], 10);
      const monthName = dateMatch[2];
      const year = parseInt(dateMatch[3], 10);
      const hour = dateMatch[4] ? parseInt(dateMatch[4], 10) : 0;
      const minute = dateMatch[5] ? parseInt(dateMatch[5], 10) : 0;

      const monthMap = {
        JAN: 0,
        FEB: 1,
        MAR: 2,
        APR: 3,
        MAY: 4,
        JUN: 5,
        JUL: 6,
        AUG: 7,
        SEP: 8,
        OCT: 9,
        NOV: 10,
        DEC: 11,
      };

      const month = monthMap[monthName.toUpperCase()];
      if (month === undefined) {
        this.log.debug(`Mes desconocido: "${monthName}"`);
        return null;
      }

      try {
        const date = new Date(year, month, day, hour, minute, 0, 0);
        const timestamp = date.getTime();

        // Validar que la fecha es válida
        if (isNaN(timestamp)) {
          return null;
        }

        return timestamp;
      } catch (error) {
        this.log.debug(`Error parseando fecha: "${dateText}"`, error.message);
        return null;
      }
    }

    // Intentar parsear con Date nativo como fallback
    try {
      const date = new Date(cleanText);
      if (!isNaN(date.getTime())) {
        return date.getTime();
      }
    } catch {
      // Ignorar
    }

    this.log.debug(`No se pudo parsear fecha: "${dateText}"`);
    return null;
  }
}

module.exports = ScraperEngine;
