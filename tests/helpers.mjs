import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageGeometry } from '../js/pdf-extract.js';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SYN = path.join(HERE, 'fixtures', 'synthetic');
export const REAL = path.join(HERE, 'fixtures', 'real');
const fontDir = path.join(HERE, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
export const PDF_OPTS = { standardFontDataUrl: fontDir, verbosity: 0 };
export const readPdf = (p) => new Uint8Array(fs.readFileSync(p));

export async function geometry(p, pageNo = 1) {
  const doc = await pdfjs.getDocument({ data: readPdf(p), ...PDF_OPTS }).promise;
  return pageGeometry(pdfjs, await doc.getPage(pageNo));
}
export { pdfjs };
