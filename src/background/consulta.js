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

// La ventana de consulta se enfoca (ver más abajo, en consultar()); esto le
// devuelve el foco al operador apenas termina de buscar, sin depender de
// que la ventana de consulta se cierre (sigue abierta, sin foco, por si
// hace falta para las descargas).
function devolverFoco(sesion) {
  if (sesion.pestanaPrevia) chrome.tabs.update(sesion.pestanaPrevia, { active: true }).catch(() => {});
}

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

// El SCW parece dar varios saltos de navegación seguidos al abrir
// home.seam por primera vez (visto contra el sitio real: el formulario no
// estaba, pese a que la pestaña ya reportaba 'complete' y el content
// script respondió). "complete" del navegador no alcanza como señal de
// que la página está lista — hay que confirmarlo por CONTENIDO
// (condicion sobre el resultado de 'estadoPagina') antes de mandar el
// mensaje real, y si aun así no llega respuesta (perdida por una
// renavegación en el instante entre medio), reintentar.
async function pedirCuandoListo(tabId, condicion, mensaje, { timeoutMs = 30000 } = {}) {
  const inicio = Date.now();
  let ultimoEstado = null, intento = 0;
  while (Date.now() - inicio < timeoutMs) {
    intento++;
    const seg = () => Math.round((Date.now() - inicio) / 1000);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Se cerró la ventana del SCW.');

    if (tab.status !== 'complete') {
      // Antes esto quedaba en silencio: si la pestaña nunca llega a
      // 'complete' (por ejemplo, atascada en una redirección), el bucle
      // entero pasaba sin dejar un solo rastro en la consola.
      if (intento % 3 === 0) console.warn('[Infocivil consulta] Pestaña sin terminar de cargar para "' +
        mensaje.action + '" (' + seg() + 's, intento ' + intento + '): status=' + tab.status + ' url=' + tab.url);
      await esperar(Math.min(400 + intento * 200, 2000));
      continue;
    }

    const estado = await pedir(tabId, { action: 'estadoPagina' });
    if (!estado) {
      // Tampoco esto: 'complete' pero el content script no respondió
      // nada (no se inyectó, o se está reinyectando justo ahora).
      if (intento % 3 === 0) console.warn('[Infocivil consulta] Sin respuesta del content script para "' +
        mensaje.action + '" (' + seg() + 's, intento ' + intento + '): url=' + tab.url);
      await esperar(Math.min(400 + intento * 200, 2000));
      continue;
    }

    ultimoEstado = estado;
    if (condicion(estado)) {
      const r = await pedir(tabId, mensaje);
      if (r) return r;
      console.warn('[Infocivil consulta] Página lista pero sin respuesta a "' + mensaje.action +
        '" (intento ' + intento + ', ' + seg() + 's, url=' + tab.url +
        ') — probablemente renavegó justo entonces. Reintentando…');
    } else if (intento % 3 === 0) {
      console.warn('[Infocivil consulta] Página aún no lista para "' + mensaje.action + '" (' + seg() +
        's, intento ' + intento + '): url=' + tab.url + ' enHome=' + estado.enHome +
        ' esExpediente=' + estado.esExpediente + ' linksResultados=' + estado.linksResultados +
        ' mensajes=' + JSON.stringify(estado.mensajes));
    }
    await esperar(Math.min(400 + intento * 200, 2000));
  }
  console.warn('[Infocivil consulta] Se agotó el tiempo esperando "' + mensaje.action + '" (' +
    Math.round(timeoutMs / 1000) + 's). Último estado visto:', ultimoEstado);
  return null;
}

// Espera hasta que el estado de la página cumpla la condición.
async function esperarEstado(tabId, condicion, timeoutMs, etiqueta = '') {
  const inicio = Date.now();
  let ultimo = null, intento = 0;
  while (Date.now() - inicio < timeoutMs) {
    intento++;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Se cerró la ventana del SCW.');
    if (tab.status === 'complete') {
      const estado = await pedir(tabId, { action: 'estadoPagina' });
      if (estado) {
        ultimo = estado;
        if (condicion(estado)) return estado;
        if (etiqueta && intento % 3 === 0) console.warn('[Infocivil consulta] ' + etiqueta + ': condición aún no cumplida (' +
          Math.round((Date.now() - inicio) / 1000) + 's): url=' + tab.url + ' ' + JSON.stringify(estado));
      } else if (etiqueta && intento % 3 === 0) {
        console.warn('[Infocivil consulta] ' + etiqueta + ': sin respuesta del content script (' +
          Math.round((Date.now() - inicio) / 1000) + 's): url=' + tab.url);
      }
    } else if (etiqueta && intento % 3 === 0) {
      console.warn('[Infocivil consulta] ' + etiqueta + ': pestaña sin terminar de cargar (' +
        Math.round((Date.now() - inicio) / 1000) + 's): status=' + tab.status + ' url=' + tab.url);
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

  // Varias ventanas aparte (minimizada, chica sin foco, chica con foco,
  // grande con foco) se probaron para intentar que la búsqueda fuera
  // invisible, y ninguna funcionó de forma confiable — además de que una
  // ventana emergente aparte es rara y no se integra con nada.
  // Se abandona esa idea: la búsqueda pasa por una PESTAÑA común, dentro
  // de la ventana del operador, igual que si abriera el SCW a mano (que
  // es, al final, la única forma que se confirmó que funciona). Se
  // recuerda cuál era la pestaña activa antes para volver a ella apenas
  // se encuentra el expediente.
  const pestanaPrevia = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then(t => (t && t[0]) || null).catch(() => null);

  avisar('Conectando con el Sistema de Consulta Web…');
  const tab = await chrome.tabs.create({ url: URL_HOME, active: true });
  const tabId = tab.id;
  sesion.tabId = tabId;
  sesion.pestanaPrevia = pestanaPrevia && pestanaPrevia.id !== tabId ? pestanaPrevia.id : null;

  const home = await esperarEstado(tabId, e => e.enHome, 30000, 'esperando home.seam');
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
    const r = await pedirCuandoListo(tabId, e => e.enHome,
      { action: 'completarFormularioBusqueda', valorJurisdiccion, numero, anio }, { timeoutMs: 30000 });
    if (!r || !r.ok) throw new Error((r && r.error) || 'No se pudo completar la Consulta Pública (la página del SCW no terminó de asentarse).');
    const inicio = Date.now();
    let resultadosTomados = false;
    while (true) {
      if (Date.now() - inicio > 45000) {
        throw new Error('El SCW tardó demasiado en responder la búsqueda de ' + nombre + '.');
      }
      estado = await esperarEstado(tabId, e =>
        (navego && (e.esExpediente || e.linksResultados > 0 || e.enHome)) || (e.enHome && !!e.mensajes), 5000, 'esperando resultado de la búsqueda');
      if (estado.vencido) continue;
      if (estado.esExpediente && estado.cid) break;
      if (estado.linksResultados > 0 && !resultadosTomados) {
        resultadosTomados = true;
        navego = false;
        avisar('Abriendo el expediente…');
        await pedirCuandoListo(tabId, e => e.linksResultados > 0, { action: 'tomarPrimerResultadoBusqueda' }, { timeoutMs: 8000 });
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
  const vuelta = await esperarEstado(tabId, e => e.esExpediente, 30000, 'volviendo al expediente tras históricas');
  if (vuelta.vencido) throw new Error('No se pudo volver al expediente después de leer las históricas.');

  avisar('Leyendo actuaciones…');
  const act = await pedirCuandoListo(tabId, e => e.esExpediente, { action: 'obtenerActuaciones' }, { timeoutMs: 25000 });
  if (!act || !act.ok) throw new Error((act && act.error) || 'No se pudieron leer las actuaciones (la página del expediente no terminó de asentarse).');

  // Encontrado: la ventana ya no necesita foco (las descargas que vengan
  // después usan fetch() en la página, que no depende de la visibilidad).
  devolverFoco(sesion);

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
    const sesion = { tabId: null, cid: null };
    const avisar = texto => { try { port.postMessage({ tipo: 'etapa', texto }); } catch (e) {} };

    port.onMessage.addListener(async msg => {
      if (!msg || msg.tipo !== 'consultar') return;
      if (sesion.tabId) {
        // Consulta nueva desde la misma pantalla: se descarta la anterior.
        chrome.tabs.remove(sesion.tabId).catch(() => {});
        sesion.tabId = sesion.cid = null;
      }
      try {
        const res = await consultar(msg, sesion, avisar);
        port.postMessage({ tipo: 'listo', ...res });
      } catch (err) {
        console.warn('[Infocivil consulta]', err);
        devolverFoco(sesion);
        if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
        sesion.tabId = sesion.cid = null;
        try { port.postMessage({ tipo: 'error', texto: err.message || String(err) }); } catch (e) {}
      }
    });

    // La pantalla de inicio se cerró o navegó: la ventana del SCW ya no
    // hace falta.
    port.onDisconnect.addListener(() => {
      if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
    });
  });
}
