// biblioteca.js — Pantalla de biblioteca + visor libro, con datos reales.
// Corre como script type="module" dentro de biblioteca.html (origen de la
// extensión), así que puede importar db.js directamente sin pasar por
// background.js — solo lo usamos para orquestar tabs del SCW (verificar/actualizar).

import * as db from './db.js';
import { verificarFirmaPDF } from './firma.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');

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
let zoomManual = null; // null = ajuste automático; número (1, 1.5, 2...) = zoom fijo elegido por el operador

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
    card.innerHTML = `
      <div class="lc-num">${esc(exp.numero || exp.cid)}</div>
      <div class="lc-title">${esc(exp.caratula || '(sin carátula detectada)')}</div>
      <div class="lc-meta">
        <span>📄 ${exp.cantidadActuaciones || 0} actuaciones</span>
        <span>💾 ${fechaCorta(exp.fechaDescarga)}</span>
      </div>
      <span class="lib-badge ${exp.estado === 'nuevo' ? 'new' : 'ok'}" data-badge>
        ${exp.estado === 'nuevo' ? '🔴 ' + exp.nuevasDetectadas + ' actuaciones nuevas' : '✓ Al día'}
      </span>
      <div class="lib-bar" style="display:none"><div class="lib-bar-fill" data-bar></div></div>
      <div class="lc-actions">
        <button data-open>Abrir</button>
        <button data-verify class="verify">${exp.estado === 'nuevo' ? 'Actualizar' : 'Verificar'}</button>
        <button data-zip title="Exportar como ZIP" style="flex:0 0 auto;padding:6px 9px">⬇️</button>
        <button data-del title="Eliminar de la biblioteca" style="flex:0 0 auto;padding:6px 9px">🗑</button>
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

function fechaCorta(iso) {
  if (!iso) return '?';
  try { return new Date(iso).toLocaleDateString('es-AR'); } catch (e) { return iso; }
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Verificar: abre (o reusa) la pestaña del SCW, escanea liviano, compara.
async function verificarExpediente(exp, card) {
  const badge = card.querySelector('[data-badge]');
  const btn = card.querySelector('[data-verify]');
  badge.className = 'lib-badge checking';
  badge.textContent = '⏳ Verificando en el SCW...';
  btn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ action: 'bibliotecaVerificarEnVivo', cid: exp.cid });
    if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo verificar.');
    exp.estado = r.cambio ? 'nuevo' : 'ok';
    exp.nuevasDetectadas = r.nuevasDetectadas || 0;
    card.classList.toggle('new', r.cambio);
    badge.className = 'lib-badge ' + (r.cambio ? 'new' : 'ok');
    badge.textContent = r.cambio ? '🔴 ' + r.nuevasDetectadas + ' actuaciones nuevas' : '✓ Al día';
    btn.textContent = r.cambio ? 'Actualizar' : 'Verificar';
  } catch (err) {
    badge.className = 'lib-badge new';
    badge.textContent = '❌ ' + err.message;
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
  badge.className = 'lib-badge checking';
  badge.textContent = '⏳ Actualizando biblioteca...';
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
    card.classList.remove('new');
    badge.className = 'lib-badge ok';
    badge.textContent = '✓ Al día';
    btn.textContent = 'Verificar';
    card.querySelector('.lc-meta').innerHTML =
      `<span>📄 ${exp.cantidadActuaciones} actuaciones</span><span>💾 ${fechaCorta(exp.fechaDescarga)}</span>`;
  } catch (err) {
    badge.className = 'lib-badge new';
    badge.textContent = '❌ ' + err.message;
  }
  btn.disabled = false;
  barWrap.style.display = 'none';
}

document.getElementById('btnHome').addEventListener('click', () => { cargarBiblioteca(); mostrarBiblioteca(); });
document.getElementById('expteSwitch').addEventListener('click', () => { cargarBiblioteca(); mostrarBiblioteca(); });
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

    flags = await db.obtenerMarcadores(cid);
    cur = 0;
    firmasPorDoc = docsDb.map(() => null);

    document.getElementById('expteNum').textContent = expActivo.numero || expActivo.cid;
    buildTabs(); buildIndex();
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

// ─────────────────────────── CORDÓN (decorativo, una sola vez) ───────────────────────────
(function dibujarCordon() {
  const svgH = 400, nHoles = 9; let holesSvg = '';
  for (let i = 0; i < nHoles; i++) {
    const y = 24 + i * ((svgH - 48) / (nHoles - 1));
    holesSvg += `<circle cx="8" cy="${y}" r="3.4" fill="#3a1015"/>`;
    holesSvg += `<path d="M8 ${y - 14} Q2 ${y} 8 ${y + 14}" stroke="url(#cordGrad)" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
  }
  document.querySelector('.cord-col svg').insertAdjacentHTML('beforeend', holesSvg);
})();

// ─────────────────────────── TABS + ÍNDICE ───────────────────────────
const tabRail = document.getElementById('tabRail');
const idxList = document.getElementById('idxList');

function buildTabs() {
  tabRail.innerHTML = '';
  docsDb.forEach((d, di) => {
    const t = document.createElement('div');
    t.className = 'tab ' + (d.esHistorica ? 'hist' : 'actual');
    t.dataset.di = di;
    t.innerHTML = `<span>${esc(d.titulo)}</span>`;
    t.title = d.titulo;
    t.addEventListener('click', () => irADoc(di));
    tabRail.appendChild(t);
  });
}
function buildIndex() {
  idxList.innerHTML = '';
  document.getElementById('idxCount').textContent = docsDb.length + ' actuaciones · ' + pages.length + ' fojas';
  docsDb.forEach((d, di) => {
    const it = document.createElement('div');
    it.className = 'index-item' + (d.esHistorica ? ' hist' : '');
    it.dataset.di = di;
    it.innerHTML = `<span class="index-num">${String(di + 1).padStart(2, '0')}</span><span>${esc(d.titulo)}</span>`;
    it.addEventListener('click', () => { irADoc(di); cerrarIndice(); });
    idxList.appendChild(it);
  });
}

// ─────────────────────────── FIRMA ELECTRÓNICA ───────────────────────────
async function verificarFirmasEnSegundoPlano() {
  for (let di = 0; di < docsDb.length; di++) {
    try {
      const buffer = await docsDb[di].blob.arrayBuffer();
      firmasPorDoc[di] = await verificarFirmaPDF(buffer);
    } catch (err) {
      firmasPorDoc[di] = { estado: 'error', firmas: [], detalle: err.message };
    }
    // Si la página actual pertenece a este documento, refrescamos el badge ya mismo.
    if (pages[cur] && pages[cur].di === di) actualizarBadgeFirma(di);
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

function actualizarBadgeFirma(di) {
  const el = document.getElementById('shFirma');
  if (!el || !pages[cur] || pages[cur].di !== di) return;
  const et = etiquetaFirma(firmasPorDoc[di]);
  el.className = 'sh-firma ' + et.cls;
  el.textContent = et.texto;
  el.title = et.title;
}

// ─────────────────────────── RENDER DE PÁGINA (lazy) ───────────────────────────
const sheet = document.getElementById('sheet');

async function renderCanvas(idx) {
  const pg = pages[idx];
  if (pg.canvas) return pg; // ya renderizado, lo reusamos
  const pdf = pdfProxies[pg.di];
  const page = await pdf.getPage(pg.p);

  // Escala dinámica: aprovechamos el espacio real disponible del contenedor
  // en vez de un zoom fijo, así se ve grande en pantallas grandes y entera
  // en chicas. Solo tiene sentido cuando el wrap ya está en el DOM medible.
  const wrap = document.getElementById('pdfWrap');
  const base = page.getViewport({ scale: 1 });
  let scale;
  if (zoomManual) {
    scale = zoomManual;
  } else {
    scale = 1.4;
    if (wrap && wrap.clientWidth > 40 && wrap.clientHeight > 40) {
      const margen = 0.97;
      scale = Math.min((wrap.clientWidth * margen) / base.width, (wrap.clientHeight * margen) / base.height);
      scale = Math.max(0.5, Math.min(scale, 2.2));
    }
  }

  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  pg.canvas = canvas;
  return pg;
}

async function render(i) {
  const pg = pages[i];
  const doc = pg.doc;

  sheet.innerHTML = `
    <div class="slimhead">
      <span class="sh-badge ${doc.esHistorica ? 'hist' : 'actual'}">${doc.esHistorica ? '📜 HIST.' : '📋 ACTUAL'}</span>
      <span class="sh-titulo" title="${esc(doc.titulo)}">${esc(doc.titulo)}</span>
      <span class="sh-firma checking" id="shFirma">⏳ Verificando firma...</span>
      <span class="sh-foja">fs. ${i + 1}/${pages.length}</span>
    </div>
    <div class="pdf-canvas-wrap" id="pdfWrap">
      <div class="page-skeleton"><div class="spin"></div>Renderizando página...</div>
    </div>
    <div class="slimfoot">
      <span>${esc((doc.urlHiper || '').replace('https://', ''))}</span>
      <span>Doc. ${pg.di + 1}/${docsDb.length} · pág ${pg.p}</span>
    </div>
  `;

  document.getElementById('counter').textContent = `fs. ${i + 1} / ${pages.length}`;
  document.getElementById('linkInput').value = doc.urlHiper || '';
  document.getElementById('btnPrev').disabled = i <= 0;
  document.getElementById('btnNext').disabled = i >= pages.length - 1;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('current', +t.dataset.di === pg.di));
  document.querySelectorAll('.index-item').forEach(t => t.classList.toggle('on', +t.dataset.di === pg.di));
  document.getElementById('btnFlag')?.classList.toggle('on', flags.some(f => f.page === i));
  actualizarBadgeFirma(pg.di);

  // Dejamos que el navegador pinte el spinner antes de arrancar el trabajo
  // pesado de renderizar el PDF (si no, en páginas escaneadas grandes el
  // hilo principal se traba y ni siquiera se llega a ver "Renderizando...").
  await new Promise(r => requestAnimationFrame(r));

  await renderCanvas(i);
  const wrap = document.getElementById('pdfWrap');
  if (wrap) {
    wrap.innerHTML = '';
    wrap.appendChild(pages[i].canvas);
    wrap.classList.toggle('manual-zoom', !!zoomManual);
  }

  // Precarga silenciosa de la página siguiente para que el próximo "pasar
  // hoja" sea instantáneo — no bloquea el render de la actual.
  if (i + 1 < pages.length) renderCanvas(i + 1);
}

async function goTo(i, dir) {
  if (animating || i < 0 || i >= pages.length) return;
  animating = true;
  try {
    // Pre-renderizamos la página destino en memoria MIENTRAS se sigue viendo
    // la actual — así la transición nunca muestra un hueco en blanco
    // esperando (el tiempo de espera varía mucho según el PDF, así que no
    // tiene sentido atarlo a una animación de duración fija).
    await renderCanvas(i);
  } catch (e) { console.error('[PJN Biblioteca] Error prerenderizando página', i, e); }
  sheet.classList.add('fading');
  await new Promise(r => setTimeout(r, 110));
  cur = i;
  await render(cur); // el canvas ya está cacheado de arriba -> esto es instantáneo
  sheet.classList.remove('fading');
  animating = false;
}
function irADoc(di) {
  const firstIdx = pages.findIndex(pg => pg.di === di);
  if (firstIdx >= 0) goTo(firstIdx, firstIdx > cur ? 'next' : 'prev');
}

document.getElementById('btnPrev').addEventListener('click', () => goTo(cur - 1, 'prev'));
document.getElementById('btnNext').addEventListener('click', () => goTo(cur + 1, 'next'));
document.getElementById('navL').addEventListener('click', () => goTo(cur - 1, 'prev'));
document.getElementById('navR').addEventListener('click', () => goTo(cur + 1, 'next'));
document.addEventListener('keydown', e => {
  if (!expActivo || sceneEl.style.display === 'none') return;
  if (e.key === 'ArrowRight') goTo(cur + 1, 'next');
  else if (e.key === 'ArrowLeft') goTo(cur - 1, 'prev');
  else if (e.key === 'Home') goTo(0, 'prev');
  else if (e.key === 'End') goTo(pages.length - 1, 'next');
  else if (e.key === 'Escape') cerrarIndice();
});

let dragStartX = null;
sheet.addEventListener('pointerdown', e => { dragStartX = e.clientX; sheet.classList.add('dragging'); });
sheet.addEventListener('pointerup', e => {
  sheet.classList.remove('dragging');
  if (dragStartX === null) return;
  const dx = e.clientX - dragStartX; dragStartX = null;
  if (dx < -60) goTo(cur + 1, 'next'); else if (dx > 60) goTo(cur - 1, 'prev');
});
sheet.addEventListener('pointerleave', () => { sheet.classList.remove('dragging'); dragStartX = null; });

// ─────────────────────────── ÍNDICE DESLIZABLE ───────────────────────────
const idxPanel = document.getElementById('idxPanel');
const idxOverlay = document.getElementById('idxOverlay');
function abrirIndice() { idxPanel.classList.add('open'); idxOverlay.classList.add('open'); }
function cerrarIndice() { idxPanel.classList.remove('open'); idxOverlay.classList.remove('open'); }
document.getElementById('btnIndex').addEventListener('click', abrirIndice);
document.getElementById('idxClose').addEventListener('click', cerrarIndice);
idxOverlay.addEventListener('click', cerrarIndice);

// ─────────────────────────── ENLACE PÚBLICO ───────────────────────────
document.getElementById('copyBtn').addEventListener('click', function () {
  const input = document.getElementById('linkInput');
  navigator.clipboard?.writeText(input.value).catch(() => { input.select(); document.execCommand('copy'); });
  this.textContent = '✓ Copiado'; this.classList.add('copied');
  setTimeout(() => { this.textContent = 'Copiar'; this.classList.remove('copied'); }, 1600);
});
document.getElementById('openBtn').addEventListener('click', () => {
  const url = document.getElementById('linkInput').value;
  if (url) window.open(url, '_blank');
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
btnFlag.addEventListener('click', e => {
  e.stopPropagation();
  const existing = flags.find(f => f.page === cur);
  document.getElementById('flagLabel').value = existing ? existing.label : '';
  selColor = existing ? existing.color : FLAG_COLORS[0].id;
  fpColors.querySelectorAll('.fp-color').forEach(x => x.classList.toggle('sel', x.dataset.id === selColor));
  document.getElementById('flagRemove').style.display = existing ? 'block' : 'none';
  flagPop.classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!flagPop.contains(e.target) && e.target !== btnFlag) flagPop.classList.remove('open');
});
document.getElementById('flagSave').addEventListener('click', async () => {
  const label = document.getElementById('flagLabel').value.trim();
  const marcador = { cid: expActivo.cid, page: cur, label, color: selColor };
  await db.guardarMarcador(marcador);
  flags = flags.filter(f => f.page !== cur);
  flags.push(marcador);
  flags.sort((a, b) => a.page - b.page);
  renderFlags();
  flagPop.classList.remove('open');
});
document.getElementById('flagRemove').addEventListener('click', async () => {
  await db.eliminarMarcador(expActivo.cid, cur);
  flags = flags.filter(f => f.page !== cur);
  renderFlags();
  flagPop.classList.remove('open');
});

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
mostrarBiblioteca();
