# PJN Descargador

Extensión de Chrome (Manifest V3) para el **Sistema de Consulta Web (SCW)** del
Poder Judicial de la Nación (scw.pjn.gov.ar). Permite:

- Detectar y navegar todas las actuaciones de un expediente (incluye
  paginación sin botones numerados y actuaciones históricas).
- Descargar los documentos en un ZIP.
- Ver el expediente como "libro" con un visor PDF.js integrado (TOC,
  zoom, barra de URL del documento).
- Verificar la firma electrónica embebida en los PDF contra la cadena de
  certificación del PJN (`firma.js`).
- Guardar expedientes en una biblioteca local (IndexedDB vía `db.js`) y
  detectar actuaciones nuevas respecto de la última descarga.

## Estructura

| Archivo | Rol |
|---|---|
| `manifest.json` | Manifest V3 de la extensión |
| `content.js` | Corre en scw.pjn.gov.ar: scraping de actuaciones, paginación, históricas |
| `background.js` | Service worker: mensajería, orquestación de descargas |
| `popup.html` / `popup.js` | UI del popup de la extensión |
| `biblioteca.html` / `biblioteca.js` | Vista de biblioteca de expedientes guardados |
| `db.js` | Capa de persistencia (IndexedDB) |
| `firma.js` | Verificación de certificados de firma electrónica (forge) |
| `pjn_visor_libro_prototipo.html` | Prototipo del visor "libro" |
| `pdf_min.js` / `pdf_worker_min.js` | PDF.js (vendored) |
| `forge_min.js` | node-forge (vendored) para verificación de firmas |

## Estado / pendientes

- Scraping de `actuacionesHistoricas.seam`: el fetch por `cid` no siempre
  trae la página real (a veces devuelve HTML de sesión en vez del PDF),
  por lo que algunos documentos históricos pueden quedar en blanco.

## Alcance de la verificación de firma (`firma.js`)

Verifica que el certificado del firmante encadene contra la Autoridad
Certificante del PJN y esté dentro de su período de validez. **No** verifica
integridad criptográfica completa (CMS/PKCS#7 sobre ByteRange) ni revocación
— para esa garantía completa, usar Adobe Reader con los certificados del PJN
importados.
