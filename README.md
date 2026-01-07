# Myrient DDL - Descargador de ROMs

<div align="center">

![Myrient DDL](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Windows-blue)

Aplicación de escritorio para explorar y descargar ROMs desde Myrient.

</div>

## 📋 Descripción

Myrient DDL es una aplicación Electron + Vue 3 que permite explorar el catálogo completo de Myrient de forma local y descargar ROMs de manera eficiente con gestión de cola, velocidades, y control de descargas.

### ✨ Características

- 🗂️ **Exploración Local**: Base de datos SQLite local con más de 2.6 millones de archivos
- 📥 **Gestor de Descargas**: Cola de descargas con control de velocidad y progreso
- ⭐ **Sistema de Favoritos**: Guarda tus carpetas favoritas para acceso rápido
- 🔍 **Búsqueda Avanzada**: Filtros por texto, tamaño, fecha, extensión y más
- 🎨 **Interfaz Moderna**: Tema oscuro/claro con diseño limpio
- ⚡ **Descargas Paralelas**: Descarga múltiples archivos simultáneamente
- 🛑 **Control de Descargas**: Detén, reinicia y gestiona tus descargas
- 📊 **Estadísticas en Tiempo Real**: Velocidad, tiempo restante y progreso

## 🚀 Inicio Rápido para Desarrolladores

### Requisitos Previos

- Node.js 18+ 
- npm 9+
- 7-Zip (para extraer la base de datos)
- Windows 10/11

### Instalación

1. **Clonar el repositorio**
```bash
git clone https://github.com/tu-usuario/myrient-ddl.git
cd myrient-ddl
```

2. **Instalar dependencias**
```bash
npm install
```

3. **Obtener la base de datos**

⚠️ **IMPORTANTE**: La base de datos `myrient.db` (1.9 GB) no está incluida en el repositorio.

**Opción A: Descargar desde el servidor**
```powershell
# Descarga myrient.7z desde el servidor
Invoke-WebRequest -Uri "URL_DEL_ARCHIVO" -OutFile "resources/myrient.7z"

# Extraer con 7-Zip
& "C:\Program Files\7-Zip\7z.exe" x resources/myrient.7z -o"resources/"
```

**Opción B: Usar base de datos existente**
- Si ya tienes `myrient.db`, cópialo a la carpeta `resources/`

4. **Ejecutar en modo desarrollo**
```bash
npm run dev
```

## 🛠️ Scripts Disponibles

```bash
# Modo desarrollo
npm run dev

# Compilar aplicación
npm run build
```

## 📦 Estructura del Proyecto

```
myrient-ddl/
├── electron/           # Código del proceso principal de Electron
│   ├── main.js        # Lógica principal, DB, descargas
│   └── preload.js     # Bridge entre Electron y Vue
├── src/               # Código Vue 3
│   ├── App.vue        # Componente principal
│   ├── main.js        # Punto de entrada Vue
│   └── style.css      # Estilos globales
├── resources/         # Archivos de recursos (ignorado en git)
│   └── myrient.db     # Base de datos SQLite (1.9 GB)
├── deploy.ps1         # Script de instalación automática
├── package.json       # Configuración del proyecto
└── vite.config.js     # Configuración de Vite
```

## 🔧 Tecnologías

- **Frontend**: Vue 3 (Composition API) + Vite
- **Backend**: Electron 28 + Node.js
- **Base de Datos**: SQLite 3 (better-sqlite3)
- **Build**: electron-builder

## 📝 Características Implementadas

### Gestión de Descargas
- ✅ Cola de descargas con límite configurable
- ✅ Velocidad en MB/s y tiempo restante
- ✅ Detener/reiniciar descargas
- ✅ Confirmación de sobrescritura de archivos
- ✅ Rotación de descargas en barra de título (cada 5s)
- ✅ Scroll horizontal de nombres largos
- ✅ Limpieza de lista (detiene descargas activas)

### Exploración
- ✅ Navegación por carpetas
- ✅ Búsqueda con múltiples filtros
- ✅ Sistema de favoritos
- ✅ Selección múltiple de archivos

## 🤝 Contribuir

Las contribuciones son bienvenidas. Por favor crea un Pull Request con tus mejoras.

## 📄 Licencia

Este proyecto está bajo la Licencia MIT.

## 🙏 Créditos

- **Myrient**: Por proporcionar el servicio de hosting de ROMs
- **Electron + Vue 3**: Frameworks utilizados

---

<div align="center">
Hecho con ❤️ para la comunidad de preservación de videojuegos
</div>
