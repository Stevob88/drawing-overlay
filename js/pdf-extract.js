// PDF inspection (Step 0) and vector extraction. Works in the browser and in Node:
// the caller passes the pdf.js module in, so nothing here touches the network.
import { mul, apply } from './geom.js';
import { classifyText, groupTextLines, extractPlotNotes } from './text.js';
import { buildGroups } from './classify.js';

const r2 = (v) => Math.round(v * 100) / 100;
const PT2MM = 25.4 / 72;

const PAPER = [
  ['A0', 841, 1189], ['A1', 594, 841], ['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297],
];
export function paperName(wMm, hMm) {
  const a = Math.min(wMm, hMm);
  const b = Math.max(wMm, hMm);
  for (const [n, x, y] of PAPER) if (Math.abs(a - x) < 3 && Math.abs(b - y) < 3) return n;
  return 'custom';
}

function hex(rgb) {
  if (typeof rgb === 'string') return rgb.toLowerCase();
  const a = Array.from(rgb ?? [0, 0, 0]);
  return '#' + a.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

function bezier(out, x0, y0, x1, y1, x2, y2, x3, y3) {
  let px = x0;
  let py = y0;
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const mt = 1 - t;
    const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
    const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
    out.push(px, py, x, y);
    px = x;
    py = y;
  }
}

/**
 * Walk the operator list and return painted paths in viewport space (y down, scale 1).
 * Each path: { segs:number[] (x1,y1,x2,y2...), stroke:bool, fill:bool, lw, color, fillColor, dash }
 */
export function walkOperators(OPS, ol, viewportTransform) {
  const paths = [];
  const images = [];
  let gs = { ctm: viewportTransform.slice(), lw: 1, stroke: '#000000', fill: '#000000', dash: '' };
  const stack = [];
  let pending = null; // segments of the current path in viewport space
  const P = OPS;
  const paintOps = new Map([
    [P.stroke, [true, false]], [P.closeStroke, [true, false]],
    [P.fill, [false, true]], [P.eoFill, [false, true]],
    [P.fillStroke, [true, true]], [P.eoFillStroke, [true, true]],
    [P.closeFillStroke, [true, true]], [P.closeEOFillStroke, [true, true]],
  ]);
  const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i];
    switch (fn) {
      case P.save: stack.push({ ...gs, ctm: gs.ctm.slice() }); break;
      case P.restore: if (stack.length) gs = stack.pop(); break;
      case P.transform: gs.ctm = mul(gs.ctm, args); break;
      case P.paintFormXObjectBegin:
        stack.push({ ...gs, ctm: gs.ctm.slice() });
        if (args?.[0]) gs.ctm = mul(gs.ctm, args[0]);
        break;
      case P.paintFormXObjectEnd: if (stack.length) gs = stack.pop(); break;
      case P.setLineWidth: gs.lw = args[0]; break;
      case P.setDash: gs.dash = (args[0] || []).length ? Array.from(args[0]).map(r2).join(',') : ''; break;
      case P.setStrokeRGBColor: gs.stroke = hex(args); break;
      case P.setFillRGBColor: gs.fill = hex(args); break;
      case P.setStrokeGray: gs.stroke = hex([args[0] * 255, args[0] * 255, args[0] * 255]); break;
      case P.setFillGray: gs.fill = hex([args[0] * 255, args[0] * 255, args[0] * 255]); break;
      case P.setGState:
        for (const [k, v] of args[0] || []) {
          if (k === 'LW') gs.lw = v;
          if (k === 'D') gs.dash = (v?.[0] || []).length ? Array.from(v[0]).map(r2).join(',') : '';
        }
        break;
      case P.constructPath: {
        const [ops, coords] = args;
        const segs = [];
        let j = 0;
        let cx = 0, cy = 0, sx = 0, sy = 0;
        const T = (x, y) => apply(gs.ctm, x, y);
        for (const op of ops) {
          if (op === P.moveTo) {
            [cx, cy] = T(coords[j], coords[j + 1]); sx = cx; sy = cy; j += 2;
          } else if (op === P.lineTo) {
            const [x, y] = T(coords[j], coords[j + 1]); j += 2;
            segs.push(cx, cy, x, y); cx = x; cy = y;
          } else if (op === P.curveTo) {
            const [x1, y1] = T(coords[j], coords[j + 1]);
            const [x2, y2] = T(coords[j + 2], coords[j + 3]);
            const [x3, y3] = T(coords[j + 4], coords[j + 5]); j += 6;
            bezier(segs, cx, cy, x1, y1, x2, y2, x3, y3); cx = x3; cy = y3;
          } else if (op === P.curveTo2) { // first control point = current point
            const [x2, y2] = T(coords[j], coords[j + 1]);
            const [x3, y3] = T(coords[j + 2], coords[j + 3]); j += 4;
            bezier(segs, cx, cy, cx, cy, x2, y2, x3, y3); cx = x3; cy = y3;
          } else if (op === P.curveTo3) { // second control point = end point
            const [x1, y1] = T(coords[j], coords[j + 1]);
            const [x3, y3] = T(coords[j + 2], coords[j + 3]); j += 4;
            bezier(segs, cx, cy, x1, y1, x3, y3, x3, y3); cx = x3; cy = y3;
          } else if (op === P.closePath) {
            if (cx !== sx || cy !== sy) segs.push(cx, cy, sx, sy);
            cx = sx; cy = sy;
          } else if (op === P.rectangle) {
            const [x, y, w, h] = [coords[j], coords[j + 1], coords[j + 2], coords[j + 3]]; j += 4;
            const a = T(x, y), b = T(x + w, y), c = T(x + w, y + h), d = T(x, y + h);
            segs.push(a[0], a[1], b[0], b[1], b[0], b[1], c[0], c[1], c[0], c[1], d[0], d[1], d[0], d[1], a[0], a[1]);
            cx = a[0]; cy = a[1]; sx = cx; sy = cy;
          }
        }
        pending = pending ? pending.concat(segs) : segs;
        break;
      }
      case P.endPath: pending = null; break;
      case P.paintImageXObject:
      case P.paintInlineImageXObject:
      case P.paintImageMaskXObject:
      case P.paintImageXObjectRepeat: {
        const m = gs.ctm;
        const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(m, x, y));
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        let w = 0, h = 0;
        if (fn === P.paintImageXObject && args) { w = args[1]; h = args[2]; }
        else if (args?.[0]?.width) { w = args[0].width; h = args[0].height; }
        const uw = Math.hypot(m[0], m[1]);
        const uh = Math.hypot(m[2], m[3]);
        images.push({
          bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          pxW: w, pxH: h,
          unitsPerPx: w && h ? Math.max(uw / w, uh / h) : null,
        });
        break;
      }
      default:
        if (paintOps.has(fn)) {
          const [s, f] = paintOps.get(fn);
          if (pending && pending.length) {
            paths.push({
              segs: pending, stroke: s, fill: f,
              lw: r2(gs.lw * scaleOf(gs.ctm)), color: gs.stroke, fillColor: gs.fill, dash: gs.dash,
            });
          }
          pending = null;
        }
    }
  }
  return { paths, images };
}

/** Extract text items into viewport space. */
export async function extractText(page, viewport) {
  const tc = await page.getTextContent();
  const vt = viewport.transform;
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const m = mul(vt, it.transform);
    const size = Math.hypot(m[2], m[3]);
    const angle = Math.atan2(m[1], m[0]); // radians, y-down space
    const sx = Math.hypot(m[0], m[1]) / (Math.hypot(it.transform[0], it.transform[1]) || 1);
    items.push({ str: it.str, x: m[4], y: m[5], size, angle, w: it.width * sx });
  }
  return items;
}

/** Full vector + text extraction of one page, ready for classification and rendering. */
export async function extractPage(pdfjs, page) {
  const viewport = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  const { paths, images } = walkOperators(pdfjs.OPS, ol, viewport.transform);
  const textItems = await extractText(page, viewport);
  const lines = groupTextLines(textItems).map((l) => ({ ...l, cls: classifyText(l.str) }));
  return { width: viewport.width, height: viewport.height, paths, images, textItems, lines, opCount: ol.fnArray.length };
}

const ROOM_RE = /\b(BED(ROOM)?\s*\d|BATH(ROOM)?|EN[\s-]?SUITE|LANDING|WC|CLOAKS?|STUDY|STORE|CUPB(OARD)?|AIRING|KITCHEN|LOUNGE|LIVING|DINING|HALL|UTILITY)\b/i;
const DIM_RE = /^\d{3,5}$/;

/** Step 0 report for one page: vector or raster, text quality, room names and dimensions found. */
export function inspectExtracted(ex) {
  const segCount = ex.paths.reduce((n, p) => n + p.segs.length / 4, 0);
  const pageArea = ex.width * ex.height;
  let imgArea = 0;
  let minUnitsPerPx = null;
  for (const im of ex.images) {
    const [x0, y0, x1, y1] = im.bbox;
    imgArea += Math.max(0, Math.min(x1, ex.width) - Math.max(x0, 0)) * Math.max(0, Math.min(y1, ex.height) - Math.max(y0, 0));
    if (im.unitsPerPx && (minUnitsPerPx === null || im.unitsPerPx > minUnitsPerPx)) minUnitsPerPx = im.unitsPerPx;
  }
  const imageCoverage = Math.min(1, imgArea / pageArea);
  const rooms = [...new Set(ex.lines.filter((l) => ROOM_RE.test(l.str)).map((l) => l.str.trim()))];
  const dims = [...new Set(ex.lines.filter((l) => DIM_RE.test(l.str.trim())).map((l) => l.str.trim()))];
  const reasons = [];
  let method;
  if (imageCoverage >= 0.5 && segCount < 1000) {
    method = 'B';
    reasons.push(`An image covers ${(imageCoverage * 100).toFixed(0)}% of the page and there are only ${segCount} vector line segments: the drawing is flattened.`);
  } else if (segCount >= 50) {
    method = 'A';
    reasons.push(`${segCount} vector line segments found: the geometry is real vector data.`);
    if (imageCoverage > 0.1) reasons.push(`WARNING: images also cover ${(imageCoverage * 100).toFixed(0)}% of the page. Anything drawn inside those images will not appear in vector layers.`);
  } else {
    method = 'B';
    reasons.push(imageCoverage > 0
      ? `Only ${segCount} vector segments and ${(imageCoverage * 100).toFixed(0)}% image coverage: not enough vector data to trust. Treating as raster.`
      : `Only ${segCount} vector segments and no images: this page has little or no drawing content (text-only page such as a schedule?). Not usable as a drawing.`);
  }
  if (!ex.textItems.length) reasons.push('No extractable text. Text may be outlined as paths or part of an image: room names cannot be labelled and plot-list notes cannot be filtered.');
  else reasons.push(`${ex.textItems.length} text items extracted.`);
  const raster = minUnitsPerPx
    ? { unitsPerPx: minUnitsPerPx, dpi: 72 / minUnitsPerPx }
    : null;
  if (raster) reasons.push(`Embedded image resolution approx ${raster.dpi.toFixed(0)} DPI.`);
  const scales = [...new Set(ex.lines.map((l) => l.str.match(/\b1\s*:\s*(\d{1,4})\b/)?.[1]).filter(Boolean).map(Number))];
  return {
    widthPt: r2(ex.width), heightPt: r2(ex.height),
    widthMm: r2(ex.width * PT2MM), heightMm: r2(ex.height * PT2MM),
    paper: paperName(ex.width * PT2MM, ex.height * PT2MM),
    opCount: ex.opCount, pathCount: ex.paths.length, segCount,
    imageCount: ex.images.length, imageCoverage: r2(imageCoverage), raster,
    textItems: ex.textItems.length, rooms, dims, statedScales: scales,
    method, reasons,
  };
}

/** Step 0 report for a whole PDF. data: Uint8Array */
export async function inspectPdf(pdfjs, data, opts = {}) {
  const doc = await pdfjs.getDocument({ data: data.slice ? data.slice() : data, ...opts }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const ex = await extractPage(pdfjs, page);
    pages.push({ page: n, ...inspectExtracted(ex) });
  }
  return { pageCount: doc.numPages, pages };
}

/** Turn a page extraction into the stored drawing model for a role ('floor' | 'roof'). */
export function prepareDrawing(ex, role) {
  const report = inspectExtracted(ex);
  const groups = report.method === 'A' ? buildGroups(ex.paths, role) : [];
  return {
    role, method: report.method, report, autoCrop: autoCrop(groups, role),
    width: ex.width, height: ex.height,
    groups, lines: ex.lines, plotNotes: extractPlotNotes(ex.lines),
    raster: report.method === 'B' ? { unitsPerPx: report.raster?.unitsPerPx ?? null } : null,
  };
}

/** Text items for every page (used by the schedule parser). */
export async function pdfTextPages(pdfjs, data, opts = {}) {
  const doc = await pdfjs.getDocument({ data: data.slice ? data.slice() : data, ...opts }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    pages.push(await extractText(page, page.getViewport({ scale: 1 })));
  }
  return pages;
}

/**
 * Automatic plan area: the largest connected cluster of wall lines (floor) or roof
 * outline/ridge lines (roof), plus anything inside it, expanded by 15%. Title-block
 * borders drawn in the same line style are separate clusters and are left out.
 * The user can override it in the layer picker.
 */
export function autoCrop(groups, role) {
  const main = role === 'floor' ? ['walls'] : ['outline', 'ridge'];
  const segs = [];
  for (const g of groups) if (main.includes(g.category) && g.kind === 'stroke') for (const v of g.segs) segs.push(v);
  const n = segs.length / 4;
  if (!n) return null;
  // union-find over segments sharing an endpoint (1pt tolerance)
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const at = new Map();
  for (let i = 0; i < n; i++) {
    for (const e of [0, 2]) {
      const x = segs[i * 4 + e];
      const y = segs[i * 4 + e + 1];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = `${Math.round(x) + dx},${Math.round(y) + dy}`;
        if (at.has(k)) parent[find(i)] = find(at.get(k));
      }
      at.set(`${Math.round(x)},${Math.round(y)}`, i);
    }
  }
  const comps = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const c = comps.get(r) || { len: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const a = i * 4;
    c.len += Math.hypot(segs[a + 2] - segs[a], segs[a + 3] - segs[a + 1]);
    c.x0 = Math.min(c.x0, segs[a], segs[a + 2]); c.x1 = Math.max(c.x1, segs[a], segs[a + 2]);
    c.y0 = Math.min(c.y0, segs[a + 1], segs[a + 3]); c.y1 = Math.max(c.y1, segs[a + 1], segs[a + 3]);
    comps.set(r, c);
  }
  const all = [...comps.values()];
  const big = all.reduce((a, b) => (b.len > a.len ? b : a));
  const m = 0.15 * Math.max(big.x1 - big.x0, big.y1 - big.y0);
  const box = { x0: big.x0 - m, y0: big.y0 - m, x1: big.x1 + m, y1: big.y1 + m };
  // include other clusters that sit inside the box (e.g. outer wall line vs inner skin)
  for (const c of all) {
    if (c.x0 >= box.x0 && c.x1 <= box.x1 && c.y0 >= box.y0 && c.y1 <= box.y1) {
      box.x0 = Math.min(box.x0, c.x0 - m); box.x1 = Math.max(box.x1, c.x1 + m);
      box.y0 = Math.min(box.y0, c.y0 - m); box.y1 = Math.max(box.y1, c.y1 + m);
    }
  }
  return box;
}
