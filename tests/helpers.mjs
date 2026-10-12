import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPage, prepareDrawing, pdfTextPages, inspectPdf } from '../js/pdf-extract.js';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SYN = path.join(HERE, 'fixtures', 'synthetic');
export const REAL = path.join(HERE, 'fixtures', 'real');
const fontDir = path.join(HERE, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
export const PDF_OPTS = { standardFontDataUrl: fontDir, verbosity: 0 };

export const readPdf = (p) => new Uint8Array(fs.readFileSync(p));

export async function loadDrawing(p, role, pageNo = 1) {
  const doc = await pdfjs.getDocument({ data: readPdf(p), ...PDF_OPTS }).promise;
  const page = await doc.getPage(pageNo);
  const ex = await extractPage(pdfjs, page);
  return prepareDrawing(ex, role);
}
export const schedulePages = (p) => pdfTextPages(pdfjs, readPdf(p), PDF_OPTS);
export const inspect = (p) => inspectPdf(pdfjs, readPdf(p), PDF_OPTS);
export { pdfjs };
