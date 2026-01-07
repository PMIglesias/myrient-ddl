# Obtención de la Base de Datos

## ⚠️ Información Importante

La base de datos `myrient.db` (1.9 GB descomprimida) **NO** está incluida en el repositorio de Git debido a su tamaño.

## 📥 Opciones para Obtener la Base de Datos

### Opción 1: Descarga Directa (Recomendado para Usuarios)

Si ya tienes el ZIP de distribución `myrient-ddl-complete.zip`:
- La base de datos ya está incluida
- Solo extrae y ejecuta la aplicación

### Opción 2: Descarga para Desarrolladores

Si estás desarrollando, necesitas descargar la base de datos manualmente:

#### A. Desde el Servidor (Si está disponible)

```powershell
# Crear carpeta resources si no existe
New-Item -ItemType Directory -Path "resources" -Force

# Descargar archivo comprimido
Invoke-WebRequest -Uri "URL_DEL_SERVIDOR/myrient.7z" -OutFile "resources/myrient.7z"

# Extraer con 7-Zip
& "C:\Program Files\7-Zip\7z.exe" x resources/myrient.7z -o"resources/"

# Eliminar el archivo comprimido (opcional)
Remove-Item "resources/myrient.7z"
```

#### B. Copiar desde Instalación Existente

Si ya tienes Myrient DDL instalado:

```powershell
# Ubicación típica de la instalación
$installedDb = "$env:USERPROFILE\Myrient DDL\resources\myrient.db"

# Copiar al proyecto
Copy-Item $installedDb -Destination "resources\myrient.db"
```

### Opción 3: Generar desde Myrient (Avanzado)

⚠️ Esta opción es solo para usuarios avanzados que quieren crear la base de datos desde cero.

Requiere:
1. Scraper del sitio de Myrient
2. Python 3.8+
3. SQLite3

(Documentación pendiente)

## 🗂️ Ubicación Correcta

La base de datos debe estar en:
```
myrient-ddl/
└── resources/
    └── myrient.db  (1.9 GB)
```

## ✅ Verificación

Para verificar que la base de datos está correctamente instalada:

```powershell
# Verificar existencia y tamaño
$dbPath = "resources\myrient.db"
if (Test-Path $dbPath) {
    $size = [math]::Round((Get-Item $dbPath).Length / 1GB, 2)
    Write-Host "✓ Base de datos encontrada: $size GB" -ForegroundColor Green
} else {
    Write-Host "✗ Base de datos no encontrada" -ForegroundColor Red
}
```

El tamaño debe ser aproximadamente **1.9 GB**.

## 🔧 Solución de Problemas

### Error: "myrient.db no encontrado"

1. Verifica que el archivo está en `resources/myrient.db`
2. Verifica que el tamaño es ~1.9 GB
3. Verifica permisos de lectura del archivo

### Error al extraer .7z

1. Instala 7-Zip: https://www.7-zip.org/
2. Verifica que el archivo .7z no está corrupto
3. Asegúrate de tener espacio en disco (necesitas ~2.1 GB)

## 📞 Soporte

Si tienes problemas para obtener la base de datos:
1. Abre un [Issue en GitHub](https://github.com/tu-usuario/myrient-ddl/issues)
2. Incluye el error específico que estás recibiendo
