// inicio.js — Pantalla de inicio de la extensión: consulta de un expediente
// sin pasar por el SCW, y acciones sobre el resultado (libro, PDF
// unificado, ZIP, Mis expedientes). La consulta la hace
// src/background/consulta.js en una ventana minimizada del SCW, que queda
// abierta mientras esta pantalla esté abierta (las descargas la usan).

import { JURISDICCIONES } from '../lib/jurisdicciones.js';

const $ = id => document.getElementById(id);
let puerto = null;
let exp = null;          // resultado de la consulta
let ocupado = false;

// ─── Utilidades de pantalla ───────────────────────────────────────────
function estadoEn(id, texto, tipo) {
  const el = $(id);
  el.textContent = texto || '';
  el.className = 'estado' + (tipo ? ' estado--' + tipo : '');
}
const estadoBuscar = (t, tipo) => estadoEn('estadoBuscar', t, tipo);
const estado = (t, tipo) => estadoEn('estado', t, tipo);

function bloquearAcciones(si) {
  ocupado = si;
  document.querySelectorAll('#vistaExpediente button').forEach(b => { b.disabled = si; });
}

// ─── Formulario ───────────────────────────────────────────────────────
(function cargarJurisdicciones() {
  const sel = $('jurisdiccion');
  sel.innerHTML = '<option value="">Seleccione una jurisdicción</option>';
  for (const j of JURISDICCIONES) {
    const o = document.createElement('option');
    o.value = j.value;
    o.dataset.sigla = j.sigla;
    o.textContent = j.sigla + ' - ' + j.nombre;
    if (j.sigla === 'CIV') o.selected = true;   // caso de uso principal
    sel.appendChild(o);
  }
})();

function conectar() {
  if (puerto) return puerto;
  puerto = chrome.runtime.connect({ name: 'consulta' });
  puerto.onMessage.addListener(recibir);
  puerto.onDisconnect.addListener(() => {
    puerto = null;
    const msg = 'Se perdió la conexión con la extensión. Volvé a consultar el expediente.';
    if (!$('vistaExpediente').hidden) { estado(msg, 'error'); bloquearAcciones(true); }
    else { estadoBuscar(msg, 'error'); $('btnConsultar').disabled = false; }
  });
  return puerto;
}

$('formBuscar').addEventListener('submit', ev => {
  ev.preventDefault();
  const sel = $('jurisdiccion');
  const valorJurisdiccion = sel.value;
  const sigla = sel.selectedOptions[0] && sel.selectedOptions[0].dataset.sigla;
  const numero = $('numero').value.trim().replace(/^0+(?=\d)/, '');
  const anio = $('anio').value.trim();
  const incidente = $('incidente').value.trim();

  if (!valorJurisdiccion) return estadoBuscar('Elegí una jurisdicción.', 'error');
  if (!/^\d+$/.test(numero) || !/^\d{4}$/.test(anio)) return estadoBuscar('Completá número y año (el año con 4 cifras).', 'error');
  if (incidente && !/^\d+$/.test(incidente)) return estadoBuscar('El incidente tiene que ser un número.', 'error');

  $('btnConsultar').disabled = true;
  estadoBuscar('Buscando el expediente en el SCW… puede demorar unos segundos.', 'cargando');
  conectar().postMessage({ tipo: 'consultar', valorJurisdiccion, sigla, numero, anio, incidente });
});

function recibir(msg) {
  if (msg.tipo === 'etapa') {
    estadoBuscar(msg.texto, 'cargando');
  } else if (msg.tipo === 'error') {
    estadoBuscar(msg.texto, 'error');
    $('btnConsultar').disabled = false;
  } else if (msg.tipo === 'listo') {
    exp = msg;
    mostrarExpediente();
  }
}

// ─── Vista del expediente ─────────────────────────────────────────────
async function mostrarExpediente() {
  $('vistaBuscar').hidden = true;
  $('vistaExpediente').hidden = false;
  $('linkNueva').hidden = false;

  const nHist = exp.archivos.filter(a => a.esHistorica).length;
  $('expId').textContent = exp.nombre;
  $('expCaratula').textContent = exp.caratula || exp.tituloExpediente || exp.nombre;
  $('expMeta').textContent = exp.archivos.length + ' actuaciones' +
    (nHist ? ' (' + nHist + ' históricas)' : '');

  const avisos = [];
  if (exp.aviso) avisos.push(exp.aviso);
  if (exp.paginacionIncompleta) avisos.push('El recorrido de páginas se cortó antes de tiempo (demora del sistema). Pueden faltar actuaciones más viejas. Conviene volver a consultar el expediente.');
  if (exp.historicasFaltantes) avisos.push('No se pudieron leer las actuaciones históricas: pueden faltar las más viejas (por ejemplo, la demanda).');
  $('avisos').innerHTML = '';
  for (const a of avisos) {
    const d = document.createElement('div');
    d.className = 'aviso';
    d.textContent = a;
    $('avisos').appendChild(d);
  }

  const r = await new Promise(res => chrome.runtime.sendMessage({ action: 'bibliotecaListar' }, res));
  const guardado = r && r.ok && (r.expedientes || []).some(e => e.cid === exp.cid);
  $('btnGuardarTexto').textContent = guardado ? 'Actualizar en Mis expedientes' : 'Agregar a Mis expedientes';
}

// Espera el fin de una descarga que informa por chrome.storage (mismo
// mecanismo que usa el popup).
// Devuelve { promesa, detener }: el unificado no marca 'terminado' (su fin
// llega por la respuesta del mensaje), así que hay que poder cortarlo.
function seguirProgreso(clave, textoEtapa) {
  let id = null;
  const promesa = new Promise(resolve => {
    id = setInterval(async () => {
      const d = await chrome.storage.local.get(clave);
      const p = d[clave];
      if (!p) return;
      if (p.error) { clearInterval(id); resolve({ ok: false, error: p.error }); return; }
      const pct = p.total > 0 ? Math.round((p.descargados / p.total) * 100) : 0;
      estado(textoEtapa(p) + ' ' + p.descargados + ' / ' + p.total + ' (' + pct + '%)' +
        (p.errores > 0 ? ' · con error: ' + p.errores : ''), 'cargando');
      if (p.terminado) { clearInterval(id); await chrome.storage.local.remove(clave); resolve({ ok: true, ...p }); }
    }, 700);
  });
  return { promesa, detener: () => clearInterval(id) };
}

async function accionEnPestana(accion) {
  await chrome.storage.local.set({
    descargaProgreso: { total: exp.archivos.length, descargados: 0, errores: 0, terminado: false },
  });
  chrome.tabs.sendMessage(exp.tabId, { action: accion, archivos: exp.archivos, folderName: exp.folderName, startIndex: 1 });
  return seguirProgreso('descargaProgreso', () =>
    accion === 'guardarEnBiblioteca' ? 'Guardando en Mis expedientes…' : 'Armando el ZIP…').promesa;
}

function confirmarCompletitud() {
  if (exp.historicasFaltantes && !confirm('No se pudieron leer las actuaciones históricas: el resultado puede arrancar más adelante en el tiempo, sin las más viejas.\n\n¿Continuar igual?')) return false;
  if (exp.paginacionIncompleta && !confirm('El recorrido de páginas se cortó antes de tiempo: pueden faltar actuaciones.\n\n¿Continuar igual?')) return false;
  return true;
}

async function guardar() {
  const r = await accionEnPestana('guardarEnBiblioteca');
  if (!r.ok) throw new Error(r.error || 'No se pudo guardar.');
  $('btnGuardarTexto').textContent = 'Actualizar en Mis expedientes';
  return r;
}

async function ejecutar(fn) {
  if (ocupado) return;
  bloquearAcciones(true);
  try { await fn(); }
  catch (e) { estado(e.message || String(e), 'error'); }
  finally { bloquearAcciones(false); }
}

$('btnEbook').addEventListener('click', () => ejecutar(async () => {
  await guardar();
  estado('Abriendo el libro…', 'ok');
  location.href = 'biblioteca.html?abrir=' + encodeURIComponent(exp.cid);
}));

$('btnGuardar').addEventListener('click', () => ejecutar(async () => {
  const r = await guardar();
  estado('✓ Guardado en Mis expedientes (' + r.descargados + ' actuaciones' +
    (r.errores ? ', ' + r.errores + ' con error' : '') + ').', 'ok');
}));

document.querySelector('[data-formato="zip"]').addEventListener('click', () => ejecutar(async () => {
  const r = await accionEnPestana('crearYDescargarZip');
  if (!r.ok) throw new Error(r.error || 'No se pudo armar el ZIP.');
  estado('✓ ZIP listo: se abrió el diálogo para guardarlo.', 'ok');
}));

document.querySelector('[data-formato="unificado-indice"]').addEventListener('click', () => ejecutar(async () => {
  if (!confirmarCompletitud()) return;
  const actuaciones = exp.actuaciones.length ? exp.actuaciones : exp.archivos;
  const seguimiento = seguirProgreso('unificadoProgreso', p =>
    p.etapa === 'armando' ? 'Armando el PDF unificado…' : 'Descargando actuaciones…');
  const r = await new Promise(res => chrome.runtime.sendMessage({
    action: 'descargarExpedienteUnificado',
    actuaciones,
    tituloExpediente: exp.tituloExpediente || exp.folderName || exp.nombre,
    historicasFaltantes: exp.historicasFaltantes,
    paginacionIncompleta: exp.paginacionIncompleta,
  }, res));
  seguimiento.detener();
  await chrome.storage.local.remove('unificadoProgreso');
  if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo generar el PDF unificado.');
  estado('✓ PDF unificado listo (' + r.descargados + '/' + r.total + ' actuaciones' +
    (r.errores ? ', ' + r.errores + ' con página de error' : '') + '). Se abrió el diálogo para guardarlo.', 'ok');
}));
