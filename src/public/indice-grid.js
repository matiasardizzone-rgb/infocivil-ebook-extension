// Arma la grilla del índice hipervinculado y maneja "Copiar"/"Abrir" por
// tarjeta. Página real de la extensión (no un blob: con HTML armado a
// mano) — un blob: hereda la política de seguridad de la extensión mismo,
// pero NO cuenta como mismo origen para cargar ni ejecutar scripts de la
// extensión (ni en línea ni por <script src>), así que la única forma
// confiable de tener botones con JS acá es una página bundleada de
// verdad, como esta. Los datos (título + lista de actuaciones) viajan por
// chrome.storage.local — se escriben justo antes de abrir esta
// pestaña (ver inicio.js) y se leen acá al cargar.
// Una pestaña abierta con window.open() (en vez de chrome.tabs.create) a
// veces arranca su script antes de que chrome.storage esté disponible del
// todo — una carrera breve, se resuelve sola en milisegundos. Reintenta
// unas pocas veces en vez de asumir que ya está listo apenas carga.
function conStorageListo(intentos, cb) {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) { cb(); return; }
  if (intentos <= 0) { document.getElementById('titulo').textContent = 'No se pudo leer el índice (no cargó a tiempo). Cerrá esta pestaña y volvé a generarlo.'; return; }
  setTimeout(() => conStorageListo(intentos - 1, cb), 100);
}

conStorageListo(20, () => chrome.storage.local.get('indiceGrid', (res) => {
  const datos = res && res.indiceGrid;
  chrome.storage.local.remove('indiceGrid'); // ya lo tenemos, no hace falta dejarlo guardado
  if (!datos) {
    document.getElementById('titulo').textContent = 'No se encontraron datos para este índice.';
    return;
  }
  document.title = 'Índice — ' + datos.titulo;
  document.getElementById('titulo').textContent = datos.titulo;
  document.getElementById('sub').textContent = 'Índice de actuaciones (' + datos.entradas.length + ')';
  document.getElementById('aviso').textContent = 'Generado ' + datos.generado + ' · copia de trabajo, sin validez de firma electrónica';

  const grilla = document.getElementById('grilla');
  datos.entradas.forEach(e => {
    const tarjeta = document.createElement('div');
    tarjeta.className = 'tarjeta';

    const titulo = document.createElement('div');
    titulo.className = 'titulo';
    titulo.textContent = e.numLabel + '. ' + e.tituloCorto;
    tarjeta.appendChild(titulo);

    if (e.fecha) {
      const fecha = document.createElement('div');
      fecha.className = 'fecha';
      fecha.textContent = e.fecha;
      tarjeta.appendChild(fecha);
    }

    if (e.url) {
      const botones = document.createElement('div');
      botones.className = 'botones';

      const btnCopiar = document.createElement('button');
      btnCopiar.className = 'btn-copiar';
      btnCopiar.textContent = '📋 Copiar';
      btnCopiar.addEventListener('click', () => {
        navigator.clipboard.writeText(e.url).then(() => {
          const t = btnCopiar.textContent;
          btnCopiar.textContent = '✓ Copiado';
          btnCopiar.classList.add('copiado');
          setTimeout(() => { btnCopiar.textContent = t; btnCopiar.classList.remove('copiado'); }, 1400);
        });
      });
      botones.appendChild(btnCopiar);

      const btnAbrir = document.createElement('a');
      btnAbrir.className = 'btn-abrir';
      btnAbrir.href = e.url;
      btnAbrir.target = '_blank';
      btnAbrir.rel = 'noopener';
      btnAbrir.textContent = '↗ Abrir';
      botones.appendChild(btnAbrir);

      tarjeta.appendChild(botones);
    }

    grilla.appendChild(tarjeta);
  });
}));
