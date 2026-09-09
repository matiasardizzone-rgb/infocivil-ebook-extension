// unificador.js — arma un único PDF con todas las actuaciones del expediente.
//
// Reglas acordadas (ver CAMBIOS_EN_EL_SCRIPT.md):
//  1. Orden cronológico de más vieja a más actual.
//  2. Índice/portada al principio: cada actuación es un hipervínculo interno
//     (Dest) que salta a su primera página.
//  3. Hipervínculo público visible Y clicable en el pie de TODAS las páginas
//     de cada actuación (para que se pueda extraer con texto plano, no solo
//     como link).
//  4. Sin páginas separadoras entre actuaciones.
//  5. Si una actuación no se pudo descargar, se dibuja una página de error
//     ("ACTUACIÓN NO DISPONIBLE") con el link público visible — nunca se
//     omite en silencio.
//  6. Es una copia de trabajo: al unificar, las firmas electrónicas
//     embebidas de cada PDF original pierden validez criptográfica.
//
// import como módulo ES.

import { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString } from './pdf_lib.esm.js';

const A4 = [595.28, 841.89];
const MARGIN = 50;
const PIE_FONT_SIZE = 6;
const INDICE_FONT_SIZE = 9;
const INDICE_STEP = 16;
const INDICE_START_Y_PORTADA = A4[1] - 185; // deja lugar arriba para título + subtítulo
const INDICE_START_Y_CONT    = A4[1] - 100; // páginas de índice siguientes (sin portada)
const INDICE_MARGIN_INFERIOR = 60;

// ─── Fechas ─────────────────────────────────────────────────────────────
// Soporta dd/mm/yyyy y ISO (yyyy-mm-dd[...]). Devuelve null si no matchea.
function parseFecha(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function fechaDe(actuacion) {
  return parseFecha(actuacion.fecha);
}

// Orden cronológico ascendente. Regla explícita: si a cualquiera de los dos
// elementos comparados le falta fecha válida, se los trata como "iguales"
// (comparator devuelve 0) para que el sort estable conserve el orden
// original entre ellos — nunca se empujan al principio o al final.
function ordenarPorFechaAsc(actuaciones) {
  return actuaciones
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const fx = fechaDe(x.a), fy = fechaDe(y.a);
      if (!fx || !fy) return 0;
      const diff = fx.getTime() - fy.getTime();
      return diff !== 0 ? diff : 0;
    })
    .map(({ a }) => a);
}

// ─── Utilidades PDF ───────────────────────────────────────────────────────

// La fuente estándar (Helvetica) usa codificación WinAnsi: no puede dibujar
// saltos de línea ni caracteres de control (el error típico es
// "WinAnsi cannot encode \n"), y tampoco caracteres fuera de Latin-1
// (emojis, comillas tipográficas, etc.). Los títulos vienen del innerText
// de la tabla del SCW y a veces traen \n adentro de una celda — por eso se
// limpia CUALQUIER texto antes de pasarlo a drawText o a una anotación.
function limpiarTextoPDF(texto) {
  if (!texto) return '';
  return String(texto)
    .replace(/[\r\n\t]+/g, ' ')                          // saltos de línea / tabs → espacio
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // otros caracteres de control
    .split('').map(ch => (ch.charCodeAt(0) <= 255 ? ch : '?')).join('') // fuera de Latin-1 → '?'
    .replace(/\s+/g, ' ')
    .trim();
}

function parecePdf(bytes) {
  if (!bytes || bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D; // "%PDF-"
}

function truncarTextoSiExcede(font, size, texto, maxWidth) {
  if (font.widthOfTextAtSize(texto, size) <= maxWidth) return texto;
  const elipsis = '...';
  let lo = 0, hi = texto.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidato = texto.slice(0, mid) + elipsis;
    if (font.widthOfTextAtSize(candidato, size) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return texto.slice(0, lo) + elipsis;
}

function pushAnnot(pdf, page, annotRef) {
  if (!page.node.Annots()) page.node.set(PDFName.of('Annots'), pdf.context.obj([]));
  page.node.Annots().push(annotRef);
}

// Link interno: salta a la primera página de una actuación (Dest + Fit).
function anotacionInterna(pdf, page, rect, destPageRef) {
  const annot = pdf.context.obj({
    Type: 'Annot', Subtype: 'Link',
    Rect: rect, Border: [0, 0, 0],
    Dest: [destPageRef, PDFName.of('Fit')],
  });
  const ref = pdf.context.register(annot);
  pushAnnot(pdf, page, ref);
}

// Link público: URL clicable (acción URI).
function anotacionUri(pdf, page, rect, url) {
  const annot = pdf.context.obj({
    Type: 'Annot', Subtype: 'Link',
    Rect: rect, Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFHexString.fromText(url) },
  });
  const ref = pdf.context.register(annot);
  pushAnnot(pdf, page, ref);
}

function construirLineaDatos(numero, titulo, fecha) {
  const partes = ['Act. ' + numero];
  if (titulo) partes.push(titulo);
  if (fecha) partes.push(fecha);
  return partes.join(' · ');
}

// ─── Pie de página (línea de datos + URL pública visible y clicable) ──────
function pieEnTodasLasPaginas(pdf, paginas, fontRegular, fontBold, numero, titulo, fecha, urlPublica) {
  const linea1 = construirLineaDatos(numero, titulo, fecha);
  const maxWidthTexto = A4[0] - 2 * MARGIN;

  for (const page of paginas) {
    const { width } = page.getSize();
    const centroX = width / 2;

    // Línea 1: identificación de la actuación (gris, y=22)
    const t1 = truncarTextoSiExcede(fontRegular, PIE_FONT_SIZE, linea1, maxWidthTexto);
    const w1 = fontRegular.widthOfTextAtSize(t1, PIE_FONT_SIZE);
    page.drawText(t1, {
      x: centroX - w1 / 2, y: 22, size: PIE_FONT_SIZE,
      font: fontRegular, color: rgb(0.25, 0.25, 0.25),
    });

    // Línea 2: URL pública completa, visible y clicable (y=12)
    const t2 = truncarTextoSiExcede(fontRegular, PIE_FONT_SIZE, urlPublica, maxWidthTexto);
    const w2 = fontRegular.widthOfTextAtSize(t2, PIE_FONT_SIZE);
    const x2 = centroX - w2 / 2;
    page.drawText(t2, {
      x: x2, y: 12, size: PIE_FONT_SIZE,
      font: fontRegular, color: rgb(0, 0, 0.6),
    });
    // Área clicable alrededor del texto de la URL
    anotacionUri(pdf, page, [x2 - 2, 8, x2 + w2 + 2, 18], urlPublica);
  }
}

// ─── Página de error (actuación no disponible) ─────────────────────────────
function dibujarPaginaError(pdf, fontBold, fontRegular, numero, titulo, fecha, urlPublica, motivo) {
  const page = pdf.addPage(A4);
  const { width, height } = page.getSize();

  page.drawText('ACTUACIÓN NO DISPONIBLE', {
    x: MARGIN, y: height - 140, size: 20, font: fontBold, color: rgb(0.75, 0.15, 0.15),
  });
  page.drawText('Act. ' + numero + (titulo ? ' · ' + titulo : ''), {
    x: MARGIN, y: height - 175, size: 12, font: fontRegular, color: rgb(0.2, 0.2, 0.2),
  });
  if (fecha) {
    page.drawText('Fecha: ' + fecha, {
      x: MARGIN, y: height - 195, size: 11, font: fontRegular, color: rgb(0.2, 0.2, 0.2),
    });
  }
  page.drawText('No se pudo incorporar este documento al PDF unificado' + (motivo ? ' (' + motivo + ').' : '.'), {
    x: MARGIN, y: height - 225, size: 10, font: fontRegular, color: rgb(0.35, 0.35, 0.35),
    maxWidth: width - 2 * MARGIN,
  });
  page.drawText('Consultar directamente en el SCW:', {
    x: MARGIN, y: height - 255, size: 10, font: fontRegular, color: rgb(0.35, 0.35, 0.35),
  });
  const yUrl = height - 275;
  page.drawText(urlPublica || '', {
    x: MARGIN, y: yUrl, size: 10, font: fontRegular, color: rgb(0, 0, 0.6),
    maxWidth: width - 2 * MARGIN,
  });
  const wUrl = fontRegular.widthOfTextAtSize(urlPublica || '', 10);
  if (urlPublica) anotacionUri(pdf, page, [MARGIN - 2, yUrl - 4, MARGIN + Math.min(wUrl, width - 2 * MARGIN) + 2, yUrl + 12], urlPublica);

  return page;
}

// ─── Índice ────────────────────────────────────────────────────────────────
// Calcula cuántas entradas entran por página según el Y inicial disponible
// (en vez de un número fijo, se deriva del alto de página real — así no se
// desalinea si algún día cambian los márgenes).
function capacidadPagina(startY) {
  return Math.max(1, Math.floor((startY - INDICE_MARGIN_INFERIOR) / INDICE_STEP) + 1);
}

function reservarPaginasIndice(pdf, cantidadEntradas) {
  const capPortada = capacidadPagina(INDICE_START_Y_PORTADA);
  const capCont     = capacidadPagina(INDICE_START_Y_CONT);
  let restantes = cantidadEntradas - capPortada;
  let nPaginasCont = restantes > 0 ? Math.ceil(restantes / capCont) : 0;

  const paginas = [pdf.addPage(A4)]; // portada + índice
  for (let i = 0; i < nPaginasCont; i++) paginas.push(pdf.addPage(A4));
  return { paginas, capPortada, capCont };
}

function dibujarPortadaEIndice(pdf, paginas, capPortada, capCont, fontBold, fontRegular, tituloExpediente, entradas) {
  const portada = paginas[0];
  const { width, height } = portada.getSize();

  portada.drawText(tituloExpediente || 'Expediente', {
    x: MARGIN, y: height - 70, size: 18, font: fontBold, color: rgb(0.1, 0.15, 0.3),
    maxWidth: width - 2 * MARGIN,
  });
  portada.drawText('Índice de actuaciones (' + entradas.length + ')', {
    x: MARGIN, y: height - 100, size: 11, font: fontRegular, color: rgb(0.35, 0.35, 0.35),
  });
  portada.drawText('Generado ' + new Date().toLocaleDateString('es-AR') + ' · copia de trabajo, sin validez de firma electrónica', {
    x: MARGIN, y: height - 118, size: 8, font: fontRegular, color: rgb(0.5, 0.5, 0.5),
  });

  const maxWidthEntrada = width - 2 * MARGIN - 15;
  let paginaIdx = 0, y = INDICE_START_Y_PORTADA, cap = capPortada;
  let usadosEnPagina = 0;

  for (let i = 0; i < entradas.length; i++) {
    if (usadosEnPagina >= cap) {
      paginaIdx++; y = INDICE_START_Y_CONT; cap = capCont; usadosEnPagina = 0;
    }
    const page = paginas[paginaIdx];
    const entrada = entradas[i];
    const numLabel = String(i + 1).padStart(3, '0') + '. ';
    let linea = numLabel + entrada.titulo + (entrada.fecha ? '  (' + entrada.fecha + ')' : '');
    linea = truncarTextoSiExcede(fontRegular, INDICE_FONT_SIZE, linea, maxWidthEntrada);
    const w = fontRegular.widthOfTextAtSize(linea, INDICE_FONT_SIZE);

    page.drawText(linea, {
      x: MARGIN, y, size: INDICE_FONT_SIZE, font: fontRegular, color: rgb(0, 0, 0.55),
    });
    anotacionInterna(pdf, page, [MARGIN - 2, y - 3, MARGIN + w + 2, y + 10], entrada.destPageRef);

    y -= INDICE_STEP;
    usadosEnPagina++;
  }
}

// ─── Función principal ──────────────────────────────────────────────────
// actuaciones: [{ numero, titulo, fecha, tipo, urlPublica, bytes: Uint8Array|null, error }]
// bytes === null (o no pasa parecePdf) ⇒ se dibuja página de error.
export async function generarPdfUnificado({ tituloExpediente, actuaciones }) {
  const titulo = limpiarTextoPDF(tituloExpediente) || 'Expediente unificado';
  const ordenadas = ordenarPorFechaAsc(actuaciones);

  const pdf = await PDFDocument.create();
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold    = await pdf.embedFont(StandardFonts.HelveticaBold);

  // 1) Reservar de entrada las páginas de índice (necesitamos sus refs para
  //    los links internos, pero el contenido se dibuja recién al final,
  //    cuando ya sabemos a qué página de contenido apunta cada entrada).
  const { paginas: paginasIndice, capPortada, capCont } = reservarPaginasIndice(pdf, ordenadas.length);

  // 2) Contenido: copiar páginas de cada actuación (o dibujar error) y
  //    aplicar el pie en todas las páginas que le correspondan.
  const entradasIndice = [];
  let numero = 1;
  for (const act of ordenadas) {
    const titulo = limpiarTextoPDF(act.titulo || ('Actuación ' + numero)) || ('Actuación ' + numero);
    const fecha = limpiarTextoPDF(act.fecha || '');
    const urlPublica = limpiarTextoPDF(act.urlPublica || act.url || '');
    let paginasDeEstaActuacion = [];

    let bytesOk = act.bytes && parecePdf(act.bytes);
    if (bytesOk) {
      try {
        const src = await PDFDocument.load(act.bytes, { ignoreEncryption: true });
        const indices = src.getPageIndices();
        const copiadas = await pdf.copyPages(src, indices);
        copiadas.forEach(p => { pdf.addPage(p); paginasDeEstaActuacion.push(p); });
        if (!copiadas.length) bytesOk = false;
      } catch (e) {
        bytesOk = false;
        act.error = act.error || e.message;
      }
    }

    if (!bytesOk) {
      const pErr = dibujarPaginaError(pdf, fontBold, fontRegular, numero, titulo, fecha, urlPublica, limpiarTextoPDF(act.error));
      paginasDeEstaActuacion = [pErr];
    }

    pieEnTodasLasPaginas(pdf, paginasDeEstaActuacion, fontRegular, fontBold, numero, titulo, fecha, urlPublica);

    entradasIndice.push({
      titulo, fecha,
      destPageRef: paginasDeEstaActuacion[0].ref,
    });
    numero++;
  }

  // 3) Ahora sí, dibujar la portada + índice con los links internos ya resueltos.
  dibujarPortadaEIndice(pdf, paginasIndice, capPortada, capCont, fontBold, fontRegular, titulo, entradasIndice);

  pdf.setTitle(titulo);
  pdf.setSubject('Expediente judicial unificado — PJN Descargador');
  pdf.setCreator('PJN Descargador');
  pdf.setProducer('PJN Descargador (pdf-lib)');

  return pdf.save();
}
