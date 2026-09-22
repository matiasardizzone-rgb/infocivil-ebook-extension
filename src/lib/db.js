// db.js — Capa de persistencia local (IndexedDB) para PJN Descargador.
// Vive en el origen de la extensión (chrome-extension://<id>), así que tanto
// background.js (service worker) como biblioteca.html pueden abrirla directo,
// sin pasarse los datos por mensajes. Solo content.js (que corre en el origen
// de scw.pjn.gov.ar) necesita enviarle los datos a background.js primero.
//
// Import como módulo ES: import { ... } from './db.js';

const DB_NAME    = 'PJNBiblioteca';
const DB_VERSION = 1;

const STORE_EXPEDIENTES = 'expedientes'; // keyPath: cid
const STORE_DOCUMENTOS  = 'documentos';  // keyPath: id (auto), index: cid
const STORE_MARCADORES  = 'marcadores';  // keyPath: id (auto), index: cid

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(STORE_EXPEDIENTES)) {
        db.createObjectStore(STORE_EXPEDIENTES, { keyPath: 'cid' });
      }

      if (!db.objectStoreNames.contains(STORE_DOCUMENTOS)) {
        const s = db.createObjectStore(STORE_DOCUMENTOS, { keyPath: 'id', autoIncrement: true });
        s.createIndex('cid', 'cid', { unique: false });
        s.createIndex('cid_indice', ['cid', 'indice'], { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_MARCADORES)) {
        const s = db.createObjectStore(STORE_MARCADORES, { keyPath: 'id', autoIncrement: true });
        s.createIndex('cid', 'cid', { unique: false });
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
  return dbPromise;
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Huella para detectar cambios sin comparar documento por documento ─────
// No es criptográfica, solo necesita ser estable y barata (djb2).
function calcularHash(archivos) {
  const base = archivos.map(a => (a.titulo || '') + '|' + (a.extension || '')).join('~');
  let h = 5381;
  for (let i = 0; i < base.length; i++) {
    h = ((h << 5) + h) + base.charCodeAt(i);
    h = h & 0xFFFFFFFF;
  }
  return 'h' + (h >>> 0).toString(36) + '_n' + archivos.length;
}

// ─── Identidad de una actuación ─────────────────────────────────────────
// El link público del SCW (sin download=true) identifica a cada actuación.
// Es la misma normalización que usa scw-content.js al guardar (urlHiper) y
// al armar el PDF unificado (urlPublica), así que los ids coinciden.
function idActuacion(url) {
  let u = url ? String(url) : '';
  if (!u) return '';
  if (u.indexOf('http') !== 0) u = 'https://scw.pjn.gov.ar' + u;
  return u.replace(/[&?]download=true/g, '');
}

// Id de un documento ya guardado. Los guardados sin urlHiper (no debería
// pasar, pero por las dudas) caen a su posición, que no sirve para diffs.
function idDeDocumento(doc) {
  return doc.urlHiper ? idActuacion(doc.urlHiper) : 'indice:' + doc.indice;
}

// ─── Expedientes ────────────────────────────────────────────────────────
async function guardarExpediente(meta) {
  const db = await openDB();
  const store = tx(db, STORE_EXPEDIENTES, 'readwrite').objectStore(STORE_EXPEDIENTES);
  const existente = await reqToPromise(store.get(meta.cid));
  const registro = {
    cid: meta.cid,
    numero: meta.numero || (existente && existente.numero) || meta.cid,
    caratula: meta.caratula || (existente && existente.caratula) || '',
    folderName: meta.folderName || (existente && existente.folderName) || meta.cid,
    cantidadActuaciones: meta.cantidadActuaciones ?? (existente && existente.cantidadActuaciones) ?? 0,
    cantidadFojas: meta.cantidadFojas ?? (existente && existente.cantidadFojas) ?? 0,
    hash: meta.hash || (existente && existente.hash) || '',
    fechaDescarga: meta.fechaDescarga || (existente && existente.fechaDescarga) || new Date().toISOString(),
    fechaVerificacion: meta.fechaVerificacion || new Date().toISOString(),
    estado: meta.estado || 'ok',            // 'ok' | 'nuevo' | 'descargando'
    nuevasDetectadas: meta.nuevasDetectadas ?? 0,
  };
  await reqToPromise(store.put(registro));
  return registro;
}

async function obtenerExpediente(cid) {
  const db = await openDB();
  const store = tx(db, STORE_EXPEDIENTES, 'readonly').objectStore(STORE_EXPEDIENTES);
  return reqToPromise(store.get(cid));
}

async function listarExpedientes() {
  const db = await openDB();
  const store = tx(db, STORE_EXPEDIENTES, 'readonly').objectStore(STORE_EXPEDIENTES);
  const todos = await reqToPromise(store.getAll());
  todos.sort((a, b) => (b.fechaVerificacion || '').localeCompare(a.fechaVerificacion || ''));
  return todos;
}

async function actualizarEstadoExpediente(cid, patch) {
  const db = await openDB();
  const store = tx(db, STORE_EXPEDIENTES, 'readwrite').objectStore(STORE_EXPEDIENTES);
  const actual = await reqToPromise(store.get(cid));
  if (!actual) return null;
  const nuevo = { ...actual, ...patch };
  await reqToPromise(store.put(nuevo));
  return nuevo;
}

async function eliminarExpediente(cid) {
  const db = await openDB();
  const t = tx(db, [STORE_EXPEDIENTES, STORE_DOCUMENTOS, STORE_MARCADORES], 'readwrite');
  t.objectStore(STORE_EXPEDIENTES).delete(cid);
  await borrarPorIndiceCid(t.objectStore(STORE_DOCUMENTOS), cid);
  await borrarPorIndiceCid(t.objectStore(STORE_MARCADORES), cid);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(true);
    t.onerror    = () => reject(t.error);
  });
}

function borrarPorIndiceCid(store, cid) {
  return new Promise((resolve, reject) => {
    const idx = store.index('cid');
    const req = idx.openCursor(IDBKeyRange.only(cid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── Documentos (PDFs como blob) ────────────────────────────────────────
// doc: { cid, indice, titulo, fecha, tipo, esHistorica, extension, urlHiper, blob }
// Si la actuación ya estaba guardada (mismo id), se reemplaza en vez de
// agregar otra copia: sin esto, cada "Actualizar biblioteca" duplicaba
// el expediente entero.
async function guardarDocumento(doc) {
  const db = await openDB();
  const store = tx(db, STORE_DOCUMENTOS, 'readwrite').objectStore(STORE_DOCUMENTOS);
  const idNuevo = idDeDocumento(doc);
  if (idNuevo.indexOf('indice:') !== 0) {
    const existentes = await reqToPromise(store.index('cid').getAll(IDBKeyRange.only(doc.cid)));
    const previo = existentes.find(d => idDeDocumento(d) === idNuevo);
    if (previo) doc.id = previo.id;
  }
  doc.eliminadaEnSCW = false;
  return reqToPromise(store.put(doc));
}

// Marca las actuaciones guardadas que el SCW ya no muestra. No se borran:
// el operador las tenía y puede necesitarlas. Solo se marca si al menos
// una coincide por id (ver la red de seguridad en verificarCambiosInterno).
async function marcarEliminadasEnSCW(cid, idsActuales) {
  const actuales = new Set(idsActuales);
  const db = await openDB();
  const store = tx(db, STORE_DOCUMENTOS, 'readwrite').objectStore(STORE_DOCUMENTOS);
  const docs = await reqToPromise(store.index('cid').getAll(IDBKeyRange.only(cid)));
  const conId = docs.filter(d => idDeDocumento(d).indexOf('indice:') !== 0);
  if (!conId.some(d => actuales.has(idDeDocumento(d)))) return 0;
  let marcadas = 0;
  for (const d of conId) {
    const eliminada = !actuales.has(idDeDocumento(d));
    if (!!d.eliminadaEnSCW !== eliminada) {
      d.eliminadaEnSCW = eliminada;
      await reqToPromise(store.put(d));
    }
    if (eliminada) marcadas++;
  }
  return marcadas;
}

async function obtenerDocumentos(cid) {
  const db = await openDB();
  const store = tx(db, STORE_DOCUMENTOS, 'readonly').objectStore(STORE_DOCUMENTOS);
  const idx = store.index('cid');
  const docs = await reqToPromise(idx.getAll(IDBKeyRange.only(cid)));
  docs.sort((a, b) => a.indice - b.indice);
  return docs;
}

async function contarDocumentos(cid) {
  const db = await openDB();
  const store = tx(db, STORE_DOCUMENTOS, 'readonly').objectStore(STORE_DOCUMENTOS);
  const idx = store.index('cid');
  return reqToPromise(idx.count(IDBKeyRange.only(cid)));
}

// ─── Marcadores libres (banderitas) ─────────────────────────────────────
// Anclados a la actuación, no a la foja absoluta del expediente:
//   { cid, actuacionId, pagina, label, color }
// pagina = foja dentro de esa actuación (0 = la primera). Si se agrega una
// actuación en medio de la cronología, la banderita no se corre.
// Formato viejo (antes de este cambio): { cid, page, label, color }, con
// page = foja absoluta. biblioteca.js los migra al abrir el expediente.
function mismoLugar(a, b) {
  if (a.actuacionId || b.actuacionId) return a.actuacionId === b.actuacionId && a.pagina === b.pagina;
  return a.page === b.page;
}

async function guardarMarcador(marcador) {
  const db = await openDB();
  const store = tx(db, STORE_MARCADORES, 'readwrite').objectStore(STORE_MARCADORES);
  // Un marcador por foja: si ya existe uno en el mismo lugar, lo reemplaza.
  const idx = store.index('cid');
  const existentes = await reqToPromise(idx.getAll(IDBKeyRange.only(marcador.cid)));
  const previo = existentes.find(m => mismoLugar(m, marcador));
  const registro = marcador.actuacionId
    ? { cid: marcador.cid, actuacionId: marcador.actuacionId, pagina: marcador.pagina, label: marcador.label, color: marcador.color }
    : { cid: marcador.cid, page: marcador.page, label: marcador.label, color: marcador.color };
  if (previo) registro.id = previo.id;
  const id = await reqToPromise(store.put(registro));
  return { ...registro, id };
}

async function obtenerMarcadores(cid) {
  const db = await openDB();
  const store = tx(db, STORE_MARCADORES, 'readonly').objectStore(STORE_MARCADORES);
  const idx = store.index('cid');
  return reqToPromise(idx.getAll(IDBKeyRange.only(cid)));
}

// lugar: { actuacionId, pagina } (formato nuevo) o { page } (formato viejo)
async function eliminarMarcador(cid, lugar) {
  const db = await openDB();
  const store = tx(db, STORE_MARCADORES, 'readwrite').objectStore(STORE_MARCADORES);
  const idx = store.index('cid');
  const existentes = await reqToPromise(idx.getAll(IDBKeyRange.only(cid)));
  const previo = existentes.find(m => mismoLugar(m, lugar));
  if (previo) await reqToPromise(store.delete(previo.id));
}

async function eliminarMarcadorPorId(id) {
  const db = await openDB();
  const store = tx(db, STORE_MARCADORES, 'readwrite').objectStore(STORE_MARCADORES);
  await reqToPromise(store.delete(id));
}

// ─── Fusión de duplicados por número de expediente ──────────────────────
// El cid del SCW identifica la CONSULTA, no el expediente: cada búsqueda
// nueva del mismo expediente (sobre todo desde la pantalla de inicio, que
// abre una sesión nueva del SCW cada vez) devuelve un cid distinto, y
// quedaba una tarjeta nueva en la biblioteca por cada búsqueda. Se llama
// al terminar de guardar: si ya existe otro expediente con el mismo
// número pero otro cid, se migran sus banderitas (ancladas por
// actuacionId, no por cid, así que sobreviven el traspaso intactas) y se
// borra el duplicado viejo, dejando una sola tarjeta con los datos recién
// descargados (más completos que los de la vez anterior).
async function fusionarDuplicadosPorNumero(cid, numero) {
  if (!numero) return 0;
  const todos = await listarExpedientes();
  const duplicados = todos.filter(e => e.cid !== cid && e.numero === numero);
  for (const dup of duplicados) {
    const marcadoresViejos = await obtenerMarcadores(dup.cid);
    for (const m of marcadoresViejos) {
      if (m.actuacionId) {
        await guardarMarcador({ cid, actuacionId: m.actuacionId, pagina: m.pagina, label: m.label, color: m.color });
      }
      // Marcadores en formato viejo (por página absoluta, sin actuacionId)
      // no se pueden re-anclar sin el armado del libro de esa sesión: se
      // pierden al fusionar. Son un resabio de antes del anclaje por
      // actuación (ver migrarBanderitasViejas en background/index.js).
    }
    await eliminarExpediente(dup.cid);
  }
  return duplicados.length;
}

export {
  calcularHash, idActuacion, idDeDocumento, fusionarDuplicadosPorNumero,
  guardarExpediente, obtenerExpediente, listarExpedientes,
  actualizarEstadoExpediente, eliminarExpediente,
  guardarDocumento, obtenerDocumentos, contarDocumentos, marcarEliminadasEnSCW,
  guardarMarcador, obtenerMarcadores, eliminarMarcador, eliminarMarcadorPorId,
};
