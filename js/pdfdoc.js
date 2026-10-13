// Browser-side PDF access via the locally bundled pdf.js. No network.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { pageGeometry } from './pdf-extract.js';

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

export async function openPdf(bytes) {
  return pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), ...OPTS }).promise;
}

// Phone canvases have an area limit (~16.7M px on iPhone); two drawings share memory.
const MAX_PIXELS = 9_000_000;

/**
 * Render one page as it appears in the PDF (markups such as vent boxes included) and read
 * its line geometry for snapping. Units: page points, y down.
 */
export async function loadPage(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(4, Math.sqrt(MAX_PIXELS / (vp1.width * vp1.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const geo = await pageGeometry(pdfjs, page);
  return { canvas, scale, ...geo };
}

/**
 * Tinted copy for overlaying: dark linework takes the colour, white stays white, so the
 * page can be laid over another with 'multiply'. Coloured markups keep their hue.
 */
export function tint(src, colour) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  if (colour) {
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}
