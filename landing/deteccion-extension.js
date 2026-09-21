// deteccion-extension.js — Para la landing de Infocivil (script clásico, sin módulos).
//
// Prueba una lista de ids en orden y se queda con el primero que responde
// al ping. Así la misma landing sirve en las dos etapas sin tocar código:
//   - hoy (desarrollo): solo responde el id fijo de "Cargar descomprimida"
//   - cuando se publique: responde el id que asigne la Chrome Web Store
// Si un operador tiene las dos instaladas (típico en SYTEC), gana la de la Store.
//
// Uso:
//   InfocivilExtension.detectar().then(ext => {
//     if (!ext) { mostrarInvitacionAInstalar(); return; }
//     console.log('Extensión', ext.id, 'versión', ext.version);
//     ext.enviar({ action: 'buscarYAbrir', jurisdiccion, numero, anio });
//   });

(function (global) {
  var IDS_CANDIDATOS = [
    // null,  // ← id de la Chrome Web Store, completar cuando exista
    'blbghgllddeiignhkclocamalkblagbi' // desarrollo (clave fija del manifest)
  ].filter(Boolean);

  var URL_INSTALACION = null; // link no listado de la Store, cuando exista

  var TIMEOUT_MS = 1500;

  function enviarA(id, mensaje, timeoutMs) {
    return new Promise(function (resolve) {
      var terminado = false;
      var t = setTimeout(function () { terminado = true; resolve(null); }, timeoutMs || TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(id, mensaje, function (resp) {
          if (terminado) return;
          clearTimeout(t);
          // lastError = no instalada, deshabilitada, o este origen no está
          // en su externally_connectable. Para la landing es lo mismo.
          resolve(chrome.runtime.lastError ? null : resp || null);
        });
      } catch (e) {
        clearTimeout(t);
        resolve(null);
      }
    });
  }

  function detectar() {
    // window.chrome.runtime solo aparece en una página web si al menos una
    // extensión instalada declara este origen en externally_connectable.
    if (!global.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      return Promise.resolve(null);
    }
    return Promise.all(IDS_CANDIDATOS.map(function (id) {
      return enviarA(id, { action: 'ping' });
    })).then(function (respuestas) {
      for (var i = 0; i < respuestas.length; i++) {
        var r = respuestas[i];
        if (r && r.ok) {
          var id = IDS_CANDIDATOS[i];
          return {
            id: id,
            version: r.version,
            acciones: r.acciones || [],
            enviar: function (msg, timeoutMs) { return enviarA(id, msg, timeoutMs || 120000); }
          };
        }
      }
      return null;
    });
  }

  global.InfocivilExtension = { detectar: detectar, URL_INSTALACION: URL_INSTALACION };
})(window);
