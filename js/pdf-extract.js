// Reads line geometry from a PDF page so taps can snap to real corners and line
// crossings, and finds the drawing's stated scale (e.g. "1:50"). Works in browser and Node.
import { mul, apply } from './geom.js';

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

const r2 = (v) => Math.round(v * 100) / 100;

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
  let inMarkup = 0;
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
        const bb = args?.[1]; // a form XObject is clipped to its BBox (not inside markups:
        // their appearance boxes are positioned by the annotation, and they are deliberate)
        if (bb && bb.length === 4 && !inMarkup) {
          const pts = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => apply(gs.ctm, x, y));
          gs.clip = intersectBox(gs.clip, segBox(pts.flat()));
        }
        break;
      }
      case P.paintFormXObjectEnd: if (stack.length) gs = stack.pop(); break;
      case P.beginAnnotation: { // markup comments (vent boxes etc.): own state + placement
        stack.push({ ...gs, ctm: gs.ctm.slice() });
        inMarkup++;
        const [, , tr, mx] = args || [];
        if (tr?.length === 6) gs.ctm = mul(gs.ctm, tr);
        if (mx?.length === 6) gs.ctm = mul(gs.ctm, mx);
        gs.clip = null;
        break;
      }
      case P.endAnnotation:
        inMarkup = Math.max(0, inMarkup - 1);
        if (stack.length) gs = stack.pop();
        break;
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
              lw: r2(gs.lw * scaleOf(gs.ctm)), color: gs.stroke, fillColor: gs.fill, dash: gs.dash, markup: inMarkup > 0,
            });
          }
          pending = null;
          cur = null; start = null;
        }
    }
  }
  return { paths, images };
}


/**
 * Everything needed from one page: size, all line segments (flat [x1,y1,x2,y2,...] in
 * page points, y down) for snapping, and the stated scale if the drawing says one.
 */
export async function pageGeometry(pdfjs, page) {
  const viewport = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  const { paths } = walkOperators(pdfjs.OPS, ol, viewport.transform);
  let n = 0;
  for (const p of paths) n += p.segs.length;
  const segs = new Float64Array(n);
  let i = 0;
  for (const p of paths) for (const v of p.segs) segs[i++] = v;
  const tc = await page.getTextContent();
  const scale = statedScale(tc.items.map((t) => t.str));
  return {
    width: viewport.width, height: viewport.height, segs, statedScale: scale,
    wallSegs: wallLayer(paths, scale || 50), rooms: roomLabels(tc.items, viewport.transform),
    clean: {
      paths: withoutDimensions(paths).map((p) => ({ segs: Float64Array.from(p.segs), stroke: p.stroke, fill: p.fill, color: p.color, fillColor: p.fillColor, lw: p.lw, dash: p.dash, markup: p.markup })),
      notes: [...noteLabels(tc.items, viewport.transform), ...(await markupLabels(page, viewport))],
    },
  };
}

/**
 * Drop dimensions: the short thick diagonal ticks, and straight lines that have a tick near
 * one end (dimension lines and extension lines overshoot their ticks).
 */
export function withoutDimensions(paths) {
  const ticks = [];
  const isTick = (p, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    return p.stroke && !p.markup && p.lw >= 0.7 && L >= 1.5 && L <= 4.5 && Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.2 * L;
  };
  for (const p of paths) {
    const a = p.segs;
    // a tick may be drawn whole or as two half-strokes from the crossing: test its middle and both ends
    for (let i = 0; i < a.length; i += 4) {
      if (isTick(p, a[i], a[i + 1], a[i + 2], a[i + 3])) ticks.push([a[i], a[i + 1]], [a[i + 2], a[i + 3]], [(a[i] + a[i + 2]) / 2, (a[i + 1] + a[i + 3]) / 2]);
    }
  }
  if (!ticks.length) return paths;
  // grid lookup of tick centres
  const cell = 4;
  const grid = new Map();
  for (const [x, y] of ticks) { const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`; (grid.get(k) || grid.set(k, []).get(k)).push([x, y]); }
  const throughTick = (x1, y1, x2, y2) => {
    const horiz = Math.abs(y1 - y2) < 0.05;
    const vert = Math.abs(x1 - x2) < 0.05;
    if (!horiz && !vert) return false;
    const [a0, a1] = horiz ? [Math.min(x1, x2), Math.max(x1, x2)] : [Math.min(y1, y2), Math.max(y1, y2)];
    for (let t = Math.floor(a0 / cell) - 1; t <= Math.floor(a1 / cell) + 1; t++) {
      for (const d of [-1, 0, 1]) {
        const k = horiz ? `${t},${Math.floor(y1 / cell) + d}` : `${Math.floor(x1 / cell) + d},${t}`;
        for (const [tx, ty] of grid.get(k) || []) {
          // the tick must be on the line AND near one of its ends (dimension/extension lines
          // overshoot their ticks by a few points); a wall a dimension merely touches is kept
          const along = horiz ? tx : ty;
          const onLine = horiz ? Math.abs(ty - y1) < 0.6 : Math.abs(tx - x1) < 0.6;
          if (onLine && along >= a0 - 0.6 && along <= a1 + 0.6 && Math.min(along - a0, a1 - along) <= 6) return true;
        }
      }
    }
    return false;
  };
  const out = [];
  for (const p of paths) {
    if (p.markup || !p.stroke) { out.push(p); continue; }
    const a = p.segs;
    const keep = [];
    for (let i = 0; i < a.length; i += 4) {
      const [x1, y1, x2, y2] = [a[i], a[i + 1], a[i + 2], a[i + 3]];
      if (isTick(p, x1, y1, x2, y2) || (p.lw < 0.7 && throughTick(x1, y1, x2, y2))) continue;
      keep.push(x1, y1, x2, y2);
    }
    if (keep.length) out.push({ ...p, segs: keep });
  }
  return out;
}

// Roof-plan words worth keeping on the overlay (vents, pipes, hatch, ridge).
const ROOF_NOTE = /\b(tile\s*vents?|vents?|SVP|RWP|Rwp|EF|ridge|hatch|soaker|flue)\b/i;

/** Short roof notes such as "SVP rise to" / "tile vent", "Rwp" (no measurements). */
export function noteLabels(items, vt) {
  const out = [];
  for (const it of items) {
    const str = (it.str || '').trim();
    if (!str || str.length > 45 || !ROOF_NOTE.test(str) || /^[\d\s.,x×-]+$/.test(str)) continue;
    const m = mul(vt, it.transform);
    if (Math.abs(m[1]) > 0.01 * Math.abs(m[0])) continue;
    const size = Math.hypot(m[2], m[3]);
    out.push({ lines: [str], x: m[4] + (it.width * Math.hypot(vt[0], vt[1])) / 2, y: m[5] - size * 0.35, size, markup: false });
  }
  return out;
}

/** Text of markup comments (e.g. "20K vent 16/17/..."), placed at the comment box. */
export async function markupLabels(page, viewport) {
  let anns = [];
  try { anns = await page.getAnnotations(); } catch { return []; }
  const out = [];
  for (const a of anns) {
    if (a.subtype !== 'FreeText') continue;
    const raw = (a.contentsObj?.str ?? a.contents ?? '').trim();
    if (!raw) continue;
    const lines = (Array.isArray(a.textContent) && a.textContent.length ? a.textContent : raw.split(/\r\n|\r|\n/)).map((t) => t.trim()).filter(Boolean);
    const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(a.rect);
    const size = Math.max(5, Math.min(14, (Math.abs(y1 - y0) / Math.max(1, lines.length)) * 0.75));
    out.push({ lines, x: (x0 + x1) / 2, y: (y0 + y1) / 2, size, markup: true });
  }
  return out;
}

const lum = (hex) => (parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)) / 3;
const isGrey = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Math.max(...v) - Math.min(...v) < 30;
};

/**
 * The wall layer of a floor plan. CAD templates like the Barratt ones draw walls (outline +
 * hatch) in mid grey and everything else in black, so the wall layer is the mid-grey line
 * colour carrying the most linework. Returns null when no such layer stands out.
 */
export function wallLayer(paths, scaleN = 50) {
  const byColour = new Map();
  let total = 0;
  for (const p of paths) {
    if (!p.stroke) continue;
    total += p.segs.length;
    const c = p.color;
    if (!isGrey(c) || lum(c) < 60 || lum(c) > 215) continue;
    byColour.set(c, (byColour.get(c) || 0) + p.segs.length);
  }
  const best = [...byColour.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 0.2 * total) return null; // a wall layer carries a big share of the linework
  const out = [];
  for (const p of paths) if (p.stroke && p.color === best[0]) for (const v of p.segs) out.push(v);
  // partitions only inside the outline of the main wall layer (skips wall-key symbols etc.)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < out.length; i += 2) { x0 = Math.min(x0, out[i]); x1 = Math.max(x1, out[i]); y0 = Math.min(y0, out[i + 1]); y1 = Math.max(y1, out[i + 1]); }
  const inside = (x, y) => x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1;
  const part = partitionLines(paths, scaleN);
  for (let i = 0; i < part.length; i += 4) {
    if (inside(part[i], part[i + 1]) && inside(part[i + 2], part[i + 3])) out.push(part[i], part[i + 1], part[i + 2], part[i + 3]);
  }
  return Float64Array.from(out);
}

/**
 * Stud partitions drawn as two thin black lines 50-130 mm apart (63 / 98 mm studs on the
 * Barratt sheets). Finds straight black lines that run alongside a parallel partner at that
 * spacing. Furniture, beds and dimension lines rarely pair up that tightly.
 */
export function partitionLines(paths, scaleN = 50) {
  const mmPerPt = (scaleN * 25.4) / 72;
  const lo = 50 / mmPerPt;
  const hi = 130 / mmPerPt;
  const minLen = 250 / mmPerPt; // ignore short bits (fittings, symbols)
  const H = [];
  const V = [];
  for (const p of paths) {
    if (!p.stroke || !isGrey(p.color) || lum(p.color) > 60) continue; // black-ish lines only
    const a = p.segs;
    for (let i = 0; i < a.length; i += 4) {
      const [x1, y1, x2, y2] = [a[i], a[i + 1], a[i + 2], a[i + 3]];
      if (Math.abs(y1 - y2) < 0.05 && Math.abs(x2 - x1) >= minLen) H.push({ c: y1, a: Math.min(x1, x2), b: Math.max(x1, x2), s: [x1, y1, x2, y2] });
      else if (Math.abs(x1 - x2) < 0.05 && Math.abs(y2 - y1) >= minLen) V.push({ c: x1, a: Math.min(y1, y2), b: Math.max(y1, y2), s: [x1, y1, x2, y2] });
    }
  }
  const out = [];
  for (const L of [H, V]) {
    L.sort((p, q) => p.c - q.c);
    const keep = new Set();
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length && L[j].c - L[i].c <= hi; j++) {
        if (L[j].c - L[i].c < lo) continue;
        const ov = Math.min(L[i].b, L[j].b) - Math.max(L[i].a, L[j].a);
        if (ov >= 0.6 * Math.min(L[i].b - L[i].a, L[j].b - L[j].a)) { keep.add(i); keep.add(j); }
      }
    }
    for (const i of keep) out.push(...L[i].s);
  }
  return out;
}

const ROOM = /^(BED(ROOM)?\s*\d*|MASTER\s+BED(ROOM)?|BATH(ROOM)?|EN[\s-]?SUITE|LANDING|WC|ST|STORE|CUPB(OARD)?|AIRING(\s+CUPBOARD)?|STUDY|KITCHEN(\s*\/\s*DINING)?|LOUNGE|LIVING(\s+ROOM)?|DINING(\s+ROOM)?|HALL(WAY)?|UTILITY|DRESSING(\s+ROOM)?|SHOWER(\s+ROOM)?|CLOAKS?(\s+ROOM)?|FAMILY(\s+ROOM)?|GARAGE|PLANT)$/i;

/** Room names (BED 1, EN-SUITE, BATH, LANDING ...) with their centre in page points. */
export function roomLabels(items, vt) {
  const out = [];
  for (const it of items) {
    const str = (it.str || '').trim().replace(/\s+/g, ' ');
    if (!str || str.length > 20 || !ROOM.test(str)) continue;
    const m = mul(vt, it.transform);
    if (Math.abs(m[1]) > 0.01 * Math.abs(m[0])) continue; // horizontal labels only
    const size = Math.hypot(m[2], m[3]);
    const w = it.width * Math.hypot(vt[0], vt[1]);
    out.push({ str, x: m[4] + w / 2, y: m[5] - size * 0.35, size });
  }
  return out;
}

/** "1:50", "1 : 50" ... The most common stated scale on the sheet, or null. */
export function statedScale(strings) {
  const counts = new Map();
  for (const s of strings) {
    for (const m of String(s).matchAll(/\b1\s*:\s*(\d{1,4})\b/g)) counts.set(+m[1], (counts.get(+m[1]) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
