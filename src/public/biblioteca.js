// biblioteca.js — Pantalla de biblioteca + visor libro, con datos reales.
// Corre como script type="module" dentro de biblioteca.html (origen de la
// extensión), así que puede importar db.js directamente sin pasar por
// background.js — solo lo usamos para orquestar tabs del SCW (verificar/actualizar).

import * as db from '../lib/db.js';
import { verificarFirmaPDF } from '../lib/firma.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');

const FLAG_COLORS = [
  { id: 'rojo', hex: '#c0392b' }, { id: 'ambar', hex: '#c78a1e' }, { id: 'verde', hex: '#2f7d4f' },
  { id: 'azul', hex: '#1e5ba8' }, { id: 'violeta', hex: '#6b4ba8' },
];

let expActivo = null;   // registro de db.js del expediente abierto
let docsDb = [];         // documentos crudos de IndexedDB (con blob)
let pdfProxies = [];     // { di, pdf } — un getDocument() por doc, cacheado
let pages = [];          // aplanado: { di, p, doc, canvas:null }
let flags = [];
let firmasPorDoc = [];   // { estado, firmas, detalle } | null (todavía no verificado) — indexado por di
let cur = 0, animating = false, selColor = FLAG_COLORS[0].id;
// Ajuste automático por defecto (null), no un porcentaje fijo: en una
// pantalla ancha, "100%" (tamaño real del PDF) deja la hoja chica con
// mucho margen vacío a los costados — lo pidió el operador explícitamente
// ("aprovechar al máximo la pantalla") después de ver el lector real en
// un monitor grande. El operador puede elegir 100% a mano desde el
// selector si lo prefiere en su pantalla — solo cambia el valor inicial.
let zoomManual = null;

// ─────────────────────────── BIBLIOTECA (grilla) ───────────────────────────
const libraryEl = document.getElementById('library');
const sceneEl   = document.getElementById('scene');
const libGrid   = document.getElementById('libGrid');

async function cargarBiblioteca() {
  const expedientes = await db.listarExpedientes();
  document.getElementById('libCount').textContent =
    expedientes.length + ' guardado' + (expedientes.length !== 1 ? 's' : '');
  libGrid.innerHTML = '';

  if (!expedientes.length) {
    libGrid.innerHTML = `<div class="lib-empty">Todavía no guardaste ningún expediente.<br>
      Abrí uno en el SCW y usá "💾 Guardar en biblioteca" desde el popup de la extensión.</div>`;
    return;
  }

  expedientes.forEach(exp => {
    const card = document.createElement('div');
    card.className = 'lib-card' + (exp.estado === 'nuevo' ? ' new' : '');
    const avisoIni = textoEstado(exp.estado === 'nuevo' ? exp.nuevasDetectadas : 0, exp.eliminadasDetectadas || 0);
    card.innerHTML = `
      <div class="lib-card-info">
        <div class="lc-num">${esc(exp.numero || exp.cid)}</div>
        <div class="lc-title">${esc(exp.caratula || '(sin carátula detectada)')}</div>
        <div class="lc-meta">
          <span>${exp.cantidadActuaciones || 0} actuaciones</span>
          <span>· visto por última vez el ${fechaCorta(exp.fechaVerificacion || exp.fechaDescarga)}</span>
          <span class="lc-badge" data-badge${avisoIni ? '' : ' hidden'}>${esc(avisoIni)}</span>
        </div>
        <div class="lib-bar" style="display:none"><div class="lib-bar-fill" data-bar></div></div>
      </div>
      <div class="lc-actions">
        <button data-verify class="lc-icon" title="${exp.estado === 'nuevo' ? 'Actualizar biblioteca' : 'Chequear si hay novedades en el SCW'}">${exp.estado === 'nuevo' ? '⬇️' : '🔄'}</button>
        <button data-zip class="lc-icon" title="Exportar como ZIP">📦</button>
        <button data-open>Abrir</button>
        <button data-del class="lc-texto" title="Eliminar de la biblioteca">Quitar</button>
      </div>
    `;
    card.querySelector('[data-open]').addEventListener('click', e => { e.stopPropagation(); abrirExpediente(exp.cid); });
    card.addEventListener('click', () => abrirExpediente(exp.cid));
    card.querySelector('[data-verify]').addEventListener('click', e => {
      e.stopPropagation();
      exp.estado === 'nuevo' ? actualizarExpediente(exp, card) : verificarExpediente(exp, card);
    });
    card.querySelector('[data-zip]').addEventListener('click', async e => {
      e.stopPropagation();
      const btnZip = card.querySelector('[data-zip]');
      const original = btnZip.textContent;
      btnZip.textContent = '⏳'; btnZip.disabled = true;
      try { await exportarZip(exp); } catch (err) { alert('No se pudo exportar: ' + err.message); }
      btnZip.textContent = original; btnZip.disabled = false;
    });
    card.querySelector('[data-del]').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('¿Eliminar "' + (exp.caratula || exp.numero) + '" de la biblioteca? Esto borra los PDFs guardados localmente.')) return;
      await db.eliminarExpediente(exp.cid);
      cargarBiblioteca();
    });
    libGrid.appendChild(card);
  });
}

// Texto del aviso de novedades de una tarjeta. Las eliminadas se informan
// aparte: no son "nuevas", pero el operador tiene que enterarse.
function textoEstado(nuevas, eliminadas) {
  const partes = [];
  if (nuevas > 0) partes.push('🔴 ' + nuevas + (nuevas === 1 ? ' actuación nueva' : ' actuaciones nuevas'));
  if (eliminadas > 0) partes.push('⚠️ ' + eliminadas + (eliminadas === 1 ? ' ya no figura' : ' ya no figuran') + ' en el SCW');
  return partes.join(' · '); // vacío = al día, no se muestra nada (el aviso de novedades es la excepción, no el estado normal)
}

function fechaCorta(iso) {
  if (!iso) return '?';
  try { return new Date(iso).toLocaleDateString('es-AR'); } catch (e) { return iso; }
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Muestra/oculta el aviso de novedades de una tarjeta (texto vacío = al
// día, no se muestra nada — la excepción es la novedad, no el estado normal).
function fijarAviso(badge, texto) {
  badge.textContent = texto;
  badge.hidden = !texto;
}

// Verificar: abre (o reusa) la pestaña del SCW, escanea liviano, compara.
async function verificarExpediente(exp, card) {
  const badge = card.querySelector('[data-badge]');
  const btn = card.querySelector('[data-verify]');
  fijarAviso(badge, '⏳ Verificando en el SCW...');
  btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ action: 'bibliotecaVerificarEnVivo', cid: exp.cid });
    if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo verificar.');
    exp.estado = r.cambio ? 'nuevo' : 'ok';
    exp.nuevasDetectadas = r.nuevasDetectadas || 0;
    card.classList.toggle('new', r.cambio);
    exp.eliminadasDetectadas = r.eliminadasDetectadas || 0;
    fijarAviso(badge, textoEstado(r.nuevasDetectadas || 0, r.eliminadasDetectadas || 0));
    if (r.criterio === 'cantidad') badge.title = 'Comparado por cantidad de actuaciones (los links públicos no coincidieron).';
    btn.textContent = r.cambio ? '⬇️' : '🔄';
    btn.title = r.cambio ? 'Actualizar biblioteca' : 'Chequear si hay novedades en el SCW';
  } catch (err) {
    fijarAviso(badge, '❌ ' + err.message);
  }
  btn.disabled = false;
}

// Actualizar: igual que verificar, pero además dispara la descarga real
// de las actuaciones faltantes (reutiliza el flujo "guardarEnBiblioteca").
async function actualizarExpediente(exp, card) {
  const badge = card.querySelector('[data-badge]');
  const btn = card.querySelector('[data-verify]');
  const barWrap = card.querySelector('.lib-bar');
  const barFill = card.querySelector('[data-bar]');
  fijarAviso(badge, '⏳ Actualizando biblioteca...');
  btn.disabled = true;
  barWrap.style.display = 'block';

  try {
    const r = await chrome.runtime.sendMessage({ action: 'bibliotecaActualizarEnVivo', cid: exp.cid });
    if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo actualizar.');

    // Progreso real vía chrome.storage.local (el mismo canal que usa el popup)
    await new Promise(resolve => {
      const poll = setInterval(() => {
        chrome.storage.local.get(['descargaProgreso'], data => {
          const p = data.descargaProgreso;
          if (!p) return;
          const pct = p.total ? Math.round((p.descargados / p.total) * 100) : 0;
          barFill.style.width = pct + '%';
          if (p.terminado) { clearInterval(poll); resolve(); }
        });
      }, 500);
      setTimeout(() => { clearInterval(poll); resolve(); }, 120000); // tope de seguridad
    });

    const actualizado = await db.obtenerExpediente(exp.cid);
    exp.estado = 'ok'; exp.nuevasDetectadas = 0;
    exp.cantidadActuaciones = actualizado ? actualizado.cantidadActuaciones : exp.cantidadActuaciones;
    exp.fechaDescarga = actualizado ? actualizado.fechaDescarga : exp.fechaDescarga;
    exp.fechaVerificacion = actualizado ? actualizado.fechaVerificacion : exp.fechaVerificacion;
    card.classList.remove('new');
    fijarAviso(badge, '');
    btn.textContent = '🔄';
    btn.title = 'Chequear si hay novedades en el SCW';
    const meta = card.querySelector('.lc-meta');
    meta.querySelector('span:first-child').textContent = exp.cantidadActuaciones + ' actuaciones';
    meta.querySelectorAll('span')[1].textContent = '· visto por última vez el ' + fechaCorta(exp.fechaVerificacion || exp.fechaDescarga);
  } catch (err) {
    fijarAviso(badge, '❌ ' + err.message);
  }
  btn.disabled = false;
  barWrap.style.display = 'none';
}

document.getElementById('btnHome').addEventListener('click', () => { cargarBiblioteca(); mostrarBiblioteca(); });
document.getElementById('expteSwitch').addEventListener('click', () => { cargarBiblioteca(); mostrarBiblioteca(); });
document.getElementById('btnNuevaConsulta').addEventListener('click', async () => {
  // Vuelve al panel de opciones de ESTE expediente (Leer como libro / PDF
  // unificado / ZIP / vinculados) — no a una búsqueda en blanco. Lee de
  // Mis expedientes, sin pasar por el SCW de nuevo (ver cargarDesdeGuardado
  // en inicio.js).
  const url = chrome.runtime.getURL('src/public/inicio.html') + '?resultados=' + encodeURIComponent(expActivo.cid);
  // Si ya hay una pestaña de consulta abierta (cualquier estado de
  // inicio.html), se reusa esa en vez de apilar una pestaña nueva cada vez.
  const existentes = await chrome.tabs.query({ url: chrome.runtime.getURL('src/public/inicio.html') + '*' });
  if (existentes.length) {
    const t = existentes[0];
    await chrome.tabs.update(t.id, { url, active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});
document.getElementById('zoomSel').addEventListener('change', async function () {
  zoomManual = parseFloat(this.value);
  pages.forEach(p => { p.canvas = null; });
  await render(cur);
});
document.getElementById('btnFit').addEventListener('click', async () => {
  zoomManual = null; // vuelve al ajuste automático — SIEMPRE recalcula al tocarlo, sea cual sea el estado anterior
  pages.forEach(p => { p.canvas = null; });
  await render(cur);
});
document.getElementById('btnDescargarDoc').addEventListener('click', () => {
  if (!pages[cur]) return;
  const doc = pages[cur].doc;
  const numero = String(pages[cur].di + 1).padStart(4, '0');
  const nombre = numero + ' - ' + sanitizarNombre(doc.titulo || 'documento') + (doc.extension || '.pdf');
  const url = URL.createObjectURL(doc.blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
});
document.getElementById('btnLimpiar').addEventListener('click', async () => {
  const expedientes = await db.listarExpedientes();
  if (!expedientes.length) return;
  if (!confirm('¿Eliminar TODOS los ' + expedientes.length + ' expedientes guardados en la biblioteca? Esto borra todos los PDFs locales y no se puede deshacer.')) return;
  for (const exp of expedientes) await db.eliminarExpediente(exp.cid);
  cargarBiblioteca();
});

function mostrarBiblioteca() { libraryEl.style.display = 'flex'; sceneEl.style.display = 'none'; }
function mostrarLibro()      { libraryEl.style.display = 'none'; sceneEl.style.display = 'flex'; }

// ─────────────────────────── ABRIR EXPEDIENTE (real) ───────────────────────────
async function abrirExpediente(cid) {
  try {
    expActivo = await db.obtenerExpediente(cid);
    if (!expActivo) { alert('No se encontró ese expediente en la biblioteca (cid=' + cid + ').'); return; }
    docsDb = await db.obtenerDocumentos(cid);
    if (!docsDb.length) { alert('Este expediente no tiene documentos guardados.'); return; }

    // Un getDocument() por PDF, pero SIN renderizar páginas todavía (lazy).
    pdfProxies = [];
    pages = [];
    for (let di = 0; di < docsDb.length; di++) {
      const doc = docsDb[di];
      const buffer = await doc.blob.arrayBuffer();
      console.log('[PJN DIAG LIB] doc', di, '| blob.size:', doc.blob.size, '| buffer.byteLength:', buffer.byteLength,
        '| primeros bytes:', Array.from(new Uint8Array(buffer.slice(0,5))).join(','));
      const pdf = await pdfjsLib.getDocument({ data: buffer, isEvalSupported: false, useSystemFonts: true }).promise;
      pdfProxies.push(pdf);
      for (let p = 1; p <= pdf.numPages; p++) pages.push({ di, p, doc, canvas: null, textLayer: null });
    }

    flags = await cargarBanderitas(cid);
    cur = 0;
    firmasPorDoc = docsDb.map(() => null);

    document.getElementById('expteNum').textContent = expActivo.numero || expActivo.cid;
    buildIndex();
    mostrarLibro();
    await render(0);
    renderFlags();
    verificarFirmasEnSegundoPlano(); // no bloquea: actualiza badges a medida que termina cada una
  } catch (err) {
    console.error('[PJN Biblioteca] Error al abrir expediente:', err);
    alert('❌ No se pudo abrir el expediente:\n\n' + (err && err.message ? err.message : err) +
      '\n\nRevisá la consola (clic derecho → Inspeccionar → Console) para más detalle.');
  }
}

// ─────────────────────────── ÍNDICE ───────────────────────────
// El riel angosto de pestañas (una por actuación, con el cordón rojo
// decorativo al lado) se sacó: quedaba redundante con el panel de
// índice, que ya hace lo mismo con más información (título completo,
// fecha) y siempre visible.
const idxList = document.getElementById('idxList');
function buildIndex() {
  idxList.innerHTML = '';
  document.getElementById('idxCount').textContent = docsDb.length + ' actuaciones · ' + pages.length + ' fojas';
  docsDb.forEach((d, di) => {
    const it = document.createElement('div');
    it.className = 'index-item' + (d.esHistorica ? ' hist' : '');
    it.dataset.di = di;
    it.dataset.buscar = (String(di + 1) + ' ' + (d.tipo || '') + ' ' + (d.titulo || '') + ' ' + (d.fecha || '')).toLowerCase();
    it.innerHTML = `<span class="index-num">${String(di + 1).padStart(3, '0')}</span>` +
      `<div class="index-body">` +
      (d.tipo ? `<div class="index-tipo">${esc(d.tipo)}</div>` : '') +
      `<div class="index-desc">${esc(d.titulo)}</div>` +
      (d.fecha ? `<div class="index-fecha">${esc(d.fecha)}</div>` : '') +
      `</div>`;
    it.addEventListener('click', () => irADoc(di)); // el panel es fijo ahora: no se cierra solo al navegar
    idxList.appendChild(it);
  });
}

// Buscador del índice: filtra por número, tipo, título o fecha a medida
// que se escribe — no hace falta salir del índice ni pasar de página.
document.getElementById('idxSearch').addEventListener('input', function () {
  const q = this.value.trim().toLowerCase();
  document.querySelectorAll('.index-item').forEach(it => {
    it.classList.toggle('filtrado', !!q && !it.dataset.buscar.includes(q));
  });
});

// ─────────────────────────── FIRMA ELECTRÓNICA ───────────────────────────
async function verificarFirmasEnSegundoPlano() {
  for (let di = 0; di < docsDb.length; di++) {
    try {
      const buffer = await docsDb[di].blob.arrayBuffer();
      firmasPorDoc[di] = await verificarFirmaPDF(buffer);
    } catch (err) {
      firmasPorDoc[di] = { estado: 'error', firmas: [], detalle: err.message };
    }
    // actualizarBadgeFirma ya recorre las hojas visibles (izq. y der.) y
    // no hace nada si ninguna es de este documento — no hace falta
    // filtrar acá primero (antes solo miraba la izquierda, y la firma de
    // la derecha podía quedar sin actualizar).
    actualizarBadgeFirma(di);
  }
}

function etiquetaFirma(resultado) {
  if (!resultado) return { cls: 'checking', texto: '⏳ Verificando firma...', title: '' };
  if (resultado.estado === 'sin_firma') return { cls: 'none', texto: '— Sin firma', title: resultado.detalle };
  if (resultado.estado === 'no_detectable') return { cls: 'bad', texto: '❓ Firma no verificable', title: resultado.detalle };
  if (resultado.estado === 'valida') {
    const f = resultado.firmas[0] || {};
    return { cls: 'ok', texto: '✅ Firma válida', title: 'Firmante: ' + (f.firmante || '?') + ' · Emisor: ' + (f.emisor || '?') };
  }
  if (resultado.estado === 'invalida') return { cls: 'bad', texto: '⚠️ Revisar firma', title: resultado.detalle };
  return { cls: 'bad', texto: '❓ No se pudo verificar', title: resultado.detalle };
}

function iconoFirma(et) {
  const m = et.texto.match(/^(\S+)/);
  return m ? m[1] : '—';
}

// Actualiza el iconito de firma de CUALQUIER hoja visible (izq. o der.,
// en cualquiera de las dos caras) que pertenezca al documento 'di' —
// puede haber hasta dos a la vez si el par cruza dos actuaciones y una
// de ellas es justo esta.
function actualizarBadgeFirma(di) {
  const et = etiquetaFirma(firmasPorDoc[di]);
  document.querySelectorAll('.leaf-col').forEach(col => {
    const idx = col.dataset.pagina === '' ? null : +col.dataset.pagina;
    if (idx === null || !pages[idx] || pages[idx].di !== di) return;
    const el = col.querySelector('.lh-firma');
    el.className = 'lh-firma ' + et.cls;
    el.textContent = iconoFirma(et);
    el.title = et.texto + (et.title ? ' — ' + et.title : '');
  });
}

// ─────────────────────────── RENDER DE PÁGINA (lazy) ───────────────────────────
const spread3d = document.getElementById('spread3d');
const caraA = document.getElementById('caraA');
const caraB = document.getElementById('caraB');
const stageEl = document.getElementById('stage');

async function renderCanvas(idx) {
  const pg = pages[idx];
  if (pg.canvas) return pg; // ya renderizado, lo reusamos
  const pdf = pdfProxies[pg.di];
  const page = await pdf.getPage(pg.p);

  // Escala dinámica: aprovechamos el espacio real disponible de UNA hoja
  // (la mitad del libro, no el libro entero) en vez de un zoom fijo, así
  // se ve grande en pantallas grandes y entera en chicas. Solo tiene
  // sentido cuando el stage ya está en el DOM medible.
  const base = page.getViewport({ scale: 1 });
  let scale;
  if (zoomManual) {
    scale = zoomManual;
  } else {
    scale = 1.4;
    if (stageEl && stageEl.clientWidth > 80 && stageEl.clientHeight > 40) {
      const margen = 0.95;
      const anchoHoja = stageEl.clientWidth / 2;
      scale = Math.min((anchoHoja * margen) / base.width, (stageEl.clientHeight * margen) / base.height);
      scale = Math.max(0.5, Math.min(scale, 2.6));
    }
  }

  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  pg.canvas = canvas;
  return pg;
}

// Copia los píxeles ya renderizados a un canvas nuevo (barato: no vuelve a
// dibujar el PDF) — hace falta porque el MISMO <canvas> no puede estar a
// la vez en la hoja "de reposo" y en la hoja "en tránsito" mientras gira.
function clonarCanvas(origen) {
  const c = document.createElement('canvas');
  c.width = origen.width; c.height = origen.height;
  c.getContext('2d').drawImage(origen, 0, 0);
  return c;
}

// Pinta UNA hoja (columna izquierda o derecha) dentro de una cara: su
// canvas, referencia (actuación · título · página), firma, bandera y
// enlace público propios — cada hoja es autosuficiente, no depende de la
// otra (pueden ser de actuaciones distintas).
function pintarHoja(colEl, pg, indice) {
  const wrap = colEl.querySelector('.pdf-canvas-wrap');
  wrap.innerHTML = '';
  colEl.dataset.pagina = indice === null ? '' : String(indice);
  colEl.dataset.url = '';
  colEl.classList.toggle('vacia', !pg);
  colEl.querySelector('.leaf-head').style.visibility = pg ? '' : 'hidden';
  colEl.querySelector('.leaf-foot').style.visibility = pg ? '' : 'hidden';
  if (!pg) return;

  wrap.appendChild(clonarCanvas(pg.canvas));
  const doc = pg.doc;
  const ref = colEl.querySelector('.lh-ref');
  ref.textContent = `Act. ${pg.di + 1} · ${doc.titulo} · pág ${pg.p}`;
  ref.title = ref.textContent;
  colEl.querySelector('.lh-flag').classList.toggle('on', flags.some(f => f.page === indice));

  const url = doc.urlHiper || '';
  colEl.dataset.url = url;
  colEl.querySelector('.lf-url').textContent = url.replace('https://', '');

  const et = etiquetaFirma(firmasPorDoc[pg.di]);
  const fEl = colEl.querySelector('.lh-firma');
  fEl.className = 'lh-firma ' + et.cls;
  fEl.textContent = iconoFirma(et);
  fEl.title = et.texto + (et.title ? ' — ' + et.title : '');
}

// Dibuja el par de páginas (i, i+1) dentro de una de las dos caras del
// spread (caraA o caraB). Devuelve la página izquierda (la "focal", la que
// manda en el índice y en counter/prev/next).
async function pintarSpreadEnCara(caraEl, i) {
  const pgL = pages[i] || null;
  const pgR = pages[i + 1] || null;
  await Promise.all([pgL, pgR].filter(Boolean).map(pg => renderCanvas(pages.indexOf(pg))));
  pintarHoja(caraEl.querySelector('[data-lado="l"]'), pgL, pgL ? i : null);
  pintarHoja(caraEl.querySelector('[data-lado="r"]'), pgR, pgR ? i + 1 : null);
  return pgL;
}

function actualizarCabeceraPieControles(i, pgL) {
  cur = i;
  const pgR = pages[i + 1] || null;

  const hayDerecha = i + 1 < pages.length;
  document.getElementById('counter').textContent = hayDerecha
    ? `fs. ${i + 1}-${i + 2} / ${pages.length}`
    : `fs. ${i + 1} / ${pages.length}`;
  document.getElementById('btnPrev').disabled = i <= 0;
  document.getElementById('btnNext').disabled = i + 2 >= pages.length;
  document.querySelectorAll('.index-item').forEach(t => {
    const di = +t.dataset.di;
    t.classList.toggle('on', di === pgL.di || (pgR && di === pgR.di));
  });
  document.getElementById('btnFlag')?.classList.toggle('on', flags.some(f => f.page === i));

  // Precarga silenciosa del próximo par para que el siguiente "pasar
  // hoja" sea instantáneo — no bloquea nada de lo de arriba.
  if (i + 2 < pages.length) renderCanvas(i + 2);
  if (i + 3 < pages.length) renderCanvas(i + 3);
}

// Primera carga, o saltos sin animación de vuelta de hoja (por ejemplo,
// al abrir el expediente): siempre queda pintado en caraA, en reposo.
async function render(i) {
  const objetivo = i - (i % 2);
  const pgL = await pintarSpreadEnCara(caraA, objetivo);
  actualizarCabeceraPieControles(objetivo, pgL);
}

function ultimoIzquierdoValido() {
  return pages.length % 2 === 0 ? pages.length - 2 : pages.length - 1;
}

function esperarTransicion(el) {
  return new Promise(resolve => {
    const fin = (e) => { if (e.target !== el) return; el.removeEventListener('transitionend', fin); resolve(); };
    el.addEventListener('transitionend', fin);
    setTimeout(resolve, 320); // red de seguridad si transitionend no llega a disparar
  });
}

async function goTo(iSolicitado, dir) {
  if (animating) return;
  const objetivo = Math.max(0, Math.min(iSolicitado - (iSolicitado % 2), ultimoIzquierdoValido()));
  if (objetivo === cur) return;
  animating = true;
  try {
    const avanza = objetivo > cur;
    // El destino se dibuja en caraB (invisible) MIENTRAS el operador
    // todavía ve caraA — nunca hay un hueco en blanco esperando.
    const pgL = await pintarSpreadEnCara(caraB, objetivo);

    // 1) La hoja actual se desliza y se desvanece hacia el lado por el
    //    que "se pasa" (adelante → sale por la izquierda, como si diera
    //    vuelta; atrás → por la derecha).
    caraA.classList.add(avanza ? 'sale-izq' : 'sale-der');
    await esperarTransicion(caraA);

    // 2) Se copia el contenido de caraB a caraA (barato: son canvases ya
    //    renderizados, no se vuelve a dibujar el PDF) y se la reubica AL
    //    INSTANTE del lado opuesto, sin animar — recién ahí se le saca
    //    esa clase, así la transición que sigue la trae deslizando desde
    //    el lado contrario al que salió la hoja vieja.
    await pintarSpreadEnCara(caraA, objetivo);
    caraA.style.transition = 'none';
    caraA.classList.remove('sale-izq', 'sale-der');
    caraA.classList.add(avanza ? 'entra-der' : 'entra-izq');
    void caraA.offsetWidth; // forzar reflow antes de reactivar la transición
    caraA.style.transition = '';
    caraA.classList.remove('entra-der', 'entra-izq');
    await esperarTransicion(caraA);

    actualizarCabeceraPieControles(objetivo, pgL);
  } catch (e) {
    console.error('[PJN Biblioteca] Error pasando de hoja:', e);
  } finally {
    animating = false;
  }
}

function irADoc(di) {
  const firstIdx = pages.findIndex(pg => pg.di === di);
  if (firstIdx >= 0) goTo(firstIdx, firstIdx > cur ? 'next' : 'prev');
}

document.getElementById('btnPrev').addEventListener('click', () => goTo(cur - 2, 'prev'));
document.getElementById('btnNext').addEventListener('click', () => goTo(cur + 2, 'next'));
document.getElementById('navL').addEventListener('click', () => goTo(cur - 2, 'prev'));
document.getElementById('navR').addEventListener('click', () => goTo(cur + 2, 'next'));
document.addEventListener('keydown', e => {
  if (!expActivo || sceneEl.style.display === 'none') return;
  if (e.key === 'ArrowRight') goTo(cur + 2, 'next');
  else if (e.key === 'ArrowLeft') goTo(cur - 2, 'prev');
  else if (e.key === 'Home') goTo(0, 'prev');
  else if (e.key === 'End') goTo(pages.length - 1, 'next');
  else if (e.key === 'Escape') cerrarIndice();
});

let dragStartX = null;
stageEl.addEventListener('pointerdown', e => { dragStartX = e.clientX; stageEl.classList.add('dragging'); });
stageEl.addEventListener('pointerup', e => {
  stageEl.classList.remove('dragging');
  if (dragStartX === null) return;
  const dx = e.clientX - dragStartX; dragStartX = null;
  if (dx < -60) goTo(cur + 2, 'next'); else if (dx > 60) goTo(cur - 2, 'prev');
});
stageEl.addEventListener('pointerleave', () => { stageEl.classList.remove('dragging'); dragStartX = null; });

// ─────────────────────────── ÍNDICE DESLIZABLE ───────────────────────────
const idxPanel = document.getElementById('idxPanel');

// El panel ahora es fijo (visible por defecto, empuja el libro en vez de
// taparlo): "cerrarlo" solo lo angosta a 0 para darle más lugar a la
// página, no lo saca de encima de nada.
function abrirIndice() { idxPanel.classList.remove('closed'); }
function cerrarIndice() { idxPanel.classList.add('closed'); }
document.getElementById('btnIndex').addEventListener('click', abrirIndice);
document.getElementById('idxClose').addEventListener('click', cerrarIndice);

// ─────────────────────────── ENLACE PÚBLICO (uno por hoja, en su pie) ───────────────────────────
// Delegado en el stage, no un listener por botón: el par de hojas se
// vuelve a pintar entero en cada vuelta de hoja (pintarHoja hace
// wrap.innerHTML = ''), así que cualquier listener puesto directo sobre
// un botón anterior quedaría huérfano.
stageEl.addEventListener('click', e => {
  const copy = e.target.closest('.lf-copy');
  const open = e.target.closest('.lf-open');
  const btn = copy || open;
  if (!btn) return;
  const col = btn.closest('.leaf-col');
  const url = col && col.dataset.url;
  if (!url) return;
  if (copy) {
    navigator.clipboard?.writeText(url).catch(() => {});
    const original = btn.textContent;
    btn.textContent = '✓'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1600);
  } else {
    window.open(url, '_blank');
  }
});

// ─────────────────────────── BANDERITAS LIBRES (persistentes de verdad) ───────────────────────────
const fpColors = document.getElementById('fpColors');
FLAG_COLORS.forEach(c => {
  const sw = document.createElement('div');
  sw.className = 'fp-color' + (c.id === selColor ? ' sel' : '');
  sw.style.background = c.hex; sw.dataset.id = c.id;
  sw.addEventListener('click', () => {
    selColor = c.id;
    fpColors.querySelectorAll('.fp-color').forEach(x => x.classList.toggle('sel', x.dataset.id === c.id));
  });
  fpColors.appendChild(sw);
});
// ─── Anclaje de banderitas ───
// En la base se guardan por { actuacionId, pagina } (foja dentro de la
// actuación). Acá se les agrega .page (foja absoluta en ESTE armado del
// libro) solo en memoria, para que el resto del lector siga igual.
function lugarDeFoja(i) {
  const pg = pages[i];
  return { actuacionId: db.idDeDocumento(pg.doc), pagina: pg.p - 1 };
}

async function cargarBanderitas(cid) {
  const guardadas = await db.obtenerMarcadores(cid);
  const inicioPorId = new Map();   // actuacionId → { inicio, fojas }
  pages.forEach((pg, i) => {
    const id = db.idDeDocumento(pg.doc);
    const r = inicioPorId.get(id);
    if (!r) inicioPorId.set(id, { inicio: i, fojas: 1 });
    else r.fojas++;
  });

  const resueltas = [];
  for (const m of guardadas) {
    if (m.actuacionId) {
      const r = inicioPorId.get(m.actuacionId);
      if (!r) continue; // la actuación no está en este armado: queda guardada, no se muestra
      // Si la actuación se volvió a descargar con menos fojas, cae a la última.
      resueltas.push({ ...m, page: r.inicio + Math.min(m.pagina || 0, r.fojas - 1) });
    } else if (typeof m.page === 'number' && m.page < pages.length) {
      // Formato viejo (foja absoluta): se migra al anclaje por actuación.
      const nueva = await db.guardarMarcador({ cid, ...lugarDeFoja(m.page), label: m.label, color: m.color });
      await db.eliminarMarcadorPorId(m.id);
      resueltas.push({ ...nueva, page: m.page });
    }
  }
  // Dos banderitas que resuelven a la misma foja: queda una.
  const porFoja = new Map();
  resueltas.forEach(f => porFoja.set(f.page, f));
  return [...porFoja.values()].sort((a, b) => a.page - b.page);
}

function renderFlags() {
  const rail = document.getElementById('flagRail');
  rail.innerHTML = '';
  const total = pages.length;
  flags.forEach(f => {
    const color = FLAG_COLORS.find(c => c.id === f.color) || FLAG_COLORS[0];
    const el = document.createElement('div');
    el.className = 'flag'; el.style.background = color.hex;
    el.style.top = ((f.page / (total - 1 || 1)) * 100) + '%';
    el.title = f.label || 'Marcador';
    el.innerHTML = `<span class="flabel">fs.${f.page + 1} · ${esc(f.label || 'marcador')}</span>`;
    el.addEventListener('click', e => { e.stopPropagation(); goTo(f.page, f.page > cur ? 'next' : 'prev'); });
    rail.appendChild(el);
  });
  document.getElementById('btnFlag').classList.toggle('on', flags.some(f => f.page === cur));
}
const flagPop = document.getElementById('flagPop');
const btnFlag = document.getElementById('btnFlag');
// Qué página apunta el popup: la izquierda por defecto (botón del
// toolbar), o la que sea si se abrió desde el iconito de una hoja
// puntual (izquierda o derecha, cualquiera de las dos caras).
let paginaObjetivoFlag = cur;

function abrirPopupFlag(pagina) {
  paginaObjetivoFlag = pagina;
  const existing = flags.find(f => f.page === pagina);
  document.getElementById('flagLabel').value = existing ? existing.label : '';
  selColor = existing ? existing.color : FLAG_COLORS[0].id;
  fpColors.querySelectorAll('.fp-color').forEach(x => x.classList.toggle('sel', x.dataset.id === selColor));
  document.getElementById('flagRemove').style.display = existing ? 'block' : 'none';
  flagPop.classList.add('open');
}
btnFlag.addEventListener('click', e => {
  e.stopPropagation();
  if (flagPop.classList.contains('open') && paginaObjetivoFlag === cur) { flagPop.classList.remove('open'); return; }
  abrirPopupFlag(cur);
});
// Delegado: el iconito 🏳 de cada hoja se recrea en cada vuelta de página
// (mismo motivo que el enlace público — pintarHoja rehace el contenido).
stageEl.addEventListener('click', e => {
  const btn = e.target.closest('.lh-flag');
  if (!btn) return;
  e.stopPropagation();
  const col = btn.closest('.leaf-col');
  const pagina = col && col.dataset.pagina;
  if (pagina === '' || pagina == null) return; // hoja vacía (spread con una sola página)
  abrirPopupFlag(+pagina);
});
document.addEventListener('click', e => {
  if (!flagPop.contains(e.target) && e.target !== btnFlag && !e.target.closest('.lh-flag')) flagPop.classList.remove('open');
});
document.getElementById('flagSave').addEventListener('click', async () => {
  const label = document.getElementById('flagLabel').value.trim();
  const pagina = paginaObjetivoFlag;
  const guardado = await db.guardarMarcador({ cid: expActivo.cid, ...lugarDeFoja(pagina), label, color: selColor });
  flags = flags.filter(f => f.page !== pagina);
  flags.push({ ...guardado, page: pagina });
  flags.sort((a, b) => a.page - b.page);
  renderFlags();
  actualizarIconosFlagVisibles();
  flagPop.classList.remove('open');
});
document.getElementById('flagRemove').addEventListener('click', async () => {
  const pagina = paginaObjetivoFlag;
  await db.eliminarMarcador(expActivo.cid, lugarDeFoja(pagina));
  flags = flags.filter(f => f.page !== pagina);
  renderFlags();
  actualizarIconosFlagVisibles();
  flagPop.classList.remove('open');
});
// Tras guardar/quitar una banderita, refleja el cambio en los iconitos
// 🏳 que ya están pintados en pantalla (sin tener que repintar la hoja
// entera).
function actualizarIconosFlagVisibles() {
  document.querySelectorAll('.leaf-col').forEach(col => {
    if (col.dataset.pagina === '' || col.dataset.pagina == null) return;
    const pagina = +col.dataset.pagina;
    col.querySelector('.lh-flag')?.classList.toggle('on', flags.some(f => f.page === pagina));
  });
}

// ─────────────────────────── EXPORTAR ZIP (desde la biblioteca) ───────────────────────────
async function exportarZip(exp) {
  const docs = await db.obtenerDocumentos(exp.cid);
  if (!docs.length) { alert('Este expediente no tiene documentos guardados.'); return; }

  const zipEntries = [];
  const filas = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const numero = String(i + 1).padStart(4, '0');
    const basename = numero + ' - ' + sanitizarNombre(d.titulo || 'documento') + (d.extension || '.pdf');
    const buffer = await d.blob.arrayBuffer();
    zipEntries.push({ name: basename, data: new Uint8Array(buffer) });
    filas.push({ nombre: basename, titulo: d.titulo, hist: d.esHistorica, url: d.urlHiper });
  }

  const indexHtml = generarIndiceZip(exp, filas);
  zipEntries.unshift({ name: 'index.html', data: new TextEncoder().encode(indexHtml) });

  const folder = sanitizarNombre(exp.folderName || exp.numero || exp.cid);
  const allEntries = zipEntries.map(e => ({ name: folder + '/' + e.name, data: e.data }));
  const zipBlob = buildZip(allEntries);
  const zipUrl = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = zipUrl; a.download = folder + '.zip'; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(zipUrl), 30000);
}

function sanitizarNombre(texto) { return String(texto).replace(/[/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim(); }

function generarIndiceZip(exp, filas) {
  const filasHtml = filas.map((f, i) => `
    <tr class="${f.hist ? 'hist' : ''}">
      <td>${i + 1}</td>
      <td>${f.hist ? '📜' : '📋'}</td>
      <td><a href="${encodeURIComponent(f.nombre)}" target="_blank">${escZip(f.titulo)}</a></td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<title>${escZip(exp.numero || exp.cid)}</title>
<style>
body{font-family:Arial,sans-serif;background:#f0f4f8;color:#1a2a3a;margin:0;padding:0}
header{background:#1a3a6b;color:#fff;padding:18px 24px}
header h1{font-size:16px;margin:0 0 4px}
header p{font-size:12px;color:#a8c4e8;margin:0}
table{width:100%;border-collapse:collapse;margin:16px auto;max-width:900px}
td{padding:9px 12px;border-bottom:1px solid #dbe6f2;font-size:13px}
tr.hist{background:#fffbf0}
a{color:#1e5ba8;text-decoration:none}
a:hover{text-decoration:underline}
</style></head><body>
<header><h1>⚖️ ${escZip(exp.numero || exp.cid)}</h1><p>${escZip(exp.caratula || '')} · ${filas.length} actuaciones</p></header>
<table><tbody>${filasHtml}</tbody></table>
</body></html>`;
}
function escZip(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildZip(files) {
  const lp = [], cd = []; let off = 0;
  const now = new Date();
  const dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) >>> 0;
  const dd = ((((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate())) >>> 0;
  for (const f of files) {
    const nb = new TextEncoder().encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const lh = new Uint8Array(30 + nb.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dt, true); lv.setUint16(12, dd, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, sz, true); lv.setUint32(22, sz, true); lv.setUint16(26, nb.length, true); lv.setUint16(28, 0, true);
    lh.set(nb, 30); lp.push(lh, f.data);
    const ce = new Uint8Array(46 + nb.length); const cv = new DataView(ce.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, dt, true); cv.setUint16(14, dd, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, sz, true); cv.setUint32(24, sz, true); cv.setUint16(28, nb.length, true);
    cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true); cv.setUint32(42, off, true); ce.set(nb, 46);
    cd.push(ce); off += lh.length + sz;
  }
  const cds = cd.reduce((s, c) => s + c.length, 0);
  const eo = new Uint8Array(22); const ev = new DataView(eo.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cds, true); ev.setUint32(16, off, true); ev.setUint16(20, 0, true);
  return new Blob([...lp, ...cd, eo], { type: 'application/zip' });
}
function crc32(d) {
  if (!crc32.t) {
    crc32.t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crc32.t[i] = c; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < d.length; i++) c = crc32.t[(c ^ d[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ─────────────────────────── ARRANQUE ───────────────────────────
cargarBiblioteca();

// biblioteca.html?abrir=<cid>: la pantalla de inicio llega acá con "Leer
// como libro" después de guardar el expediente; se abre directo en el
// lector, SIN pasar por "Mis expedientes" — antes mostrarBiblioteca() se
// llamaba igual (sin condición) antes de abrirExpediente(), que es
// asincrónica (decodifica los PDFs), así que la biblioteca se veía un
// instante antes de que el lector la tapara.
const cidAbrir = new URLSearchParams(location.search).get('abrir');
if (cidAbrir) {
  // .library tiene display:flex por defecto en el CSS (para que se vea
  // sin depender de JS en el caso normal) — se ve desde el primer pintado
  // de la página, antes de que corra cualquier script. Ocultarla recién
  // dentro de abrirExpediente() (asincrónica: decodifica los PDFs) dejaba
  // ese hueco visible. Se oculta acá, ya, antes de arrancar esa espera.
  libraryEl.style.display = 'none';
  abrirExpediente(cidAbrir);
} else {
  mostrarBiblioteca();
}
