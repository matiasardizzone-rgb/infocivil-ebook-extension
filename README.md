# Infocivil Ebook — extensión de Chrome

Lectura de expedientes del fuero Civil (PJN) como libro digital,
exportaciones y "Mis Expedientes", todo en el navegador del operador,
sin servidor central. Nace de `pjn-descargador` (este repo conserva su
historial) y va sumando lo ya probado en Infocivil Ebook Portable.

Destinatarios: operadores del PJN, con Chrome común (sin política
empresarial). Piso de compatibilidad: **Chrome 109** (equipos Windows
7/8.1 de 32 bits). Estado: **desarrollo**, sin publicar.

## Estructura

| Ruta | Rol |
|---|---|
| `manifest.json` | Manifest V3 de **desarrollo** (id fijo por `"key"`) |
| `src/background/index.js` | Service worker: mensajería, biblioteca, descargas, PDF unificado |
| `src/background/externo.js` | Canal landing → extensión (`onMessageExternal`), valida origen |
| `src/content/scw-content.js` | Content script en scw.pjn.gov.ar: scraping, paginación, históricas |
| `src/lib/db.js` | IndexedDB: expedientes, documentos, banderitas |
| `src/lib/firma.js` | Verificación de firma electrónica PJN (alcance: ver comentario del archivo) |
| `src/lib/unificador.js` | PDF unificado: portada, índice hipervinculado, link público al pie |
| `src/public/popup.*` | Popup de la extensión |
| `src/public/biblioteca.*` | Mis Expedientes + lector libro |
| `src/public/lector.html` | Prototipo de lector con transición de página realista (sin integrar) |
| `vendor/` | PDF.js, pdf-lib, forge (ver `vendor/LICENCIAS.md`) |
| `icons/` | Íconos (provisorios) |
| `landing/deteccion-extension.js` | Para la landing de Infocivil: detecta la extensión instalada |
| `scripts/empaquetar-store.mjs` | Genera el ZIP para la Chrome Web Store |
| `docs/PUBLICACION.md` | Identidad (dos ids), checklist de publicación, reglas Chrome 109 |
| `docs/ESQUEMA-MANIFEST.md` | Diseño del expediente canónico (sin implementar) |

## Cómo probar

1. `chrome://extensions` → Modo desarrollador → "Cargar descomprimida" →
   la carpeta del repo. El id tiene que ser `blbghgllddeiignhkclocamalkblagbi`.
2. Abrir un expediente en `scw.pjn.gov.ar` y usar el popup.

## Hoja de ruta de la reconstrucción

Hecho:
- [x] Estructura `src/` + `vendor/` (corrige los nombres de vendor que
      rompían la biblioteca en `pjn-descargador`).
- [x] Identidad: manifest con clave fija, Chrome 109 mínimo, canal externo
      con `ping`, empaquetado para la Store, detección desde la landing.

Siguiente, en este orden:
- [ ] Novedades por id de actuación (no por cantidad) y banderitas ancladas
      a la actuación (no a la página), con migración de lo ya guardado.
- [ ] Vinculados/incidentes: portar `vinculados.js` del Portable (versión
      con clic real y selectores verificados contra el SCW).
- [ ] Lectura continua en la biblioteca.
- [ ] `buscarYAbrir` desde la landing.
- [ ] Integrar `lector.html` (transición realista) al lector de la biblioteca.
- [ ] EPUB.
- [ ] LEX100 (falta el dominio y el formato de URL de actuación).

Fuera de alcance: OCR, IA, integración con Infocivil LM.
