// RoofLine: lay a roof plan over a floor plan. Choose the two PDFs, tap the same corner on
// each, and the roof sits on top of the floor plan. Everything stays on this device.
import * as db from './db.js';
import { openPdf, loadPage, tint } from './pdfdoc.js';
import { Viewer } from './viewer.js';
import { snapNear, roofToFloorPoint, houseArea, inArea, scaleRatio } from './geom.js';
import { STANDARD_SCALES } from './pdf-extract.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const ROOF_TINT = '#e00000';
const FLOOR_TINT = '#0047c2';
const NOTICE = 'Setting-out aid only. Vent positions on the roof plan are indicative. Check against the truss layout / designer before fixing.';

// saved between visits (IndexedDB, this device only)
let saved = { roof: null, floor: null, align: null, nudge: { x: 0, y: 0 }, opacity: 0.6, colour: true, flip: false, wallsOnly: true, cleanRoof: true, crop: true, scaleOverride: { roof: null, floor: null } };
// loaded drawings: { doc, pages, page, canvas, scale, width, height, segs, statedScale, tinted }
const dr = { roof: null, floor: null };
let mode = 'view'; // view | pick-roof | pick-floor | move
let viewer = null;
let fullView = false; // drawing fills the whole screen

// ---------------------------------------------------------------- helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
/** Replace an element's children; flattens arrays and skips empty values. */
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== ''));
function toast(t, ms = 2500) {
  $toast.textContent = t;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.hidden = true; }, ms);
}
const save = () => db.kvSet('overlay', saved).catch(() => {});

function pickFile() {
  return new Promise((resolve) => {
    const i = h('input', { type: 'file', accept: 'application/pdf,.pdf', style: 'display:none' });
    i.addEventListener('change', () => { resolve(i.files[0] || null); i.remove(); });
    document.body.append(i);
    i.click();
  });
}

// ---------------------------------------------------------------- geometry
/**
 * Each drawing's scale (the N in 1:N): the one you set by hand, else the one the app worked
 * out (measured from the drawing's dimensions, or read from its text and corrected for the
 * page size).
 */
const scaleN = (slot) => saved.scaleOverride?.[slot] || dr[slot]?.drawingScale?.n || null;
/** Roof page points -> floor page points: bring both drawings to the same scale. */
function roofRatio() {
  return scaleRatio(scaleN('roof'), scaleN('floor'));
}
const SOURCE_TEXT = { dimensions: 'measured from its dimensions', stated: 'read from the drawing text', 'stated-page': 'from the drawing text, corrected for the page size' };
function scaleSource(slot) {
  if (saved.scaleOverride?.[slot]) return 'set by you';
  const d = dr[slot]?.drawingScale;
  if (!d) return 'not found';
  return d.weak ? 'from one dimension only, please check' : SOURCE_TEXT[d.source];
}
/** One plain sentence about how the drawings were matched. */
function matchText() {
  const a = scaleN('roof');
  const b = scaleN('floor');
  if (!a || !b) return `Couldn't work out the scale of the ${!a ? 'roof' : 'floor'} plan, so the drawings are assumed to be at the same scale.`;
  const r = a / b;
  if (Math.abs(r - 1) < 0.005) return `Both drawings are 1:${a}. No resizing needed.`;
  const x = r >= 1 ? r : 1 / r;
  return `Roof is 1:${a}, floor is 1:${b}. The roof is ${r > 1 ? 'enlarged' : 'reduced'} ×${+x.toFixed(2)} to match.`;
}
const roofToFloor = (x, y) => roofToFloorPoint(x, y, saved.align, roofRatio(), saved.nudge);
/** Area where the two sheets overlap (in floor points): a good first view after lining up. */
function overlapBox() {
  const f = dr.floor;
  const r = dr.roof;
  const a = roofToFloor(0, 0);
  const b = roofToFloor(r.width, r.height);
  const box = { x0: Math.max(0, Math.min(a.x, b.x)), y0: Math.max(0, Math.min(a.y, b.y)), x1: Math.min(f.width, Math.max(a.x, b.x)), y1: Math.min(f.height, Math.max(a.y, b.y)) };
  return box.x1 > box.x0 && box.y1 > box.y0 ? box : { x0: 0, y0: 0, x1: f.width, y1: f.height };
}

/** Best first view: the house on the floor plan (every sizeable block of it, wings included). */
function homeBox() { return flipBox(homeBoxUnflipped()); }
function homeBoxUnflipped() {
  const u = dr.floor?.fit?.union;
  if (!u || !(u.x1 > u.x0) || !(u.y1 > u.y0)) return overlapBox();
  const m = 0.06 * Math.max(u.x1 - u.x0, u.y1 - u.y0);
  return { x0: u.x0 - m, y0: u.y0 - m, x1: u.x1 + m, y1: u.y1 + m };
}

// Flip (opposite hand): mirror the whole overlay left-right about a vertical line through
// the lined-up corner. Roof and floor flip together, so they stay lined up.
const flipping = () => saved.flip && mode !== 'pick-roof' && mode !== 'pick-floor';
const axis = () => (saved.align?.floorRef ? saved.align.floorRef.x : (dr.floor?.width || 0) / 2);
const fx = (x) => (flipping() ? 2 * axis() - x : x);
const flipBox = (b) => (flipping() ? { x0: fx(b.x1), y0: b.y0, x1: fx(b.x0), y1: b.y1 } : b);
const showWallsOnly = () => saved.wallsOnly && !!dr.floor?.wallSegs;
const showCleanRoof = () => saved.cleanRoof && !!dr.roof?.clean;
// floor plans without a wall layer: hide measurements etc. by cleaning the drawing instead
const showCleanFloor = () => saved.wallsOnly && !dr.floor?.wallSegs && !!dr.floor?.clean;

/** Floor point -> roof point (inverse of roofToFloor). */
function floorToRoof(x, y) {
  const k = roofRatio();
  const al = saved.align;
  const n = saved.nudge;
  if (!al?.roofRef || !al?.floorRef) return { x: (x - n.x) / k, y: (y - n.y) / k };
  return { x: (x - n.x - al.floorRef.x) / k + al.roofRef.x, y: (y - n.y - al.floorRef.y) / k + al.roofRef.y };
}
/**
 * Roof linework worth drawing, in roof page points: the roof's own plan blocks plus wherever the
 * floor plan's blocks fall once lined up (the roof can have wings or eaves beyond one's outline).
 * null = draw everything (crop switched off, or nothing found).
 */
function roofArea() {
  const r = dr.roof;
  if (!saved.crop || !r?.area) return null;
  const boxes = r.area.boxes.slice();
  if (saved.align?.floorRef && dr.floor?.area) {
    for (const b of dr.floor.area.boxes) {
      const a = floorToRoof(b.x0, b.y0);
      const c = floorToRoof(b.x1, b.y1);
      boxes.push({ x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) });
    }
  }
  return { boxes };
}
const floorAreaOrNull = () => (saved.crop && dr.floor?.area ? dr.floor.area : null);

// ---------------------------------------------------------------- drawing
function drawPage(ctx, view, d, img, dpr, m0) {
  // m = [a, b, c, d, e, f] page points -> floor points (identity for the floor itself)
  const m = flipping() ? [-m0[0], 0, 0, m0[3], 2 * axis() - m0[4], m0[5]] : m0;
  const s = view.s;
  const k = 1 / d.scale;
  ctx.setTransform(dpr * s * m[0] * k, 0, 0, dpr * s * m[3] * k, dpr * (s * m[4] + view.tx), dpr * (s * m[5] + view.ty));
  ctx.drawImage(img, 0, 0);
}

function draw(ctx, view, info) {
  const dpr = info.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, info.w, info.h);
  ctx.imageSmoothingEnabled = true;
  if (mode === 'pick-roof' && dr.roof) { drawPage(ctx, view, dr.roof, dr.roof.canvas, dpr, [1, 0, 0, 1, 0, 0]); return marks(ctx, view, dpr, saved.align?.roofRef); }
  if (mode === 'pick-floor' && dr.floor) { drawPage(ctx, view, dr.floor, dr.floor.canvas, dpr, [1, 0, 0, 1, 0, 0]); return marks(ctx, view, dpr, saved.align?.floorRef); }
  if (dr.floor) {
    if (showWallsOnly()) drawWalls(ctx, view, dpr);
    else if (showCleanFloor()) drawFloorClean(ctx, view, dpr);
    else drawPage(ctx, view, dr.floor, saved.colour ? dr.floor.tinted : dr.floor.canvas, dpr, [1, 0, 0, 1, 0, 0]);
  }
  if (dr.roof && showCleanRoof()) drawRoofClean(ctx, view, dpr);
  else if (dr.roof) {
    const o = roofToFloor(0, 0);
    const k = roofRatio();
    ctx.save();
    ctx.globalAlpha = saved.opacity;
    ctx.globalCompositeOperation = 'multiply'; // white paper becomes see-through
    drawPage(ctx, view, dr.roof, saved.colour ? dr.roof.tinted : dr.roof.canvas, dpr, [k, 0, 0, k, o.x, o.y]);
    ctx.restore();
  }
  if (dr.floor && (showWallsOnly() || showCleanFloor())) drawRooms(ctx, view, dpr); // room names on top, never mirrored
  if (saved.align) marks(ctx, view, dpr, { x: fx(saved.align.floorRef.x + saved.nudge.x), y: saved.align.floorRef.y + saved.nudge.y });
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const isColour = (hex) => { const v = rgb(hex); return Math.max(...v) - Math.min(...v) >= 40; };
const lightness = (hex) => rgb(hex).reduce((a, b) => a + b, 0) / 765;

/**
 * Roof plan drawn from its own linework, without dimensions, measurements, title block or
 * keys. Markups (vent / PV boxes and their notes) are always kept.
 */
function drawRoofClean(ctx, view, dpr) {
  drawClean(ctx, view, dpr, { data: dr.roof.clean, toFloor: roofToFloor, area: roofArea(), tint: ROOF_TINT, alpha: saved.opacity, k: roofRatio(), notes: true });
}

/**
 * Floor plan without a separate wall layer: same clean-up as the roof (no dimensions,
 * measurements, keys, schedules or title block); room names are drawn by drawRooms.
 */
function drawFloorClean(ctx, view, dpr) {
  drawClean(ctx, view, dpr, { data: dr.floor.clean, toFloor: (x, y) => ({ x, y }), area: floorAreaOrNull(), tint: FLOOR_TINT, alpha: 1, k: 1, notes: false });
}

function drawClean(ctx, view, dpr, o) {
  const { s, tx, ty } = view;
  const inReg = (x, y) => inArea(o.area, x, y);
  const P = (x, y) => { const f = o.toFloor(x, y); return [fx(f.x) * s + tx, f.y * s + ty]; };
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = o.alpha;
  ctx.lineCap = 'round';
  for (const p of o.data.paths) {
    const a = p.segs;
    if (!p.markup && p.fill) {
      // filled shapes (wall poche etc.): keep or drop as a whole
      let cx = 0, cy = 0;
      for (let i = 0; i < a.length; i += 2) { cx += a[i]; cy += a[i + 1]; }
      if (!inReg(cx / (a.length / 2), cy / (a.length / 2))) continue;
    }
    ctx.beginPath();
    let lx = NaN, ly = NaN;
    let any = false;
    for (let i = 0; i < a.length; i += 4) {
      // lines are judged one by one: keys, schedules and notes drop out, the plan never does
      if (!p.markup && !p.fill && !inReg((a[i] + a[i + 2]) / 2, (a[i + 1] + a[i + 3]) / 2)) continue;
      if (a[i] !== lx || a[i + 1] !== ly) ctx.moveTo(...P(a[i], a[i + 1]));
      ctx.lineTo(...P(a[i + 2], a[i + 3]));
      lx = a[i + 2]; ly = a[i + 3];
      any = true;
    }
    if (!any) continue;
    // coloured items (pink vent boxes, yellow PV areas) keep their colour; black/grey linework
    // takes the roof colour. White fills are text backgrounds and are skipped.
    if (p.fill && p.fillColor !== '#ffffff') {
      const own = p.markup || !saved.colour || isColour(p.fillColor);
      ctx.save();
      ctx.globalAlpha = o.alpha * (isColour(p.fillColor) ? 0.5 : lightness(p.fillColor) > 0.5 ? 0.25 : 1);
      ctx.fillStyle = own ? p.fillColor : o.tint;
      ctx.fill('evenodd');
      ctx.restore();
    }
    if (p.stroke && p.color !== '#ffffff') {
      ctx.strokeStyle = p.markup || !saved.colour || isColour(p.color) ? p.color : o.tint;
      ctx.lineWidth = Math.max(p.markup ? 1.5 : 0.8, Math.min(3, p.lw * s * o.k));
      ctx.setLineDash(p.dash ? [5, 3] : []);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  // notes: markups always, other roof notes inside the house area; never mirrored
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const n of o.notes ? o.data.notes : o.data.notes.filter((q) => q.markup)) {
    if (!n.markup && !inReg(n.x, n.y)) continue;
    const [x, y] = P(n.x, n.y);
    const px = Math.max(9, Math.min(18, n.size * s * o.k));
    const lh = px * 1.15;
    ctx.font = `${n.markup ? 'bold ' : ''}${px}px system-ui, -apple-system, sans-serif`;
    n.lines.forEach((t, i) => {
      const yy = y + (i - (n.lines.length - 1) / 2) * lh;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(t, x, yy);
      ctx.fillStyle = n.markup ? '#a0005a' : saved.colour ? '#b00000' : '#000000';
      ctx.fillText(t, x, yy);
    });
  }
  ctx.restore();
}

/** Floor plan reduced to its wall layer. */
function drawWalls(ctx, view, dpr) {
  const g = dr.floor.wallSegs;
  const { s, tx, ty } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = saved.colour ? FLOOR_TINT : '#333333';
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < g.length; i += 4) {
    ctx.moveTo(fx(g[i]) * s + tx, g[i + 1] * s + ty);
    ctx.lineTo(fx(g[i + 2]) * s + tx, g[i + 3] * s + ty);
  }
  ctx.stroke();
}

/** Room names, upright and readable even when flipped. */
function drawRooms(ctx, view, dpr) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const r of dr.floor.rooms || []) {
    const px = Math.max(11, Math.min(26, r.size * view.s));
    const x = fx(r.x) * view.s + view.tx;
    const y = r.y * view.s + view.ty;
    ctx.font = `bold ${px}px system-ui, -apple-system, sans-serif`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(r.str, x, y);
    ctx.fillStyle = saved.colour ? '#002f86' : '#000000';
    ctx.fillText(r.str, x, y);
  }
}

function marks(ctx, view, dpr, p) {
  if (!p) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = p.x * view.s + view.tx;
  const y = p.y * view.s + view.ty;
  ctx.strokeStyle = '#ff8c00';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
}

// ---------------------------------------------------------------- loading
async function loadSlot(slot, info) {
  const f = await db.get('files', info.fileId);
  if (!f) throw new Error('That drawing is no longer stored on this phone. Choose it again.');
  const doc = await openPdf(f.data);
  const pageNo = Math.min(info.page || 1, doc.numPages);
  const p = await loadPage(doc, pageNo);
  dr[slot] = { ...p, doc, pages: doc.numPages, page: pageNo, name: info.name, tinted: tint(p.canvas, slot === 'roof' ? ROOF_TINT : FLOOR_TINT) };
  // Plan areas, found once per drawing: `area` (generous) decides which lines count as the plan
  // rather than keys / schedules; `fit` (tight) is the first view. Blocks holding room names
  // are always kept, so a separate wing is never lost.
  // Worked out on the line work with dimensions and the sheet border already removed: dimension
  // lines are what join a house to the notes and keys around it.
  const plan = [];
  for (const q of p.clean?.paths || []) if (!q.markup) for (const v of q.segs) plan.push(v);
  const planSegs = plan.length ? Float64Array.from(plan) : p.segs;
  dr[slot].area = houseArea(planSegs, p.width, p.height, p.rooms || []);
  dr[slot].fit = houseArea(planSegs, p.width, p.height, p.rooms || [], { cell: 10, gap: 2, pad: 0 });
}

async function choose(slot) {
  const file = await pickFile();
  if (!file) return;
  toast('Opening drawing…', 20000);
  try {
    const buf = await file.arrayBuffer();
    const fileId = await db.saveFile(file.name, buf);
    saved[slot] = { fileId, name: file.name, page: 1 };
    saved.scaleOverride = { ...saved.scaleOverride, [slot]: null };
    saved.align = null; // a new drawing needs lining up again
    saved.nudge = { x: 0, y: 0 };
    await loadSlot(slot, saved[slot]);
    await save();
    db.requestPersistence();
    $toast.hidden = true;
    if (dr.roof && dr.floor) {
      startLineUp();
      if (Math.abs(roofRatio() - 1) >= 0.005 || !scaleN('roof') || !scaleN('floor')) toast(matchText(), 6000);
    } else render();
  } catch (e) {
    toast('Could not open that PDF: ' + e.message, 6000);
  }
}

async function setPage(slot, n) {
  saved[slot].page = n;
  saved.scaleOverride = { ...saved.scaleOverride, [slot]: null };
  saved.align = null;
  saved.nudge = { x: 0, y: 0 };
  toast('Opening page…', 20000);
  await loadSlot(slot, saved[slot]);
  $toast.hidden = true;
  await save();
  render();
}

// ---------------------------------------------------------------- line up
function startLineUp() {
  mode = 'pick-roof';
  render();
}

function onPoint(p) {
  if (mode === 'pick-roof') {
    saved.align = { roofRef: p, floorRef: saved.align?.floorRef || null };
    mode = 'pick-floor';
    render();
  } else if (mode === 'pick-floor') {
    saved.align.floorRef = p;
    saved.nudge = { x: 0, y: 0 };
    mode = 'view';
    save();
    render();
    toast('Lined up. Pinch to zoom. Use "Move roof" to nudge it if needed.');
  }
}

// ---------------------------------------------------------------- screen
// ---------------------------------------------------------------- interface
const ICONS = {
  roof: '<path d="M3 12l9-8 9 8"/><path d="M5.5 10.5V20h13v-9.5"/><circle cx="12" cy="14.5" r="2"/>',
  floor: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h8M12 4v8M12 16v4M16 12h4"/>',
  target: '<circle cx="12" cy="12" r="4"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  flip: '<path d="M12 3v18" stroke-dasharray="2 3"/><path d="M9 7L3 12l6 5z"/><path d="M15 7l6 5-6 5z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
  shrink: '<path d="M14 4v6h6M10 20v-6H4M14 10l6.5-6.5M10 14l-6.5 6.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>',
};
function ico(name) {
  const el = document.createElement('span');
  el.className = 'ico';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;
  return el;
}
const LOGO = '<svg class="logo" viewBox="0 0 40 40" aria-hidden="true"><rect x="7" y="19" width="26" height="16" rx="2.5" fill="none" stroke="#1c4fd8" stroke-width="3"/><path d="M4 21L20 6l16 15" fill="none" stroke="#d92b2b" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="27" r="3" fill="#d92b2b"/></svg>';

function header() {
  const brand = h('div', { class: 'brand' });
  brand.insertAdjacentHTML('afterbegin', LOGO);
  const words = h('div', null,
    h('div', { class: 'wordmark' }, 'Roof', h('b', null, 'Line')),
    h('div', { class: 'tagline' }, 'Roof plan over floor plan'));
  brand.append(words);
  return h('header', { class: 'appbar' }, brand, h('span', { class: 'pill', title: 'Drawings never leave this device' }, ico('lock'), 'On this device only'));
}

function progress(picking) {
  const both = dr.roof && dr.floor;
  const done = [!!dr.roof, !!dr.floor, !!(both && !picking && saved.align)];
  const cur = !dr.roof ? 0 : !dr.floor ? 1 : done[2] ? 3 : 2;
  const labels = ['Roof plan', 'Floor plan', 'Line up'];
  return h('ol', { class: 'steps', 'aria-label': 'Progress' }, labels.map((t, i) => h('li', { class: done[i] ? 'done' : i === cur ? 'current' : '' },
    h('span', { class: 'n' }, done[i] ? ico('check') : String(i + 1)), h('span', { class: 't' }, t))));
}

function slotCard(slot, label) {
  const d = dr[slot];
  return h('div', { class: `file ${slot}` },
    h('div', { class: 'badge-ico' }, ico(slot)),
    h('div', null,
      h('div', { class: 'label' }, label),
      h('div', { class: d ? 'name set' : 'name' }, d ? d.name : 'No drawing chosen'),
      d && d.pages > 1 ? h('label', { class: 'page' }, 'Page ',
        h('select', { onchange: (e) => setPage(slot, +e.target.value) },
          Array.from({ length: d.pages }, (_, i) => h('option', { value: i + 1, selected: d.page === i + 1 }, String(i + 1))))) : null),
    h('button', { class: d ? 'small' : (slot === 'roof' || dr.roof) ? 'primary' : '', onclick: () => choose(slot) }, d ? 'Change' : 'Choose PDF'));
}

function instruction() {
  const note = (n, ...kids) => h('div', { class: 'callout' }, h('span', { class: 'num' }, typeof n === 'string' ? ico(n) : String(n)), h('p', null, ...kids));
  if (!dr.roof || !dr.floor) return note(!dr.roof ? 1 : 2, !dr.roof ? 'Choose the roof plan PDF.' : 'Now choose the floor plan PDF (first or second floor).');
  if (mode === 'pick-roof') return note(1, h('strong', null, 'Line up 1 of 2: '), 'tap a corner of the building on the ROOF plan (e.g. the top-left outside corner of the walls). Drag one finger to aim, lift to place. Two fingers to zoom.');
  if (mode === 'pick-floor') return note(2, h('strong', null, 'Line up 2 of 2: '), 'tap the SAME corner on the FLOOR plan.');
  if (mode === 'move') return note('move', h('strong', null, 'Move roof: '), 'drag with one finger to slide the roof drawing. Tap Done when it sits right.');
  if (!saved.align) return note(3, 'Not lined up yet. Tap ', h('strong', null, 'Line up'), ' and pick the same corner on each drawing.');
  return null;
}

let scaleBoxOpen = false;
function scaleBox() {
  const unknown = !scaleN('roof') || !scaleN('floor');
  const differ = Math.abs(roofRatio() - 1) >= 0.005;
  const pick = (slot, label) => h('label', { class: 'scalepick', for: `scale-${slot}` }, h('span', null, label),
    h('select', { id: `scale-${slot}`, onchange: (e) => { saved.scaleOverride = { ...saved.scaleOverride, [slot]: e.target.value ? +e.target.value : null }; scaleBoxOpen = true; save(); render(); } },
      h('option', { value: '' }, `Auto${dr[slot]?.drawingScale ? ` (1:${dr[slot].drawingScale.n})` : ' (not found)'}`),
      STANDARD_SCALES.map((n) => h('option', { value: n, selected: saved.scaleOverride?.[slot] === n }, `1:${n}`))),
    h('small', null, scaleSource(slot)));
  return h('details', { class: `scalebox ${unknown ? 'warn' : differ ? 'diff' : ''}`, open: unknown || differ || scaleBoxOpen || !!(saved.scaleOverride?.roof || saved.scaleOverride?.floor), ontoggle: (e) => { if (e.target.open) scaleBoxOpen = true; } },
    h('summary', null, h('span', { class: 'sumtitle' }, 'Drawing scales'), h('span', { class: 'sumtext' }, matchText())),
    h('div', { class: 'scalepicks' }, pick('roof', 'Roof plan'), pick('floor', 'Floor plan')),
    h('p', { class: 'small muted' }, 'The app measures each drawing\'s scale from its dimensions and resizes the roof to match the floor. If a drawing looks the wrong size, set its scale here.'));
}

const tool = (icon, text, onclick, extra = {}) => h('button', { class: `tool ${extra.class || ''}`, onclick, 'aria-pressed': extra.pressed == null ? null : String(extra.pressed) }, ico(icon), text);
/**
 * Full screen: the drawing box covers the page (works everywhere, including iPhone), and where
 * the browser allows it the browser's own bars are hidden too.
 */
function setFullView(on) {
  if (on === fullView) return;
  fullView = on;
  document.body.classList.toggle('noscroll', on);
  const de = document.documentElement;
  if (on && de.requestFullscreen && !document.fullscreenElement) de.requestFullscreen().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  render();
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && fullView) setFullView(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fullView) setFullView(false); });

const toggle = (id, text, checked, onchange) => h('label', { class: 'switch' }, text, h('input', { id, type: 'checkbox', checked, onchange }));

function render() {
  const both = dr.roof && dr.floor;
  const canvas = h('canvas', { 'aria-label': 'Roof plan over floor plan' });
  const picking = mode === 'pick-roof' || mode === 'pick-floor';
  const hasDrawing = both || dr.roof || dr.floor;

  const chips = both && !picking ? h('div', { class: 'chips' },
    saved.colour ? [h('span', { class: 'chip' }, h('i', { class: 'dot floor' }), 'Floor plan'), h('span', { class: 'chip' }, h('i', { class: 'dot roof' }), 'Roof plan')] : h('span', { class: 'chip' }, 'Roof plan on floor plan')) : null;

  const tools = both ? (picking
    ? h('div', { class: 'tools two a-tools' },
      mode === 'pick-floor' ? tool('undo', '‹ Back to roof', () => { mode = 'pick-roof'; render(); }) : null,
      tool('close', 'Cancel', () => { mode = 'view'; if (saved.align && !saved.align.floorRef) saved.align = null; render(); }))
    : h('div', { class: 'tools a-tools' },
      tool('target', saved.align ? 'Line up again' : 'Line up', startLineUp, { class: saved.align ? '' : 'primary' }),
      tool('move', mode === 'move' ? 'Done' : 'Move roof', () => { mode = mode === 'move' ? 'view' : 'move'; if (mode === 'view') save(); render(); }, { class: mode === 'move' ? 'on' : '' }),
      tool('fit', 'Fit', () => viewer.fit(homeBox(), 8)),
      tool('flip', saved.flip ? 'Flipped ✓' : 'Flip (opp. hand)', () => { saved.flip = !saved.flip; save(); render(); }, { class: saved.flip ? 'on' : '', pressed: !!saved.flip }))) : null;

  const pct = Math.round(saved.opacity * 100);
  const options = both && !picking ? h('div', { class: 'panel a-options' },
    h('div', { class: 'sliderrow' }, h('label', { for: 'opacity' }, 'Roof see-through'), h('output', { id: 'opacityval', for: 'opacity' }, `${pct}%`)),
    h('input', { id: 'opacity', type: 'range', min: 10, max: 100, value: pct, oninput: (e) => { saved.opacity = e.target.value / 100; document.getElementById('opacityval').textContent = `${e.target.value}%`; viewer.redraw(); }, onchange: save }),
    scaleBox(),
    toggle('walls', dr.floor.wallSegs ? 'Floor plan: walls and room names only' : 'Floor plan: hide measurements, keys and notes', saved.wallsOnly, (e) => { saved.wallsOnly = e.target.checked; save(); viewer.redraw(); }),
    toggle('cleanroof', 'Roof plan: hide measurements and sheet notes', saved.cleanRoof, (e) => { saved.cleanRoof = e.target.checked; save(); render(); }),
    toggle('crop', 'Hide keys, schedules and sheet notes', saved.crop, (e) => { saved.crop = e.target.checked; save(); viewer.redraw(); }),
    toggle('colour', 'Colour the drawings (roof red, floor blue)', saved.colour, (e) => { saved.colour = e.target.checked; save(); render(); }),
    saved.nudge.x || saved.nudge.y ? h('button', { class: 'small linkbtn', onclick: () => { saved.nudge = { x: 0, y: 0 }; save(); viewer.redraw(); render(); } }, ico('undo'), 'Undo roof moves') : null) : null;

  const notice = both ? h('p', { class: 'notice a-notice', role: 'note' }, ico('info'), NOTICE) : null;
  const hint = instruction();
  const layout = h('div', { class: `layout ${hasDrawing ? '' : 'empty'} ${hint ? 'hinted' : ''}` },
    h('div', { class: `files a-files ${both ? 'compact' : ''}` }, slotCard('roof', 'Roof plan'), slotCard('floor', 'Floor plan')),
    hint && !fullView ? (hint.classList.add('a-hint'), hint) : null,
    hasDrawing ? h('div', { class: `canvaswrap a-canvas ${picking ? 'aiming' : ''} ${fullView ? 'full' : ''}` },
      fullView && hint ? h('div', { class: 'fullhint' }, hint) : null,
      h('div', { class: 'stage' }, canvas,
      both && saved.flip && !picking ? h('div', { class: 'modebar' }, h('span', { class: 'mirrorbadge' }, showCleanRoof() ? 'FLIPPED - opposite hand' : 'FLIPPED - opposite hand. Roof writing reads backwards.')) : null,
      chips,
      h('button', { class: 'fullbtn', 'aria-label': fullView ? 'Exit full screen' : 'Full screen', title: fullView ? 'Exit full screen' : 'Full screen', onclick: () => setFullView(!fullView) }, ico(fullView ? 'shrink' : 'expand')),
      h('div', { class: 'canvasbtns' },
        h('button', { 'aria-label': 'Zoom in', onclick: () => viewer.zoomBy(1.6) }, '+'),
        h('button', { 'aria-label': 'Zoom out', onclick: () => viewer.zoomBy(1 / 1.6) }, '−'))),
      fullView && tools ? h('div', { class: 'fullbar' }, tools) : null) : null,
    fullView ? null : tools, options, notice);

  put($app, header(), progress(picking), layout, h('p', { class: 'foot' }, 'Drawings stay on this device. Nothing is uploaded.'));

  viewer?.destroy();
  viewer = null;
  if (!(both || dr.roof || dr.floor)) { if (fullView) setFullView(false); return; }
  viewer = new Viewer(canvas, {
    draw,
    onPoint,
    snap: (w, r) => {
      const d = mode === 'pick-roof' ? dr.roof : mode === 'pick-floor' ? dr.floor : null;
      return d ? snapNear(d.segs, w, r) : null;
    },
    onDrag: (dx, dy) => { saved.nudge = { x: saved.nudge.x + (flipping() ? -dx : dx), y: saved.nudge.y + dy }; },
  });
  viewer.setMode(picking ? 'point' : mode === 'move' ? 'drag' : 'pan');
  viewer.resize();
  const solo = picking ? (mode === 'pick-roof' ? dr.roof : dr.floor) : (!both ? (dr.roof || dr.floor) : null);
  if (solo) viewer.fit({ x0: 0, y0: 0, x1: solo.width, y1: solo.height }, 8);
  else viewer.fit(homeBox(), 8);
}

// ---------------------------------------------------------------- start
async function boot() {
  window.__roofline = { dr, saved: () => saved, viewer: () => viewer, roofRatio: () => roofRatio(), roofToFloor: (x, y) => roofToFloor(x, y), homeBox: () => homeBox() }; // used by automated tests
  try { saved = { ...saved, ...(await db.kvGet('overlay', {})) }; } catch { /* first run */ }
  for (const slot of ['roof', 'floor']) {
    if (!saved[slot]) continue;
    try { await loadSlot(slot, saved[slot]); } catch (e) { saved[slot] = null; toast(e.message, 5000); }
  }
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // When a new version of the app has been downloaded, reload once so it is used straight
    // away (drawings and line-up are kept on the device, so nothing is lost).
    const updating = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
  }
}
boot();
