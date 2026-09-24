// inicio.js — Pantalla de inicio de la extensión: consulta de un expediente
// sin pasar por el SCW, y acciones sobre el resultado (libro, PDF
// unificado, ZIP, Mis expedientes). La consulta la hace
// src/background/consulta.js en una ventana minimizada del SCW, que queda
// abierta mientras esta pantalla esté abierta (las descargas la usan).

import { JURISDICCIONES, valorPorSigla } from '../lib/jurisdicciones.js';
import * as db from '../lib/db.js';

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

// Cada consulta abre SU PROPIA conexión, no reusa una vieja: el service
// worker de una extensión Manifest V3 se apaga solo tras un rato sin
// actividad, y un puerto conectado a un worker ya apagado se queda
// "vivo" del lado del cliente pero no llega a ningún lado — visto en la
// práctica al abrir un vinculado después de que la búsqueda inicial ya
// había terminado y la pantalla llevaba un rato quieta: postMessage no
// tiraba error, pero el mensaje nunca llegaba al fondo.
function iniciarBusqueda(datos) {
  if (puerto) puerto.disconnect();
  const p = chrome.runtime.connect({ name: 'consulta' });
  puerto = p;
  p.onMessage.addListener(recibir);
  p.onDisconnect.addListener(() => {
    // Si 'puerto' ya no es ESTE puerto, es porque se reemplazó por una
    // conexión más nueva (iniciarBusqueda de vuelta): este disconnect es
    // el de la conexión vieja cerrándose a propósito, no un corte real.
    if (puerto !== p) return;
    puerto = null;
    const msg = 'Se perdió la conexión con la extensión. Volvé a consultar el expediente.';
    if (!$('vistaExpediente').hidden) { estado(msg, 'error'); bloquearAcciones(true); }
    else { estadoBuscar(msg, 'error'); $('btnConsultar').disabled = false; }
  });
  p.postMessage({ tipo: 'consultar', ...datos });
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
  iniciarBusqueda({ valorJurisdiccion, sigla, numero, anio, incidente });
});

function recibir(msg) {
  if (msg.tipo === 'etapa') {
    estadoBuscar(msg.texto, 'cargando');
  } else if (msg.tipo === 'error') {
    estadoBuscar(msg.texto, 'error');
    $('btnConsultar').disabled = false;
    // Por si el error vino de abrir un vinculado (con vistaExpediente
    // visible, no vistaBuscar): sin esto, las acciones quedaban
    // bloqueadas para siempre (mismo motivo que en el 'listo' de abajo).
    bloquearAcciones(false);
    if (!vistaExpediente.hidden) estado(msg.texto, 'error');
  } else if (msg.tipo === 'listo') {
    exp = msg;
    mostrarExpediente();
    // bloquearAcciones(true) al abrir un vinculado (más arriba) no tiene su
    // propio 'false': lo pone acá, en el punto de llegada común a la
    // búsqueda inicial y a abrir un vinculado.
    bloquearAcciones(false);
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

  // PDF unificado / ZIP arman el archivo volviendo a pedirle cada
  // actuación al SCW — necesitan la pestaña de una consulta en vivo. Sin
  // ella (se llegó acá con "← Volver", no buscando de nuevo), avisan en
  // vez de fallar en silencio; "Leer como libro" no tiene este problema,
  // ya está todo guardado.
  const sinPestana = !exp.tabId;
  document.querySelectorAll('[data-formato]').forEach(b => {
    b.disabled = sinPestana;
    b.title = sinPestana ? 'Hace falta volver a consultar el expediente para generar esto (no se guarda el enlace de descarga original).' : '';
  });

  renderVinculados();
}

// Incidentes y expedientes vinculados del principal (estilo del portal web).
function renderVinculados() {
  const cont = $('listaVinculados');
  cont.innerHTML = '';
  const lista = exp.vinculados || [];
  $('seccionVinculados').hidden = !lista.length;
  for (const v of lista) {
    const fila = document.createElement('div');
    fila.className = 'vinculado';

    const datos = document.createElement('div');
    datos.className = 'vinculado-datos';
    const idEl = document.createElement('div'); idEl.className = 'vinculado-id'; idEl.textContent = v.expediente;
    const car = document.createElement('div'); car.className = 'vinculado-caratula'; car.textContent = v.caratula || '';
    const meta = document.createElement('div'); meta.className = 'vinculado-meta';
    meta.textContent = [v.dependencia, v.situacion, v.ultimaActuacion ? 'últ. act. ' + v.ultimaActuacion : '']
      .filter(Boolean).join(' · ');
    datos.append(idEl, car, meta);

    const boton = document.createElement('button');
    boton.className = 'boton-secundario';
    boton.textContent = 'Abrir';
    boton.addEventListener('click', () => abrirVinculadoDesdeResultado(boton, v.expediente));

    fila.append(datos, boton);
    cont.appendChild(fila);
  }
}

// "CIV 013719/2023/1" → { sigla, numero, anio, incidente }. Los ceros a la
// izquierda no importan (el SCW los muestra, el formulario no los pide).
function partirExpediente(texto) {
  const m = (texto || '').match(/([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/i);
  if (!m) return null;
  return { sigla: m[1].toUpperCase(), numero: String(Number(m[2])), anio: m[3], incidente: String(Number(m[4])) };
}

function abrirVinculadoDesdeResultado(boton, expedienteTexto) {
  if (ocupado) return;
  const partes = partirExpediente(expedienteTexto);
  if (!partes) return;
  const valorJurisdiccion = valorPorSigla(partes.sigla);
  if (valorJurisdiccion == null) {
    estado('No se reconoce la jurisdicción "' + partes.sigla + '".', 'error');
    return;
  }
  boton.disabled = true;
  boton.textContent = 'Abriendo…';
  bloquearAcciones(true);
  // Sin progreso en vivo acá (a diferencia del formulario inicial): los
  // mensajes de etapa van al estado de la pantalla de búsqueda, que queda
  // oculta mientras se ve el expediente. Al terminar, recibir() reemplaza
  // 'exp' y vuelve a llamar mostrarExpediente() con el incidente.
  estado('Abriendo ' + expedienteTexto + '… puede demorar unos segundos.', 'cargando');
  // sendMessage, no el puerto de la búsqueda inicial: acá no hace falta
  // progreso en vivo, y es más robusto para despertar el service worker
  // si lleva un rato inactivo (ver el comentario en
  // iniciarAperturaVinculados, background/consulta.js).
  chrome.runtime.sendMessage({
    action: 'consultarVinculado', valorJurisdiccion, ...partes,
    // Si la pestaña del expediente actual sigue abierta, se actúa directo
    // sobre ella (sin pasar por el SCW de nuevo, sin foco en ningún
    // momento); si ya no sirve, el fondo hace una búsqueda completa igual.
    tabIdExistente: exp && exp.tabId, expedienteVinculado: expedienteTexto,
  }, resp => {
    bloquearAcciones(false);
    if (chrome.runtime.lastError) {
      estado('Se perdió la conexión con la extensión. Probá de nuevo.', 'error');
      return;
    }
    if (resp && resp.tipo === 'listo') { exp = resp; mostrarExpediente(); }
    else estado((resp && resp.texto) || 'No se pudo abrir el incidente.', 'error');
  });
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
  // Sin pestaña del SCW (se llegó acá con "← Volver", no con una consulta
  // en vivo): no hace falta guardar de nuevo, ya está en Mis expedientes
  // — abrir el libro directo.
  let mensaje = '✓ Libro abierto en una pestaña nueva.';
  if (exp.tabId) {
    const r = await guardar();
    mensaje = '✓ Libro abierto en una pestaña nueva (' + r.descargados + ' actuaciones' +
      (r.errores ? ', ' + r.errores + ' con error' : '') + ').';
  }
  // Pestaña nueva, no location.href: así el libro queda abierto aparte y
  // esta pantalla puede volver a la búsqueda para el próximo expediente,
  // sin perder el que se acaba de abrir.
  chrome.tabs.create({ url: chrome.runtime.getURL('src/public/biblioteca.html?abrir=' + encodeURIComponent(exp.cid)) });
  volverABuscar(mensaje);
}));

function volverABuscar(mensaje) {
  exp = null;
  $('vistaExpediente').hidden = true;
  $('linkNueva').hidden = true;
  $('vistaBuscar').hidden = false;
  $('numero').value = '';
  $('anio').value = '';
  $('incidente').value = '';
  $('btnConsultar').disabled = false;
  estadoBuscar(mensaje || '', mensaje ? 'ok' : '');
  $('numero').focus();
}

$('btnGuardar').addEventListener('click', () => ejecutar(async () => {
  const r = await guardar();
  estado('✓ Guardado en Mis expedientes (' + r.descargados + ' actuaciones' +
    (r.errores ? ', ' + r.errores + ' con error' : '') + ').', 'ok');
}));

document.querySelector('[data-formato="zip"]').addEventListener('click', () => ejecutar(async () => {
  if (!exp.tabId) { estado('Para armar el ZIP hace falta volver a consultar el expediente.', 'error'); return; }
  const r = await accionEnPestana('crearYDescargarZip');
  if (!r.ok) throw new Error(r.error || 'No se pudo armar el ZIP.');
  estado('✓ ZIP listo: se abrió el diálogo para guardarlo.', 'ok');
}));

// A diferencia de PDF unificado y ZIP, no necesita pestaña del SCW: no
// vuelve a descargar ningún documento, solo arma una lista con lo que ya
// se tiene (título/fecha/enlace público) — funciona igual viniendo de una
// consulta en vivo o de "← Volver".
document.getElementById('btnIndiceHiper').addEventListener('click', () => ejecutar(async () => {
  const actuaciones = exp.actuaciones.length ? exp.actuaciones : exp.archivos;
  const r = await new Promise(res => chrome.runtime.sendMessage({
    action: 'descargarIndiceHipervinculado',
    actuaciones,
    tituloExpediente: exp.tituloExpediente || exp.folderName || exp.nombre,
    historicasFaltantes: exp.historicasFaltantes,
    paginacionIncompleta: exp.paginacionIncompleta,
  }, res));
  if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo generar el índice.');
  estado('✓ Índice hipervinculado listo (' + r.total + ' actuaciones). Se abrió el diálogo para guardarlo.', 'ok');
}));

document.querySelector('[data-formato="unificado-indice"]').addEventListener('click', () => ejecutar(async () => {
  if (!exp.tabId) { estado('Para generar el PDF unificado hace falta volver a consultar el expediente.', 'error'); return; }
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

// ─────────────────────────── "← Volver" desde el lector ───────────────────────────
// inicio.html?resultados=<cid>: en vez de una búsqueda nueva contra el
// SCW, arma la pantalla de resultados leyendo directo de lo que ya está
// guardado en Mis Expedientes (sin pasar por el SCW de nuevo). Vinculados
// no se persisten (solo viajan en la respuesta de una búsqueda en vivo),
// así que esa sección queda vacía en este camino — limitación conocida,
// no hay vuelta si el expediente no se resguscó de nuevo.
(async function cargarDesdeGuardado() {
  const cid = new URLSearchParams(location.search).get('resultados');
  if (!cid) return;
  const expediente = await db.obtenerExpediente(cid);
  if (!expediente) { estadoBuscar('No se encontró "' + cid + '" en Mis expedientes.', 'error'); return; }
  const documentos = await db.obtenerDocumentos(cid);
  exp = {
    cid: expediente.cid,
    tabId: null, // no hay pestaña del SCW abierta en este camino: no vino de una búsqueda en vivo
    nombre: expediente.numero,
    caratula: expediente.caratula,
    folderName: expediente.folderName,
    tituloExpediente: expediente.caratula,
    archivos: documentos.map(d => ({ titulo: d.titulo, esHistorica: d.esHistorica })),
    actuaciones: documentos.map(d => ({ titulo: d.titulo, fecha: d.fecha, tipo: d.tipo, esHistorica: d.esHistorica, urlPublica: d.urlHiper })),
    aviso: '', paginacionIncompleta: false, historicasFaltantes: false,
    vinculados: [],
  };
  await mostrarExpediente();
})();
