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
probado contra el sitio real.

**v0.9.3 — con foco durante TODA la búsqueda, no solo al principio.**
Historial completo de este ida y vuelta, porque importa para no repetirlo:
- v0.9.0: pestaña oculta desde el arranque → 13 de 29 actuaciones.
- v0.9.1: mostrada un momento, luego oculta (hipótesis: "nunca mostrada"
  era la causa) → el operador confirmó que seguía igual, cortaba en la
  página 2 igual. Hipótesis descartada.
- v0.9.2: de vuelta oculta, pero con mucho más margen de espera por
  página (25s/45s en vez de 8s/15s) → el operador confirmó que **seguía
  cortando en la página 2**, con el mismo mensaje de siempre. Esto
  descarta que fuera cuestión de tiempo: más margen no cambió nada.
- Diagnóstico: no es que sea más lento en segundo plano, es que
  probablemente Chrome SUSPENDE del todo el ciclo de repintado
  (`requestAnimationFrame`) en pestañas ocultas, no solo lo frena. Si
  RichFaces aplica sus actualizaciones del DOM a través de eso, la
  respuesta del SCW puede llegar bien y nunca reflejarse en la página
  mientras esté oculta — por eso ningún margen de espera, por generoso
  que sea, lo soluciona.
- v0.9.3: la pestaña se queda CON foco durante toda la búsqueda —
  incluidas históricas y actuaciones, no solo el tramo inicial de
  home.seam — y el foco recién vuelve al operador cuando todo terminó.
  Mismo arreglo aplicado a abrir un vinculado desde la pantalla de
  resultados (v0.8.1), que tenía el mismo problema sin que nadie lo
  hubiera notado: nunca traía la pestaña al frente.

**Se abandona la idea de una búsqueda completamente oculta.** El
operador va a ver la pestaña del SCW durante toda la consulta (hasta que
aparece el menú de resultados) — no hay forma de evitarlo sin arriesgar
actuaciones faltantes, dado este límite de Chrome con pestañas ocultas y
contenido armado por RichFaces/AJAX. **A confirmar contra el SCW real
que esta vez sí traiga el expediente completo.**

**Históricas (v0.9.0):** desde 2019 los expedientes no tienen históricas
(nacieron digitales, dato del operador) — para esos no se visita
`actuacionesHistoricas.seam` en absoluto. Para los anteriores, se portó el
criterio del Portable: el SCW sin históricas NO muestra cartel, solo la
página con los datos generales; si aparece "Carátula" y en 6s no hay
filas, no hay históricas (antes se esperaban 40s enteros por un cartel
que nunca llegaba). Medido contra el simulador: 14s un expediente 2026,
26s uno de 2015 sin históricas.

**Lento (1 a 1.5 min entre históricas y actuaciones), confirmado contra
el SCW real — funciona de punta a punta, solo tarda.** (Antes de v0.9.0:
buena parte de esa demora eran los 40s de espera en históricas vacías.) No es un cuelgue:
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

**v0.8.1 — abrir un vinculado desde la pantalla de resultados ya no pasa
por el SCW en absoluto** (ni una pestaña nueva, ni foco en ningún
momento): en vez de rehacer la búsqueda completa desde `home.seam`
(que sí necesita foco, por los saltos de navegación), actúa directo
sobre la pestaña del expediente PRINCIPAL, que sigue abierta en segundo
plano desde la búsqueda inicial. Solo si esa pestaña ya no sirve (se
cerró, por ejemplo) cae a la búsqueda completa como red de seguridad.

En el camino se encontró y arregló otro bug: la vuelta desde
`actuacionesHistoricas.seam` recarga la página entera, y con ella se
pierde la solapa "Vinculados" ya abierta durante la búsqueda inicial —
`abrirVinculadoDOM` ahora la reabre sola si hace falta, en vez de asumir
que ya está abierta.

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
