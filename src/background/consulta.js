// consulta.js — Consulta de un expediente desde la pantalla de inicio de la
// extensión (src/public/inicio.html), sin que el operador pase por el SCW.
//
// El SCW sigue siendo la fuente (no tiene otra vía pública): se abre en una
// ventana minimizada, se completa la Consulta Pública, se leen las
// actuaciones (incluidas las históricas) y la ventana queda abierta,
// minimizada, mientras la pantalla de inicio la necesite para descargar.
// Se cierra sola cuando se cierra o se va de esa pantalla.
//
// Comunicación con inicio.html por un puerto (chrome.runtime.connect con
// nombre 'consulta'): mantiene vivo el service worker durante la consulta y
// avisa cuándo la pantalla se cerró.
//
// Lógica de búsqueda portada del Portable (src/scw/buscarExpediente.js),
// que es la versión probada contra el SCW real: no alcanza con ver cid= en
// la URL (el SCW lo agrega a casi todas sus páginas); se confirma por
// contenido (ver estadoPaginaSCW en scw-content.js).

const SCW = 'https://scw.pjn.gov.ar/scw';
const URL_HOME = SCW + '/home.seam';
const urlExpediente = cid => SCW + '/expediente.seam?cid=' + cid;
const urlHistoricas = cid => SCW + '/actuacionesHistoricas.seam?cid=' + cid;

const esperar = ms => new Promise(r => setTimeout(r, ms));

// Mensaje al content script de la pestaña; null si todavía no hay uno
// escuchando (la página está navegando o cargando).
function pedir(tabId, mensaje) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, mensaje, resp => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp || null);
      });
    } catch (e) { resolve(null); }
  });
}

// El SCW puede navegar solo justo después de que una página termina de
// cargar (por ejemplo, para agregar un parámetro de sesión a home.seam) —
// visto contra el sitio real: 'complete' llega, se manda el siguiente
// mensaje, y para entonces la página ya está navegando de nuevo y destruyó
// el content script anterior, así que ese mensaje se pierde. pedir() por sí
// solo no lo nota (una sola sendMessage), así que estos mensajes clave se
// reintentan esperando a que la pestaña vuelva a estar 'complete' entre
// intento e intento.
async function pedirConReintento(tabId, mensaje, intentos = 4) {
  for (let i = 0; i < intentos; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Se cerró la ventana del SCW.');
    if (tab.status === 'complete') {
      const r = await pedir(tabId, mensaje);
      if (r) return r;
    }
    console.warn('[Infocivil consulta] Sin respuesta a "' + mensaje.action + '" (intento ' +
      (i + 1) + '/' + intentos + ', status=' + tab.status + ', url=' + tab.url + ') — reintentando…');
    await esperar(400 + i * 500);
  }
  return null;
}

// Espera hasta que el estado de la página cumpla la condición.
async function esperarEstado(tabId, condicion, timeoutMs) {
  const inicio = Date.now();
  let ultimo = null;
  while (Date.now() - inicio < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Se cerró la ventana del SCW.');
    if (tab.status === 'complete') {
      const estado = await pedir(tabId, { action: 'estadoPagina' });
      if (estado) {
        ultimo = estado;
        if (condicion(estado)) return estado;
      }
    }
    await esperar(500);
  }
  return { vencido: true, ultimo };
}

async function esperarStorage(clave, timeoutMs) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const d = await chrome.storage.local.get([clave, 'pjnHistoricasResult']);
    if (clave in d) return { ok: true, valor: d[clave] };
    if (d.pjnHistoricasResult && d.pjnHistoricasResult.ok === false) {
      return { ok: false, error: d.pjnHistoricasResult.error };
    }
    await esperar(700);
  }
  return { ok: false, error: 'tiempo agotado' };
}

async function consultar({ valorJurisdiccion, sigla, numero, anio, incidente }, sesion, avisar) {
  const nombre = `${sigla} ${numero}/${anio}`;

  avisar('Conectando con el Sistema de Consulta Web…');
  const ventana = await chrome.windows.create({ url: URL_HOME, state: 'minimized', focused: false });
  sesion.windowId = ventana.id;
  const tabId = ventana.tabs[0].id;
  sesion.tabId = tabId;

  const home = await esperarEstado(tabId, e => e.enHome, 30000);
  if (home.vencido) throw new Error('El SCW no respondió (no cargó la Consulta Pública).');

  // Tres salidas posibles: el expediente, una página de resultados, o de
  // vuelta en home.seam (típicamente con un mensaje de "no encontrado").
  // Para distinguir "todavía no envió" de "volvió a home", se exige haber
  // visto la pestaña navegar después del envío, o que home muestre un
  // mensaje (por si el SCW contesta por AJAX sin recargar). El registro de
  // la navegación se activa ANTES de enviar, para no perderla.
  let navego = false;
  const onUpdated = (id, info) => { if (id === tabId && info.status === 'loading') navego = true; };
  chrome.tabs.onUpdated.addListener(onUpdated);
  let estado;
  try {
    avisar('Buscando ' + nombre + '…');
    const r = await pedirConReintento(tabId, { action: 'completarFormularioBusqueda', valorJurisdiccion, numero, anio });
    if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo completar la Consulta Pública (la página del SCW no respondió a tiempo).');
    const inicio = Date.now();
    let resultadosTomados = false;
    while (true) {
      if (Date.now() - inicio > 45000) {
        throw new Error('El SCW tardó demasiado en responder la búsqueda de ' + nombre + '.');
      }
      estado = await esperarEstado(tabId, e =>
        (navego && (e.esExpediente || e.linksResultados > 0 || e.enHome)) || (e.enHome && !!e.mensajes), 5000);
      if (estado.vencido) continue;
      if (estado.esExpediente && estado.cid) break;
      if (estado.linksResultados > 0 && !resultadosTomados) {
        resultadosTomados = true;
        navego = false;
        avisar('Abriendo el expediente…');
        await pedir(tabId, { action: 'tomarPrimerResultadoBusqueda' });
        continue;
      }
      if (estado.enHome) {
        throw new Error('No se encontró el expediente ' + nombre + '.' +
          (estado.mensajes ? ' El SCW dice: ' + estado.mensajes : ''));
      }
    }
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }

  const cid = estado.cid;
  sesion.cid = cid;
  let aviso = '';
  if (incidente) {
    aviso = 'La apertura de incidentes todavía no está disponible: se abrió el expediente principal.';
  }

  // Históricas: se leen navegando la misma pestaña a su página (el
  // content script las lee solo y las deja en storage) y se vuelve.
  avisar('Leyendo actuaciones históricas…');
  const clave = 'pjnHistoricas_' + cid;
  await chrome.storage.local.remove([clave, 'pjnHistoricasResult']);
  await chrome.tabs.update(tabId, { url: urlHistoricas(cid) });
  const hist = await esperarStorage(clave, 60000);
  if (!hist.ok) console.warn('[Infocivil consulta] Históricas no leídas:', hist.error);

  await chrome.tabs.update(tabId, { url: urlExpediente(cid) });
  const vuelta = await esperarEstado(tabId, e => e.esExpediente, 30000);
  if (vuelta.vencido) throw new Error('No se pudo volver al expediente después de leer las históricas.');

  avisar('Leyendo actuaciones…');
  const act = await pedirConReintento(tabId, { action: 'obtenerActuaciones' });
  if (!act || !act.ok) throw new Error((act && act.error) || 'No se pudieron leer las actuaciones (la página no respondió a tiempo).');

  return {
    cid, tabId, aviso,
    nombre,
    caratula: vuelta.caratula || act.tituloExpediente || '',
    folderName: act.folderName,
    tituloExpediente: act.tituloExpediente,
    actuaciones: act.actuaciones || [],
    archivos: act.archivos || [],
    historicasFaltantes: !!act.historicasFaltantes,
    paginacionIncompleta: !!act.paginacionIncompleta,
  };
}

export function iniciarConsultas() {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'consulta') return;
    const sesion = { windowId: null, tabId: null, cid: null };
    const avisar = texto => { try { port.postMessage({ tipo: 'etapa', texto }); } catch (e) {} };

    port.onMessage.addListener(async msg => {
      if (!msg || msg.tipo !== 'consultar') return;
      if (sesion.windowId) {
        // Consulta nueva desde la misma pantalla: se descarta la anterior.
        chrome.windows.remove(sesion.windowId).catch(() => {});
        sesion.windowId = sesion.tabId = sesion.cid = null;
      }
      try {
        const res = await consultar(msg, sesion, avisar);
        port.postMessage({ tipo: 'listo', ...res });
      } catch (err) {
        console.warn('[Infocivil consulta]', err);
        if (sesion.windowId) chrome.windows.remove(sesion.windowId).catch(() => {});
        sesion.windowId = sesion.tabId = sesion.cid = null;
        try { port.postMessage({ tipo: 'error', texto: err.message || String(err) }); } catch (e) {}
      }
    });

    // La pantalla de inicio se cerró o navegó: la ventana del SCW ya no
    // hace falta.
    port.onDisconnect.addListener(() => {
      if (sesion.windowId) chrome.windows.remove(sesion.windowId).catch(() => {});
    });
  });
}
