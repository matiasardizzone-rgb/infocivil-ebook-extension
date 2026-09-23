// consulta.js — Consulta de un expediente desde la pantalla de inicio de la
// extensión (src/public/inicio.html), sin que el operador pase por el SCW.
//
// El SCW sigue siendo la fuente (no tiene otra vía pública): se abre en una
// PESTAÑA con foco, dentro de la ventana del operador, y se completa la
// Consulta Pública. Se queda con foco durante toda la lectura de
// históricas y actuaciones — no solo la búsqueda inicial —, porque esa
// parte depende de que RichFaces aplique cambios al DOM, y Chrome
// suspende el ciclo de repintado (requestAnimationFrame) en pestañas
// ocultas: se probó devolver el foco antes (apenas confirmado el
// expediente) y, contra el sitio real, la paginación de actuaciones se
// cortaba siempre en la página 2, sin importar cuánto margen de espera se
// le diera. Recién al terminar todo eso el foco vuelve al operador; la
// pestaña del SCW queda abierta, en segundo plano, mientras la pantalla
// de inicio la necesite para descargar (eso sí es solo fetch() de PDFs,
// que no depende de la visibilidad). Se cierra sola cuando se cierra o se
// va de esa pantalla.
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

// Históricas + actuaciones sobre un expediente YA confirmado (cid propio):
// la parte de consultar() que no depende de cómo se llegó hasta acá.
// Reusada tanto por la búsqueda normal como por abrir un vinculado sobre
// una pestaña que ya estaba en el expediente.
// Desde este año el fuero no tiene actuaciones históricas (dato del
// operador: los expedientes de 2019 en adelante nacieron digitales). Para
// esos no se visita actuacionesHistoricas.seam: se ahorra la ida, la
// espera y la vuelta enteras.
const ANIO_SIN_HISTORICAS = 2019;

async function leerHistoricasYActuaciones(tabId, cid, avisar, anio) {
  const clave = 'pjnHistoricas_' + cid;
  let vuelta;
  if (Number(anio) >= ANIO_SIN_HISTORICAS) {
    // Lista vacía explícita (no ausencia de la clave): así obtenerActuaciones
    // no lo reporta como "históricas faltantes".
    await chrome.storage.local.set({ [clave]: [] });
    vuelta = await esperarEstado(tabId, e => e.esExpediente, 30000, 'confirmando expediente');
    if (vuelta.vencido) throw new Error('La página del expediente no terminó de cargar.');
  } else {
    avisar('Leyendo actuaciones históricas…');
    await chrome.storage.local.remove([clave, 'pjnHistoricasResult']);
    await chrome.tabs.update(tabId, { url: urlHistoricas(cid) });
    const hist = await esperarStorage(clave, 60000);
    if (!hist.ok) console.warn('[Infocivil consulta] Históricas no leídas:', hist.error);

    await chrome.tabs.update(tabId, { url: urlExpediente(cid) });
    vuelta = await esperarEstado(tabId, e => e.esExpediente, 30000, 'volviendo al expediente tras históricas');
    if (vuelta.vencido) throw new Error('No se pudo volver al expediente después de leer las históricas.');
  }

  avisar('Leyendo actuaciones…');
  // Generoso a propósito: adentro puede haber varias páginas, cada una
  // con hasta 70s de margen (25s + 45s de reintento, ver scw-content.js)
  // porque esta pestaña corre en segundo plano casi siempre.
  const act = await pedirCuandoListo(tabId, e => e.esExpediente, { action: 'obtenerActuaciones' }, { timeoutMs: 300000 });
  if (!act || !act.ok) throw new Error((act && act.error) || 'No se pudieron leer las actuaciones (la página del expediente no terminó de asentarse).');

  return { vuelta, act };
}

async function consultar({ valorJurisdiccion, sigla, numero, anio, incidente }, sesion, avisar) {
  // Se reasigna más abajo si termina abriendo un incidente en vez del
  // principal (nombre del PRINCIPAL hasta ese punto — los mensajes de
  // "Buscando…"/"Abriendo…" de más arriba hablan del principal a propósito,
  // es lo que el operador tecleó).
  let nombre = `${sigla} ${numero}/${anio}`;

  // Varias ventanas aparte (minimizada, chica sin foco, chica con foco,
  // grande con foco) se probaron para intentar que la búsqueda fuera
  // invisible, y ninguna funcionó de forma confiable — además de que una
  // ventana emergente aparte es rara y no se integra con nada.
  // Se abandona esa idea: la búsqueda pasa por una PESTAÑA común, dentro
  // de la ventana del operador, igual que si abriera el SCW a mano (que
  // es, al final, la única forma que se confirmó que funciona). Se
  // recuerda cuál era la pestaña activa antes para volver a ella apenas
  // se encuentra el expediente.
  // Pestaña de origen: la que mandó la consulta (sesion.pestanaOrigen, que
  // Chrome informa en el propio mensaje), no "la activa de la última
  // ventana enfocada" — con la consola del service worker abierta, esa
  // consulta puede devolver la ventana de DevTools, y el foco nunca vuelve.
  const pestanaPrevia = sesion.pestanaOrigen ||
    await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      .then(t => (t && t[0]) || null).catch(() => null);

  avisar('Conectando con el Sistema de Consulta Web…');
  // Con foco (active:true), y así se queda hasta el final — ver el porqué
  // en el comentario junto a devolverFoco() más abajo.
  const tab = await chrome.tabs.create({
    url: URL_HOME, active: true,
    ...(pestanaPrevia ? { windowId: pestanaPrevia.windowId, index: pestanaPrevia.index + 1 } : {}),
  });
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
      { action: 'completarFormularioBusqueda', valorJurisdiccion, numero, anio }, { timeoutMs: 12000 });
    if (!r || !r.ok) {
      // Visto contra el sitio real: el envío puede funcionar (la página
      // navega al expediente correcto) y perderse solo la RESPUESTA de
      // ese mensaje, porque la navegación destruye el content script en
      // el instante en que iba a contestar. pedirCuandoListo, al no
      // recibir respuesta, sigue esperando 'enHome' — que ya no vuelve a
      // ser cierto nunca, porque ya estamos en el expediente. Antes de
      // darlo por error, nos fijamos si la página ya avanzó de verdad.
      const chequeo = await pedir(tabId, { action: 'estadoPagina' });
      if (!chequeo || !(chequeo.esExpediente || chequeo.linksResultados > 0)) {
        throw new Error((r && r.error) || 'No se pudo completar la Consulta Pública (la página del SCW no terminó de asentarse).');
      }
      console.warn('[Infocivil consulta] El envío no confirmó respuesta, pero la página ya avanzó ' +
        '(la búsqueda probablemente sí funcionó): url=' + chequeo.url);
    }
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

  let cid = estado.cid;
  let aviso = '';

  // Vinculados: se leen siempre (para mostrarlos en la pantalla de
  // resultados, haya o no incidente pedido), sobre el expediente PRINCIPAL
  // — es donde vive la solapa "Vinculados".
  avisar('Buscando vinculados…');
  let vinculados = [];
  const vin = await pedir(tabId, { action: 'leerVinculados' });
  if (vin && vin.ok) vinculados = vin.vinculados || [];
  else console.warn('[Infocivil consulta] No se pudo leer vinculados:', vin && vin.error);

  if (incidente) {
    const objetivo = sigla + ' ' + numero + '/' + anio + '/' + incidente;
    avisar('Abriendo el incidente ' + incidente + '…');
    const cidPrincipal = cid;
    let r = await pedir(tabId, { action: 'abrirVinculado', expediente: objetivo });
    if (!r) {
      // Mismo patrón que el envío del formulario de búsqueda (v0.5.5): el
      // clic en el botón "ojo" puede funcionar de verdad (la página navega
      // al incidente) y perderse solo la RESPUESTA, porque la navegación
      // destruye el content script en el instante de contestar. Antes de
      // reintentar —que correría sobre la página YA navegada al incidente,
      // sin tabla de vinculados, y fallaría por una razón distinta y
      // confusa— nos fijamos si ya cambió de expediente.
      await esperar(800);
      const chequeo = await pedir(tabId, { action: 'estadoPagina' });
      if (chequeo && chequeo.esExpediente && chequeo.cid && chequeo.cid !== cidPrincipal) {
        r = { ok: true, cid: chequeo.cid };
        console.warn('[Infocivil consulta] Abrir vinculado sin confirmar respuesta, pero la página ya cambió de expediente (probablemente sí funcionó): cid=' + chequeo.cid);
      } else {
        await esperar(1000);
        r = await pedir(tabId, { action: 'abrirVinculado', expediente: objetivo });
      }
    }
    if (r && r.ok && r.cid) {
      cid = r.cid;
      nombre = objetivo; // ya no es el principal: la pantalla debe decir "CIV .../n", no el principal
    } else {
      aviso = 'No se pudo abrir el incidente ' + incidente + ' (' +
        ((r && r.error) || 'no encontrado en Vinculados') + '): se abrió el expediente principal.';
    }
  }
  sesion.cid = cid;

  // Históricas: se leen navegando la misma pestaña a su página (el
  // content script las lee solo y las deja en storage) y se vuelve.
  const { vuelta, act } = await leerHistoricasYActuaciones(tabId, cid, avisar, anio);

  // Devolver el foco ACÁ, al final, no apenas se confirma el expediente.
  // Se probó devolverlo antes (v0.5.4-v0.9.2): históricas y actuaciones
  // quedaban leyéndose con la pestaña ya en segundo plano, y contra el
  // sitio real la paginación se cortaba siempre en la página 2 — no por
  // lenta, ni más tiempo de espera lo arregló (25s/45s tampoco). Todo
  // apunta a que Chrome SUSPENDE del todo el ciclo de repintado
  // (requestAnimationFrame) en pestañas ocultas, no solo lo frena — y si
  // RichFaces aplica sus actualizaciones del DOM a través de eso, la
  // respuesta del SCW puede llegar bien y nunca reflejarse en la página
  // mientras esté oculta. La pestaña se ve durante toda la búsqueda; a
  // cambio, no se pierden actuaciones.
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
    vinculados,
  };
}

// Abrir un vinculado desde la pantalla de resultados: mensaje suelto
// (sendMessage), no puerto. Un puerto de conexión larga (el que usa la
// búsqueda inicial) puede quedar mirando a un service worker que ya se
// apagó por inactividad — visto en la práctica: la pantalla de resultados
// puede quedar quieta un buen rato antes de que alguien toque "Abrir" en
// un vinculado, tiempo de sobra para que se apague. sendMessage es el
// mecanismo estándar para justamente ese caso (despertarlo bajo demanda),
// a costa de no tener mensajes de 'etapa' en vivo por este camino — la
// pantalla ya no los necesita, solo el resultado final.
// Abrir un vinculado directo sobre la pestaña del expediente PRINCIPAL,
// si esa pestaña sigue abierta (queda abierta en segundo plano después de
// cada búsqueda, justamente para esto). No pasa por home.seam de nuevo:
// nada de foco en ningún momento, porque no hay ningún salto de
// navegación delicado de por medio esta vez — la pestaña ya está en el
// expediente correcto. null si la pestaña ya no sirve (cerrada, navegada
// a otra cosa): el llamador decide si cae a la búsqueda completa.
async function abrirVinculadoEnPestanaExistente(tabId, expedienteTexto, avisar, pestanaOrigen) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  const estadoPrevio = await pedir(tabId, { action: 'estadoPagina' });
  if (!estadoPrevio || !estadoPrevio.esExpediente) return null;
  const cidPrincipal = estadoPrevio.cid;

  // Traer al frente: esta pestaña está en segundo plano desde que terminó
  // la búsqueda original, y lo que sigue (abrir la solapa, leer históricas
  // y paginar actuaciones) depende de que RichFaces aplique cambios al
  // DOM — algo que Chrome no hace en pestañas ocultas (mismo motivo que en
  // consultar(), ver su comentario junto a devolverFoco()).
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  try {
    avisar('Abriendo ' + expedienteTexto + '…');
    let r = await pedir(tabId, { action: 'abrirVinculado', expediente: expedienteTexto });
    if (!r) {
      // Mismo patrón que en consultar(): la respuesta se puede perder por la
      // navegación aunque el clic haya funcionado de verdad.
      await esperar(800);
      const chequeo = await pedir(tabId, { action: 'estadoPagina' });
      if (chequeo && chequeo.esExpediente && chequeo.cid && chequeo.cid !== cidPrincipal) {
        r = { ok: true, cid: chequeo.cid };
      } else {
        await esperar(1000);
        r = await pedir(tabId, { action: 'abrirVinculado', expediente: expedienteTexto });
      }
    }
    if (!r || !r.ok || !r.cid) {
      if (r && r.error) throw new Error(r.error); // "no encontrado en Vinculados": no tiene sentido reintentar con una búsqueda nueva, va a dar el mismo resultado
      return null; // sin respuesta ni motivo claro: que decida el llamador
    }

    const cid = r.cid;
    const { vuelta, act } = await leerHistoricasYActuaciones(tabId, cid, avisar, ((expedienteTexto || '').match(/\/(\d{4})\//) || [])[1]);
    return {
      cid, tabId, aviso: '', nombre: expedienteTexto,
      caratula: vuelta.caratula || act.tituloExpediente || '',
      folderName: act.folderName,
      tituloExpediente: act.tituloExpediente,
      actuaciones: act.actuaciones || [],
      archivos: act.archivos || [],
      historicasFaltantes: !!act.historicasFaltantes,
      paginacionIncompleta: !!act.paginacionIncompleta,
      vinculados: [],
    };
  } finally {
    if (pestanaOrigen) chrome.tabs.update(pestanaOrigen.id, { active: true }).catch(() => {});
  }
}

export function iniciarAperturaVinculados() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.action !== 'consultarVinculado') return;
    (async () => {
      try {
        if (msg.tabIdExistente && msg.expedienteVinculado) {
          try {
            const res = await abrirVinculadoEnPestanaExistente(
              msg.tabIdExistente, msg.expedienteVinculado, () => {}, sender && sender.tab);
            if (res) { sendResponse({ tipo: 'listo', ...res }); return; }
          } catch (err) {
            // Vinculado genuinamente no encontrado ahí: no tiene sentido
            // repetir con una búsqueda nueva, va a dar lo mismo.
            sendResponse({ tipo: 'error', texto: err.message || String(err) });
            return;
          }
          console.warn('[Infocivil consulta] La pestaña existente ya no sirve para abrir el vinculado; se busca de nuevo desde cero.');
        }
        const sesion = { pestanaOrigen: sender && sender.tab };
        try {
          const res = await consultar(msg, sesion, () => {});
          sendResponse({ tipo: 'listo', ...res });
        } catch (err) {
          await devolverFoco(sesion);
          if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
          throw err;
        }
      } catch (err) {
        console.warn('[Infocivil consulta]', err);
        sendResponse({ tipo: 'error', texto: err.message || String(err) });
      }
    })();
    return true; // respuesta asíncrona
  });
}

export function iniciarConsultas() {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'consulta') return;
    const sesion = { tabId: null, cid: null, pestanaOrigen: port.sender && port.sender.tab };
    const avisar = texto => { try { port.postMessage({ tipo: 'etapa', texto }); } catch (e) {} };

    port.onMessage.addListener(async msg => {
      if (!msg || msg.tipo !== 'consultar') return;
      if (sesion.tabId) {
        // Consulta nueva desde la misma pantalla: se descarta la anterior.
        if (sesion.rescateTimer) { clearTimeout(sesion.rescateTimer); sesion.rescateTimer = null; }
        chrome.tabs.remove(sesion.tabId).catch(() => {});
        sesion.tabId = sesion.cid = null;
      }
      try {
        const res = await consultar(msg, sesion, avisar);
        port.postMessage({ tipo: 'listo', ...res });
      } catch (err) {
        console.warn('[Infocivil consulta]', err);
        await devolverFoco(sesion);
        if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
        sesion.tabId = sesion.cid = null;
        try { port.postMessage({ tipo: 'error', texto: err.message || String(err) }); } catch (e) {}
      }
    });

    // La pantalla de inicio se cerró o navegó: la ventana del SCW ya no
    // hace falta.
    port.onDisconnect.addListener(() => {
      if (sesion.rescateTimer) clearTimeout(sesion.rescateTimer);
      if (sesion.tabId) chrome.tabs.remove(sesion.tabId).catch(() => {});
    });
  });
}
