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

const segBox = (a) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < a.length; i += 2) { x0 = Math.min(x0, a[i]); x1 = Math.max(x1, a[i]); y0 = Math.min(y0, a[i + 1]); y1 = Math.max(y1, a[i + 1]); }
  return { x0, y0, x1, y1 };
};
const intersectBox = (a, b) => (!a ? b : { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/** Clip segments to a box (Liang-Barsky). */
export function clipSegs(segs, box) {
  if (!box) return segs;
  if (box.x1 < box.x0 || box.y1 < box.y0) return [];
  const out = [];
  const e = 1e-6;
  for (let i = 0; i < segs.length; i += 4) {
    const x1 = segs[i], y1 = segs[i + 1], dx = segs[i + 2] - x1, dy = segs[i + 3] - y1;
    let t0 = 0, t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, x1 - box.x0 + e], [dx, box.x1 - x1 + e], [-dy, y1 - box.y0 + e], [dy, box.y1 - y1 + e]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) continue;
    if (t0 === 0 && t1 === 1) out.push(segs[i], segs[i + 1], segs[i + 2], segs[i + 3]);
    else out.push(x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy);
  }
  return out;
}

/**
 * Walk the operator list and return painted paths in viewport space (y down, scale 1).
 * Each path: { segs:number[] (x1,y1,x2,y2...), stroke:bool, fill:bool, lw, color, fillColor, dash }
 */
export function walkOperators(OPS, ol, viewportTransform) {
  const paths = [];
  const images = [];
  // clip = bounding box of the current clipping path (viewport space). Exact for the usual
  // rectangular clips; for other shapes it keeps a little more than the PDF shows.
  let gs = { ctm: viewportTransform.slice(), lw: 1, stroke: '#000000', fill: '#000000', dash: '', clip: null };
  let pendingClip = false;
  // current point persists across constructPath ops until the path is painted/ended;
  // null = no current point (a lineTo without one draws nothing, never a line from 0,0)
  let cur = null;
  let start = null;
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
      case P.paintFormXObjectBegin: {
        stack.push({ ...gs, ctm: gs.ctm.slice() });
        if (args?.[0]) gs.ctm = mul(gs.ctm, args[0]);
        const bb = args?.[1]; // a form XObject is clipped to its BBox
        if (bb && bb.length === 4) {
          const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => apply(gs.ctm, x, y));
          gs.clip = intersectBox(gs.clip, segBox(pts.flat()));
        }
        break;
      }
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
        let has = !!cur;
        let cx = cur ? cur[0] : 0, cy = cur ? cur[1] : 0, sx = start ? start[0] : 0, sy = start ? start[1] : 0;
        const T = (x, y) => apply(gs.ctm, x, y);
        for (const op of ops) {
          if (op === P.moveTo) {
            [cx, cy] = T(coords[j], coords[j + 1]); sx = cx; sy = cy; j += 2; has = true;
          } else if (op === P.lineTo) {
            const [x, y] = T(coords[j], coords[j + 1]); j += 2;
            if (has) segs.push(cx, cy, x, y);
            cx = x; cy = y; if (!has) { sx = x; sy = y; has = true; }
          } else if (op === P.curveTo) {
            const [x1, y1] = T(coords[j], coords[j + 1]);
            const [x2, y2] = T(coords[j + 2], coords[j + 3]);
            const [x3, y3] = T(coords[j + 4], coords[j + 5]); j += 6;
            if (has) bezier(segs, cx, cy, x1, y1, x2, y2, x3, y3);
            cx = x3; cy = y3; if (!has) { sx = x3; sy = y3; has = true; }
          } else if (op === P.curveTo2) { // first control point = current point
            const [x2, y2] = T(coords[j], coords[j + 1]);
            const [x3, y3] = T(coords[j + 2], coords[j + 3]); j += 4;
            if (has) bezier(segs, cx, cy, cx, cy, x2, y2, x3, y3);
            cx = x3; cy = y3; if (!has) { sx = x3; sy = y3; has = true; }
          } else if (op === P.curveTo3) { // second control point = end point
            const [x1, y1] = T(coords[j], coords[j + 1]);
            const [x3, y3] = T(coords[j + 2], coords[j + 3]); j += 4;
            if (has) bezier(segs, cx, cy, x1, y1, x3, y3, x3, y3);
            cx = x3; cy = y3; if (!has) { sx = x3; sy = y3; has = true; }
          } else if (op === P.closePath) {
            if (has && (cx !== sx || cy !== sy)) segs.push(cx, cy, sx, sy);
            cx = sx; cy = sy;
          } else if (op === P.rectangle) {
            const [x, y, w, h] = [coords[j], coords[j + 1], coords[j + 2], coords[j + 3]]; j += 4;
            const a = T(x, y), b = T(x + w, y), c = T(x + w, y + h), d = T(x, y + h);
            segs.push(a[0], a[1], b[0], b[1], b[0], b[1], c[0], c[1], c[0], c[1], d[0], d[1], d[0], d[1], a[0], a[1]);
            cx = a[0]; cy = a[1]; sx = cx; sy = cy; has = true;
          }
        }
        cur = has ? [cx, cy] : null;
        start = has ? [sx, sy] : null;
        pending = pending ? pending.concat(segs) : segs;
        break;
      }
      case P.clip:
      case P.eoClip:
        pendingClip = true;
        break;
      case P.endPath:
        if (pendingClip && pending?.length) gs.clip = intersectBox(gs.clip, segBox(pending));
        pendingClip = false;
        pending = null;
        cur = null; start = null;
        break;
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
          if (pendingClip && pending?.length) { gs.clip = intersectBox(gs.clip, segBox(pending)); pendingClip = false; }
          const segs = pending?.length ? clipSegs(pending, gs.clip) : null;
          if (segs && segs.length) {
            paths.push({
              segs, stroke: s, fill: f,
              lw: r2(gs.lw * scaleOf(gs.ctm)), color: gs.stroke, fillColor: gs.fill, dash: gs.dash,
            });
          }
          pending = null;
          cur = null; start = null;
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

/**
 * Text from PDF markups (FreeText / callout / note comments added in Bluebeam, Acrobat etc).
 * Their drawn boxes come through the operator list; their text does not, so read it here.
 * str = the full comment text (authoritative for plot lists: a list that wraps on screen,
 * e.g. "75/7" + "6/82", is stored unbroken); display = the lines as shown.
 */
export async function extractMarkups(page, viewport) {
  const out = [];
  let anns = [];
  try { anns = await page.getAnnotations(); } catch { return out; }
  for (const a of anns) {
    if (!['FreeText', 'Text', 'Square', 'Circle', 'Polygon', 'Line'].includes(a.subtype)) continue;
    const raw = (a.contentsObj?.str ?? a.contents ?? '').trim();
    if (!raw) continue;
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(a.rect);
    const display = (Array.isArray(a.textContent) && a.textContent.length ? a.textContent : raw.split(/\r\n|\r|\n/)).map((t) => t.trim()).filter(Boolean);
    const str = raw.replace(/\s*(\r\n|\r|\n)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const h = Math.abs(y1 - y0);
    const size = Math.max(5, Math.min(14, (h / Math.max(1, display.length)) * 0.75));
    out.push({
      str, display, source: 'markup', subtype: a.subtype, cls: classifyText(str),
      x: Math.min(x0, x1), y: Math.max(y0, y1), angle: 0, size, w: Math.abs(x1 - x0),
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
    });
  }
  return out;
}

/** Full vector + text extraction of one page, ready for classification and rendering. */
export async function extractPage(pdfjs, page) {
  const viewport = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  const { paths, images } = walkOperators(pdfjs.OPS, ol, viewport.transform);
  const textItems = await extractText(page, viewport);
  const lines = groupTextLines(textItems).map((l) => ({ ...l, cls: classifyText(l.str) }));
  const markups = await extractMarkups(page, viewport);
  for (const m of markups) lines.push(m);
  return { width: viewport.width, height: viewport.height, paths, images, textItems, lines, markups: markups.length, opCount: ol.fnArray.length };
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
  if (ex.markups) reasons.push(`${ex.markups} markup comment(s) with text found (e.g. vent / PV notes added in a PDF editor). Their text is read for plot filtering.`);
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
    role, method: report.method, report, autoCrop: autoCrop(groups, role, ex.width, ex.height),
    width: ex.width, height: ex.height,
    groups, lines: ex.lines, plotNotes: extractPlotNotes(ex.lines),
    raster: report.method === 'B' ? { unitsPerPx: report.raster?.unitsPerPx ?? null } : null,
  };
}

/**
 * Text items + horizontal table rules for every page (used by the schedule parser).
 * Rules = y of horizontal lines (or thin filled bars) spanning >30% of the page width.
 */
export async function pdfTextPages(pdfjs, data, opts = {}) {
  const doc = await pdfjs.getDocument({ data: data.slice ? data.slice() : data, ...opts }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const items = await extractText(page, vp);
    const { paths } = walkOperators(pdfjs.OPS, await page.getOperatorList(), vp.transform);
    const ys = [];
    for (const p of paths) {
      for (let i = 0; i < p.segs.length; i += 4) {
        const s = p.segs;
        if (Math.abs(s[i + 1] - s[i + 3]) < 0.05 && Math.abs(s[i + 2] - s[i]) > 0.3 * vp.width) ys.push(s[i + 1]);
      }
    }
    ys.sort((a, b) => a - b);
    const rules = [];
    for (const y of ys) if (!rules.length || y - rules[rules.length - 1] > 0.5) rules.push(y);
    pages.push({ items, rules });
  }
  return pages;
}

/**
 * Automatic plan area: the largest connected cluster of linework on the sheet, ignoring
 * the sheet border, expanded by 6%, plus any other
 * cluster lying inside it. Keys, schedules and title blocks are separate clusters and
 * fall outside. It is a starting point: the user can set the plan area by hand.
 */
export function autoCrop(groups, role, width = Infinity, height = Infinity) {
  // Ignore the sheet border and anything reaching into the outer 5% margin.
  const short = Math.min(width, height);
  const edge = 0.05 * short;
  const nearEdge = (x, y) => x < edge || y < edge || x > width - edge || y > height - edge;
  const segs = [];
  for (const g of groups) {
    if (g.kind !== 'stroke' || g.color === '#ffffff') continue;
    for (let i = 0; i < g.segs.length; i += 4) {
      const [x1, y1, x2, y2] = [g.segs[i], g.segs[i + 1], g.segs[i + 2], g.segs[i + 3]];
      const L = Math.hypot(x2 - x1, y2 - y1);
      if (L === 0 || L > 0.85 * short) continue;
      if (nearEdge(x1, y1) || nearEdge(x2, y2)) continue; // border, or stray lines from the sheet corner
      segs.push(x1, y1, x2, y2);
    }
  }
  const n = segs.length / 4;
  if (!n) return null;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  // connect segments whose endpoints are within ~1.5pt (grid hashing)
  const cell = 1.5;
  const at = new Map();
  for (let i = 0; i < n; i++) {
    for (const e of [0, 2]) {
      const gx = Math.floor(segs[i * 4 + e] / cell);
      const gy = Math.floor(segs[i * 4 + e + 1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = (gx + dx) * 100003 + (gy + dy);
        if (at.has(k)) parent[find(i)] = find(at.get(k));
      }
      at.set(gx * 100003 + gy, i);
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
  const m = 0.06 * Math.max(big.x1 - big.x0, big.y1 - big.y0);
  const box = { x0: big.x0 - m, y0: big.y0 - m, x1: big.x1 + m, y1: big.y1 + m };
  for (const c of all) {
    if (c.x0 >= box.x0 && c.x1 <= box.x1 && c.y0 >= box.y0 && c.y1 <= box.y1) {
      box.x0 = Math.min(box.x0, c.x0 - m); box.x1 = Math.max(box.x1, c.x1 + m);
      box.y0 = Math.min(box.y0, c.y0 - m); box.y1 = Math.max(box.y1, c.y1 + m);
    }
  }
  box.x0 = Math.max(box.x0, 0); box.y0 = Math.max(box.y0, 0);
  box.x1 = Math.min(box.x1, width); box.y1 = Math.min(box.y1, height);
  return box;
}
