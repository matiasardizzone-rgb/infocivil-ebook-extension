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
async function guardarDocumento(doc) {
  const db = await openDB();
  const store = tx(db, STORE_DOCUMENTOS, 'readwrite').objectStore(STORE_DOCUMENTOS);
  return reqToPromise(store.put(doc));
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
// marcador: { cid, page, label, color }
async function guardarMarcador(marcador) {
  const db = await openDB();
  const store = tx(db, STORE_MARCADORES, 'readwrite').objectStore(STORE_MARCADORES);
  // Un marcador por foja: si ya existe uno para (cid, page), lo reemplaza.
  const idx = store.index('cid');
  const existentes = await reqToPromise(idx.getAll(IDBKeyRange.only(marcador.cid)));
  const previo = existentes.find(m => m.page === marcador.page);
  if (previo) marcador.id = previo.id;
  return reqToPromise(store.put(marcador));
}

async function obtenerMarcadores(cid) {
  const db = await openDB();
  const store = tx(db, STORE_MARCADORES, 'readonly').objectStore(STORE_MARCADORES);
  const idx = store.index('cid');
  return reqToPromise(idx.getAll(IDBKeyRange.only(cid)));
}

async function eliminarMarcador(cid, page) {
  const db = await openDB();
  const store = tx(db, STORE_MARCADORES, 'readwrite').objectStore(STORE_MARCADORES);
  const idx = store.index('cid');
  const existentes = await reqToPromise(idx.getAll(IDBKeyRange.only(cid)));
  const previo = existentes.find(m => m.page === page);
  if (previo) await reqToPromise(store.delete(previo.id));
}

export {
  calcularHash,
  guardarExpediente, obtenerExpediente, listarExpedientes,
  actualizarEstadoExpediente, eliminarExpediente,
  guardarDocumento, obtenerDocumentos, contarDocumentos,
  guardarMarcador, obtenerMarcadores, eliminarMarcador,
};
