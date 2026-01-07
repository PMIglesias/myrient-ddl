<template>
  <div id="container">
    <!-- Barra de Título Personalizada -->
    <div id="titlebar" class="titlebar">
      <div class="titlebar-content">
        <button 
          v-if="currentNodeId !== 1" 
          @click="goBack" 
          class="back-btn" 
          title="Volver"
        >
          <
        </button>
        <span class="titlebar-title">Myrient Downloader</span>
        <span class="location-path" v-if="locationPath">{{ locationPath }}</span>
      </div>
      <div class="titlebar-controls">
        <div v-if="activeDownloadCount > 0" class="speed-indicator" :title="`${currentDownloadName || 'Descargando...'}${currentDownloadName ? ' - ' + activeDownloadCount + ' activa(s)' : ''}`">
          <span class="speed-icon">⬇️</span>
          <span class="speed-info">
            <span class="download-name scrolling-text">{{ currentDownloadName || 'Descargando...' }}</span>
            <span class="speed-value">{{ averageDownloadSpeed.toFixed(2) }} MB/s</span>
          </span>
        </div>
        <button @click="toggleTheme" class="titlebar-btn theme-btn" :title="isDarkMode ? 'Modo Claro' : 'Modo Oscuro'">
          {{ isDarkMode ? '☀️' : '🌙' }}
        </button>
        <button @click="openSettings" class="titlebar-btn settings-btn" title="Configuración">
          ⚙️
        </button>
        <button @click="minimizeWindow" class="titlebar-btn minimize-btn" title="Minimizar">
          -
        </button>
        <button @click="maximizeWindow" class="titlebar-btn maximize-btn" :title="isMaximized ? 'Restaurar' : 'Maximizar'">
          {{ isMaximized ? '▭' : '□' }}
        </button>
        <button @click="closeWindow" class="titlebar-btn close-btn" title="Cerrar">
          ✕
        </button>
      </div>
    </div>

    <div id="header">
      <div class="header-top">
        <h1>Myrient DDL</h1>
        <div class="header-buttons">
          <button @click="toggleFavorites" class="favorites-btn" :class="{ active: showingFavorites }">
            ⭐ Favoritos
          </button>
          <button @click="toggleDownloads" class="downloads-btn" :class="{ active: showingDownloads }">
            ⬇️ Descargas ({{ allDownloads.length }})
          </button>
          <button 
            v-if="searchResults.length > 0" 
            @click="toggleAdvancedFilters" 
            class="filters-btn" 
            :class="{ active: showAdvancedFilters }"
          >
            🔍 Filtros Avanzados
          </button>
        </div>
      </div>
      <div id="breadcrumb">
        <button 
          @click="goToRoot()" 
          :class="{ active: currentNodeId === 1 }"
          class="breadcrumb-btn"
        >
          Inicio
        </button>
        <template v-for="node in breadcrumbPath" :key="node.id">
          <span class="breadcrumb-separator">/</span>
          <button 
            @click="navigateToNode(node)" 
            class="breadcrumb-btn"
          >
            {{ node.title }}
          </button>
        </template>
      </div>
    </div>

    <div id="search-container">
      <input 
        type="text" 
        id="search-input" 
        v-model="searchTerm" 
        placeholder="Buscar en Myrient... (mínimo 3 caracteres)"
      >
      <button @click="search" :disabled="searchTerm.trim().length < 3">
        🔍 Buscar
      </button>
    </div>

    <div id="content-container">
      <!-- Sección de Favoritos -->
      <div v-if="showingFavorites && favoriteFolders.length > 0" id="favorites-section">
        <h2>Favoritos</h2>
        <div class="folders-grid">
          <div 
            v-for="folder in favoriteFolders" 
            :key="folder.id"
            class="folder-wrapper"
          >
            <button 
              @click="navigateToNode(folder)"
              class="folder-btn"
              :title="folder.title"
            >
              📁 {{ folder.title }}
            </button>
            <button 
              @click.stop="toggleFavorite(folder)"
              class="favorite-star-btn visible"
              title="Quitar de favoritos"
            >
              ⭐
            </button>
          </div>
        </div>
      </div>
      
      <div v-if="showingFavorites && favoriteFolders.length === 0" class="empty-state">
        <p>No tienes carpetas favoritas. Agrega carpetas usando la estrella al pasar el mouse sobre ellas.</p>
      </div>

      <!-- Sección de Descargas -->
      <div v-if="showingDownloads && allDownloads.length > 0" id="downloads-section">
        <div class="downloads-header">
          <h2>Lista de Descargas</h2>
          <button @click="clearDownloads" class="btn-clear-downloads" title="Limpiar lista de descargas">
            🗑️ Limpiar Lista
          </button>
        </div>
        <!-- Botones de acciones masivas -->
        <div v-if="selectedDownloads.size > 0" class="bulk-actions">
          <span class="bulk-info">{{ selectedDownloads.size }} seleccionada(s)</span>
          <button @click="confirmOverwriteAll" class="btn-bulk btn-bulk-yes">✓ Aceptar seleccionadas</button>
          <button @click="cancelOverwriteAll" class="btn-bulk btn-bulk-no">✗ Cancelar seleccionadas</button>
        </div>
        <table class="downloads-table">
          <thead>
            <tr>
              <th class="checkbox-col">
                <input 
                  type="checkbox" 
                  :checked="selectedHistoryDownloads.size === allDownloads.length && allDownloads.length > 0"
                  @change="toggleSelectAllHistoryDownloads"
                  class="checkbox-input"
                  title="Seleccionar todo"
                />
              </th>
              <th>Nombre del Archivo</th>
              <th>Proceso</th>
              <th>Estado</th>
              <th>Velocidad</th>
              <th>Fecha</th>
              <th>Ubicación</th>
              <th v-if="pendingConfirmations.length > 0">Observación</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="download in allDownloads" :key="download.id" :class="'download-row-' + download.queueStatus">
              <td class="checkbox-col">
                <input 
                  type="checkbox" 
                  :checked="selectedHistoryDownloads.has(download.id)"
                  @change="toggleSelectHistoryDownload(download.id)"
                  class="checkbox-input"
                />
              </td>
              <td class="download-name" :title="download.title">{{ download.title }}</td>
              <td class="download-process">
                <div v-if="download.queueStatus === 'downloading'" class="progress-container">
                  <progress :value="download.percent || 0" max="1"></progress>
                  <span class="progress-text">{{ getDownloadPercentage(download) }}%</span>
                </div>
                <div v-else-if="download.queueStatus === 'paused'" class="progress-container">
                  <progress :value="download.percent || 0" max="1"></progress>
                  <span class="progress-text">{{ getDownloadPercentage(download) }}%</span>
                </div>
                <span v-else-if="download.queueStatus === 'queued'">-</span>
                <span v-else-if="download.queueStatus === 'completed'">100%</span>
                <span v-else-if="download.queueStatus === 'error'">-</span>
              </td>
              <td class="download-status">
                <span v-if="download.state === 'waiting'" class="status-badge status-waiting">⏸️ Esperando confirmación</span>
                <span v-else-if="download.state === 'paused'" class="status-badge status-paused">⏸ Pausada</span>
                <span v-else-if="download.state === 'cancelled'" class="status-badge status-cancelled">⏹ Detenida</span>
                <span v-else-if="download.queueStatus === 'queued'" class="status-badge status-queued">⏳ En cola</span>
                <span v-else-if="download.queueStatus === 'downloading'" class="status-badge status-downloading">⬇️ Descargando</span>
                <span v-else-if="download.queueStatus === 'completed'" class="status-badge status-completed">✅ Completado</span>
                <span v-else-if="download.queueStatus === 'error'" class="status-badge status-error" :title="download.error">❌ Error: {{ download.error }}</span>
              </td>
              <td class="download-speed">
                <span v-if="speedStats.has(download.id)" class="speed-badge">
                  {{ speedStats.get(download.id).speed.toFixed(2) }} MB/s
                </span>
                <span v-else>-</span>
              </td>
              <td class="download-date">
                <span v-if="download.queueStatus === 'completed' && download.completedAt">
                  {{ formatDateTime(download.completedAt) }}
                </span>
                <span v-else>-</span>
              </td>
              <td class="download-location" :title="download.savePath || ''">
                {{ getDirectoryPath(download.savePath) }}
              </td>
              <td v-if="pendingConfirmations.length > 0" class="download-observation">
                <div v-if="pendingConfirmations.find(c => c.id === download.id)" class="observation-actions">
                  <div class="observation-content">
                    <span class="observation-text">Archivo existente</span>
                    <span class="observation-question">¿Sobrescribir?</span>
                  </div>
                  <button @click="confirmOverwrite(download.id)" class="obs-btn obs-btn-yes" title="Sobrescribir archivo">
                    SÍ
                  </button>
                  <button @click="cancelOverwrite(download.id)" class="obs-btn obs-btn-no" title="Cancelar descarga">
                    NO
                  </button>
                </div>
                <span v-else>-</span>
              </td>
              <td class="download-actions">
                <div v-if="download.queueStatus === 'downloading' || download.queueStatus === 'queued'" class="action-buttons">
                  <button 
                    v-if="!pendingConfirmations.find(c => c.id === download.id) && download.queueStatus === 'downloading'"
                    @click="pauseDownload(download.id)"
                    class="btn-action btn-pause"
                    title="Pausar descarga"
                  >
                    ⏸
                  </button>
                  <button 
                    v-if="!pendingConfirmations.find(c => c.id === download.id)"
                    @click="cancelDownload(download.id)"
                    class="btn-action btn-stop"
                    title="Detener y eliminar"
                  >
                    ⏹
                  </button>
                </div>
                <div v-else-if="download.state === 'paused'" class="action-buttons">
                  <button 
                    @click="resumeDownload(download.id)"
                    class="btn-action btn-resume"
                    title="Reanudar descarga"
                  >
                    ▶
                  </button>
                  <button 
                    @click="cancelDownload(download.id)"
                    class="btn-action btn-stop"
                    title="Detener y eliminar"
                  >
                    ⏹
                  </button>
                </div>
                <div v-else class="action-buttons">
                  <button 
                    v-if="download.state === 'cancelled' || download.state === 'interrupted'"
                    @click="restartDownload(download.id)"
                    class="btn-action btn-resume"
                    title="Reiniciar descarga"
                  >
                    ▶
                  </button>
                  <button 
                    @click="removeDownload(download.id)"
                    class="btn-action btn-delete"
                    title="Eliminar del listado"
                  >
                    🗑
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      
      <!-- Botones de acciones masivas en historial -->
      <div v-if="showingDownloads && selectedHistoryDownloads.size > 0" class="bulk-actions">
        <span class="bulk-info">{{ selectedHistoryDownloads.size }} descarga(s) seleccionada(s)</span>
        <button @click="deleteSelectedDownloads" class="btn-bulk btn-bulk-no">
          🗑 Eliminar seleccionadas
        </button>
      </div>
      
      <div v-if="showingDownloads && allDownloads.length === 0" class="empty-state">
        <p>No hay descargas.</p>
      </div>

      <!-- Sección de Carpetas (Botones) -->
      <div v-if="!showingFavorites && !showingDownloads && folders.length > 0 && searchResults.length === 0" id="folders-section">
        <h2>Carpetas</h2>
        <div class="folders-grid">
          <div 
            v-for="folder in folders" 
            :key="folder.id"
            class="folder-wrapper"
          >
            <button 
              @click="navigateToNode(folder)"
              class="folder-btn"
              :title="folder.title"
            >
              📁 {{ folder.title }}
            </button>
            <button 
              @click.stop="toggleFavorite(folder)"
              class="favorite-star-btn"
              :class="{ active: isFavorite(folder.id), disabled: isFavorite(folder.id) }"
              :title="isFavorite(folder.id) ? 'Quitar de favoritos' : 'Agregar a favoritos'"
            >
              {{ isFavorite(folder.id) ? '⭐' : '☆' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Sección de Archivos (Tabla) -->
      <div v-if="!showingFavorites && !showingDownloads && files.length > 0 && searchResults.length === 0" id="files-section">
        <div class="files-header">
          <h2>Archivos</h2>
          <button 
            v-if="selectedFiles.length > 0" 
            @click="downloadSelected" 
            class="download-selected-btn"
          >
            📥 Descargar seleccionados ({{ selectedFiles.length }})
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th class="checkbox-col">
                <input 
                  type="checkbox" 
                  :checked="selectedFiles.length === files.length && files.length > 0"
                  @change="toggleSelectAll"
                  title="Seleccionar todos"
                />
              </th>
              <th>Nombre</th>
              <th>Fecha Modificación</th>
              <th>Tamaño</th>
              <th>Descargar</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="file in files" :key="file.id">
              <td class="checkbox-col">
                <input 
                  type="checkbox" 
                  :checked="selectedFiles.includes(file.id)"
                  @change="toggleFileSelection(file.id)"
                />
              </td>
              <td :title="file.title">{{ file.title }}</td>
              <td>{{ formatDate(file.modified_date) }}</td>
              <td>{{ file.size || '-' }}</td>
              <td>
                <button @click="download(file)" :disabled="downloads[file.id] && downloads[file.id].state !== 'interrupted'">
                  {{ getDownloadButtonText(file.id) }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Mensaje cuando no hay contenido -->
      <div v-if="!showingFavorites && !showingDownloads && folders.length === 0 && files.length === 0 && searchResults.length === 0" class="empty-state">
        <p>No hay carpetas ni archivos en esta ubicación.</p>
      </div>

      <!-- Resultados de búsqueda -->
      <div v-if="!showingFavorites && !showingDownloads && searchResults.length > 0" id="search-results">
        <h2>Resultados de búsqueda</h2>
        
        <!-- Carpetas encontradas como botones -->
        <div v-if="searchFolders.length > 0" class="search-folders-section">
          <h3>Carpetas</h3>
          <div class="folders-grid">
            <div 
              v-for="folder in searchFolders" 
              :key="folder.id"
              class="folder-wrapper"
            >
              <button 
                @click="navigateToNode(folder)"
                class="folder-btn search-folder-btn"
                :title="folder.displayTitle || folder.title"
              >
                <span v-if="folder.breadcrumbPath" class="folder-breadcrumb">{{ folder.breadcrumbPath }}/</span>
                <span class="folder-name">📁 {{ folder.title }}</span>
              </button>
              <button 
                @click.stop="toggleFavorite(folder)"
                class="favorite-star-btn"
                :class="{ active: isFavorite(folder.id), disabled: isFavorite(folder.id) }"
                :title="isFavorite(folder.id) ? 'Quitar de favoritos' : 'Agregar a favoritos'"
              >
                {{ isFavorite(folder.id) ? '⭐' : '☆' }}
              </button>
            </div>
          </div>
        </div>
        
        <!-- Archivos encontrados como tabla -->
        <div v-if="searchFiles.length > 0" class="search-files-section">
          <div class="files-header">
            <h3>Archivos</h3>
            <button 
              v-if="selectedSearchFiles.length > 0" 
              @click="downloadSelectedSearch" 
              class="download-selected-btn"
            >
              📥 Descargar seleccionados ({{ selectedSearchFiles.length }})
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th class="checkbox-col">
                  <input 
                    type="checkbox" 
                    :checked="selectedSearchFiles.length === searchFiles.length && searchFiles.length > 0"
                    @change="toggleSelectAllSearch"
                    title="Seleccionar todos"
                  />
                </th>
                <th @click="sortField = 'title'; sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'" class="sortable">
                  Nombre
                  <span class="sort-arrow" v-if="sortField === 'title'">
                    {{ sortDirection === 'asc' ? '↑' : '↓' }}
                  </span>
                </th>
                <th @click="sortField = 'fullPath'; sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'" class="sortable">
                  Ubicación
                  <span class="sort-arrow" v-if="sortField === 'fullPath'">
                    {{ sortDirection === 'asc' ? '↑' : '↓' }}
                  </span>
                </th>
                <th @click="sortField = 'modified_date'; sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'" class="sortable">
                  Fecha Modificación
                  <span class="sort-arrow" v-if="sortField === 'modified_date'">
                    {{ sortDirection === 'asc' ? '↑' : '↓' }}
                  </span>
                </th>
                <th @click="sortField = 'size'; sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'" class="sortable">
                  Tamaño
                  <span class="sort-arrow" v-if="sortField === 'size'">
                    {{ sortDirection === 'asc' ? '↑' : '↓' }}
                  </span>
                </th>
                <th>Descargar</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="file in searchFiles" :key="file.id">
                <td class="checkbox-col">
                  <input 
                    type="checkbox" 
                    :checked="selectedSearchFiles.includes(file.id)"
                    @change="toggleSearchFileSelection(file.id)"
                  />
                </td>
                <td :title="file.title">{{ file.title }}</td>
                <td class="location-cell" :title="file.fullPath || ''">{{ file.fullPath || '-' }}</td>
                <td>{{ formatDate(file.modified_date) }}</td>
                <td class="size-cell">{{ formatSize(file.size) }}</td>
                <td>
                  <button @click="download(file)" :disabled="downloads[file.id] && downloads[file.id].state !== 'interrupted'">
                    {{ getDownloadButtonText(file.id) }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="statusMessage" class="status-message">{{ statusMessage }}</div>
    </div>

    <!-- Panel de Configuración (Lado Derecho) -->
    <div v-if="showSettings" class="settings-overlay" @click="showSettings = false"></div>
    <div v-if="showSettings" class="settings-panel">
      <div class="settings-header">
        <h2>⚙️ Configuración</h2>
        <button @click="showSettings = false" class="close-modal-btn">✕</button>
      </div>
      
      <div class="settings-body">
        <div class="settings-section">
          <h3>Búsqueda</h3>
          <div class="setting-item">
            <label>Límite de resultados</label>
            <div class="setting-control">
              <input 
                type="number" 
                v-model.number="searchLimit" 
                min="100" 
                max="2000" 
                step="100"
                class="number-input"
              />
              <span class="setting-hint">Resultados máximos por búsqueda</span>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>Descargas</h3>
          <div class="setting-item">
            <label>Carpeta de destino</label>
            <div class="setting-control">
              <div class="path-input-group">
                <input 
                  type="text" 
                  v-model="downloadPath" 
                  @blur="saveDownloadSettings"
                  class="path-input"
                  placeholder="Ej: C:\Descargas"
                />
                <button @click="selectDownloadFolder" class="select-folder-btn">
                  📁 Seleccionar
                </button>
              </div>
              <span class="setting-hint">Ruta donde se guardarán los archivos</span>
            </div>
          </div>
          <div class="setting-item">
            <label class="checkbox-label">
              <input 
                type="checkbox" 
                v-model="preserveStructure"
                @change="saveDownloadSettings"
                class="checkbox-input"
              />
              Mantener estructura de carpetas
            </label>
            <span class="setting-hint">Si está activado, se recreará la estructura de directorios</span>
          </div>
          <div class="setting-item">
            <label>Descargas en paralelo</label>
            <div class="setting-control">
              <input 
                type="number" 
                v-model.number="maxParallelDownloads" 
                @blur="saveDownloadSettings"
                min="1" 
                max="3" 
                step="1"
                class="number-input"
              />
              <span class="setting-hint">Máximo permitido: 3 descargas simultáneas</span>
            </div>
          </div>
          <div class="setting-item">
            <label class="checkbox-label">
              <input 
                type="checkbox" 
                v-model="showNotifications"
                @change="saveDownloadSettings"
                class="checkbox-input"
              />
              Mostrar notificaciones de archivos existentes
            </label>
            <span class="setting-hint">Muestra alertas cuando el archivo ya existe</span>
          </div>
        </div>

        <div class="settings-section">
          <h3>Almacenamiento</h3>
          <div class="setting-item">
            <label>Favoritos</label>
            <div class="setting-control">
              <button @click="clearFavorites" class="danger-btn">
                🗑️ Limpiar todos los favoritos
              </button>
              <span class="setting-hint">{{ favorites.length }} favorito(s) guardado(s)</span>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>Información</h3>
          <div class="setting-item">
            <label>Versión</label>
            <div class="setting-control">
              <span>Myrient Downloader v1.0.0</span>
            </div>
          </div>
          <div class="setting-item">
            <label>Última actualización</label>
            <div class="setting-control">
              <span>{{ lastUpdateDate ? formatDate(lastUpdateDate) : 'Cargando...' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Panel de Filtros Avanzados (Lado Derecho) -->
    <div v-if="showAdvancedFilters" class="filters-overlay" @click="showAdvancedFilters = false"></div>
    <div v-if="showAdvancedFilters" class="filters-panel">
      <div class="filters-header">
        <h2>🔍 Filtros Avanzados</h2>
        <button @click="showAdvancedFilters = false" class="close-modal-btn">[x]</button>
      </div>
      
      <div class="filters-body">
        <!-- Gestión de Presets -->
        <div class="filters-section presets-section">
          <h3>Presets Guardados</h3>
          <div class="preset-controls">
            <select v-model="currentFilterPreset" @change="loadPreset" class="preset-select">
              <option value="">Seleccionar un preset...</option>
              <option v-for="(preset, name) in filterPresets" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
            <div class="preset-save">
              <input 
                type="text" 
                v-model="currentFilterPreset" 
                placeholder="Nombre del preset"
                class="preset-name-input"
              />
              <button @click="savePreset" class="btn-save-preset">💾 Guardar</button>
            </div>
          </div>
        </div>

        <!-- Filtro por Texto -->
        <div class="filters-section">
          <h3>Filtro por Texto</h3>
          
          <!-- Inclusión de texto -->
          <div class="filter-subsection">
            <h4>✅ Incluir archivos que contengan:</h4>
            <div class="text-filter-input">
              <input 
                type="text" 
                v-model="tempIncludeText"
                @keydown.enter="addIncludeText"
                placeholder="Ej: Deluxe, Complete"
                class="text-input"
              />
              <button @click="addIncludeText" class="btn-add">Añadir</button>
            </div>
            <div v-if="advancedFilters.includeText.length > 0" class="text-list">
              <div v-for="(text, index) in advancedFilters.includeText" :key="index" class="text-item">
                <span>{{ text }}</span>
                <button @click="removeIncludeText(index)" class="btn-remove">[x]</button>
              </div>
              <button @click="advancedFilters.includeText = []" class="btn-clear-list">Limpiar lista</button>
            </div>
            <div v-else class="empty-list">No hay frases para incluir</div>
          </div>

          <!-- Exclusión de texto -->
          <div class="filter-subsection">
            <h4>❌ Excluir archivos que contengan:</h4>
            <div class="text-filter-input">
              <input 
                type="text" 
                v-model="tempExcludeText"
                @keydown.enter="addExcludeText"
                placeholder="Ej: Beta, Demo"
                class="text-input"
              />
              <button @click="addExcludeText" class="btn-add">Añadir</button>
            </div>
            <div v-if="advancedFilters.excludeText.length > 0" class="text-list">
              <div v-for="(text, index) in advancedFilters.excludeText" :key="index" class="text-item">
                <span>{{ text }}</span>
                <button @click="removeExcludeText(index)" class="btn-remove">[x]</button>
              </div>
              <button @click="advancedFilters.excludeText = []" class="btn-clear-list">Limpiar lista</button>
            </div>
            <div v-else class="empty-list">No hay frases para excluir</div>
          </div>
        </div>

        <!-- Filtro por Etiquetas -->
        <div class="filters-section">
          <h3>Filtro por Etiquetas</h3>
          
          <!-- Regiones -->
          <div class="filter-category">
            <h4>🌍 Regiones ({{ availableTags.regions.length }})</h4>
            <div class="tag-panels">
              <div class="tag-panel">
                <div class="panel-header">
                  <span>✅ Incluir</span>
                  <button @click="selectAllTags('regions', 'include')" class="btn-select-all">Todos</button>
                </div>
                <div class="tag-list">
                  <label v-for="tag in availableTags.regions" :key="tag" class="tag-checkbox">
                    <input 
                      type="checkbox" 
                      :value="tag"
                      v-model="advancedFilters.includeTags.regions"
                      :disabled="advancedFilters.excludeTags.regions.includes(tag)"
                    />
                    <span>{{ tag }}</span>
                  </label>
                </div>
              </div>
              <div class="tag-panel">
                <div class="panel-header">
                  <span>❌ Excluir</span>
                  <button @click="selectAllTags('regions', 'exclude')" class="btn-select-all">Todos</button>
                </div>
                <div class="tag-list">
                  <label v-for="tag in availableTags.regions" :key="tag" class="tag-checkbox">
                    <input 
                      type="checkbox" 
                      :value="tag"
                      v-model="advancedFilters.excludeTags.regions"
                      :disabled="advancedFilters.includeTags.regions.includes(tag)"
                    />
                    <span>{{ tag }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- Idiomas -->
          <div class="filter-category">
            <h4>🗣️ Idiomas ({{ availableTags.languages.length }})</h4>
            <div class="tag-panels">
              <div class="tag-panel">
                <div class="panel-header">
                  <span>✅ Incluir</span>
                  <button @click="selectAllTags('languages', 'include')" class="btn-select-all">Todos</button>
                </div>
                <div class="tag-list">
                  <label v-for="tag in availableTags.languages" :key="tag" class="tag-checkbox">
                    <input 
                      type="checkbox" 
                      :value="tag"
                      v-model="advancedFilters.includeTags.languages"
                      :disabled="advancedFilters.excludeTags.languages.includes(tag)"
                    />
                    <span>{{ tag }}</span>
                  </label>
                </div>
              </div>
              <div class="tag-panel">
                <div class="panel-header">
                  <span>❌ Excluir</span>
                  <button @click="selectAllTags('languages', 'exclude')" class="btn-select-all">Todos</button>
                </div>
                <div class="tag-list">
                  <label v-for="tag in availableTags.languages" :key="tag" class="tag-checkbox">
                    <input 
                      type="checkbox" 
                      :value="tag"
                      v-model="advancedFilters.excludeTags.languages"
                      :disabled="advancedFilters.includeTags.languages.includes(tag)"
                    />
                    <span>{{ tag }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- Versiones -->
          <div class="filter-category">
            <h4>📦 Versiones ({{ availableTags.versions.length }})</h4>
            <div class="tag-panels">
              <div class="tag-panel">
                <div class="panel-header">
                  <span>✅ Incluir</span>
                  <button @click="selectAllTags('versions', 'include')" class="btn-select-all">Todos</button>
                </div>
                <div class="tag-list">
                  <label v-for="tag in availableTags.versions" :key="tag" class="tag-checkbox">
                    <input 
                      type="checkbox" 
                      :value="tag"
                      v-model="advancedFilters.includeTags.versions"
                      :disabled="advancedFilters.excludeTags.versions.includes(tag)"
                    />
                    <span>{{ tag }}</span>
                  </label>
                </div>
              </div>
              <div class="tag-panel">
                <div class="panel-header">
                  <span>❌ Excluir</span>
                  <button @click="selectAllTags('versions', 'exclude')" class="btn-select-all">Todos</button>
                </div>
                <div class="tag-list">
                  <label v-for="tag in availableTags.versions" :key="tag" class="tag-checkbox">
                    <input 
                      type="checkbox" 
                      :value="tag"
                      v-model="advancedFilters.excludeTags.versions"
                      :disabled="advancedFilters.includeTags.versions.includes(tag)"
                    />
                    <span>{{ tag }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- Otros -->
          <div class="filter-category">
            <h4>🏷️ Otros ({{ availableTags.other.length }})</h4>
            <div class="tag-panels">
              <div class="tag-panel">
                <div class="panel-header">
                  <span>✅ Incluir</span>
                  <button @click="selectAllTags('other', 'include')" class="btn-select-all">Todos</button>
                </div>
                <div class="tag-list">
                  <label v-for="tag in availableTags.other" :key="tag" class="tag-checkbox">
                    <input 
                      type="checkbox" 
                      :value="tag"
                      v-model="advancedFilters.includeTags.other"
                      :disabled="advancedFilters.excludeTags.other.includes(tag)"
                    />
                    <span>{{ tag }}</span>
                  </label>
                </div>
              </div>
              <div class="tag-panel">
                <div class="panel-header">
                  <span>❌ Excluir</span>
                  <button @click="selectAllTags('other', 'exclude')" class="btn-select-all">Todos</button>
                </div>
                <div class="tag-list">
                  <label v-for="tag in availableTags.other" :key="tag" class="tag-checkbox">
                    <input 
                      type="checkbox" 
                      :value="tag"
                      v-model="advancedFilters.excludeTags.other"
                      :disabled="advancedFilters.includeTags.other.includes(tag)"
                    />
                    <span>{{ tag }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Estadísticas -->
        <div class="filters-section stats-section">
          <h3>📊 Estadísticas</h3>
          <div class="filter-stats">
            <div class="stat-item">
              <span class="stat-label">Total encontrados:</span>
              <span class="stat-value">{{ searchResults.length }}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Después de filtros:</span>
              <span class="stat-value">{{ filteredSearchResults.length }}</span>
            </div>
          </div>
          <button @click="clearAllFilters" class="btn-clear-filters">🗑️ Limpiar todos los filtros</button>
        </div>
      </div>
    </div>

    <!-- Notificaciones laterales de confirmación -->
    <div class="confirmation-notifications">
      <transition-group name="slide-fade">
        <div 
          v-for="confirmation in pendingConfirmations.filter(c => c.showNotification)" 
          :key="confirmation.id" 
          class="confirmation-toast"
        >
          <div class="toast-content">
            <div class="toast-title-line">
              <div class="toast-title-left">
                <span class="toast-icon">⚠️</span>
                <span class="toast-label">Archivo existente</span>
              </div>
              <span class="toast-filename">{{ confirmation.title }}</span>
            </div>
            <div class="toast-sizes-line">
              <span class="size-description">{{ getSizeComparison(confirmation.existingSize, confirmation.expectedSize) }}</span>
            </div>
            <div class="toast-actions-line">
              <span class="toast-question">¿Sobrescribir?</span>
              <button @click="confirmOverwrite(confirmation.id)" class="toast-btn toast-btn-yes">
                [v] SÍ
              </button>
              <button @click="cancelOverwrite(confirmation.id)" class="toast-btn toast-btn-no">
                ✗ NO
              </button>
            </div>
          </div>
        </div>

        <!-- Confirmación de limpieza de lista -->
        <div 
          v-if="clearListConfirmation" 
          key="clear-list-confirmation"
          class="confirmation-toast clear-list-toast"
        >
          <div class="toast-content">
            <div class="toast-title-line">
              <div class="toast-title-left">
                <span class="toast-icon">🗑</span>
                <span class="toast-label">Limpiar lista</span>
              </div>
              <span class="toast-filename">Descargas</span>
            </div>
            <div class="toast-sizes-line">
              <span class="size-description">Se eliminarán todos los registros de descargas</span>
            </div>
            <div class="toast-actions-line">
              <span class="toast-question">¿Estás seguro?</span>
              <button @click="confirmClearDownloads" class="toast-btn toast-btn-yes">
                [v] SÍ
              </button>
              <button @click="cancelClearDownloads" class="toast-btn toast-btn-no">
                ✗ NO
              </button>
            </div>
          </div>
        </div>
      </transition-group>
    </div>

  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';

const currentNodeId = ref(1);  // Comienza en el nodo raíz
const currentParentId = ref(null); // Para almacenar el parent_id del nodo actual
const allChildren = ref([]);
const downloads = ref({});
const searchTerm = ref('');
const searchResults = ref([]);
const statusMessage = ref('');
const breadcrumbPath = ref([]);
const isDarkMode = ref(true);
const isMaximized = ref(false);
const showingFavorites = ref(false);
const showingDownloads = ref(false);
const selectedDownloads = ref(new Set()); // Descargas seleccionadas
const selectedHistoryDownloads = ref(new Set()); // Descargas del historial seleccionadas
const selectAllHistoryDownloads = ref(false); // Checkbox para seleccionar todo el historial
const selectAllDownloads = ref(false); // Checkbox de seleccionar todo
const favorites = ref([]);
const sortField = ref('title'); // Campo para ordenar
const sortDirection = ref('asc'); // 'asc' o 'desc'
const showSettings = ref(false);
const searchLimit = ref(500);
const totalRecords = ref(2971946);
const lastUpdateDate = ref(null);
const maxParallelDownloads = ref(3);
const downloadQueue = ref([]);
const downloadPath = ref('');
const preserveStructure = ref(true);
const showNotifications = ref(true);
const speedStats = ref(new Map()); // Map para almacenar velocidades: {downloadId: {speed, totalBytes, downloadedBytes, remainingTime}}
const currentDownloadIndex = ref(0); // Índice para rotar descargas en el titlebar
const pendingConfirmations = ref([]);
const clearListConfirmation = ref(false); // Confirmación para limpiar lista

// Estado para filtros avanzados
const showAdvancedFilters = ref(false);
const advancedFilters = ref({
  includeText: [],
  excludeText: [],
  includeTags: {
    regions: [],
    languages: [],
    versions: [],
    other: []
  },
  excludeTags: {
    regions: [],
    languages: [],
    versions: [],
    other: []
  }
});
const currentFilterPreset = ref('');
const filterPresets = ref({});
const tempIncludeText = ref('');
const tempExcludeText = ref('');

// Selección múltiple de archivos
const selectedFiles = ref([]);
const selectedSearchFiles = ref([]);

// ========== FIX MEMORY LEAK: Gestión centralizada de timeouts ==========

// Set para almacenar todos los timeouts activos
const activeTimeouts = new Set();

// Flag para saber si el componente está montado
let isMounted = false;

// Función helper para crear timeouts seguros que se auto-limpian
const safeSetTimeout = (callback, delay) => {
  const timeoutId = setTimeout(() => {
    activeTimeouts.delete(timeoutId);
    // Solo ejecutar si el componente sigue montado
    if (isMounted) {
      callback();
    }
  }, delay);
  activeTimeouts.add(timeoutId);
  return timeoutId;
};

// Función helper para limpiar un timeout específico
const safeClearTimeout = (timeoutId) => {
  if (timeoutId) {
    clearTimeout(timeoutId);
    activeTimeouts.delete(timeoutId);
  }
};

// Función para limpiar todos los timeouts pendientes
const clearAllTimeouts = () => {
  activeTimeouts.forEach(timeoutId => {
    clearTimeout(timeoutId);
  });
  activeTimeouts.clear();
};

// ========== Variables para cleanup (anteriores) ==========

let rotationInterval = null;
let removeDownloadProgressListener = null;
let searchTimeout = null;
let reconciliationInterval = null; // Para sincronizacion periodica con backend

// ========== FIX RACE CONDITIONS: Sistema de cola con Promise-based locking ==========

// Promise que representa el procesamiento actual de la cola
let queueProcessPromise = null;

// Timeout para debounce de procesamiento
let queueProcessTimeout = null;

// Contador de version para detectar cambios durante el procesamiento
let queueVersion = 0;

// Set para trackear IDs de descargas que estan siendo iniciadas (evita duplicados)
const startingDownloads = new Set();

// ========== FUNCIONES ==========

// Cargar favoritos desde archivo JSON
const loadFavorites = async () => {
  try {
    const result = await window.api.readConfigFile('favorites.json');
    if (result.success && result.data) {
      favorites.value = result.data;
    } else {
      favorites.value = [];
    }
  } catch (error) {
    console.error('Error cargando favoritos:', error);
    favorites.value = [];
  }
};

// Guardar favoritos
const saveFavorites = async () => {
  try {
    await window.api.writeConfigFile('favorites.json', favorites.value);
  } catch (error) {
    console.error('Error guardando favoritos:', error);
  }
};

// Cargar configuración de descargas desde archivo JSON
const loadDownloadSettings = async () => {
  try {
    const result = await window.api.readConfigFile('download-settings.json');
    if (result.success && result.data) {
      downloadPath.value = result.data.downloadPath || '';
      preserveStructure.value = result.data.preserveStructure !== false;
      showNotifications.value = result.data.showNotifications !== false;
      maxParallelDownloads.value = result.data.maxParallelDownloads || 3;
    }
  } catch (error) {
    console.error('Error cargando configuración de descargas:', error);
  }
};

// Guardar configuración de descargas
const saveDownloadSettings = async () => {
  try {
    await window.api.writeConfigFile('download-settings.json', {
      downloadPath: downloadPath.value,
      preserveStructure: preserveStructure.value,
      showNotifications: showNotifications.value,
      maxParallelDownloads: maxParallelDownloads.value
    });
  } catch (error) {
    console.error('Error guardando configuración de descargas:', error);
  }
};

// Cargar historial de descargas
const loadDownloadHistory = async () => {
  try {
    const result = await window.api.readConfigFile('download-history.json');
    if (result.success && result.data) {
      downloads.value = result.data;
      
      // FIX ESTADO INCONSISTENTE: Sincronizar estado inicial con el backend
      // Cualquier descarga que estaba "activa" al cerrar la app ahora está interrumpida
      Object.values(downloads.value).forEach(download => {
        if (download.state === 'progressing' || download.state === 'starting') {
          console.log(`[Init] Marcando descarga ${download.id} como interrumpida (estaba activa al cerrar)`);
          download.state = 'interrupted';
          download.error = 'Descarga interrumpida al cerrar la aplicación';
        }
        // Limpiar estados temporales
        if (download.state === 'queued') {
          console.log(`[Init] Limpiando estado queued de ${download.id}`);
          // Mantener como queued pero asegurar que no esté en estructuras obsoletas
        }
      });
      
      // Guardar el estado corregido
      await saveDownloadHistory();
    }
  } catch (error) {
    console.error('Error cargando historial de descargas:', error);
  }
};

// Guardar historial de descargas
const saveDownloadHistory = async () => {
  try {
    // ✅ FIX: Sanitizar datos antes de guardar para evitar errores de serialización
    const sanitizedDownloads = {};
    
    for (const [id, download] of Object.entries(downloads.value)) {
      // Solo guardar propiedades serializables
      sanitizedDownloads[id] = {
        id: download.id,
        title: download.title,
        state: download.state,
        percent: download.percent || 0,
        error: download.error || null,
        savePath: download.savePath || null,
        completedAt: download.completedAt || null,
        addedAt: download.addedAt || null
      };
    }
    
    await window.api.writeConfigFile('download-history.json', sanitizedDownloads);
  } catch (error) {
    console.error('Error guardando historial de descargas:', error);
  }
};

// Cargar presets de filtros
const loadFilterPresets = async () => {
  try {
    const result = await window.api.readConfigFile('filter-presets.json');
    if (result.success && result.data) {
      filterPresets.value = result.data;
    }
  } catch (error) {
    console.error('Error cargando presets de filtros:', error);
  }
};

// Guardar presets de filtros
const saveFilterPresets = async () => {
  try {
    await window.api.writeConfigFile('filter-presets.json', filterPresets.value);
  } catch (error) {
    console.error('Error guardando presets de filtros:', error);
  }
};

// Cargar hijos del nodo actual
const loadChildren = async () => {
  try {
    const response = await window.api.getChildren(currentNodeId.value);
    if (response.success) {
      allChildren.value = response.data;
      
      // Obtener info del nodo actual para conocer su parent_id
      if (currentNodeId.value !== 1) {
        const nodeInfo = await window.api.getNodeInfo(currentNodeId.value);
        if (nodeInfo.success) {
          currentParentId.value = nodeInfo.data.parent_id;
        }
      } else {
        currentParentId.value = null;
      }
      
      // Construir breadcrumb
      loadBreadcrumb();
    } else {
      statusMessage.value = `Error: ${response.error}`;
    }
  } catch (error) {
    statusMessage.value = `Error al cargar: ${error.message}`;
  }
};

// Cargar la ruta de navegación (breadcrumb)
const loadBreadcrumb = async () => {
  if (currentNodeId.value === 1) {
    breadcrumbPath.value = [];
    return;
  }
  try {
    const response = await window.api.getAncestors(currentNodeId.value);
    if (response.success) {
      breadcrumbPath.value = response.data;
    }
  } catch (error) {
    console.error('Error cargando breadcrumb:', error);
  }
};

// Separar carpetas y archivos
const folders = computed(() => {
  return allChildren.value
    .filter(item => item.type === 'folder')
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
});

const files = computed(() => {
  return allChildren.value.filter(item => item.type === 'file');
});

// Separar resultados de búsqueda en carpetas y archivos
const searchFolders = computed(() => {
  return filteredSearchResults.value
    .filter(item => item.type === 'folder')
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
});

// Extraer tags de un título (para filtros)
const extractTags = (title) => {
  const tagMatch = title.match(/\(([^)]+)\)/g);
  if (!tagMatch) return [];
  return tagMatch.map(t => t.replace(/[()]/g, '').trim());
};

// Tags disponibles calculados de los resultados de búsqueda
const availableTags = computed(() => {
  const tags = {
    regions: new Set(),
    languages: new Set(),
    versions: new Set(),
    other: new Set()
  };
  
  const regionPatterns = ['USA', 'Europe', 'Japan', 'World', 'Asia', 'Australia', 'Brazil', 'Canada', 'China', 'France', 'Germany', 'Italy', 'Korea', 'Netherlands', 'Spain', 'Sweden', 'UK'];
  const languagePatterns = ['En', 'Es', 'Fr', 'De', 'It', 'Ja', 'Ko', 'Pt', 'Zh', 'Nl', 'Sv', 'No', 'Da', 'Fi', 'Pl', 'Ru'];
  const versionPatterns = ['Rev', 'v1', 'v2', 'Beta', 'Proto', 'Demo', 'Sample', 'Promo', 'Alt', 'Unl'];
  
  searchResults.value.forEach(item => {
    const itemTags = extractTags(item.title);
    itemTags.forEach(tag => {
      if (regionPatterns.some(r => tag.includes(r))) {
        tags.regions.add(tag);
      } else if (languagePatterns.some(l => tag === l || tag.startsWith(l + ','))) {
        tags.languages.add(tag);
      } else if (versionPatterns.some(v => tag.includes(v))) {
        tags.versions.add(tag);
      } else {
        tags.other.add(tag);
      }
    });
  });
  
  return {
    regions: Array.from(tags.regions).sort(),
    languages: Array.from(tags.languages).sort(),
    versions: Array.from(tags.versions).sort(),
    other: Array.from(tags.other).sort()
  };
});

// Aplicar filtros avanzados a los resultados de búsqueda
const filteredSearchResults = computed(() => {
  let results = searchResults.value;
  
  // Filtrar por texto incluido
  if (advancedFilters.value.includeText.length > 0) {
    results = results.filter(item => 
      advancedFilters.value.includeText.some(phrase => 
        item.title.toLowerCase().includes(phrase.toLowerCase())
      )
    );
  }
  
  // Filtrar por texto excluido
  if (advancedFilters.value.excludeText.length > 0) {
    results = results.filter(item => 
      !advancedFilters.value.excludeText.some(phrase => 
        item.title.toLowerCase().includes(phrase.toLowerCase())
      )
    );
  }
  
  // Filtrar por etiquetas incluidas
  const allIncludeTags = [
    ...advancedFilters.value.includeTags.regions,
    ...advancedFilters.value.includeTags.languages,
    ...advancedFilters.value.includeTags.versions,
    ...advancedFilters.value.includeTags.other
  ];
  
  if (allIncludeTags.length > 0) {
    results = results.filter(item => {
      const itemTags = extractTags(item.title);
      return allIncludeTags.some(tag => itemTags.includes(tag));
    });
  }
  
  // Filtrar por etiquetas excluidas
  const allExcludeTags = [
    ...advancedFilters.value.excludeTags.regions,
    ...advancedFilters.value.excludeTags.languages,
    ...advancedFilters.value.excludeTags.versions,
    ...advancedFilters.value.excludeTags.other
  ];
  
  if (allExcludeTags.length > 0) {
    results = results.filter(item => {
      const itemTags = extractTags(item.title);
      return !allExcludeTags.some(tag => itemTags.includes(tag));
    });
  }
  
  return results;
});

const searchFiles = computed(() => {
  let files = filteredSearchResults.value.filter(item => item.type === 'file');
  
  // Aplicar ordenamiento
  files.sort((a, b) => {
    let aVal = a[sortField.value];
    let bVal = b[sortField.value];
    
    if (typeof aVal === 'string') aVal = aVal.toLowerCase();
    if (typeof bVal === 'string') bVal = bVal.toLowerCase();
    
    if (aVal < bVal) return sortDirection.value === 'asc' ? -1 : 1;
    if (aVal > bVal) return sortDirection.value === 'asc' ? 1 : -1;
    return 0;
  });
  
  return files;
});

// Navegar a un nodo
const navigateToNode = (node) => {
  if (!node.type || node.type === 'folder') {
    currentParentId.value = node.parent_id || currentNodeId.value;
    currentNodeId.value = node.id;
    allChildren.value = [];
    searchResults.value = [];
    searchTerm.value = '';
    loadChildren();
  }
};

// Volver a la raíz
const goToRoot = () => {
  currentNodeId.value = 1;
  currentParentId.value = null;
  allChildren.value = [];
  searchResults.value = [];
  searchTerm.value = '';
  loadChildren();
};

// Volver al nodo anterior
const goBack = () => {
  if (currentParentId.value) {
    currentNodeId.value = currentParentId.value;
    allChildren.value = [];
    searchResults.value = [];
    searchTerm.value = '';
    loadChildren();
  }
};

// Realizar búsqueda
const search = async () => {
  if (!searchTerm.value.trim()) {
    searchResults.value = [];
    statusMessage.value = 'Por favor, introduce un término de búsqueda.';
    return;
  }
  
  statusMessage.value = 'Buscando...';
  searchResults.value = [];

  try {
    const response = await window.api.search(searchTerm.value);
    if (response.success) {
      searchResults.value = response.data;
      statusMessage.value = response.data.length === 0 ? 'No se encontraron resultados.' : '';
    } else {
      statusMessage.value = `Error en la búsqueda: ${response.error}`;
    }
  } catch (error) {
    statusMessage.value = `Error: ${error.message}`;
  }
};

// Watch para búsqueda incremental
watch(searchTerm, (newValue) => {
  // Limpiar el timeout anterior de forma segura
  safeClearTimeout(searchTimeout);
  
  // Si hay resultados de búsqueda activos, hacer búsqueda incremental
  if (searchResults.value.length > 0 || newValue.trim().length >= 3) {
    // ✅ FIX: Usar safeSetTimeout en lugar de setTimeout
    searchTimeout = safeSetTimeout(() => {
      if (newValue.trim().length >= 3) {
        search();
      } else if (newValue.trim().length === 0) {
        searchResults.value = [];
        statusMessage.value = '';
      }
    }, 500);
  }
});

// Descargar archivo
const download = (file) => {
  // FIX ESTADO INCONSISTENTE: Verificar si ya existe una descarga activa para este archivo
  const existingDownload = downloads.value[file.id];
  if (existingDownload) {
    // Si está en progreso o iniciando, no hacer nada
    if (existingDownload.state === 'progressing' || existingDownload.state === 'starting') {
      console.log(`[Download] Archivo ${file.id} ya está descargándose, ignorando`);
      return;
    }
    // Si está en cola, no duplicar
    if (existingDownload.state === 'queued') {
      console.log(`[Download] Archivo ${file.id} ya está en cola, ignorando`);
      return;
    }
    // Si está pausado, preguntar si quiere reanudar (se maneja en otro lugar)
    if (existingDownload.state === 'paused') {
      console.log(`[Download] Archivo ${file.id} está pausado, usar resumeDownload en su lugar`);
      return;
    }
    // Si está completado, interrumpido o cancelado, permitir re-descarga
  }
  
  // FIX ESTADO INCONSISTENTE: Verificar que no esté en startingDownloads
  if (startingDownloads.has(file.id)) {
    console.log(`[Download] Archivo ${file.id} está siendo iniciado, ignorando`);
    return;
  }
  
  // FIX ESTADO INCONSISTENTE: Verificar que no esté ya en la cola
  const inQueue = downloadQueue.value.some(d => d.id === file.id && d.status === 'queued');
  if (inQueue) {
    console.log(`[Download] Archivo ${file.id} ya está en downloadQueue, ignorando`);
    return;
  }
  
  const addedAt = Date.now();
  // Agregar inmediatamente al historial de descargas con estado 'queued'
  downloads.value[file.id] = {
    id: file.id,
    title: file.title,
    state: 'queued',
    percent: 0,
    addedAt
  };
  
  // Agregar a la cola
  downloadQueue.value.push({
    id: file.id,
    title: file.title,
    status: 'queued',
    addedAt
  });
  
  // Procesar la cola
  processDownloadQueue();
};

// ========== FIX RACE CONDITIONS: Procesar la cola con Promise-based locking ==========
// Esta implementacion garantiza:
// 1. Solo un procesamiento a la vez (mutex con Promise)
// 2. Debounce para agrupar llamadas rapidas
// 3. Deteccion de cambios durante el procesamiento
// 4. Prevencion de duplicados con startingDownloads Set
const processDownloadQueue = () => {
  // Incrementar version para detectar cambios
  const currentVersion = ++queueVersion;
  
  // Cancelar timeout anterior (debounce)
  safeClearTimeout(queueProcessTimeout);
  
  // Si ya hay un procesamiento en curso, encolar para despues
  if (queueProcessPromise) {
    console.log('[Queue] Procesamiento en curso, encolando solicitud...');
    // Esperar a que termine y luego re-procesar
    queueProcessPromise.then(() => {
      // Solo re-procesar si esta es la version mas reciente
      if (currentVersion === queueVersion && isMounted) {
        processDownloadQueue();
      }
    });
    return;
  }
  
  // Debounce: esperar 100ms antes de procesar
  queueProcessTimeout = safeSetTimeout(() => {
    // Verificar que el componente siga montado
    if (!isMounted) {
      console.log('[Queue] Componente desmontado, cancelando');
      return;
    }
    
    // Crear la Promise de procesamiento (actua como mutex)
    queueProcessPromise = executeQueueProcessing()
      .finally(() => {
        queueProcessPromise = null;
        
        // Si hubo cambios durante el procesamiento, re-procesar
        if (currentVersion !== queueVersion && isMounted) {
          console.log('[Queue] Cambios detectados durante procesamiento, re-procesando...');
          safeSetTimeout(() => processDownloadQueue(), 50);
        }
      });
  }, 100);
};

// Funcion interna que ejecuta el procesamiento real de la cola
const executeQueueProcessing = async () => {
  try {
    // Contar descargas activas (starting, progressing, o siendo iniciadas)
    const activeCount = Object.values(downloads.value).filter(
      d => d.state === 'starting' || d.state === 'progressing'
    ).length;
    
    // Tambien contar las que estan siendo iniciadas (en transito)
    const startingCount = startingDownloads.size;
    const totalActive = activeCount + startingCount;
    
    console.log('=== PROCESS QUEUE ===');
    console.log('Active downloads:', activeCount);
    console.log('Starting (in transit):', startingCount);
    console.log('Total active:', totalActive);
    console.log('Max parallel:', maxParallelDownloads.value);
    console.log('Available slots:', Math.max(0, maxParallelDownloads.value - totalActive));
    console.log('Queued in queue:', downloadQueue.value.filter(d => d.status === 'queued').length);
    console.log('====================');
    
    // Calcular slots disponibles
    const availableSlots = maxParallelDownloads.value - totalActive;
    
    if (availableSlots <= 0) {
      console.log('[Queue] No hay slots disponibles, esperando...');
      return;
    }
    
    // Obtener descargas en cola que NO estan siendo iniciadas
    const queuedDownloads = downloadQueue.value.filter(
      d => d.status === 'queued' && !startingDownloads.has(d.id)
    );
    
    const toStart = queuedDownloads.slice(0, availableSlots);
    
    if (toStart.length === 0) {
      console.log('[Queue] No hay descargas pendientes para iniciar');
      return;
    }
    
    console.log('[Queue] Iniciando', toStart.length, 'descargas:', toStart.map(d => d.title));
    
    // Iniciar las descargas secuencialmente con await para evitar race conditions
    for (const download of toStart) {
      // Verificar que el componente siga montado
      if (!isMounted) {
        console.log('[Queue] Componente desmontado durante inicio de descargas');
        break;
      }
      
      // Verificar que no se haya iniciado ya (doble check)
      if (startingDownloads.has(download.id)) {
        console.log(`[Queue] Descarga ${download.id} ya esta siendo iniciada, saltando`);
        continue;
      }
      
      // Marcar como "en transito" para evitar duplicados
      startingDownloads.add(download.id);
      
      // Marcar como downloading en la cola
      download.status = 'downloading';
      
      try {
        // Usar await para asegurar que la llamada IPC se complete antes de continuar
        const result = await window.api.download({ 
          id: download.id, 
          title: download.title,
          downloadPath: downloadPath.value,
          preserveStructure: preserveStructure.value,
          forceOverwrite: download.forceOverwrite || false
        });
        
        console.log(`[Queue] Descarga ${download.id} iniciada:`, result);
        
        // Si la descarga se encolo en el backend, el evento 'starting' la marcara
        // Si fallo, manejar el error
        if (!result.success && !result.queued) {
          console.error(`[Queue] Error iniciando descarga ${download.id}:`, result.error);
          download.status = 'queued'; // Volver a encolar para reintentar
          
          if (downloads.value[download.id]) {
            downloads.value[download.id].state = 'interrupted';
            downloads.value[download.id].error = result.error || 'Error al iniciar descarga';
          }
        }
      } catch (error) {
        console.error(`[Queue] Excepcion iniciando descarga ${download.id}:`, error);
        download.status = 'queued'; // Volver a encolar para reintentar
      } finally {
        // Remover del set de "en transito" despues de un breve delay
        // para dar tiempo al evento 'starting' de llegar
        safeSetTimeout(() => {
          startingDownloads.delete(download.id);
        }, 500);
      }
      
      // Pequeno delay entre descargas para evitar saturar
      await new Promise(resolve => safeSetTimeout(resolve, 50));
    }
    
  } catch (error) {
    console.error('[Queue] Error en procesamiento de cola:', error);
  }
};

// Confirmar sobrescritura de archivo
const confirmOverwrite = (downloadId) => {
  const confirmation = pendingConfirmations.value.find(c => c.id === downloadId);
  if (!confirmation) return;
  
  // Remover de confirmaciones pendientes
  pendingConfirmations.value = pendingConfirmations.value.filter(c => c.id !== downloadId);
  
  // Remover de selecciones (sincronizar UI)
  selectedDownloads.value.delete(downloadId);
  
  // FIX ESTADO INCONSISTENTE: Verificar que no esté ya en la cola
  const alreadyInQueue = downloadQueue.value.some(d => d.id === downloadId);
  if (alreadyInQueue) {
    console.log(`[ConfirmOverwrite] Descarga ${downloadId} ya está en cola, actualizando forceOverwrite`);
    const existingItem = downloadQueue.value.find(d => d.id === downloadId);
    if (existingItem) {
      existingItem.forceOverwrite = true;
    }
  } else {
    // Agregar a la cola con flag de sobrescritura
    downloadQueue.value.push({
      id: confirmation.id,
      title: confirmation.title,
      status: 'queued',
      forceOverwrite: true,
      addedAt: Date.now()
    });
  }
  
  // Actualizar estado en downloads
  if (downloads.value[downloadId]) {
    downloads.value[downloadId].state = 'queued';
    delete downloads.value[downloadId].error;
  }
  
  // Procesar la cola
  processDownloadQueue();
};

// Cancelar sobrescritura de archivo
const cancelOverwrite = (downloadId) => {
  // Remover de confirmaciones pendientes
  pendingConfirmations.value = pendingConfirmations.value.filter(c => c.id !== downloadId);
  
  // Remover de selecciones (sincronizar UI)
  selectedDownloads.value.delete(downloadId);
  
  // Marcar como cancelado en el historial
  if (downloads.value[downloadId]) {
    downloads.value[downloadId].state = 'cancelled';
    downloads.value[downloadId].error = 'Descarga cancelada por el usuario';
    saveDownloadHistory();
  }
};

// Toggle selección de archivo individual
const toggleFileSelection = (fileId) => {
  const index = selectedFiles.value.indexOf(fileId);
  if (index >= 0) {
    selectedFiles.value.splice(index, 1);
  } else {
    selectedFiles.value.push(fileId);
  }
};

const toggleSearchFileSelection = (fileId) => {
  const index = selectedSearchFiles.value.indexOf(fileId);
  if (index >= 0) {
    selectedSearchFiles.value.splice(index, 1);
  } else {
    selectedSearchFiles.value.push(fileId);
  }
};

// Toggle seleccionar todos los archivos
const toggleSelectAll = () => {
  if (selectedFiles.value.length === files.value.length) {
    selectedFiles.value = [];
  } else {
    selectedFiles.value = files.value.map(f => f.id);
  }
};

const toggleSelectAllSearch = () => {
  if (selectedSearchFiles.value.length === searchFiles.value.length) {
    selectedSearchFiles.value = [];
  } else {
    selectedSearchFiles.value = searchFiles.value.map(f => f.id);
  }
};

// Descargar archivos seleccionados
const downloadSelected = () => {
  const filesToDownload = files.value.filter(f => selectedFiles.value.includes(f.id));
  filesToDownload.forEach(file => download(file));
  selectedFiles.value = [];
};

const downloadSelectedSearch = () => {
  const filesToDownload = searchFiles.value.filter(f => selectedSearchFiles.value.includes(f.id));
  filesToDownload.forEach(file => download(file));
  selectedSearchFiles.value = [];
};

// Seleccionar/Deseleccionar una descarga
const toggleSelectDownload = (downloadId) => {
  if (selectedDownloads.value.has(downloadId)) {
    selectedDownloads.value.delete(downloadId);
  } else {
    selectedDownloads.value.add(downloadId);
  }
};

// Seleccionar/Deseleccionar todos (para descargas)
const toggleSelectAllDownloads = (event) => {
  const isChecked = event.target.checked;
  if (isChecked) {
    pendingConfirmations.value.forEach(confirmation => {
      selectedDownloads.value.add(confirmation.id);
    });
  } else {
    selectedDownloads.value.clear();
  }
};

// Confirmar sobrescritura masiva
const confirmOverwriteAll = () => {
  selectedDownloads.value.forEach(downloadId => {
    confirmOverwrite(downloadId);
  });
  selectedDownloads.value.clear();
};

// Cancelar sobrescritura masiva
const cancelOverwriteAll = () => {
  selectedDownloads.value.forEach(downloadId => {
    cancelOverwrite(downloadId);
  });
  selectedDownloads.value.clear();
};

// Pausar una descarga en progreso
const pauseDownload = async (downloadId) => {
  try {
    const result = await window.api.pauseDownload(downloadId);
    if (result.success) {
      console.log('Descarga pausada:', downloadId);
    } else {
      console.error('Error al pausar descarga:', result.error);
    }
  } catch (error) {
    console.error('Error pausando descarga:', error);
  }
};

// Reanudar una descarga pausada
const resumeDownload = (downloadId) => {
  const download = downloads.value[downloadId];
  if (!download) {
    console.warn('Descarga no encontrada:', downloadId);
    return;
  }
  
  // FIX ESTADO INCONSISTENTE: Verificar que no esté ya activa o en proceso
  if (download.state === 'progressing' || download.state === 'starting') {
    console.log(`[Resume] Descarga ${downloadId} ya está activa, ignorando`);
    return;
  }
  
  if (startingDownloads.has(downloadId)) {
    console.log(`[Resume] Descarga ${downloadId} está siendo iniciada, ignorando`);
    return;
  }
  
  // FIX ESTADO INCONSISTENTE: Verificar que no esté ya en la cola
  const alreadyInQueue = downloadQueue.value.some(d => d.id === downloadId && d.status === 'queued');
  if (alreadyInQueue) {
    console.log(`[Resume] Descarga ${downloadId} ya está en cola, ignorando`);
    return;
  }
  
  // Cambiar estado a queued
  download.state = 'queued';
  download.queueStatus = 'queued';
  delete download.error;
  
  // Agregar a la cola (el sistema detectará el .part automáticamente)
  downloadQueue.value.push({
    id: downloadId,
    title: download.title,
    status: 'queued',
    preserveStructure: download.preserveStructure || false,
    addedAt: Date.now()
  });
  
  console.log('Descarga reanudada, agregada a cola:', downloadId);
  
  // Procesar la cola inmediatamente
  processDownloadQueue();
};

// Cancelar una descarga en progreso
const cancelDownload = async (downloadId) => {
  try {
    const result = await window.api.cancelDownload(downloadId);
    if (result.success) {
      console.log('Descarga cancelada:', downloadId);
    } else {
      console.error('Error al cancelar descarga:', result.error);
    }
  } catch (error) {
    console.error('Error cancelando descarga:', error);
  }
};

// Eliminar una descarga del listado
const removeDownload = (downloadId) => {
  delete downloads.value[downloadId];
  selectedHistoryDownloads.value.delete(downloadId);
  saveDownloadHistory();
};

// Reiniciar una descarga cancelada o con error
const restartDownload = (downloadId) => {
  const download = downloads.value[downloadId];
  if (!download) return;
  
  // FIX ESTADO INCONSISTENTE: Verificar que no esté ya activa o en proceso
  if (download.state === 'progressing' || download.state === 'starting') {
    console.log(`[Restart] Descarga ${downloadId} ya está activa, ignorando`);
    return;
  }
  
  if (startingDownloads.has(downloadId)) {
    console.log(`[Restart] Descarga ${downloadId} está siendo iniciada, ignorando`);
    return;
  }
  
  // FIX ESTADO INCONSISTENTE: Verificar que no esté ya en la cola
  const alreadyInQueue = downloadQueue.value.some(d => d.id === downloadId && d.status === 'queued');
  if (alreadyInQueue) {
    console.log(`[Restart] Descarga ${downloadId} ya está en cola, ignorando`);
    return;
  }
  
  if (!download.addedAt) download.addedAt = Date.now();
  
  // Actualizar estado a queued
  download.state = 'queued';
  download.percent = 0;
  delete download.error;
  
  // Agregar a la cola
  downloadQueue.value.push({
    id: download.id,
    title: download.title,
    status: 'queued',
    addedAt: download.addedAt
  });
  
  // Procesar la cola
  processDownloadQueue();
};

// Alternar selección de una descarga del historial
const toggleSelectHistoryDownload = (downloadId) => {
  if (selectedHistoryDownloads.value.has(downloadId)) {
    selectedHistoryDownloads.value.delete(downloadId);
  } else {
    selectedHistoryDownloads.value.add(downloadId);
  }
};

// Seleccionar/deseleccionar todas las descargas del historial
const toggleSelectAllHistoryDownloads = () => {
  if (selectAllHistoryDownloads.value) {
    selectedHistoryDownloads.value.clear();
    selectAllHistoryDownloads.value = false;
  } else {
    allDownloads.value.forEach(download => {
      selectedHistoryDownloads.value.add(download.id);
    });
    selectAllHistoryDownloads.value = true;
  }
};

// Eliminar descargas seleccionadas del historial
const deleteSelectedDownloads = () => {
  selectedHistoryDownloads.value.forEach(downloadId => {
    removeDownload(downloadId);
  });
  selectedHistoryDownloads.value.clear();
  selectAllHistoryDownloads.value = false;
};

// Formatear tamaño en bytes a formato legible
const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return size.toFixed(2) + ' ' + units[unitIndex];
};

// Comparar tamaños y devolver descripción
const getSizeComparison = (existingSize, expectedSize) => {
  if (!existingSize || !expectedSize) return '';
  
  const difference = Math.abs(existingSize - expectedSize);
  const margin = 10240; // 10 KB margin
  
  if (difference <= margin) {
    return 'Ambos archivos tienen el mismo tamaño';
  } else if (expectedSize > existingSize) {
    return 'Archivo más grande';
  } else {
    return 'Archivo más pequeño';
  }
};

// Formatear fecha
const formatDate = (dateString) => {
  if (!dateString) return '-';
  try {
    return new Date(dateString).toLocaleDateString('es-ES');
  } catch {
    return dateString;
  }
};

// Formatear fecha y hora para descargas
const formatDateTime = (dateString) => {
  if (!dateString) return '-';
  try {
    const date = new Date(dateString);
    const dateStr = date.toLocaleDateString('es-ES', { 
      day: '2-digit', 
      month: '2-digit', 
      year: 'numeric' 
    });
    const timeStr = date.toLocaleTimeString('es-ES', { 
      hour: '2-digit', 
      minute: '2-digit'
    });
    return `${dateStr} ${timeStr}`;
  } catch {
    return dateString;
  }
};

// Obtener ubicación del archivo
const locationPath = computed(() => {
  if (breadcrumbPath.value.length === 0) return '';
  return breadcrumbPath.value.map(n => n.title).join(' / ');
});

// Toggle para favoritos
const toggleFavorites = () => {
  showingFavorites.value = !showingFavorites.value;
  if (showingFavorites.value) {
    showingDownloads.value = false;
  }
};

// Toggle para descargas
const toggleDownloads = () => {
  showingDownloads.value = !showingDownloads.value;
  if (showingDownloads.value) {
    showingFavorites.value = false;
  }
};

// Toggle para filtros avanzados
const toggleAdvancedFilters = () => {
  showAdvancedFilters.value = !showAdvancedFilters.value;
};

// Verificar si una carpeta es favorita
const isFavorite = (folderId) => {
  return favorites.value.some(f => f.id === folderId);
};

// Agregar/quitar de favoritos
const toggleFavorite = (folder) => {
  const index = favorites.value.findIndex(f => f.id === folder.id);
  if (index > -1) {
    favorites.value.splice(index, 1);
  } else {
    favorites.value.push({
      id: folder.id,
      title: folder.title,
      parent_id: folder.parent_id
    });
  }
  saveFavorites();
};

// Carpetas favoritas
const favoriteFolders = computed(() => {
  return favorites.value;
});

// Abrir configuración
const openSettings = () => {
  showSettings.value = true;
};

// Cerrar configuración
const closeSettings = () => {
  showSettings.value = false;
  saveDownloadSettings();
};

// Seleccionar carpeta de descargas
const selectDownloadFolder = async () => {
  try {
    const result = await window.api.selectFolder();
    if (result.success) {
      downloadPath.value = result.path;
      saveDownloadSettings();
    }
  } catch (error) {
    console.error('Error seleccionando carpeta:', error);
  }
};

// Toggle tema
const toggleTheme = () => {
  isDarkMode.value = !isDarkMode.value;
  document.body.classList.toggle('light-mode', !isDarkMode.value);
};

// Controles de ventana
const minimizeWindow = () => window.api.minimizeWindow();
const maximizeWindow = () => {
  window.api.maximizeWindow();
  isMaximized.value = !isMaximized.value;
};
const closeWindow = () => window.api.closeWindow();

// Ordenar resultados
const sortBy = (field) => {
  if (sortField.value === field) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortField.value = field;
    sortDirection.value = 'asc';
  }
};

// Limpiar descargas
const clearDownloads = () => {
  clearListConfirmation.value = true;
};

const confirmClearDownloads = () => {
  downloads.value = {};
  downloadQueue.value = [];
  pendingConfirmations.value = [];
  selectedDownloads.value.clear();
  selectedHistoryDownloads.value.clear();
  clearListConfirmation.value = false;
  saveDownloadHistory();
};

const cancelClearDownloads = () => {
  clearListConfirmation.value = false;
};

// Agregar texto a filtros
const addIncludeText = () => {
  if (tempIncludeText.value.trim()) {
    advancedFilters.value.includeText.push(tempIncludeText.value.trim());
    tempIncludeText.value = '';
  }
};

const addExcludeText = () => {
  if (tempExcludeText.value.trim()) {
    advancedFilters.value.excludeText.push(tempExcludeText.value.trim());
    tempExcludeText.value = '';
  }
};

const removeIncludeText = (index) => {
  advancedFilters.value.includeText.splice(index, 1);
};

const removeExcludeText = (index) => {
  advancedFilters.value.excludeText.splice(index, 1);
};

// Seleccionar todos los tags de una categoría
const selectAllTags = (category, type) => {
  if (type === 'include') {
    advancedFilters.value.includeTags[category] = [...availableTags.value[category]];
  } else {
    advancedFilters.value.excludeTags[category] = [...availableTags.value[category]];
  }
};

// Limpiar todos los filtros
const clearAllFilters = () => {
  advancedFilters.value = {
    includeText: [],
    excludeText: [],
    includeTags: {
      regions: [],
      languages: [],
      versions: [],
      other: []
    },
    excludeTags: {
      regions: [],
      languages: [],
      versions: [],
      other: []
    }
  };
};

// Velocidad promedio de descarga
const averageDownloadSpeed = computed(() => {
  if (speedStats.value.size === 0) return 0;
  let total = 0;
  speedStats.value.forEach(stat => {
    total += stat.speed || 0;
  });
  return total / speedStats.value.size;
});

// Nombre de la descarga actual (para titlebar)
const currentDownloadName = computed(() => {
  if (speedStats.value.size === 0) return '';
  const keys = Array.from(speedStats.value.keys());
  const index = currentDownloadIndex.value % keys.length;
  const downloadId = keys[index];
  const download = downloads.value[downloadId];
  return download ? download.title : '';
});

// Contador de descargas activas
const activeDownloadCount = computed(() => {
  return speedStats.value.size;
});

// Computed para todas las descargas ordenadas
const allDownloads = computed(() => {
  const allDownloads = Object.values(downloads.value).map(download => {
    let queueStatus = 'completed';
    
    if (download.state === 'queued' || download.state === 'waiting') {
      queueStatus = 'queued';
    } else if (download.state === 'starting' || download.state === 'progressing') {
      queueStatus = 'downloading';
    } else if (download.state === 'paused') {
      queueStatus = 'paused';
    } else if (download.state === 'completed') {
      queueStatus = 'completed';
    } else if (download.state === 'interrupted' || download.state === 'cancelled') {
      queueStatus = 'error';
    }
    
    return {
      ...download,
      queueStatus
    };
  });
  
  // Ordenar: descargando arriba, luego en cola, luego completadas, luego error
  allDownloads.sort((a, b) => {
    const order = { downloading: 0, queued: 1, completed: 2, error: 3 };
    const statusDiff = order[a.queueStatus] - order[b.queueStatus];
    if (statusDiff !== 0) return statusDiff;
    const aTime = a.addedAt || 0;
    const bTime = b.addedAt || 0;
    return aTime - bTime;
  });
  
  return allDownloads;
});

const getDownloadButtonText = (id) => {
  const download = downloads.value[id];
  if (download) {
    if (download.state === 'completed') return '¡Listo!';
    if (download.state === 'progressing') return 'Bajando...';
    if (download.state === 'interrupted') return 'Reintentar';
  }
  return 'Descargar';
};

const getDirectoryPath = (fullPath) => {
  if (!fullPath) return '-';
  const lastSep = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'));
  return lastSep > 0 ? fullPath.substring(0, lastSep) : fullPath;
};

const getDownloadPercentage = (download) => {
  if (!download) return 0;
  const percent = download.percent || 0;
  return Math.round(percent * 100);
};

// ========== LIFECYCLE HOOKS CON FIX DE MEMORY LEAKS ==========

onMounted(() => {
  // Marcar componente como montado
  isMounted = true;
  
  loadFavorites();
  loadDownloadSettings();
  loadFilterPresets();
  loadDownloadHistory();
  loadChildren();

  // Intervalo de rotacion para el indicador de velocidad
  rotationInterval = setInterval(() => {
    // Verificar que el componente sigue montado
    if (!isMounted) return;
    
    if (speedStats.value.size > 0) {
      currentDownloadIndex.value = (currentDownloadIndex.value + 1) % speedStats.value.size;
    } else {
      currentDownloadIndex.value = 0;
    }
  }, 5000);

  // FIX ESTADO INCONSISTENTE: Reconciliacion periodica bidireccional con el backend
  // Cada 5 segundos, verificar que el estado del frontend coincide con el backend
  reconciliationInterval = setInterval(async () => {
    if (!isMounted) return;
    
    try {
      const stats = await window.api.getDownloadStats();
      
      if (!stats || !isMounted) return;
      
      // ========== RECONCILIACIÓN 1: Frontend -> Backend ==========
      // Verificar descargas que el frontend cree activas pero el backend no tiene
      Object.values(downloads.value).forEach(download => {
        if (download.state === 'progressing' || download.state === 'starting') {
          // Si el backend no tiene esta descarga como activa, marcarla como interrumpida
          if (!stats.activeIds.includes(download.id) && !stats.queuedIds.includes(download.id)) {
            // Dar un pequeño margen de tiempo (podría estar en transición)
            if (!startingDownloads.has(download.id)) {
              console.warn(`[Reconciliation] Descarga ${download.id} perdida en backend, marcando como interrumpida`);
              download.state = 'interrupted';
              download.error = 'Conexión perdida con el servidor';
              
              // Limpiar de estructuras locales
              speedStats.value.delete(download.id);
              downloadQueue.value = downloadQueue.value.filter(d => d.id !== download.id);
              
              // Guardar historial
              saveDownloadHistory();
            }
          }
        }
      });
      
      // ========== RECONCILIACIÓN 2: Backend -> Frontend ==========
      // Verificar descargas que el backend tiene activas pero el frontend no conoce
      stats.activeIds.forEach(activeId => {
        const frontendDownload = downloads.value[activeId];
        if (!frontendDownload) {
          console.warn(`[Reconciliation] Backend tiene descarga ${activeId} activa pero frontend no la conoce`);
          // Crear una entrada básica para esta descarga huérfana
          downloads.value[activeId] = {
            id: activeId,
            title: `Descarga ${activeId}`,
            state: 'progressing',
            percent: 0,
            addedAt: Date.now(),
            orphan: true // Marcar como huérfana para identificación
          };
        } else if (frontendDownload.state !== 'progressing' && frontendDownload.state !== 'starting') {
          // El frontend la tiene pero con estado incorrecto
          console.warn(`[Reconciliation] Corrigiendo estado de ${activeId}: ${frontendDownload.state} -> progressing`);
          frontendDownload.state = 'progressing';
        }
      });
      
      // ========== RECONCILIACIÓN 3: Cola sincronizada ==========
      // Verificar que downloadQueue esté sincronizada con downloads.value
      downloadQueue.value = downloadQueue.value.filter(queueItem => {
        const download = downloads.value[queueItem.id];
        if (!download) {
          console.warn(`[Reconciliation] Item ${queueItem.id} en cola sin entrada en downloads, removiendo`);
          return false;
        }
        // Si la descarga ya no está en estado queued, remover de la cola
        if (download.state !== 'queued' && queueItem.status === 'queued') {
          console.debug(`[Reconciliation] Limpiando ${queueItem.id} de cola (estado: ${download.state})`);
          return false;
        }
        return true;
      });
      
      // ========== RECONCILIACIÓN 4: Limpiar speedStats huérfanas ==========
      // Remover entradas de speedStats para descargas que ya no están activas
      speedStats.value.forEach((_, downloadId) => {
        const download = downloads.value[downloadId];
        if (!download || (download.state !== 'progressing' && download.state !== 'starting')) {
          console.debug(`[Reconciliation] Limpiando speedStats huérfana para ${downloadId}`);
          speedStats.value.delete(downloadId);
        }
      });
      
    } catch (error) {
      // Silenciar errores de reconciliación para no molestar al usuario
      console.debug('[Reconciliation] Error:', error.message);
    }
  }, 5000);

  // FIX ESTADO INCONSISTENTE: Listener de progreso de descarga mejorado
  removeDownloadProgressListener = window.api.on('download-progress', (progressInfo) => {
    // Verificar que el componente todavia este montado
    if (!isMounted || !downloads.value) {
      console.warn('Componente desmontado, ignorando evento de descarga');
      return;
    }
    
    console.log('[Progress]', progressInfo.state, 'for', progressInfo.title || progressInfo.id);
    
    // Remover del set de "starting" cuando recibimos cualquier evento
    startingDownloads.delete(progressInfo.id);
    
    // FIX ESTADO INCONSISTENTE: Obtener estado existente o crear uno nuevo
    // Preservar datos existentes como addedAt, title, etc.
    let downloadState = downloads.value[progressInfo.id] || {
      id: progressInfo.id,
      title: progressInfo.title || `Descarga ${progressInfo.id}`,
      addedAt: Date.now()
    };
    
    // FIX ESTADO INCONSISTENTE: Asegurar que el ID siempre esté presente
    downloadState.id = progressInfo.id;
    
    // FIX ESTADO INCONSISTENTE: Actualizar título si viene en el evento
    if (progressInfo.title) {
      downloadState.title = progressInfo.title;
    }

    switch (progressInfo.state) {
      case 'starting':
        downloadState.state = 'starting';
        downloadState.percent = 0;
        // Remover posible error anterior
        delete downloadState.error;
        break;
        
      case 'progressing':
        downloadState.percent = progressInfo.percent;
        downloadState.state = 'progressing';
        // Remover posible error anterior
        delete downloadState.error;
        speedStats.value.set(progressInfo.id, {
          speed: progressInfo.speed || 0,
          totalBytes: progressInfo.totalBytes || 0,
          downloadedBytes: progressInfo.downloadedBytes || 0,
          remainingTime: progressInfo.remainingTime || 0
        });
        break;
        
      case 'awaiting-confirmation':
        console.log('Awaiting confirmation for:', progressInfo.title);
        console.log('File check:', progressInfo.fileCheck);
        
        downloadState.state = 'waiting';
        downloadState.savePath = progressInfo.savePath;
        
        // FIX ESTADO INCONSISTENTE: Evitar duplicados en pendingConfirmations
        if (!pendingConfirmations.value.some(c => c.id === progressInfo.id)) {
          pendingConfirmations.value.push({
            id: progressInfo.id,
            title: progressInfo.title,
            savePath: progressInfo.savePath,
            existingSize: progressInfo.fileCheck.existingSize,
            expectedSize: progressInfo.fileCheck.expectedSize,
            sizeDifference: progressInfo.fileCheck.sizeDifference,
            showNotification: showNotifications.value
          });
        }
        
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== progressInfo.id);
        
        // ✅ FIX: Usar safeSetTimeout
        safeSetTimeout(() => {
          processDownloadQueue();
        }, 100);
        break;
        
      case 'completed':
        downloadState.state = 'completed';
        downloadState.savePath = progressInfo.savePath;
        downloadState.completedAt = new Date().toISOString();
        
        speedStats.value.delete(progressInfo.id);
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== progressInfo.id);
        
        saveDownloadHistory();
        
        // ✅ FIX: Usar safeSetTimeout
        safeSetTimeout(() => {
          processDownloadQueue();
        }, 100);
        break;
        
      case 'interrupted':
        downloadState.state = 'interrupted';
        downloadState.error = progressInfo.error || 'Error desconocido';
        downloadState.savePath = progressInfo.savePath;
        
        speedStats.value.delete(progressInfo.id);
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== progressInfo.id);
        
        saveDownloadHistory();
        
        // ✅ FIX: Usar safeSetTimeout
        safeSetTimeout(() => {
          processDownloadQueue();
        }, 100);
        break;
        
      case 'cancelled':
        downloadState.state = 'cancelled';
        downloadState.queueStatus = 'cancelled';
        // NO asignar error, solo indicar que fue detenida
        
        speedStats.value.delete(progressInfo.id);
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== progressInfo.id);
        
        saveDownloadHistory();
        
        // ✅ FIX: Usar safeSetTimeout
        safeSetTimeout(() => {
          processDownloadQueue();
        }, 100);
        break;
        
      case 'paused':
        downloadState.state = 'paused';
        downloadState.queueStatus = 'paused';
        // Preservar el porcentaje actual recibido desde backend
        if (typeof progressInfo.percent !== 'undefined') {
          downloadState.percent = progressInfo.percent;
        }
        
        speedStats.value.delete(progressInfo.id);
        downloadQueue.value = downloadQueue.value.filter(d => d.id !== progressInfo.id);
        
        saveDownloadHistory();
        
        // ✅ FIX: Usar safeSetTimeout
        safeSetTimeout(() => {
          processDownloadQueue();
        }, 100);
        break;
    }
    
    downloads.value[progressInfo.id] = downloadState;
  });
});

onUnmounted(() => {
  console.log('[Cleanup] Limpiando recursos del componente App...');
  
  // FIX: Marcar componente como desmontado PRIMERO
  isMounted = false;
  
  // 1. Limpiar intervalo de rotacion
  if (rotationInterval) {
    clearInterval(rotationInterval);
    rotationInterval = null;
    console.log('✅ Intervalo de rotacion limpiado');
  }
  
  // 2. Limpiar intervalo de reconciliacion
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
    console.log('✅ Intervalo de reconciliacion limpiado');
  }
  
  // 3. Remover listener de IPC
  if (removeDownloadProgressListener) {
    removeDownloadProgressListener();
    removeDownloadProgressListener = null;
    console.log('✅ Listener de download-progress removido');
  }
  
  // 4. FIX: Limpiar TODOS los timeouts pendientes
  clearAllTimeouts();
  console.log('✅ Todos los timeouts limpiados');
  
  // 5. Limpiar timeouts especificos (por si acaso)
  safeClearTimeout(searchTimeout);
  searchTimeout = null;
  
  safeClearTimeout(queueProcessTimeout);
  queueProcessTimeout = null;
  
  // 6. FIX: Limpiar variables de control de cola
  queueProcessPromise = null;
  queueVersion = 0;
  startingDownloads.clear();
  
  // 7. Guardar estado antes de desmontar
  try {
    saveDownloadHistory();
    saveFavorites();
    saveDownloadSettings();
    console.log('✅ Estado guardado antes de desmontar');
  } catch (error) {
    console.error('❌ Error guardando estado:', error);
  }
  
  // 8. Limpiar referencias a objetos grandes
  downloads.value = {};
  searchResults.value = [];
  allChildren.value = [];
  speedStats.value.clear();
  pendingConfirmations.value = [];
  downloadQueue.value = [];
  selectedFiles.value = [];
  selectedSearchFiles.value = [];
  
  console.log('✅ Componente App desmontado correctamente');
});

</script>
