(function () {
  if (window.__pjnListener) {
    chrome.runtime.onMessage.removeListener(window.__pjnListener);
  }
  window.__pjnDescargadorLoaded = true;

  window.__pjnListener = function (message, sender, sendResponse) {
    if (!message) return;

    // ─── Consulta desde la pantalla de inicio de la extensión ───────────
    // background/consulta.js maneja el flujo completo (esta instancia se
    // destruye en cada navegación); acá solo se lee y se actúa sobre la
    // página actual.
    if (message.action === 'estadoPagina') {
      sendResponse(estadoPaginaSCW());
      return false;
    }

    if (message.action === 'completarFormularioBusqueda') {
      (async () => {
        try {
          await completarFormularioBusquedaDOM(message.valorJurisdiccion, message.numero, message.anio);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message || String(e) });
        }
      })();
      return true;
    }

    if (message.action === 'tomarPrimerResultadoBusqueda') {
      sendResponse(tomarPrimerResultadoBusquedaDOM());
      return false;
    }

    if (message.action === 'leerVinculados') {
      (async () => {
        try { sendResponse({ ok: true, ...(await leerVinculadosDOM()) }); }
        catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
      })();
      return true;
    }

    if (message.action === 'abrirVinculado') {
      (async () => {
        try { sendResponse({ ok: true, ...(await abrirVinculadoDOM(message.expediente)) }); }
        catch (e) { sendResponse({ ok: false, error: e.message || String(e) }); }
      })();
      return true;
    }

    if (message.action === 'findPdfs') {
      (async () => {
        try {
          const folderName = obtenerNombreExpediente();
          const archivos   = await recolectarTodosLosDocumentos();
          const resultado  = { ok: true, folderName, total: archivos.length, archivos };
          // Guardar en storage por si el popup se cerró mientras esperaba (tab de históricas)
          chrome.storage.local.set({ pjnFindPdfsResult: resultado });
          sendResponse(resultado);
        } catch (e) {
          console.error('[PJN] Error en findPdfs:', e);
          const error = { ok: false, error: e.message || String(e) };
          chrome.storage.local.set({ pjnFindPdfsResult: error });
          sendResponse(error);
        }
      })();
      return true;
    }

    // Alias liviano de 'findPdfs' para el flujo de PDF unificado: además de
    // 'archivos' (compatibilidad con el resto de la extensión), devuelve
    // 'actuaciones' con fecha/tipo separados y las dos variantes de URL que
    // necesita el unificador (urlPdf para descargar, urlPublica para el pie
    // y el índice — sin el parámetro download=true).
    if (message.action === 'obtenerActuaciones') {
      (async () => {
        try {
          const folderName = obtenerNombreExpediente();
          const tituloExpediente = obtenerCaratula() || folderName;
          const archivos = await recolectarTodosLosDocumentos();
          const actuaciones = archivos.map((a, i) => {
            let urlPdf = a.url ? String(a.url) : '';
            if (urlPdf && urlPdf.indexOf('http') !== 0) urlPdf = 'https://scw.pjn.gov.ar' + urlPdf;
            if (urlPdf.indexOf('/scw/viewer') !== -1 && urlPdf.indexOf('download=true') === -1)
              urlPdf += (urlPdf.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
            const urlPublica = urlPdf.replace(/[&?]download=true/g, '');
            return {
              numero: i + 1,
              titulo: a.titulo || 'documento',
              fecha: a.fecha || '',
              tipo: a.tipo || '',
              descripcion: a.descripcion || '',
              url: urlPdf, urlPdf, urlPublica,
              esHistorica: a.esHistorica || false,
            };
          });

          // Aviso: si el usuario nunca visitó "Actuaciones históricas" para
          // este expediente, esa sección no se cargó — y ahí suele estar
          // el inicio del expediente (demanda, primeras providencias). Sin
          // este aviso el PDF unificado sale "incompleto" en silencio,
          // como pasó con el caso que arrancaba en 2024 en vez de 2021.
          const cid = obtenerCid();
          let historicasFaltantes = false;
          if (cid) {
            const key = 'pjnHistoricas_' + cid;
            const data = await new Promise(res => chrome.storage.local.get(key, res));
            historicasFaltantes = !(key in data);
          }

          // Segundo aviso posible para el mismo síntoma (falta la actuación
          // más vieja): la paginación de actuaciones ACTUALES se cortó por
          // timeout antes de llegar genuinamente al final, en vez de que el
          // expediente realmente no tenga históricas.
          const paginacionIncompleta = !ultimaPaginacionCompleta;

          const resultado = { ok: true, actuaciones, archivos, folderName, tituloExpediente, total: actuaciones.length, historicasFaltantes, paginacionIncompleta };
          chrome.storage.local.set({ pjnFindPdfsResult: resultado });
          sendResponse(resultado);
        } catch (e) {
          console.error('[PJN] Error en obtenerActuaciones:', e);
          const error = { ok: false, error: e.message || String(e) };
          chrome.storage.local.set({ pjnFindPdfsResult: error });
          sendResponse(error);
        }
      })();
      return true;
    }

    if (message.action === 'abrirVisor') {
      (async () => {
        const archivos   = message.archivos || [];
        const folderName = message.folderName || 'Expediente';
        const total      = archivos.length;
        let indice = 1;

        // Preparar lista con URLs sin descargar — el visor carga cada PDF on-demand
        const pdfFiles = archivos.map(archivo => {
          let url = archivo.url ? String(archivo.url) : '';
          if (url && url.indexOf('http') !== 0) url = 'https://scw.pjn.gov.ar' + url;
          if (url && url.indexOf('/scw/viewer') !== -1 && url.indexOf('download=true') === -1)
            url += (url.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
          const urlHiper = url.replace(/[&?]download=true/g, '');
          const numero   = leftPad(indice, 4);
          const basename = numero + ' - ' + sanitizar(archivo.titulo || 'documento') + (archivo.extension || '.pdf');
          indice++;
          return { name: basename, url, urlHiper, esHistorica: archivo.esHistorica || false };
        });

        // Abrir visor inmediatamente con las URLs — sin predescargar nada
        abrirOverlayVisor(folderName, pdfFiles);
        chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados: total, errores: 0, terminado: true }, nextIndex: indice });
      })();
      return false;
    }

    if (message.action === 'crearYDescargarZip') {
      (async () => {
        const archivos   = message.archivos || [];
        const folderName = message.folderName || 'Expediente';
        const total      = archivos.length;
        const zipEntries = [], pdfNames = [];
        let descargados = 0, errores = 0, indice = 1;

        for (let i = 0; i < total; i++) {
          const archivo = archivos[i];
          let url = archivo.url ? String(archivo.url) : '';
          if (!url) { errores++; continue; }
          if (url.indexOf('http') !== 0) url = 'https://scw.pjn.gov.ar' + url;
          if (url.indexOf('/scw/viewer') !== -1 && url.indexOf('download=true') === -1)
            url += (url.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
          const numero   = leftPad(indice, 4);
          const basename = numero + ' - ' + sanitizar(archivo.titulo || 'documento') + (archivo.extension || '.pdf');
          try {
            const buffer = await descargarPDFValidado(url, 30000);
            zipEntries.push({ name: basename, data: new Uint8Array(buffer) });
            pdfNames.push(basename);
            descargados++; indice++;
          } catch (err) { console.warn('[PJN] Descarga descartada (' + basename + '):', err.message); errores++; }
          if (i % 5 === 0 || i === total - 1)
            chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados, errores, terminado: false }, nextIndex: indice });
        }

        const viewerBytes = new TextEncoder().encode(generarViewerHtml(folderName, pdfNames));
        zipEntries.unshift({ name: 'index.html', data: viewerBytes });
        const allEntries = zipEntries.map(e => ({ name: sanitizar(folderName) + '/' + e.name, data: e.data }));
        const zipBlob = buildZip(allEntries);
        const zipUrl  = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = zipUrl; a.download = sanitizar(folderName) + '.zip'; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(zipUrl), 30000);
        chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados, errores, terminado: true }, nextIndex: indice });
      })();
      return false;
    }
    if (message.action === 'guardarEnBiblioteca') {
      (async () => {
        const archivos   = message.archivos || [];
        const folderName = message.folderName || 'Expediente';
        const total      = archivos.length;
        const cid        = obtenerCid();

        if (!cid) {
          chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados: 0, errores: total, terminado: true }, error: 'No se pudo determinar el cid del expediente.' });
          return;
        }

        // Reemplaza cualquier versión previa guardada de este mismo expediente.
        await new Promise(r => chrome.runtime.sendMessage({ action: 'bibliotecaEliminar', cid }, r));
        await new Promise(r => chrome.runtime.sendMessage({
          action: 'bibliotecaIniciar', cid, numero: folderName, folderName,
          caratula: obtenerCaratula(), archivos
        }, r));

        let descargados = 0, errores = 0, indice = 1;
        for (let i = 0; i < total; i++) {
          const archivo = archivos[i];
          let url = archivo.url ? String(archivo.url) : '';
          if (!url) { errores++; continue; }
          if (url.indexOf('http') !== 0) url = 'https://scw.pjn.gov.ar' + url;
          if (url.indexOf('/scw/viewer') !== -1 && url.indexOf('download=true') === -1)
            url += (url.indexOf('?') !== -1 ? '&' : '?') + 'download=true';
          const urlHiper = url.replace(/[&?]download=true/g, '');
          try {
            const buffer = await descargarPDFValidado(url, 30000);
            const bufferB64 = arrayBufferABase64(buffer);
            console.log('[PJN DIAG] doc', indice, '| bytes originales:', buffer.byteLength,
              '| primeros bytes:', new Uint8Array(buffer.slice(0,5)).join(','),
              '| base64 len:', bufferB64.length);
            await new Promise(r => chrome.runtime.sendMessage({
              action: 'bibliotecaGuardarDocumento', cid, indice,
              titulo: archivo.titulo || 'documento',
              esHistorica: archivo.esHistorica || false,
              extension: archivo.extension || '.pdf',
              urlHiper, bufferB64, mime: 'application/pdf'
            }, r));
            descargados++; indice++;
          } catch (err) { console.warn('[PJN] Descarga descartada al guardar en biblioteca (doc ' + indice + '):', err.message); errores++; }
          if (i % 3 === 0 || i === total - 1)
            chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados, errores, terminado: false }, nextIndex: indice });
        }

        await new Promise(r => chrome.runtime.sendMessage({ action: 'bibliotecaFinalizar', cid, archivos }, r));
        chrome.runtime.sendMessage({ action: 'actualizarProgreso', progreso: { total, descargados, errores, terminado: true }, nextIndex: indice });
      })();
      return false;
    }
  };

  chrome.runtime.onMessage.addListener(window.__pjnListener);

  // ─── Recolección completa ─────────────────────────────────────────────────

  // Se setea en cada corrida de recorrerTodasLasPaginas(); permite avisar si
  // la paginación de actuaciones actuales se cortó por timeout en vez de
  // llegar genuinamente al final (ver obtenerActuaciones más abajo).
  let ultimaPaginacionCompleta = true;

  async function recolectarTodosLosDocumentos() {
    const href = window.location.href;
    if (href.includes('actuacionesHistoricas')) {
      const h = await scrapeHistoricasDOMDirecto();
      console.log('[PJN] Históricas DOM:', h.length);
      return h;
    }
    const actuales   = await recorrerTodasLasPaginas();
    const historicas = await fetchHistoricasConPost();
    console.log('[PJN] Actuales:', actuales.length, '| Históricas:', historicas.length);
    return [...historicas, ...actuales];
  }

  // ─── Históricas scraping directo ──────────────────────────────────────────


  async function esperarFilasConLinks(timeoutMs) {
    return new Promise(resolve => {
      const inicio = Date.now();
      const id = setInterval(() => {
        // Salir rápido si la página dice que no hay históricas
        const sinHistoricas = Array.from(document.querySelectorAll('*')).some(el =>
          el.children.length === 0 &&
          (el.textContent || '').toLowerCase().includes('no posee actuaciones hist')
        );
        if (sinHistoricas) {
          console.log('[PJN] Expediente sin actuaciones históricas.');
          clearInterval(id); resolve(); return;
        }
        const filas = document.querySelectorAll('tbody tr');
        const ok = Array.from(filas).some(f => f.querySelector("a[href*='viewer']"));
        if (ok) {
          console.log('[PJN] Tabla de históricas lista con', filas.length, 'filas');
          clearInterval(id); resolve();
        } else if (Date.now() - inicio >= timeoutMs) {
          console.log('[PJN] Timeout esperando tabla históricas');
          clearInterval(id); resolve();
        }
      }, 500);
    });
  }

  async function scrapeHistoricasDOMDirecto() {
    const r = [], u = new Set();
    // Esperar activamente hasta que RichFaces rellene la tabla (hasta 25s)
    console.log('[PJN] Esperando que cargue tabla de históricas...');
    await esperarFilasConLinks(40000);
    let pag = 1;
    while (true) {
      console.log('[PJN] Históricas DOM pág', pag);
      scrapearFilas(document, r, u, true);
      const btn = Array.from(document.querySelectorAll('a,button')).find(el =>
        el.textContent.trim().toLowerCase() === 'siguiente' &&
        !el.disabled && !el.classList.contains('disabled') && !el.classList.contains('ui-state-disabled')
      );
      if (!btn) break;
      const btnId = btn.getAttribute('id') || '';
      const oc = btn.getAttribute('onclick') || '';
      if (!oc) break;
      const contarLinks = () => document.querySelectorAll("tbody a[href*='viewer']").length;
      const linksBefore = contarLinks();
      if (btnId) {
        // Clickear el elemento por ID directamente en MAIN world
        await new Promise(r => {
          chrome.runtime.sendMessage({ action: 'runInPageWorld', code: 'document.getElementById(' + JSON.stringify(btnId) + ')?.click();' }, () => setTimeout(r, 200));
        });
      } else if (oc.includes('RichFaces')) {
        await ejecutarEnPaginaViaBg(oc);
      } else {
        dispararClickReal(btn);
      }
      // Esperar que cambien los links (RichFaces puede no cambiar innerHTML pero sí los hrefs)
      await new Promise(resolve => {
        const inicio = Date.now();
        const id = setInterval(() => {
          if (contarLinks() !== linksBefore || Date.now() - inicio >= 8000) {
            clearInterval(id); resolve();
          }
        }, 300);
      });
      if (contarLinks() === linksBefore) {
        console.warn('[PJN] Históricas: links no cambiaron, deteniendo paginación');
        break;
      }
      pag++;
    }
    return r.reverse();
  }

  // ─── Históricas via tab en segundo plano ─────────────────────────────────────
  // El iframe no funciona porque RichFaces necesita el ciclo completo del navegador.
  // Solución: pedirle al background que abra la página en un tab invisible,
  // la scrapea con el content script que ya existe, y devuelve los datos.

  async function fetchHistoricasConPost() {
    // Leer históricas guardadas desde storage (el usuario navegó manualmente a históricas)
    const cidMatch = window.location.href.match(/cid=(\d+)/);
    if (!cidMatch) return [];
    const cid = cidMatch[1];
    return new Promise(resolve => {
      chrome.storage.local.get('pjnHistoricas_' + cid, function(data) {
        const archivos = data['pjnHistoricas_' + cid] || [];
        console.log('[PJN] Históricas en storage para cid=' + cid + ':', archivos.length);
        resolve(archivos);
      });
    });
  }

  function extraerFormParaSiguiente(doc, urlBase) {
    let btnSig = null;
    for (const el of doc.querySelectorAll('a, input[type="submit"], button, span')) {
      const txt = (el.textContent || el.value || el.getAttribute('title') || '').trim().toLowerCase();
      if (txt === 'siguiente' || txt === 'siguiente >' || txt.startsWith('siguiente')) {
        const disabled = el.disabled || el.classList.contains('disabled') ||
          el.classList.contains('ui-state-disabled') || el.getAttribute('aria-disabled') === 'true';
        if (!disabled) { btnSig = el; break; }
      }
    }
    if (!btnSig) return null;

    const form = btnSig.closest('form') || doc.querySelector('form');
    if (!form) return null;

    const data = new FormData();
    form.querySelectorAll('input[type="hidden"]').forEach(inp => {
      if (inp.name) data.append(inp.name, inp.value || '');
    });
    if (btnSig.tagName === 'INPUT' && btnSig.name) data.append(btnSig.name, btnSig.value || '');
    if (btnSig.tagName === 'A') {
      const onclick = btnSig.getAttribute('onclick') || '';
      const match = onclick.match(/\{([^}]+)\}/);
      if (match) {
        try {
          const pairs = match[1].match(/'([^']+)'\s*:\s*'([^']*)'/g);
          if (pairs) pairs.forEach(pair => {
            const [, k, v] = pair.match(/'([^']+)'\s*:\s*'([^']*)'/) || [];
            if (k) data.append(k, v || '');
          });
        } catch(e) {}
      }
    }
    return data;
  }

  async function fetchHTML(url, method, formData) {
    try {
      const opts = { credentials: 'include', method };
      if (method === 'POST' && formData) opts.body = formData;
      const resp = await fetch(url, opts);
      if (!resp.ok || !resp.url.includes('scw.pjn.gov.ar')) return null;
      return await resp.text();
    } catch (err) { console.error('[PJN] Error fetch:', err.message); return null; }
  }

  function parseHTML(html) { return new DOMParser().parseFromString(html, 'text/html'); }

  // El SCW mete etiquetas de accesibilidad (para lectores de pantalla) como
  // texto plano en varias celdas — quedan pegadas al valor real cuando se
  // lee con textContent/innerText ("Tipo actuacion ESCRITO AGREGADO",
  // "Detalle DR. INGENIERI..."). Sin sacarlas, cualquier texto armado con
  // estos campos (el índice del PDF unificado, por ejemplo) queda ilegible
  // y repite "Fecha"/"Tipo actuacion"/"Detalle" en cada línea.
  function limpiarEtiquetaAccesibilidad(texto) {
    return (texto || '')
      .replace(/^\s*(tipo\s+actuaci[oó]n|detalle|fecha)\s*:?\s*/i, '')
      .trim();
  }

  function scrapearFilas(doc, r, u, esHistorica) {
    doc.querySelectorAll('tbody tr').forEach(fila => {
      const link = fila.querySelector("a[href*='viewer']");
      if (!link) return;
      let url = link.getAttribute('href');
      if (!url) return;
      if (url.indexOf('http') === 0) url = url.replace(/^http:\/\//, 'https://');
      else url = 'https://scw.pjn.gov.ar' + url;
      if (url.includes('/scw/viewer') && !url.includes('download=true'))
        url += (url.includes('?') ? '&' : '?') + 'download=true';
      if (u.has(url)) return;
      u.add(url);
      const c = fila.querySelectorAll('td');
      // Columnas: 0=botones, 1=oficina, 2=fecha, 3=tipo, 4=descripcion, 5=fojas
      const foja  = (c[5]||{}).textContent||'';
      const fecha = limpiarEtiquetaAccesibilidad((c[2]||{}).textContent||'');
      const tipo  = limpiarEtiquetaAccesibilidad((c[3]||{}).textContent||'');
      const desc  = limpiarEtiquetaAccesibilidad((c[4]||{}).textContent||'');
      r.push({
        url,
        titulo: sanitizar(`${foja.trim()} - ${fecha} - ${tipo} - ${desc}`),
        fecha, tipo, descripcion: desc,
        extension: '.pdf',
        esHistorica
      });
    });
  }

  // Fetch con timeout para evitar que un PDF colgado trabe todo
  async function fetchConTimeout(url, opciones, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...opciones, signal: controller.signal });
      clearTimeout(timer);
      return resp;
    } catch(e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // El SCW a veces responde 200 OK con una página HTML (error de sesión,
  // redirect a login, etc.) en vez del PDF pedido — sobre todo si la sesión
  // vence a mitad de una descarga larga. Un fetch "exitoso" (resp.ok) no
  // garantiza que el body sea un PDF real, y guardar esa página HTML como si
  // fuera el documento produce las "actuaciones en blanco" que no se pueden
  // abrir después. Chequeamos la firma %PDF- al inicio del archivo antes de
  // darlo por bueno.
  function esBufferPDFValido(buffer) {
    if (!buffer || buffer.byteLength < 5) return false;
    const firma = new Uint8Array(buffer, 0, 5);
    return firma[0] === 0x25 && firma[1] === 0x50 && firma[2] === 0x44 && firma[3] === 0x46 && firma[4] === 0x2D; // "%PDF-"
  }

  // Descarga un documento validando que el resultado sea un PDF real.
  // Si la primera respuesta no lo es (típicamente sesión vencida), reintenta
  // una vez tras una pequeña espera antes de darlo por error.
  async function descargarPDFValidado(url, timeoutMs) {
    for (let intento = 0; intento < 2; intento++) {
      const resp = await fetchConTimeout(url, { credentials: 'include' }, timeoutMs);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buffer = await resp.arrayBuffer();
      if (esBufferPDFValido(buffer)) return buffer;
      if (intento === 0) await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error('La respuesta no es un PDF válido (posible sesión vencida)');
  }

  // ─── Overlay ──────────────────────────────────────────────────────────────

  function abrirOverlayVisor(folderName, pdfFiles) {
    const existing = document.getElementById('__pjnVisorOverlay');
    if (existing) existing.remove();

    const viewerHtml = generarViewerHtmlConBlobs(folderName, pdfFiles);
    const viewerBlob = new Blob([viewerHtml], { type: 'text/html;charset=utf-8' });
    const viewerUrl  = URL.createObjectURL(viewerBlob);

    const overlay = document.createElement('div');
    overlay.id = '__pjnVisorOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#f0f4f8;display:flex;flex-direction:column';

    const iframe = document.createElement('iframe');
    iframe.src = viewerUrl;
    iframe.style.cssText = 'width:100%;height:100%;border:none';
    // sandbox removido para permitir fetch con credenciales desde el visor

    window.addEventListener('message', function onMsg(e) {
      if (e.data === '__pjnCerrarVisor') {
        overlay.remove();
        URL.revokeObjectURL(viewerUrl);
        pdfFiles.forEach(f => URL.revokeObjectURL(f.blobUrl));
        window.removeEventListener('message', onMsg);
      }
    });

    overlay.appendChild(iframe);
    document.body.appendChild(overlay);
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  function generarViewerHtmlConBlobs(titulo, pdfFiles) {
    const listaJs = JSON.stringify(pdfFiles.map(f => ({
      name: f.name,
      url: f.blobUrl || f.url || '',
      urlHiper: f.urlHiper || '',
      esHistorica: f.esHistorica || false
    })));
    return visorTemplate(titulo, listaJs);
  }

  function generarViewerHtml(titulo, pdfNames) {
    const listaJs = JSON.stringify(pdfNames.map(n => ({ name: n, url: n, urlHiper: '', esHistorica: false })));
    return visorTemplate(titulo, listaJs);
  }

  function visorTemplate(titulo, listaJs) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escHtml(titulo)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --azul-oscuro:#1a3a6b;--azul-medio:#1e5ba8;--azul-claro:#2e80d8;
  --azul-hover:#e8f0fb;--azul-activo:#d0e4f7;--borde:#c8d8ec;
  --fondo:#f0f4f8;--texto:#1a2a3a;--texto-muted:#5a7090;
  --verde:#1a7a4a;--rojo:#c0392b;--hist-badge:#8a6000;--hist-bg:#fffbf0;
}
body{display:flex;height:100vh;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;background:var(--fondo);color:var(--texto)}
#wrap{display:flex;flex-direction:column;height:100%;width:100%}
#header{background:var(--azul-oscuro);color:#fff;display:flex;align-items:center;padding:0 18px;height:52px;flex-shrink:0;gap:14px;border-bottom:3px solid var(--azul-claro)}
#headerLogo{font-size:20px}
#headerTexto .ht{font-size:14px;font-weight:700}
#headerTexto .hs{font-size:10px;color:#a8c4e8;text-transform:uppercase;letter-spacing:.5px}
#headerExpte{margin-left:auto;text-align:right}
#headerExpte .he-num{font-size:13px;font-weight:700;color:#ddeeff}
#headerExpte .he-lbl{font-size:10px;color:#a8c4e8;text-transform:uppercase;letter-spacing:.5px}
#body{display:flex;flex:1;overflow:hidden;min-height:0}
#sidebar{width:280px;min-width:280px;background:#fff;display:flex;flex-direction:column;border-right:1px solid var(--borde)}
#sidebarHead{padding:12px 14px 10px;border-bottom:1px solid var(--borde);background:#f7f9fc}
.sh-label{font-size:10px;color:var(--azul-medio);font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px}
.sh-stats{font-size:11px;color:var(--texto-muted)}
#toc{overflow-y:auto;flex:1;padding:4px 0}
#toc::-webkit-scrollbar{width:4px}
#toc::-webkit-scrollbar-thumb{background:var(--borde);border-radius:2px}
.toc-sep{padding:5px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;border-bottom:1px solid var(--borde);border-top:1px solid var(--borde)}
.toc-sep.act{color:var(--azul-claro);background:#f0f6ff}
.toc-sep.hist{color:var(--hist-badge);background:#fffbf0;border-color:#e8d080}
.toc-item{display:flex;align-items:flex-start;gap:8px;padding:8px 14px;font-size:11.5px;cursor:pointer;color:var(--texto-muted);line-height:1.45;transition:background .12s;border-left:3px solid transparent;border-bottom:1px solid #f0f4f8}
.toc-item:hover{background:var(--azul-hover);color:var(--azul-medio)}
.toc-item.active{background:var(--azul-activo);color:var(--azul-oscuro);border-left-color:var(--azul-medio);font-weight:600}
.toc-item.hist{background:var(--hist-bg)}
.toc-item.hist:hover{background:#fff3c0}
.toc-item.hist.active{background:#ffe89a;border-left-color:var(--hist-badge);color:var(--hist-badge)}
.toc-num{color:#fff;font-size:9.5px;font-weight:700;min-width:28px;text-align:center;padding:2px 4px;border-radius:3px;margin-top:1px;flex-shrink:0;background:var(--azul-medio)}
.toc-item.hist .toc-num{background:var(--hist-badge)}
.toc-item.active .toc-num{background:var(--azul-oscuro)}
.toc-item.hist.active .toc-num{background:#5a3d00}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;position:relative}
#toolbar{background:#fff;padding:7px 12px;display:flex;align-items:center;gap:7px;border-bottom:1px solid var(--borde);flex-shrink:0;flex-wrap:wrap;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.tb-group{display:flex;align-items:center;gap:4px}
.tb-sep{width:1px;height:22px;background:var(--borde);margin:0 3px}
.tb-btn{background:#fff;border:1px solid var(--borde);color:var(--azul-medio);padding:5px 11px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500;transition:all .14s;white-space:nowrap}
.tb-btn:hover:not(:disabled){background:var(--azul-hover);border-color:var(--azul-claro);color:var(--azul-oscuro)}
.tb-btn:disabled{opacity:.35;cursor:default}
.tb-btn.danger{border-color:#e8c0bb;color:var(--rojo)}
.tb-btn.danger:hover{background:#fdf0ee;border-color:var(--rojo)}
#docTitle{flex:1;font-size:11.5px;color:var(--texto-muted);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;padding:0 6px}
#pageInfo{font-size:12px;font-weight:600;color:var(--azul-oscuro);white-space:nowrap;min-width:68px;text-align:center;background:#eef4fb;padding:4px 8px;border-radius:4px}
#histBadge{display:none;background:var(--hist-badge);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;white-space:nowrap}
#zoomSel{background:#fff;border:1px solid var(--borde);color:var(--texto);padding:5px 8px;border-radius:4px;font-size:12px;cursor:pointer;outline:none}
#urlBar{background:#f7f9fc;border-top:1px solid var(--borde);padding:5px 14px;display:flex;align-items:center;gap:8px;flex-shrink:0;border-bottom:1px solid var(--borde)}
#urlLabel{font-size:10.5px;color:var(--azul-medio);white-space:nowrap;flex-shrink:0;font-weight:600}
#urlInput{flex:1;background:transparent;border:none;outline:none;color:var(--azul-claro);font-size:11px;font-family:monospace;cursor:text;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#btnCopiar,#btnAbrir{background:#fff;border:1px solid var(--borde);color:var(--texto-muted);padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap;transition:all .14s;flex-shrink:0}
#btnCopiar:hover{border-color:var(--verde);color:var(--verde);background:#f0fbf4}
#btnCopiar.copiado{border-color:var(--verde);color:var(--verde)}
#btnAbrir:hover{border-color:var(--azul-claro);color:var(--azul-medio);background:var(--azul-hover)}
#viewer{flex:1;overflow-y:auto;display:flex;flex-direction:column;align-items:center;padding:20px;gap:12px;background:var(--fondo)}
#viewer::-webkit-scrollbar{width:6px}
#viewer::-webkit-scrollbar-thumb{background:var(--borde);border-radius:3px}
.pdf-page{background:#fff;box-shadow:0 2px 16px rgba(30,91,168,.15);border-radius:2px;position:relative;transition:box-shadow .2s;border:1px solid #dde8f5}
.pdf-page:hover{box-shadow:0 4px 24px rgba(30,91,168,.28)}
.pdf-page.hist-page{border-left:3px solid var(--hist-badge)}
.page-label{position:absolute;bottom:6px;right:10px;font-size:10px;color:#5a7090;background:rgba(240,244,248,.92);padding:2px 7px;border-radius:3px;pointer-events:none;font-family:monospace;border:1px solid var(--borde)}
canvas{display:block}
.pdf-page{position:relative}
.text-layer{position:absolute;top:0;left:0;right:0;bottom:0;overflow:hidden;opacity:0.2;line-height:1;pointer-events:auto}
.text-layer>span{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
::selection{background:rgba(0,0,255,0.3)}
#loading{position:absolute;inset:0;background:rgba(240,244,248,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:50;gap:16px}
#loading.oculto{display:none}
#loadEscudo{font-size:48px;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.94)}}
#loadTitle{font-size:16px;font-weight:700;color:var(--azul-oscuro)}
#loadSub{font-size:12px;color:var(--texto-muted);max-width:400px;text-align:center;word-break:break-word}
#loadBar{width:320px;height:5px;background:var(--borde);border-radius:3px;overflow:hidden}
#loadFill{height:100%;background:linear-gradient(90deg,var(--azul-medio),var(--azul-claro));width:0%;transition:width .3s;border-radius:3px}
#loadPct{font-size:12px;color:var(--azul-medio);font-weight:600}
</style>
</head>
<body>
<div id="wrap">
<div id="header">
  <div id="headerLogo">⚖️</div>
  <div id="headerTexto"><div class="ht">Poder Judicial de la Nación</div><div class="hs">Cámara Nacional de Apelaciones en lo Civil</div></div>
  <div id="headerExpte"><div class="he-lbl">Expediente</div><div class="he-num">${escHtml(titulo)}</div></div>
</div>
<div id="body">
<div id="sidebar">
  <div id="sidebarHead"><div class="sh-label">📋 Tabla de actuaciones</div><div class="sh-stats" id="sidebarStats">Cargando...</div></div>
  <div id="toc"></div>
</div>
<div id="main">
  <div id="toolbar">
    <div class="tb-group">
      <button class="tb-btn" id="bPD">⏮ Ant.</button>
      <button class="tb-btn" id="bP">◀</button>
      <span id="pageInfo">— / —</span>
      <button class="tb-btn" id="bN">▶</button>
      <button class="tb-btn" id="bND">Sig. ⏭</button>
    </div>
    <div class="tb-sep"></div>
    <span id="histBadge">📜 HISTÓRICA</span>
    <span id="docTitle"></span>
    <div class="tb-sep"></div>
    <div class="tb-group">
      <select id="zoomSel">
        <option value="0.75">75%</option><option value="1">100%</option>
        <option value="1.25">125%</option><option value="1.5" selected>150%</option>
        <option value="2">200%</option>
      </select>
      <button class="tb-btn" id="bFit">⟷ Ajustar</button>
    </div>
    <div class="tb-sep"></div>
    <button class="tb-btn danger" id="bCerrar">✕ Cerrar</button>
  </div>
  <div id="urlBar">
    <span id="urlLabel">🔗 Enlace SCW:</span>
    <input id="urlInput" type="text" readonly value="">
    <button id="btnCopiar">📋 Copiar</button>
    <button id="btnAbrir">↗ Abrir</button>
  </div>
  <div id="viewer"></div>
  <div id="loading">
    <div id="loadEscudo">⚖️</div>
    <div id="loadTitle">Cargando expediente</div>
    <div id="loadSub"></div>
    <div id="loadBar"><div id="loadFill"></div></div>
    <div id="loadPct"></div>
  </div>
</div>
</div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
const PDF_LIST=${listaJs};
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let pages=[],docRanges=[],current=0,zoom=1.5,fitW=false;
const viewer=document.getElementById('viewer');
const loadEl=document.getElementById('loading');
const loadFill=document.getElementById('loadFill');
const loadTitle=document.getElementById('loadTitle');
const loadMsg=document.getElementById('loadSub');
const loadPct=document.getElementById('loadPct');
const urlInput=document.getElementById('urlInput');
const btnCopiar=document.getElementById('btnCopiar');
const btnAbrir=document.getElementById('btnAbrir');
const histBadge=document.getElementById('histBadge');

async function init(){
  let prevHist=null;
  PDF_LIST.forEach((f,i)=>{
    const isHist=f.esHistorica===true;
    if(prevHist!==null&&isHist!==prevHist){
      const sep=document.createElement('div');
      sep.className='toc-sep '+(isHist?'hist':'act');
      sep.textContent=isHist?'📜 Actuaciones históricas':'📋 Actuaciones actuales';
      document.getElementById('toc').appendChild(sep);
    }
    prevHist=isHist;
    const d=document.createElement('div');
    d.className='toc-item'+(isHist?' hist':'');d.dataset.i=i;
    const num=document.createElement('span');num.className='toc-num';
    num.textContent=(i+1).toString().padStart(3,'0');
    const txt=document.createElement('span');
    txt.textContent=f.name.replace(/\.pdf$/i,'').replace(/^\d+ - /,'');
    d.appendChild(num);d.appendChild(txt);
    d.addEventListener('click',()=>goDoc(i));
    document.getElementById('toc').appendChild(d);
  });

  const nHist=PDF_LIST.filter(f=>f.esHistorica).length;
  let totalPages=0;

  // Tiempos límite: sin ellos, una actuación cuya descarga o render nunca
  // termina deja el cartel trabado para siempre. Al vencer, esa actuación
  // se muestra con el visor nativo de Chrome (mismo camino que un error).
  const LIMITE_DOCUMENTO_MS=90000, LIMITE_FOJA_MS=45000;
  function conLimite(promesa,ms,que){
    return new Promise(function(ok,mal){
      const t=setTimeout(function(){mal(new Error('Tiempo agotado: '+que));},ms);
      promesa.then(function(v){clearTimeout(t);ok(v);},function(e){clearTimeout(t);mal(e);});
    });
  }

  for(let di=0;di<PDF_LIST.length;di++){
    const f=PDF_LIST[di];
    const pct=Math.round((di/PDF_LIST.length)*100);
    const progreso=(di+1)+' de '+PDF_LIST.length+' documentos';
    loadTitle.textContent='Procesando actuaciones...';
    loadMsg.textContent=f.name.replace(/\.pdf$/i,'').replace(/^\d+ - /,'');
    loadFill.style.width=pct+'%';
    loadPct.textContent=pct+'%  ('+progreso+')';
    const start=pages.length;
    let tarea=null;
    try{
      tarea=pdfjsLib.getDocument({
        url:f.url,isEvalSupported:false,useSystemFonts:true,disableFontFace:false
      });
      const pdf=await conLimite(tarea.promise,LIMITE_DOCUMENTO_MS,'descarga del documento '+(di+1));
      for(let p=1;p<=pdf.numPages;p++){
        if(pdf.numPages>1)loadPct.textContent=pct+'%  ('+progreso+' · foja '+p+' de '+pdf.numPages+')';
        const pg=await conLimite(pdf.getPage(p),LIMITE_FOJA_MS,'foja '+p);
        const {canvas,textLayer}=await conLimite(renderPg(pg,zoom),LIMITE_FOJA_MS,'foja '+p);
        const wrap=document.createElement('div');
        wrap.className='pdf-page'+(f.esHistorica?' hist-page':'');
        const lbl=document.createElement('div');lbl.className='page-label';
        lbl.textContent=(f.esHistorica?'📜 ':'')+'Doc '+(di+1)+' · pág '+p+'/'+pdf.numPages;
        wrap.appendChild(canvas);if(textLayer)wrap.appendChild(textLayer);wrap.appendChild(lbl);
        viewer.appendChild(wrap);
        pages.push({di,p,canvas,wrap,pg});totalPages++;
      }
    }catch(e){
      console.warn('[Infocivil visor] Documento '+(di+1)+' sin render propio:',e&&e.message);
      // No se cancela la descarga colgada (destroy() deja errores internos de
      // PDF.js en la consola); se abandona y se sigue con la próxima.
      if(tarea)tarea.promise.catch(function(){});
      // Si el documento ya había dibujado algunas fojas, se descartan para
      // no mostrarlo a medias: va entero al visor nativo.
      while(pages.length>start){const q=pages.pop();if(q.wrap&&q.wrap.parentNode)q.wrap.parentNode.removeChild(q.wrap);totalPages--;}
      const wrap=document.createElement('div');
      wrap.className='pdf-page'+(f.esHistorica?' hist-page':'');
      wrap.innerHTML='<iframe src="'+(f.urlHiper||f.url)+'" style="width:100%;height:850px;border:none;display:block;"></iframe>';
      viewer.appendChild(wrap);
      pages.push({di,p:1,canvas:null,wrap,pg:null});totalPages++;
    }
    docRanges.push({start,end:pages.length-1,name:f.name,esHistorica:f.esHistorica});
  }

  const nHistF=PDF_LIST.filter(f=>f.esHistorica).length;
  document.getElementById('sidebarStats').textContent=
    PDF_LIST.length+' actuaciones'+(nHistF?' ('+nHistF+' hist.)':'')+' · '+totalPages+' páginas';
  loadFill.style.width='100%';loadPct.textContent='100%';
  setTimeout(()=>loadEl.classList.add('oculto'),300);
  show(0);
}


async function renderPg(pg,scale){
  if(fitW){const b=pg.getViewport({scale:1});scale=Math.max(100,viewer.clientWidth-40)/b.width;}
  const vp=pg.getViewport({scale});
  const c=document.createElement('canvas');c.width=vp.width;c.height=vp.height;
  await pg.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
  // Capa de texto para poder seleccionar y copiar
  let textLayer = null;
  try {
    const textContent = await pg.getTextContent();
    textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    textLayer.style.width = vp.width + 'px';
    textLayer.style.height = vp.height + 'px';
    await pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayer,
      viewport: vp,
      textDivs: []
    }).promise;
  } catch(e) { textLayer = null; }
  return {canvas: c, textLayer};
}
async function reRender(){
  loadEl.classList.remove('oculto');loadTitle.textContent='Recalculando...';
  loadMsg.textContent='';loadFill.style.width='0%';loadPct.textContent='';
  for(let i=0;i<pages.length;i++){
    const p=pages[i];const {canvas:c,textLayer:tl}=await renderPg(p.pg,zoom);
    p.wrap.replaceChild(c,p.canvas);p.canvas=c;
    // Actualizar text layer
    const oldTl=p.wrap.querySelector('.text-layer');
    if(oldTl)p.wrap.removeChild(oldTl);
    if(tl){p.wrap.insertBefore(tl,p.wrap.querySelector('.page-label'));}
    loadFill.style.width=((i/pages.length)*100)+'%';
  }
  loadFill.style.width='100%';setTimeout(()=>loadEl.classList.add('oculto'),200);show(current);
}

function show(idx){
  if(idx<0||idx>=pages.length)return;current=idx;
  pages[idx].wrap.scrollIntoView({behavior:'smooth',block:'start'});
  const di=pages[idx].di;
  document.getElementById('pageInfo').textContent=(idx+1)+' / '+pages.length;
  const f=PDF_LIST[di];
  document.getElementById('docTitle').textContent=f.name.replace(/\\.pdf$/i,'').replace(/^\\d+ - /,'');
  histBadge.style.display=f.esHistorica?'inline-block':'none';
  const url=f.urlHiper||'';urlInput.value=url;urlInput.title=url;
  btnCopiar.disabled=!url;btnAbrir.disabled=!url;
  document.querySelectorAll('.toc-item').forEach((el)=>{
    const elI=parseInt(el.dataset.i);
    el.classList.toggle('active',elI===di);if(elI===di)el.scrollIntoView({block:'nearest'});
  });
  document.getElementById('bP').disabled=idx<=0;
  document.getElementById('bN').disabled=idx>=pages.length-1;
  document.getElementById('bPD').disabled=di<=0;
  document.getElementById('bND').disabled=di>=PDF_LIST.length-1;
}
function goDoc(di){const r=docRanges[di];if(r)show(r.start);}

btnCopiar.addEventListener('click',()=>{
  const url=urlInput.value;if(!url)return;
  navigator.clipboard.writeText(url).then(()=>{
    btnCopiar.textContent='✅ Copiado';btnCopiar.classList.add('copiado');
    setTimeout(()=>{btnCopiar.textContent='📋 Copiar';btnCopiar.classList.remove('copiado');},2000);
  }).catch(()=>{urlInput.select();document.execCommand('copy');
    btnCopiar.textContent='✅ Copiado';setTimeout(()=>{btnCopiar.textContent='📋 Copiar';},2000);
  });
});
btnAbrir.addEventListener('click',()=>{const url=urlInput.value;if(url)window.open(url,'_blank');});
urlInput.addEventListener('click',()=>urlInput.select());
document.getElementById('bP').addEventListener('click',()=>show(current-1));
document.getElementById('bN').addEventListener('click',()=>show(current+1));
document.getElementById('bPD').addEventListener('click',()=>{const di=pages[current].di;if(di>0)goDoc(di-1);});
document.getElementById('bND').addEventListener('click',()=>{const di=pages[current].di;if(di<PDF_LIST.length-1)goDoc(di+1);});
document.getElementById('zoomSel').addEventListener('change',function(){zoom=parseFloat(this.value);fitW=false;reRender();});
document.getElementById('bFit').addEventListener('click',()=>{fitW=true;reRender();});
document.getElementById('bCerrar').addEventListener('click',()=>window.parent.postMessage('__pjnCerrarVisor','*'));
document.addEventListener('keydown',e=>{
  if(e.key==='ArrowRight'||(e.key==='ArrowDown'&&!e.ctrlKey)||e.key==='PageDown')show(current+1);
  else if(e.key==='ArrowLeft'||(e.key==='ArrowUp'&&!e.ctrlKey)||e.key==='PageUp')show(current-1);
  else if(e.ctrlKey&&e.key==='ArrowRight'){const di=pages[current].di;if(di<PDF_LIST.length-1)goDoc(di+1);}
  else if(e.ctrlKey&&e.key==='ArrowLeft'){const di=pages[current].di;if(di>0)goDoc(di-1);}
  else if(e.key==='Home')show(0);else if(e.key==='End')show(pages.length-1);
});
init();
</script>
</body>
</html>`;
  }

  function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

  // ─── Actuaciones actuales ─────────────────────────────────────────────────

  async function recorrerTodasLasPaginas(){
    const r=[],u=new Set();
    ultimaPaginacionCompleta = true;
    await esperar(1500);await irAPrimeraPagina();await esperar(3000);
    let n=obtenerPaginaActual();
    while(true){
      console.log('[PJN] Scrapeando pág',n);
      scrapearPaginaActual(r,u);
      const oc=obtenerOnclickSiguiente();
      if(!oc){console.log('[PJN] Fin actuales. Total:',r.length);break;}
      const h=obtenerHtmlTabla();
      await ejecutarEnPaginaViaBg(oc);
      let cambio = await esperarCambioDOM(h,8000);
      if(!cambio){
        // Puede ser una respuesta lenta puntual de RichFaces, no
        // necesariamente el final real de la paginación — reintentamos una
        // vez con más margen antes de cortar y avisar que quedó incompleta.
        console.warn('[PJN] Timeout pág',n+1,'— reintentando una vez...');
        await ejecutarEnPaginaViaBg(oc);
        cambio = await esperarCambioDOM(h,15000);
        if(!cambio){
          console.warn('[PJN] Timeout definitivo en pág',n+1,'— paginación quedó incompleta.');
          ultimaPaginacionCompleta = false;
          break;
        }
      }
      n++;
    }
    return r.reverse();
  }

  function scrapearPaginaActual(r,u){
    document.querySelectorAll('#expediente\\:action-table tbody tr').forEach(fila=>{
      const link=fila.querySelector("a[href*='viewer']");if(!link)return;
      let url=link.getAttribute('href');if(!url)return;
      if(url.includes('/scw/viewer')&&!url.includes('download=true'))url+=(url.includes('?')?'&':'?')+'download=true';
      if(u.has(url))return;u.add(url);
      // nth-child es 1-based: 3=fecha, 4=tipo, 5=descripcion, 6=fojas
      const fecha = limpiarEtiquetaAccesibilidad(extraerTexto(fila,'td:nth-child(3)'));
      const tipo  = limpiarEtiquetaAccesibilidad(extraerTexto(fila,'td:nth-child(4)'));
      const desc  = limpiarEtiquetaAccesibilidad(extraerTexto(fila,'td:nth-child(5)'));
      r.push({
        url,
        titulo: sanitizar(`${extraerTexto(fila,'td:nth-child(6)')} - ${fecha} - ${tipo} - ${desc}`),
        fecha, tipo, descripcion: desc,
        extension:'.pdf', esHistorica:false
      });
    });
  }

  function dispararClickReal(el){
    el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
    el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    el.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  }

  async function esperarCambioFn(fn, valorAntes, timeoutMs){
    return new Promise(resolve=>{
      const i=Date.now();
      const id=setInterval(()=>{
        if(fn()!==valorAntes){clearInterval(id);resolve();}
        else if(Date.now()-i>=timeoutMs){clearInterval(id);resolve();}
      },300);
    });
  }

  function obtenerPaginaActual(){const a=document.querySelector('li.active');if(a){const n=parseInt(a.textContent.trim(),10);if(!isNaN(n))return n;}return 1;}
  function obtenerOnclickSiguiente(){const li=document.querySelector('li.active');if(!li)return null;const s=li.nextElementSibling;if(!s)return null;const a=s.querySelector('a');const o=a&&a.getAttribute('onclick')||'';return o.includes('RichFaces')?o:null;}
  async function irAPrimeraPagina(){
    if(obtenerPaginaActual()===1)return;
    for(const li of document.querySelectorAll('.pagination li')){
      const a=li.querySelector('a');const o=a&&a.getAttribute('onclick');
      if(li.textContent.trim()==='1'&&o&&o.includes('RichFaces')){const h=obtenerHtmlTabla();await ejecutarEnPaginaViaBg(o);await esperarCambioDOM(h,6000);return;}
    }
  }
  function ejecutarEnPaginaViaBg(c){return new Promise(r=>{chrome.runtime.sendMessage({action:'runInPageWorld',code:c},()=>setTimeout(r,200));});}
  function obtenerHtmlTabla(){const t=document.querySelector('#expediente\\:action-table tbody');return t?t.innerHTML:'';}
  function esperarCambioDOM(h,t){return new Promise(r=>{const i=Date.now();const id=setInterval(()=>{if(obtenerHtmlTabla()!==h){clearInterval(id);r(true);}else if(Date.now()-i>=t){clearInterval(id);r(false);}},300);});}
  function obtenerNombreExpediente(){const m=document.body.innerText.match(/[A-Z]{2,4}\s?\d+\/\d+/);return m?m[0].replace(/\//g,'-'):'Expediente';}
  function obtenerCid(){const m=window.location.href.match(/cid=(\d+)/);return m?m[1]:null;}
  function arrayBufferABase64(buffer){
    // chrome.runtime.sendMessage puede corromper ArrayBuffers grandes;
    // los mandamos como base64 (texto) y se reconstruyen en background.js.
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function obtenerCaratula(){
    // Best-effort: el SCW no siempre expone la carátula con un selector fijo,
    // así que buscamos el patrón de texto típico "Carátula: ..." en la página.
    const texto = document.body.innerText || '';
    const m = texto.match(/Car[aá]tula\s*:?\s*(.+)/i);
    if (m && m[1]) return m[1].split('\n')[0].trim().slice(0, 160);
    return '';
  }
  function extraerTexto(fila,sel){const el=fila.querySelector(sel);return el?el.innerText.trim():'';}
  function sanitizar(texto){return texto.replace(/[/\\?%*:|"<>]/g,' ').replace(/\s+/g,' ').trim();}
  function leftPad(n,w){let s=String(n);while(s.length<w)s='0'+s;return s;}
  function esperar(ms){return new Promise(r=>setTimeout(r,ms));}

  // ─── Búsqueda en la Consulta Pública (home.seam) ──────────────────────────
  // Selectores confirmados contra el HTML real de home.seam por el Portable
  // (src/scw/buscarExpediente.js). El value del <select> es un código
  // numérico (0=CSJ, 1=CIV, ...), no la sigla.
  //
  // Un cid= en la URL NO alcanza para dar por encontrado el expediente: el
  // SCW agrega cid= a casi todas sus páginas, incluida home.seam. Igual que
  // en el Portable, se confirma por contenido: "Carátula" en el texto o la
  // tabla de actuaciones presente.
  function estadoPaginaSCW() {
    const texto = (document.body && document.body.innerText) || '';
    const enHome = !!document.querySelector('input[name="formPublica:buscarPorNumeroButton"]');
    // Antes exigía además "Carátula" en el texto o la tabla de
    // actuaciones presente — visto contra el sitio real: el SCW navega
    // bien al expediente tecleado, pero esa condición extra se queda en
    // false (el texto o la tabla tardan en aparecer, o no calzan exacto)
    // y la extensión espera algo que ya pasó, sin límite. La URL de
    // expediente.seam con un cid numérico alcanza — ese patrón no se da
    // en ningún otro lugar del sitio (a diferencia de home.seam, que sí
    // puede traer un cid propio de sesión).
    const esExpediente = /\/expediente\.seam$/.test(location.pathname) && !!obtenerCid();
    const linksResultados = enHome || esExpediente ? 0 :
      document.querySelectorAll('a[href*="expediente.seam?cid="]').length;
    // Mensajes que el SCW muestra en la propia página (p. ej. "no se
    // encontraron resultados"): PrimeFaces/RichFaces los pone en estos
    // contenedores. Se devuelven tal cual para mostrarlos al operador.
    const mensajes = Array.from(document.querySelectorAll('.ui-messages, .ui-message, .rf-msgs, .rf-msg, .alert, .error'))
      .map(el => (el.innerText || '').trim()).filter(Boolean).join(' · ').slice(0, 300);
    return {
      ok: true, url: location.href, cid: obtenerCid(), enHome, esExpediente, linksResultados, mensajes,
      caratula: esExpediente ? (obtenerCaratula() || '') : '',
      textoInicio: texto.replace(/\s+/g, ' ').slice(0, 300),
    };
  }

  async function completarFormularioBusquedaDOM(valorJurisdiccion, numero, anio) {
    const sel = document.querySelector('select[name="formPublica:camaraNumAni"]');
    const inpNumero = document.querySelector('input[name="formPublica:numero"]');
    const inpAnio = document.querySelector('input[name="formPublica:anio"]');
    const boton = document.querySelector('input[name="formPublica:buscarPorNumeroButton"]');
    if (!sel || !inpNumero || !inpAnio || !boton) {
      throw new Error('No se encontró el formulario de Consulta Pública (¿cambió el HTML de home.seam?).');
    }
    sel.value = String(valorJurisdiccion);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    // 150ms no alcanzaba: si el <select> dispara un postback AJAX propio
    // (típico en formularios JSF — el value=camaraNumAni sugiere que puede
    // recalcular algo dependiente de la jurisdicción), un humano tarda
    // naturalmente más que eso en escribir número y año, dándole tiempo a
    // terminar. Automatizado, 150ms no le dejaba margen: se probó contra
    // un simulador que nunca tuvo ese comportamiento, así que nunca se
    // hubiera detectado ahí.
    await esperar(1200);
    inpNumero.value = String(numero);
    inpNumero.dispatchEvent(new Event('input', { bubbles: true }));
    inpAnio.value = String(anio);
    inpAnio.dispatchEvent(new Event('input', { bubbles: true }));
    // Mismo margen antes de tocar "Consultar": si escribir el número o el
    // año también dispara algo (menos probable, pero barato de cubrir).
    await esperar(500);
    // El botón dispara jsf.util.chain(...) → mojarra.jsfcljs(...), un submit
    // real de formulario: se ejecuta su onclick en el mundo de la página
    // (mismo mecanismo que la paginación de históricas).
    const onclick = boton.getAttribute('onclick') || '';
    if (onclick) await ejecutarEnPaginaViaBg(onclick);
    else dispararClickReal(boton);
  }

  // ─── Vinculados / incidentes ────────────────────────────────────────────
  // Portado de vinculados.js del Portable (versión Playwright, probada
  // contra el SCW real; "playwright-reference" en el paquete fusionado
  // resultó ser una copia literal, nunca se portó a DOM de verdad).
  // Selectores verificados por el Portable sobre el HTML real de la solapa
  // abierta — no confirmados de nuevo acá.
  const SELECTOR_TABLA_VINCULADOS = '#expediente\\:connectedTable';
  const SELECTOR_CONTENIDO_VINCULADOS = '#expediente\\:vinculadosTab';

  // Normaliza "CIV 013719/2023/1" y "CIV 13719/2023/1" a la misma clave.
  function claveExpediente(texto) {
    const m = (texto || '').match(/([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/i);
    if (!m) return null;
    return m[1].toUpperCase() + '|' + Number(m[2]) + '|' + m[3] + '|' + Number(m[4]);
  }
  function contieneClave(texto, clave) {
    const re = /([A-Z]{2,4})\s*0*(\d+)\/(\d{4})\/(\d+)/gi;
    let m;
    while ((m = re.exec(texto || '')) !== null) {
      if (m[1].toUpperCase() + '|' + Number(m[2]) + '|' + m[3] + '|' + Number(m[4]) === clave) return true;
    }
    return false;
  }

  function abrirSolapaVinculados() {
    // RichFaces engancha el manejador por JS, no por atributo onclick — clic
    // real (mousedown/up/click), no ejecutar código.
    const etiquetas = Array.from(document.querySelectorAll('.rf-tab-lbl'))
      .filter(el => (el.textContent || '').trim() === 'Vinculados');
    for (const el of etiquetas) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) { dispararClickReal(el); return true; }
    }
    return false;
  }

  function leerFilasVinculados() {
    const tabla = document.querySelector(SELECTOR_TABLA_VINCULADOS);
    const filas = tabla ? Array.from(tabla.querySelectorAll('tbody tr')) : [];
    const salida = [];
    for (const fila of filas) {
      const celdas = Array.from(fila.querySelectorAll('td')).map(c => (c.innerText || '').trim());
      if (!celdas.length) continue;
      const expediente = (celdas[0] || '').replace(/\s+/g, ' ').trim();
      if (!/\d+\/\d{4}\/\d+/.test(expediente)) continue;
      salida.push({
        expediente, dependencia: celdas[1] || '', situacion: celdas[2] || '',
        caratula: celdas[3] || '', ultimaActuacion: celdas[4] || '',
      });
    }
    return salida;
  }

  // { vinculados: [...], estado: 'ok'|'sin-vinculados'|'no-disponible' }
  async function leerVinculadosDOM() {
    if (!abrirSolapaVinculados()) return { vinculados: [], estado: 'no-disponible' };

    // El contenido llega por AJAX recién al abrir la solapa.
    const inicioEspera = Date.now();
    while (!document.querySelector(SELECTOR_CONTENIDO_VINCULADOS) && Date.now() - inicioEspera < 12000) {
      await esperar(300);
    }

    const inicio = Date.now();
    while (Date.now() - inicio < 12000) {
      const filas = leerFilasVinculados();
      if (filas.length) return { vinculados: filas, estado: 'ok' };
      const texto = (document.body && document.body.innerText) || '';
      if (/total de 0 vinculado/i.test(texto) || /no se (han )?encontr/i.test(texto)) {
        return { vinculados: [], estado: 'sin-vinculados' };
      }
      await esperar(400);
    }
    return { vinculados: [], estado: 'sin-vinculados' };
  }

  // { cid: '...' } — expediente: ej. 'CIV 013719/2023/1' (los ceros no importan).
  async function abrirVinculadoDOM(expediente) {
    const clave = claveExpediente(expediente);
    if (!clave) throw new Error('No se entiende el expediente "' + expediente + '".');

    // La solapa puede no estar abierta: si esta pestaña navegó de vuelta
    // desde actuacionesHistoricas.seam después de haberla leído la primera
    // vez (para leer históricas, por ejemplo), la vuelta recarga la
    // página entera y la borra — no alcanza con haberla abierto una vez
    // antes en la vida de esta pestaña.
    if (!document.querySelector(SELECTOR_TABLA_VINCULADOS + ' tbody tr')) {
      const leido = await leerVinculadosDOM();
      if (leido.estado !== 'ok') {
        throw new Error('No se encontró el vinculado ' + expediente +
          ' (no se pudo abrir la solapa "Vinculados": ' + leido.estado + ').');
      }
    }

    const filas = Array.from(document.querySelectorAll(SELECTOR_TABLA_VINCULADOS + ' tbody tr'));
    let objetivo = null;
    for (const fila of filas) {
      if (claveExpediente(fila.innerText) === clave) { objetivo = fila; break; }
    }
    if (!objetivo) throw new Error('No se encontró el vinculado ' + expediente + ' en la lista.');

    const boton = objetivo.querySelector('a.btn, a[onclick]');
    if (!boton) throw new Error('No se encontró el botón para abrir ' + expediente + '.');

    // Clic real no alcanza: el onclick hace un submit de formulario JSF
    // (mojarra.jsfcljs) — se ejecuta ese código en la página, mismo
    // mecanismo que el botón "Consultar" de home.seam.
    const urlAntes = location.href;
    const onclick = boton.getAttribute('onclick') || '';
    if (onclick) await ejecutarEnPaginaViaBg(onclick);
    else dispararClickReal(boton);

    const inicio = Date.now();
    while (Date.now() - inicio < 25000) {
      const m = location.href.match(/cid=(\d+)/);
      const texto = (document.body && document.body.innerText) || '';
      if (m && texto.length > 200 && contieneClave(texto, clave)) return { cid: m[1] };
      await esperar(400);
    }
    throw new Error('No se pudo abrir ' + expediente + ': el sitio no terminó de cargarlo' +
      (location.href === urlAntes ? ' (la página no cambió).' : '.'));
  }

  // Página intermedia de resultados (sin confirmar si el SCW la muestra
  // cuando hay un único resultado): se abre el primer expediente.
  function tomarPrimerResultadoBusquedaDOM() {
    const links = Array.from(document.querySelectorAll('a[href*="expediente.seam?cid="]'));
    if (!links.length) return { ok: false, error: 'No hay resultados en esta página.' };
    const link = links[0];
    const href = link.getAttribute('href') || '';
    const onclick = link.getAttribute('onclick') || '';
    if (onclick) ejecutarEnPaginaViaBg(onclick);
    else if (href && href !== '#') location.href = href.indexOf('http') === 0 ? href : 'https://scw.pjn.gov.ar' + href;
    else dispararClickReal(link);
    return { ok: true, multiplesResultados: links.length > 1 };
  }

  // ─── ZIP builder ──────────────────────────────────────────────────────────
  function buildZip(files){
    const lp=[],cd=[];let off=0;
    const now=new Date();
    const dt=((now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1))>>>0;
    const dd=((((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate()))>>>0;
    for(const f of files){
      const nb=new TextEncoder().encode(f.name),crc=crc32(f.data),sz=f.data.length;
      const lh=new Uint8Array(30+nb.length);const lv=new DataView(lh.buffer);
      lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0,true);lv.setUint16(8,0,true);
      lv.setUint16(10,dt,true);lv.setUint16(12,dd,true);lv.setUint32(14,crc,true);
      lv.setUint32(18,sz,true);lv.setUint32(22,sz,true);lv.setUint16(26,nb.length,true);lv.setUint16(28,0,true);
      lh.set(nb,30);lp.push(lh,f.data);
      const ce=new Uint8Array(46+nb.length);const cv=new DataView(ce.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0,true);
      cv.setUint16(10,0,true);cv.setUint16(12,dt,true);cv.setUint16(14,dd,true);cv.setUint32(16,crc,true);
      cv.setUint32(20,sz,true);cv.setUint32(24,sz,true);cv.setUint16(28,nb.length,true);
      cv.setUint16(30,0,true);cv.setUint16(32,0,true);cv.setUint16(34,0,true);cv.setUint16(36,0,true);
      cv.setUint32(38,0,true);cv.setUint32(42,off,true);ce.set(nb,46);
      cd.push(ce);off+=lh.length+sz;
    }
    const cds=cd.reduce((s,c)=>s+c.length,0);
    const eo=new Uint8Array(22);const ev=new DataView(eo.buffer);
    ev.setUint32(0,0x06054b50,true);ev.setUint16(4,0,true);ev.setUint16(6,0,true);
    ev.setUint16(8,files.length,true);ev.setUint16(10,files.length,true);
    ev.setUint32(12,cds,true);ev.setUint32(16,off,true);ev.setUint16(20,0,true);
    return new Blob([...lp,...cd,eo],{type:'application/zip'});
  }
  function crc32(d){
    if(!crc32.t){crc32.t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);crc32.t[i]=c;}}
    let c=0xFFFFFFFF;for(let i=0;i<d.length;i++)c=crc32.t[(c^d[i])&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;
  }

  // ─── Auto-scraping en página de históricas ────────────────────────────────
  // Cuando el background abre este tab, el content script corre automáticamente
  // y guarda los resultados en storage (evita el timeout del canal de mensajes).
  if (window.location.href.includes('actuacionesHistoricas')) {
    (async () => {
      try {
        console.log('[PJN] Auto-scraping históricas...');

        const archivos = await scrapeHistoricasDOMDirecto();
        const archivosHist = archivos.map(a => ({ ...a, esHistorica: true }));

        // Obtener cid de la URL — en históricas puede no estar como parámetro
        // sino embebido en el link "Volver al expediente"
        let cid = '0';
        const cidUrl = window.location.href.match(/cid=(\d+)/);
        if (cidUrl) {
          cid = cidUrl[1];
        } else {
          // Buscar en el link "Volver al expediente"
          const linkVolver = Array.from(document.querySelectorAll('a')).find(a =>
            (a.textContent || '').toLowerCase().includes('volver') &&
            (a.getAttribute('href') || '').includes('cid=')
          );
          if (linkVolver) {
            const m = (linkVolver.getAttribute('href') || '').match(/cid=(\d+)/);
            if (m) cid = m[1];
          }
          // Fallback: buscar en cualquier link del DOM
          if (cid === '0') {
            const anyLink = Array.from(document.querySelectorAll('a[href*="cid="]'))
              .find(a => (a.getAttribute('href') || '').match(/cid=\d+/));
            if (anyLink) {
              const m = (anyLink.getAttribute('href') || '').match(/cid=(\d+)/);
              if (m) cid = m[1];
            }
          }
        }

        console.log('[PJN] Guardando', archivosHist.length, 'históricas para cid=' + cid);
        const storageData = {};
        storageData['pjnHistoricas_' + cid] = archivosHist;
        chrome.storage.local.set(storageData);
      } catch (e) {
        console.error('[PJN] Error auto-scraping históricas:', e);
        chrome.storage.local.set({ pjnHistoricasResult: { ok: false, error: e.message } });
      }
    })();
  }

})();
