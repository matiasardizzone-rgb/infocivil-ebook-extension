#!/usr/bin/env node
// empaquetar-store.mjs — Arma el ZIP para subir a la Chrome Web Store.
//
// El manifest.json del repo es el de DESARROLLO: trae "key" (id fijo en
// modo "Cargar descomprimida") y el origen de prueba en
// externally_connectable. Este script genera una copia en dist/store/ con:
//   - "key" eliminado (la Store no lo acepta en el paquete: asigna su propio id)
//   - orígenes de desarrollo quitados de externally_connectable
//   - archivos que no van en el producto excluidos (scripts, docs, .pem, .git)
// y la comprime en dist/infocivil-ebook-<versión>.zip.
//
// Sin dependencias. Uso:  node scripts/empaquetar-store.mjs
// En Windows usa tar.exe (incluido desde Windows 10): Compress-Archive de
// PowerShell 5.1 guarda rutas con "\" y la Store rechaza esos ZIP.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(RAIZ, 'dist');
const DESTINO = path.join(DIST, 'store');

// Orígenes que solo existen en desarrollo. Si se agrega otro servidor de
// prueba al manifest, sumarlo acá también.
const ORIGENES_DEV = ['*://10.5.1.224/*'];

const EXCLUIR = new Set(['.git', '.gitignore', 'dist', 'scripts', 'docs', 'landing', 'node_modules', 'README.md', '.vscode']);
const EXCLUIR_EXT = ['.pem', '.map', '.md'];

function fallar(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

function copiar(origen, destino) {
  for (const entrada of fs.readdirSync(origen, { withFileTypes: true })) {
    if (EXCLUIR.has(entrada.name)) continue;
    const o = path.join(origen, entrada.name);
    const d = path.join(destino, entrada.name);
    if (entrada.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copiar(o, d);
    } else if (!EXCLUIR_EXT.some(ext => entrada.name.endsWith(ext)) || /^(LICENSE|LICENCIAS)/i.test(entrada.name)) {
      fs.copyFileSync(o, d);
    }
  }
}

// ─── 1. Manifest de producción ────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(RAIZ, 'manifest.json'), 'utf8'));
delete manifest.key;

const ec = manifest.externally_connectable;
if (ec && Array.isArray(ec.matches)) {
  ec.matches = ec.matches.filter(p => !ORIGENES_DEV.includes(p));
  if (!ec.matches.length) {
    fallar('externally_connectable quedaría vacío: falta agregar el origen de producción de la landing en manifest.json.');
  }
}

// ─── 2. Copia limpia ──────────────────────────────────────────────────────
fs.rmSync(DESTINO, { recursive: true, force: true });
fs.mkdirSync(DESTINO, { recursive: true });
copiar(RAIZ, DESTINO);
fs.writeFileSync(path.join(DESTINO, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ─── 3. Verificaciones que la Store (o Chrome) rechazaría igual ───────────
const faltantes = [];
const verificar = rel => rel && !fs.existsSync(path.join(DESTINO, rel)) && faltantes.push(rel);
verificar(manifest.background && manifest.background.service_worker);
verificar(manifest.action && manifest.action.default_popup);
Object.values(manifest.icons || {}).forEach(verificar);
(manifest.content_scripts || []).forEach(cs => (cs.js || []).forEach(verificar));
if (manifest.default_locale) verificar(`_locales/${manifest.default_locale}/messages.json`);
if (faltantes.length) fallar('Archivos referenciados en el manifest que no existen:\n  ' + faltantes.join('\n  '));

const restos = [];
(function buscarPem(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) buscarPem(p);
    else if (e.name.endsWith('.pem')) restos.push(p);
  }
})(DESTINO);
if (restos.length) fallar('Hay claves privadas dentro del paquete: ' + restos.join(', '));

// ─── 4. ZIP ───────────────────────────────────────────────────────────────
const zip = path.join(DIST, `infocivil-ebook-${manifest.version}.zip`);
fs.rmSync(zip, { force: true });
try {
  if (process.platform === 'win32') {
    execFileSync('tar.exe', ['-a', '-c', '-f', zip, '*'], { cwd: DESTINO, stdio: 'inherit', shell: true });
  } else {
    execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: DESTINO, stdio: 'inherit' });
  }
} catch (e) {
  fallar('No se pudo comprimir (¿falta "zip" o "tar.exe"?). La carpeta lista está en ' + DESTINO);
}

console.log('✔ Paquete para la Store: ' + path.relative(RAIZ, zip));
console.log('  externally_connectable: ' + JSON.stringify(ec ? ec.matches : []));
