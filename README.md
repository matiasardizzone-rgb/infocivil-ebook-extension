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

- [x] Novedades por id de actuación (link público), no por cantidad: el
      orden distinto ya no cuenta como cambio, y se avisan las actuaciones
      que el SCW dejó de mostrar. Si ningún link coincide con lo guardado
      (URL con parámetros variables), cae a comparar por cantidad.
- [x] "Actualizar biblioteca" ya no duplica el expediente.
- [x] Banderitas ancladas a la actuación, no a la foja absoluta; las viejas
      se migran solas (al abrir o antes de actualizar).

**A confirmar contra el SCW real:** que el link público de cada actuación
sea estable entre visitas. Si al verificar un expediente sin cambios el
aviso dice "al día", está confirmado. Si en la consola del service worker
aparece "Ningún link público coincide con lo guardado", no lo es.

- [x] Pantalla de inicio propia (🔎 Consultar expediente en el popup):
      Jurisdicción / Número / Año → la extensión consulta el SCW en una
      ventana minimizada (incluye históricas) y muestra el menú: leer como
      libro, PDF unificado con índice, ZIP, Mis expedientes. La ventana
      del SCW se cierra sola al salir de la pantalla.
- [x] Visor sobre el SCW: tiempo límite por actuación y progreso por foja.

**Estado real (confirmado contra el SCW): la búsqueda automática de
`src/public/inicio.html` funciona de punta a punta.** Búsqueda,
históricas, actuaciones, vuelta al formulario y "Leer como libro" — todo
probado contra el sitio real. La pestaña del SCW se abre CON foco: se probó en segundo plano (v0.6.0),
y contra el sitio real terminaba apareciendo igual — el SCW parece sí
necesitar estar en primer plano durante los saltos de navegación de
home.seam. No vale la pena seguir insistiendo con la invisibilidad total;
lo confirmado es que el foco vuelve al operador apenas se encuentra el
expediente (unos segundos después de arrancar, no al final de leer
históricas y actuaciones).

**Lento (1 a 1.5 min entre históricas y actuaciones), confirmado contra
el SCW real — funciona de punta a punta, solo tarda.** No es un cuelgue:
es el costo real de navegar a actuacionesHistoricas.seam, esperar la
lectura, volver al expediente, y recién ahí leer las actuaciones — todo
secuencial, con viajes de ida y vuelta reales.

Idea concreta para acortarlo (del operador): reusar el mismo criterio de
"Verificar" en Mis Expedientes (compara por id de actuación — el link
público — contra lo ya guardado, y solo baja lo nuevo) para la búsqueda
automática. Si se consulta un expediente que YA está guardado, comparar
antes de descargar y traer solo las actuaciones que falten, en vez de
volver a bajar las 29 enteras. Achica bastante las consultas REPETIDAS de
un mismo expediente; no ayuda la primera vez (nada guardado todavía) ni
el paso de buscar en home.seam (es navegación para conseguir sesión
válida, no descarga — hace falta igual aunque ya se haya consultado
antes). Toca el bucle de descarga en scw-content.js; no es un ajuste
chico, queda pendiente.

**Resuelto: expedientes duplicados en Mis Expedientes.** El `cid` del
SCW identifica la CONSULTA, no el expediente (confirmado: 8648, 15356,
18527, 19003, 26324, todos para CIV 2425/2026 en la misma sesión) — cada
búsqueda nueva creaba una tarjeta nueva. En vez de reindexar toda la base
por número de expediente (riesgoso con datos reales ya guardados), se
agregó `db.fusionarDuplicadosPorNumero()`: al terminar de guardar, si ya
hay otro expediente con el mismo número pero otro `cid`, se migran sus
banderitas (ancladas por actuacionId, sobreviven el traspaso) y se borra
el duplicado viejo. El esquema (`STORE_EXPEDIENTES` sigue por `cid`) no
cambió; es una fusión al vuelo, no una migración. Marcadores en formato
viejo (por página absoluta, sin actuacionId) no se pueden re-anclar sin
el armado del libro de esa sesión vieja y se pierden al fusionar — caso
raro a esta altura, ya casi todo migró a actuacionId.

También funciona, confirmado contra el SCW real: **buscar el expediente a
mano** (como siempre) y usar el popup — 💾 Guardar en biblioteca, 📎 PDF
unificado con índice y enlaces, ⬇️ ZIP, y **📖 Leer como libro**, que
guarda (mismo camino que 💾) y abre directo el lector real
(`biblioteca.html`) en vez del visor continuo viejo.

**Resuelto: Vinculados / incidentes.** Portado de `vinculados.js` del
Portable (versión Playwright probada contra el SCW real — la
"playwright-reference" del paquete fusionado resultó ser una copia
literal, nunca se había portado a DOM de verdad). Al confirmar el
expediente principal, se leen sus vinculados (solapa "Vinculados", clic
real + `#expediente:connectedTable`) y se muestran en la pantalla de
resultados con un botón "Abrir" cada uno (estilo del portal web). Si se
pidió un incidente puntual desde el formulario, se abre automáticamente
(botón "ojo" de la fila — requiere ejecutar su onclick en la página, un
clic sintético no alcanza) y el resto del flujo (históricas, actuaciones)
sigue sobre el incidente, no el principal. Si el incidente pedido no
aparece en Vinculados, cae al principal con un aviso claro.

Dos bugs de fondo encontrados y corregidos en el camino, los dos con el
mismo patrón que ya había aparecido en la búsqueda (v0.5.5) — una
respuesta perdida por navegación no es lo mismo que un fallo real:
- Abrir un vinculado desde la pantalla de resultados (después de que la
  búsqueda inicial ya terminó) usaba el mismo puerto de conexión larga de
  esa búsqueda — y el service worker de una extensión Manifest V3 se
  apaga solo tras un rato de inactividad. Ahora usa `sendMessage` (mensaje
  suelto, sin conexión que mantener), que despierta el service worker de
  forma confiable bajo demanda.
- El clic en el botón "ojo" de un vinculado funciona (navega al incidente)
  pero puede perderse la respuesta si la navegación destruye el content
  script en el instante de contestar — igual que pasaba con el botón
  "Consultar" del formulario. Antes de reintentar (que corría sobre la
  página YA navegada, sin tabla de vinculados, y fallaba distinto), se
  verifica si la página ya cambió de expediente.

Probado con un vinculado real: lista visible en pantalla, "Abrir" desde
el botón, pedido directo desde el formulario con el campo Incidente, y
caída correcta al principal cuando el incidente no existe.

**Límite conocido:** en Chrome 109 el service worker se corta a los 5
minutos aunque esté trabajando; una consulta normal tarda mucho menos, pero
un expediente enorme podría no llegar. Desde Chrome 110 no pasa.

Siguiente, en este orden:
- [ ] Lectura continua dentro del lector (portar del paquete fusionado) y
      agregarla a la pantalla del expediente.
- [ ] Lector real con el diseño del artefacto web: panel lateral con el
      índice de actuaciones (descripción, no solo número), páginas más
      grandes, y unificar el color de las barras superior e inferior en
      azul (línea con el resto de Infocivil). Referencia: el lector viejo
      del portal web (`Infocivil-Ebook-Portable`).
- [ ] `buscarYAbrir` desde la landing.
- [ ] Integrar `lector.html` (transición realista) al lector de la biblioteca.
- [ ] EPUB.
- [ ] LEX100 (falta el dominio y el formato de URL de actuación).

Fuera de alcance: OCR, IA, integración con Infocivil LM.
