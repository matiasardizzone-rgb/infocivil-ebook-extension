// pdf_lib.esm.js — wrapper ESM sobre pdf_lib.min.js (build UMD de pdf-lib 1.17.1).
// El UMD no expone exports ESM; al evaluarse se limita a colgar todo de
// globalThis.PDFLib (ver el propio pdf_lib.min.js: "(t=t||self).PDFLib={}").
// background.js es un módulo ES ("type":"module" en manifest.json), así que
// necesita imports con nombre — de ahí este wrapper de ~10 líneas.
import './pdf_lib.min.js';

const lib = globalThis.PDFLib;

export const PDFDocument   = lib.PDFDocument;
export const StandardFonts = lib.StandardFonts;
export const rgb           = lib.rgb;
export const PDFName       = lib.PDFName;
export const PDFHexString  = lib.PDFHexString;

export default lib;
