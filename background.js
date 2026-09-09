import * as db from './db.js';
import { generarPdfUnificado } from './unificador.js';

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message) return;

  // ═══════════════════════════════════════════════════════════════════
  // PDF UNIFICADO — descarga cada actuación, arma un único PDF con índice
  // hipervinculado y link público en el pie de cada página (unificador.js).
  // ═══════════════════════════════════════════════════════════════════

  if (message.action === 'descargarExpedienteUnificado') {
    (async () => {
      try {
        const actuacionesIn = message.actuaciones || [];
        const tituloExpediente = message.tituloExpediente || 'Expediente';
        const historicasFaltantes = !!message.historicasFaltantes;
        if (!actuacionesIn.length) { sendResponse({ ok: false, error: 'No hay actuaciones para unificar.' }); return; }

        // Normalizar URLs por si vinieran relativas o sin download=true
        // (obtenerActuaciones en content.js ya las arma completas, pero no
        // asumimos: este handler también puede invocarse a futuro desde
        // otro flujo, p.ej. biblioteca).
        const actuaciones = actuacionesIn.map((a, i) => {
          let urlPdf = a.urlPdf || a.url || '';
          if (urlPdf && urlPdf.indexOf('http') !== 0) urlPdf = 'https://scw.pjn.gov.ar' + urlPdf;
          if (urlPdf.indexOf('/scw/viewer') !== -1 && urlPdf.indexOf('download=true') === -1)
            urlPdf += (urlPdf.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
          const urlPublica = a.urlPublica || urlPdf.replace(/[&?]download=true/g, '');
          return {
            numero: a.numero || i + 1,
            titulo: a.titulo || 'Actuación ' + (i + 1),
            fecha: a.fecha || '',
            tipo: a.tipo || '',
            descripcion: a.descripcion || '',
            urlPdf, urlPublica,
            bytes: null, error: null,
          };
        });

        chrome.storage.local.set({ unificadoProgreso: { total: actuaciones.length, descargados: 0, errores: 0, terminado: false } });

        const CONC = 3;
        let siguiente = 0, descargados = 0, errores = 0;
        async function worker() {
          while (siguiente < actuaciones.length) {
            const act = actuaciones[siguiente++];
            try {
              const resp = await fetch(act.urlPdf, { credentials: 'include' });
              if (!resp.ok) throw new Error('HTTP ' + resp.status);
              const buffer = await resp.arrayBuffer();
              const bytes = new Uint8Array(buffer);
              // Igual chequeo de firma %PDF- que en content.js: evita que una
              // página de error/sesión (200 OK con HTML) quede incrustada
              // como si fuera el documento — el unificador la reemplaza por
              // una página de error explícita en su lugar.
              if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D) {
                act.bytes = bytes;
                descargados++;
              } else {
                act.error = 'La respuesta no es un PDF válido (posible sesión vencida)';
                errores++;
              }
            } catch (e) {
              act.error = e.message;
              errores++;
            }
            chrome.storage.local.set({ unificadoProgreso: { total: actuaciones.length, descargados, errores, terminado: false, etapa: 'descargando' } });
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONC, actuaciones.length) }, worker));

        chrome.storage.local.set({ unificadoProgreso: { total: actuaciones.length, descargados, errores, terminado: false, etapa: 'armando' } });

        const pdfBytes = await generarPdfUnificado({ tituloExpediente, actuaciones, historicasFaltantes });
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });

        let url;
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          url = URL.createObjectURL(blob);
        } else {
          // Fallback por si el service worker no soporta createObjectURL:
          // data URI en base64 (funciona igual con chrome.downloads.download).
          const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          url = 'data:application/pdf;base64,' + b64;
        }

        const nombreArchivo = sanitizarNombre(tituloExpediente).slice(0, 50) + '_UNIFICADO.pdf';
        chrome.downloads.download({ url, filename: nombreArchivo, saveAs: true }, () => {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' && url.indexOf('blob:') === 0) {
            setTimeout(() => URL.revokeObjectURL(url), 30000);
          }
        });

        chrome.storage.local.set({ unificadoProgreso: { total: actuaciones.length, descargados, errores, terminado: true } });
        sendResponse({ ok: true, descargados, errores, total: actuaciones.length });
      } catch (err) {
        console.error('[PJN BG] Error armando PDF unificado:', err);
        chrome.storage.local.set({ unificadoProgreso: { terminado: true, error: err.message } });
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // BIBLIOTECA — persistencia local en IndexedDB (ver db.js)
  // content.js corre en el origen de scw.pjn.gov.ar y no puede tocar el
  // IndexedDB de la extensión directamente, así que todo pasa por acá.
  // biblioteca.html, en cambio, puede importar db.js y leer directo.
  // ═══════════════════════════════════════════════════════════════════

  if (message.action === 'bibliotecaIniciar') {
    // { cid, numero, folderName, caratula, archivos }
    const archivos = message.archivos || [];
    db.guardarExpediente({
      cid: message.cid,
      numero: message.numero,
      folderName: message.folderName,
      caratula: message.caratula,
      cantidadActuaciones: archivos.length,
      cantidadFojas: archivos.length, // aproximado: 1 PDF ≈ 1 foja hasta que el visor cuente páginas reales
      hash: db.calcularHash(archivos),
      estado: 'descargando',
      fechaDescarga: new Date().toISOString(),
    }).then(reg => sendResponse({ ok: true, expediente: reg }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'bibliotecaGuardarDocumento') {
    // { cid, indice, titulo, fecha, tipo, esHistorica, extension, urlHiper, bufferB64, mime }
    try {
      const bytes = base64ABytes(message.bufferB64);
      console.log('[PJN DIAG BG] doc', message.indice, '| base64 recibido len:', (message.bufferB64||'').length,
        '| bytes decodificados:', bytes.length,
        '| primeros bytes:', Array.from(bytes.slice(0,5)).join(','));
      const blob = new Blob([bytes], { type: message.mime || 'application/pdf' });
      db.guardarDocumento({
        cid: message.cid,
        indice: message.indice,
        titulo: message.titulo,
        fecha: message.fecha,
        tipo: message.tipo,
        esHistorica: message.esHistorica,
        extension: message.extension,
        urlHiper: message.urlHiper,
        blob,
      }).then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }

  if (message.action === 'bibliotecaFinalizar') {
    // { cid, archivos }
    const archivos = message.archivos || [];
    db.actualizarEstadoExpediente(message.cid, {
      estado: 'ok',
      nuevasDetectadas: 0,
      cantidadActuaciones: archivos.length,
      cantidadFojas: archivos.length,
      hash: db.calcularHash(archivos),
      fechaVerificacion: new Date().toISOString(),
    }).then(reg => sendResponse({ ok: true, expediente: reg }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'bibliotecaVerificarCambios') {
    // { cid, archivos }  — archivos = resultado liviano de findPdfs (sin blobs)
    verificarCambiosInterno(message.cid, message.archivos)
      .then(r => sendResponse(r))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'bibliotecaVerificarEnVivo') {
    // { cid } — abre (o reusa) la pestaña del expediente, escanea liviano y compara
    (async () => {
      try {
        const { tab, creado } = await obtenerTabExpediente(message.cid);
        const resp = await sendMessageATab(tab.id, { action: 'findPdfs' });
        if (creado) chrome.tabs.remove(tab.id);
        if (!resp || !resp.ok) { sendResponse({ ok: false, error: (resp && resp.error) || 'No se pudo escanear el expediente.' }); return; }
        const resultado = await verificarCambiosInterno(message.cid, resp.archivos);
        sendResponse(resultado);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'bibliotecaActualizarEnVivo') {
    // { cid } — abre (o reusa) la pestaña, escanea y dispara la descarga real.
    // El progreso se sigue por chrome.storage.local ('descargaProgreso'), igual que el popup.
    (async () => {
      try {
        const { tab, creado } = await obtenerTabExpediente(message.cid);
        const resp = await sendMessageATab(tab.id, { action: 'findPdfs' });
        if (!resp || !resp.ok) {
          if (creado) chrome.tabs.remove(tab.id);
          sendResponse({ ok: false, error: (resp && resp.error) || 'No se pudo escanear el expediente.' });
          return;
        }
        chrome.storage.local.set({ descargaProgreso: { total: resp.archivos.length, descargados: 0, errores: 0, terminado: false } });
        chrome.tabs.sendMessage(tab.id, {
          action: 'guardarEnBiblioteca', archivos: resp.archivos, folderName: resp.folderName, startIndex: 1
        });
        sendResponse({ ok: true, iniciado: true });

        if (creado) {
          // Cerramos la pestaña recién creada apenas termine la descarga.
          const check = setInterval(() => {
            chrome.storage.local.get(['descargaProgreso'], data => {
              if (data.descargaProgreso && data.descargaProgreso.terminado) {
                clearInterval(check);
                chrome.tabs.remove(tab.id, () => {});
              }
            });
          }, 1000);
          setTimeout(() => clearInterval(check), 180000); // tope de seguridad: 3 min
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'bibliotecaListar') {
    db.listarExpedientes()
      .then(expedientes => sendResponse({ ok: true, expedientes }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'bibliotecaEliminar') {
    db.eliminarExpediente(message.cid)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.action === 'verificarExpedienteEnVivo') {
    // Abre el expediente en una pestaña oculta, corre el mismo findPdfs liviano
    // que ya existe (no descarga PDFs), compara contra lo guardado y cierra.
    const cid = message.cid;
    const url = 'https://scw.pjn.gov.ar/scw/expediente.seam?cid=' + cid;
    chrome.tabs.create({ url, active: false }, function (tab) {
      const tabId = tab.id;
      function onUpdated(tid, info) {
        if (tid !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, { action: 'findPdfs' }, async function (resp) {
            chrome.tabs.remove(tabId);
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              sendResponse({ ok: false, error: (resp && resp.error) || 'No se pudo escanear el expediente.' });
              return;
            }
            try {
              const existente = await db.obtenerExpediente(cid);
              if (!existente) { sendResponse({ ok: true, noGuardado: true }); return; }
              const hashNuevo = db.calcularHash(resp.archivos);
              const cambio = existente.hash !== hashNuevo;
              const nuevasDetectadas = cambio ? Math.max(0, resp.archivos.length - existente.cantidadActuaciones) : 0;
              const actualizado = await db.actualizarEstadoExpediente(cid, {
                estado: cambio ? 'nuevo' : 'ok',
                nuevasDetectadas,
                fechaVerificacion: new Date().toISOString(),
              });
              sendResponse({ ok: true, cambio, nuevasDetectadas, expediente: actualizado });
            } catch (err) {
              sendResponse({ ok: false, error: err.message });
            }
          });
        }, 4000); // margen para que RichFaces termine de pintar el paginador
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    return true;
  }

  if (message.action === 'actualizarExpedienteEnVivo') {
    // Abre el expediente, escanea, y dispara el mismo guardado que usa el
    // popup — el progreso se sigue vía chrome.storage.local ('descargaProgreso'),
    // igual que ya hace popup.js.
    const cid = message.cid;
    const url = 'https://scw.pjn.gov.ar/scw/expediente.seam?cid=' + cid;
    chrome.tabs.create({ url, active: false }, function (tab) {
      const tabId = tab.id;
      function onUpdated(tid, info) {
        if (tid !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(function () {
          chrome.tabs.sendMessage(tabId, { action: 'findPdfs' }, function (resp) {
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              chrome.tabs.remove(tabId);
              sendResponse({ ok: false, error: (resp && resp.error) || 'No se pudo escanear el expediente.' });
              return;
            }
            chrome.storage.local.set({
              descargaProgreso: { total: resp.archivos.length, descargados: 0, errores: 0, terminado: false }
            });
            chrome.tabs.sendMessage(tabId, {
              action: 'guardarEnBiblioteca', archivos: resp.archivos, folderName: resp.folderName, startIndex: 1
            });
            sendResponse({ ok: true, iniciado: true, total: resp.archivos.length });

            const check = setInterval(function () {
              chrome.storage.local.get(['descargaProgreso'], function (d) {
                if (d.descargaProgreso && d.descargaProgreso.terminado) {
                  clearInterval(check);
                  chrome.tabs.remove(tabId);
                }
              });
            }, 1500);
          });
        }, 4000);
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lógica original — sin cambios
  // ═══════════════════════════════════════════════════════════════════

  if (message.action === 'startDownload') {
    var archivos   = message.archivos || [];
    var folderName = message.folderName || 'Expediente';
    var startIndex = parseInt(message.startIndex, 10) || 1;

    if (!archivos.length) {
      sendResponse({ ok: false, error: 'Lista de archivos vacía' });
      return true;
    }

    chrome.storage.local.set({
      descargaProgreso: { total: archivos.length, descargados: 0, errores: 0, terminado: false }
    }, function () {
      sendResponse({ ok: true, total: archivos.length });
    });

    chrome.tabs.query({ url: 'https://scw.pjn.gov.ar/*' }, function (tabs) {
      var tabId = tabs && tabs[0] && tabs[0].id;
      if (!tabId) { console.error('[PJN BG] No se encontró tab del SCW'); return; }
      chrome.tabs.sendMessage(tabId, {
        action: 'crearYDescargarZip', archivos: archivos,
        folderName: folderName, startIndex: startIndex
      });
    });
    return true;
  }

  if (message.action === 'actualizarProgreso') {
    chrome.storage.local.set({ descargaProgreso: message.progreso });
    if (message.progreso.terminado) {
      chrome.storage.local.set({ nextCorrelativeIndex: message.nextIndex || 1 });
    }
    return false;
  }

  if (message.action === 'abrirTabHistoricas') {
    var cid     = message.cid;
    var urlHist = 'https://scw.pjn.gov.ar/scw/actuacionesHistoricas.seam?cid=' + cid;

    chrome.storage.local.remove('pjnHistoricasResult', function() {
      chrome.tabs.query({ active: true, currentWindow: true }, function(activeTabs) {
        var originalActiveTabId = activeTabs && activeTabs[0] && activeTabs[0].id;

        chrome.tabs.create({ url: urlHist, active: false }, function(tab) {
          var histTabId = tab.id;

          function onUpdated(tabId, info) {
            if (tabId !== histTabId || info.status !== 'complete') return;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.update(histTabId, { active: true }, function() {
              console.log('[PJN BG] Tab historicas activo, esperando auto-scraping...');
            });
          }
          chrome.tabs.onUpdated.addListener(onUpdated);

          var intentos = 40;
          function poll() {
            chrome.storage.local.get('pjnHistoricasResult', function(data) {
              if (data.pjnHistoricasResult) {
                var resp = data.pjnHistoricasResult;
                chrome.storage.local.remove('pjnHistoricasResult');
                chrome.tabs.remove(histTabId, function() {});
                if (originalActiveTabId) {
                  chrome.tabs.update(originalActiveTabId, { active: true });
                }
                var total = resp.archivos ? resp.archivos.length : 0;
                console.log('[PJN BG] Historicas recibidas:', total);
                sendResponse(resp);
              } else if (intentos-- > 0) {
                setTimeout(poll, 2000);
              } else {
                chrome.tabs.remove(histTabId, function() {});
                if (originalActiveTabId) {
                  chrome.tabs.update(originalActiveTabId, { active: true });
                }
                console.warn('[PJN BG] Timeout esperando historicas');
                sendResponse({ ok: false, error: 'Timeout' });
              }
            });
          }
          setTimeout(poll, 45000);
        });
      });
    });
    return true;
  }

  if (message.action === 'runInPageWorld') {
    var tabId = sender && sender.tab && sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: 'Sin tabId' }); return true; }
    chrome.scripting.executeScript(
      { target: { tabId: tabId }, world: 'MAIN', func: executeOnclick, args: [message.code || ''] },
      function () {
        if (chrome.runtime.lastError) console.error('[PJN BG]', chrome.runtime.lastError.message);
        sendResponse({ ok: true });
      }
    );
    return true;
  }
});

function executeOnclick(onclickCode) {
  try {
    var code = onclickCode.replace(/;?\s*return\s+false\s*;?/g, '');
    new Function('event', code)(new MouseEvent('click', { bubbles: true, cancelable: true }));
  } catch (e) { console.error('[PJN]', e); }
}

// ─── Auxiliares para orquestar biblioteca ↔ pestañas del SCW ───────────────

async function verificarCambiosInterno(cid, archivos) {
  const existente = await db.obtenerExpediente(cid);
  if (!existente) return { ok: true, noGuardado: true };
  const hashNuevo = db.calcularHash(archivos);
  const cambio = existente.hash !== hashNuevo;
  const nuevasDetectadas = cambio ? Math.max(0, archivos.length - existente.cantidadActuaciones) : 0;
  const actualizado = await db.actualizarEstadoExpediente(cid, {
    estado: cambio ? 'nuevo' : 'ok',
    nuevasDetectadas,
    fechaVerificacion: new Date().toISOString(),
  });
  return { ok: true, cambio, nuevasDetectadas, expediente: actualizado };
}

// Busca una pestaña ya abierta en ese expediente; si no hay, crea una nueva
// (inactiva) y espera a que cargue + a que content.js se registre.
async function obtenerTabExpediente(cid) {
  const urlExp = 'https://scw.pjn.gov.ar/scw/expediente.seam?cid=' + cid;
  const tabs = await chrome.tabs.query({ url: 'https://scw.pjn.gov.ar/scw/expediente.seam*' });
  let tab = tabs.find(t => (t.url || '').includes('cid=' + cid));
  if (tab) return { tab, creado: false };

  tab = await chrome.tabs.create({ url: urlExp, active: false });
  await esperarCargaCompleta(tab.id);
  await new Promise(r => setTimeout(r, 1500)); // margen para que content.js se registre
  return { tab, creado: true };
}

function esperarCargaCompleta(tabId) {
  return new Promise(resolve => {
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function sendMessageATab(tabId, msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, msg, resp => {
      if (chrome.runtime.lastError) resolve(null); else resolve(resp);
    });
  });
}

function sanitizarNombre(texto) {
  return String(texto || 'Expediente').replace(/[/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function base64ABytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
