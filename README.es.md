# Carnet santé Helper (extensión para Chrome / Edge)

[English](README.md) · [Français](README.fr.md) · [中文](README.zh.md) · [العربية](README.ar.md) · **Español** · [Kreyòl ayisyen](README.ht.md)

Descargue en lote y organice automáticamente sus informes de [Carnet santé Québec](https://carnetsante.gouv.qc.ca) — el portal de salud de Quebec:

- **Prélèvements** (resultados de laboratorio)
- **Imagerie médicale** (imágenes médicas)

El portal no tiene exportación en lote; esta extensión lo hace por usted, dentro de su propia sesión iniciada. La interfaz habla 13 idiomas y sigue el modo claro/oscuro de su sistema.

## Qué obtiene

Cada PDF archivado por fecha y nombre, más un índice resumen — en la carpeta de descargas del navegador (por defecto) o en la carpeta que elija:

```
Downloads/
└── Carnet santé/
    ├── Prélèvements/
    │   └── 2026-02-01 - Hémogramme.pdf
    ├── Imagerie médicale/
    │   └── 2026-05-15 - Radiographie thorax.pdf
    ├── index-20261107-1530.csv      ← tabla resumen de todos los informes
    └── donnees-20261107-1530.json   ← los mismos datos, legibles por máquina
```

Los informes ya descargados se **omiten automáticamente**: puede ejecutarlo periódicamente y solo se descargan los nuevos.

## Instalación — una vez por computadora

**Opción A · con el script de instalación (actualizaciones fáciles)**

En una máquina nueva (este repositorio es privado — se necesita Git y su sesión de GitHub):

macOS / Linux — Terminal:
```sh
gh repo clone bellchu/CarnetSanteHelper ~/Code/CarnetSanteHelper
bash ~/Code/CarnetSanteHelper/tools/install.sh
```

Windows — PowerShell:
```powershell
gh repo clone bellchu/CarnetSanteHelper $HOME\Code\CarnetSanteHelper
cd $HOME\Code\CarnetSanteHelper
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

¿Ya clonado? Desde el repositorio, ejecute `bash tools/install.sh` (macOS/Linux) o `powershell -ExecutionPolicy Bypass -File tools\install.ps1` (Windows). El script actualiza el código, copia la ruta de la extensión al portapapeles y abre la página de extensiones del navegador.

**Opción B · sin Git — descargar un ZIP**

1. En GitHub: botón verde **Code** → **Download ZIP** → descomprímalo (p. ej. `CarnetSanteHelper-main`).
2. Copie la ruta completa de la **carpeta descomprimida** (no el archivo ZIP). En Windows: Mayús+clic derecho en la carpeta → **Copiar como ruta de acceso**.

**Después, en Chrome o Edge (el único paso manual — regla de seguridad del navegador para extensiones no publicadas):**

1. Abra `chrome://extensions` (Edge: `edge://extensions`).
2. Active el **modo de desarrollador** (arriba a la derecha).
3. Haga clic en **Cargar descomprimida** → pegue la ruta (⌘⇧V / Ctrl+Shift+V) → Enter.

✅ **Listo cuando:** aparezca una tarjeta "Carnet santé Helper" en esa página. Consejo: fíjela — icono de pieza de rompecabezas en la barra → fijar — para tenerla siempre a un clic.

**Actualizar después:** vuelva a ejecutar el script (o descargue el ZIP de nuevo) y haga clic en **Recargar ↻** en la tarjeta de la extensión. Ese último clic no se puede automatizar — es una regla del navegador, no un error.

## Primer uso — 4 pasos

1. **Inicie sesión** en [carnetsante.gouv.qc.ca](https://carnetsante.gouv.qc.ca) y quédese en cualquier página del portal.
2. **Haga clic en el icono de la extensión.** En uno o dos segundos la ventana debería mostrar *Sesión iniciada: su nombre*. Si dice que no hay sesión: actualice la pestaña del portal y vuelva a abrir la ventana.
3. **¿Primera vez? Marque «Solo escanear»** y pulse *Escanear* — cuenta los informes que se descargarían, sin descargar nada. ¿Le convencen los números? Desmarque y pulse *Descargar*.
4. **Vea el progreso** en la ventana (barra, contadores por sección, registro en vivo). Al terminar, abra sus archivos con el botón 📁 del encabezado. **No cierre la pestaña del portal mientras se ejecuta.**

## Ajustes (⚙)

| Ajuste | Qué hace |
|---|---|
| Carpeta de informes | **Elija cualquier carpeta de su disco** (Chrome/Edge de escritorio): los informes se escriben directamente en ella, con subcarpetas. Elija «Permitir en cada visita» al autorizar, para evitar reautorizar. Vuelve a Descargas si no está disponible |
| Carpeta raíz / subcarpetas | Estructura del archivo, por defecto `Carnet santé/Prélèvements` e `Imagerie médicale` (vista previa en vivo; las rutas absolutas se convierten en relativas — el navegador prohíbe escribir fuera de Descargas) |
| Plantilla de nombre | Variables `{date} {label} {prescriber} {section} {id} {year}`, por defecto `{date} - {label}` |
| Retardo entre informes | Por defecto 400 ms — mantenlo por encima de 0, por cortesía con el sitio |
| Años hacia atrás | Por defecto 6 (la API de imagen limita una consulta a ~6 años; la extensión divide automáticamente) |
| Omitir descargados | Interruptor de deduplicación; *Borrar historial* fuerza una descarga completa |

## Cómo funciona y privacidad

El portal es una aplicación Angular sin API pública. La extensión reutiliza su sesión: lee el token OIDC del propio portal en la página, llama a los mismos endpoints privados `/api/1` que usa el sitio (imagen: lista → metadatos → PDF; laboratorio: listas anuales → PDF en base64 dentro del JSON) y guarda vía `chrome.downloads` o la API File System Access.

Todo ocurre localmente en su navegador. **La extensión no se conecta a ningún servicio de terceros ni recopila ni envía nada**; el token solo se usa para obtener sus propios expedientes.

## Solución de problemas

| Síntoma | Solución |
|---|---|
| «No se detectó ninguna sesión» | Inicie sesión en el portal, quédese en su página, actualice una vez y reabra la ventana |
| «Failed to fetch» | Bloqueo de red/CORS: actualice la pestaña conectada del portal y reintente |
| Aparece un diálogo de guardado por cada archivo | El ajuste «Preguntar dónde guardar cada archivo» está activo — desactívelo en `chrome://settings/downloads` y vuelva a ejecutar |
| ⚠ en la carpeta / destino con ⚠ | Autorización caducada (puede pasar tras reiniciar el navegador): reeligir la carpeta en ⚙ Ajustes |
| Archivos fuera de la carpeta elegida | Carpeta movida / desconectada → respaldo automático a Descargas — vea los errores/registro en la ventana |
| Muchos fallos / 401 a mitad | Token probablemente expirado — la extensión lo renueva una vez; si persiste, actualice la página del portal y reintente (lo ya descargado se omite) |
| «Análisis no disponible» | La función no está activada para su cuenta — la extensión omite esa sección y sigue con la imagen |
| Algunos años dan HTTP 500 | El servidor es sensible a los rangos de fechas — la extensión reintenta automáticamente (cambio de formato → año por año); los restos se registran y omiten, suelen superar la retención en línea (~3 años) |
| No encuentro los archivos | Botón 📁 del encabezado; o revise las descargas del navegador (están bajo `Carnet santé/`) |

## Límites y desarrollo

- Depende de los endpoints privados `/api/1` del portal; un rediseño gubernamental podría exigir una actualización (endpoints agrupados al inicio de `lib/pipeline.js`).
- La vacunación está en otro portal; los valores anuales de laboratorio (`ResultatsAnalyse`) no se incluyen.
- Para organizar **sus propios** expedientes de salud — úselo con sensatez (el retardo por defecto tiene su razón de ser).

Desarrolladores: `npm test` — 30 pruebas unitarias + de integración que simulan todo el pipeline contra un `/api/1` falso. Estructura: `lib/` (lógica + orquestación), `content/` (token + llamadas), `background/` (descargas y estado), `popup/`, `options/`, `folder/`.
