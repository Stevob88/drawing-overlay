// Browser-side PDF access via the locally bundled pdf.js. No network.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import * as db from './db.js';
import { extractPage, prepareDrawing, inspectPdf, pdfTextPages } from './pdf-extract.js';

// Paths are relative to the page (index.html sits next to vendor/), so the same code works
// as separate modules or bundled into one page.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', document.baseURI).href;
const OPTS = {
  standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', document.baseURI).href,
  isEvalSupported: false,
  disableAutoFetch: true,
  disableStream: true,
  verbosity: 0,
};
const EXTRACT_VERSION = 8; // bump when extraction/classification changes

const docs = new Map();
export async function openDoc(fileId) {
  if (docs.has(fileId)) return docs.get(fileId);
  const f = await db.get('files', fileId);
  if (!f) throw new Error('Drawing file is missing from this device. Re-import it.');
  const p = pdfjs.getDocument({ data: new Uint8Array(f.data.slice(0)), ...OPTS }).promise;
  docs.set(fileId, p);
  return p;
}

export const inspectBytes = (buf) => inspectPdf(pdfjs, new Uint8Array(buf.slice(0)), OPTS);
export const textPages = (buf) => pdfTextPages(pdfjs, new Uint8Array(buf.slice(0)), OPTS);

/** Prepared drawing model (groups, text, notes), cached per file/page/role. */
export async function getDrawing(fileId, pageNo, role) {
  const key = `${fileId}:${pageNo}:${role}:v${EXTRACT_VERSION}`;
  const cached = await db.get('extracts', key);
  if (cached) return cached.model;
  const doc = await openDoc(fileId);
  const page = await doc.getPage(pageNo);
  const ex = await extractPage(pdfjs, page);
  const model = prepareDrawing(ex, role);
  try { await db.put('extracts', { key, model }); } catch { /* cache only */ }
  return model;
}

const IOS_MAX_PIXELS = 16_000_000; // iOS Safari canvas area limit (~16.7M)

/**
 * Render a region of a page (drawing units) to a canvas.
 * Returns { canvas, unitsPerPx, dpi, limited }  limited=true if the DPI had to be reduced.
 */
export async function renderRegion(fileId, pageNo, crop, targetDpi = 300, maxPixels = IOS_MAX_PIXELS) {
  const doc = await openDoc(fileId);
  const page = await doc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const c = crop || { x0: 0, y0: 0, x1: vp1.width, y1: vp1.height };
  const wU = c.x1 - c.x0;
  const hU = c.y1 - c.y0;
  let scale = targetDpi / 72;
  let limited = false;
  if (wU * hU * scale * scale > maxPixels) { scale = Math.sqrt(maxPixels / (wU * hU)); limited = true; }
  const vp = page.getViewport({ scale, offsetX: -c.x0 * scale, offsetY: -c.y0 * scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(wU * scale);
  canvas.height = Math.floor(hU * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, unitsPerPx: 1 / scale, dpi: scale * 72, limited, crop: c };
}

/** Tint a black-on-white render: black -> colour, white stays white. */
export function tint(src, colour) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}
