// RoofLine: lay a roof plan over a floor plan. Choose the two PDFs, tap the same corner on
// each, and the roof sits on top of the floor plan. Everything stays on this device.
import * as db from './db.js';
import { openPdf, loadPage, tint } from './pdfdoc.js';
import { Viewer } from './viewer.js';
import { snapNear, roofToFloorPoint, regionAround } from './geom.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const ROOF_TINT = '#e00000';
const FLOOR_TINT = '#0047c2';
const NOTICE = 'Setting-out aid only. Vent positions on the roof plan are indicative. Check against the truss layout / designer before fixing.';

// saved between visits (IndexedDB, this device only)
let saved = { roof: null, floor: null, align: null, nudge: { x: 0, y: 0 }, opacity: 0.6, colour: true, flip: false, wallsOnly: true };
// loaded drawings: { doc, pages, page, canvas, scale, width, height, segs, statedScale, tinted }
const dr = { roof: null, floor: null };
let mode = 'view'; // view | pick-roof | pick-floor | move
let viewer = null;

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
/** Roof page points -> floor page points. Scale from the drawings' stated scales (1:N). */
function roofRatio() {
  const a = dr.roof?.statedScale;
  const b = dr.floor?.statedScale;
  return a && b ? a / b : 1;
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

/** Best first view: the house on the floor plan, found around the tapped corner. */
function homeBox() { return flipBox(homeBoxUnflipped()); }
function homeBoxUnflipped() {
  const f = dr.floor;
  if (!saved.align?.floorRef || !f) return overlapBox();
  const seed = saved.align.floorRef;
  let box = null;
  for (const cell of [8, 14]) {
    box = regionAround(f.segs, f.width, f.height, seed, cell);
    if (box && box.x1 - box.x0 > 0.12 * f.width && box.y1 - box.y0 > 0.12 * f.height) break;
  }
  if (!box) return overlapBox();
  const m = 0.06 * Math.max(box.x1 - box.x0, box.y1 - box.y0);
  return { x0: box.x0 - m, y0: box.y0 - m, x1: box.x1 + m, y1: box.y1 + m };
}

// Flip (opposite hand): mirror the whole overlay left-right about a vertical line through
// the lined-up corner. Roof and floor flip together, so they stay lined up.
const flipping = () => saved.flip && mode !== 'pick-roof' && mode !== 'pick-floor';
const axis = () => (saved.align?.floorRef ? saved.align.floorRef.x : (dr.floor?.width || 0) / 2);
const fx = (x) => (flipping() ? 2 * axis() - x : x);
const flipBox = (b) => (flipping() ? { x0: fx(b.x1), y0: b.y0, x1: fx(b.x0), y1: b.y1 } : b);
const showWallsOnly = () => saved.wallsOnly && !!dr.floor?.wallSegs;

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
    else drawPage(ctx, view, dr.floor, saved.colour ? dr.floor.tinted : dr.floor.canvas, dpr, [1, 0, 0, 1, 0, 0]);
  }
  if (dr.roof) {
    const o = roofToFloor(0, 0);
    const k = roofRatio();
    ctx.save();
    ctx.globalAlpha = saved.opacity;
    ctx.globalCompositeOperation = 'multiply'; // white paper becomes see-through
    drawPage(ctx, view, dr.roof, saved.colour ? dr.roof.tinted : dr.roof.canvas, dpr, [k, 0, 0, k, o.x, o.y]);
    ctx.restore();
  }
  if (dr.floor && showWallsOnly()) drawRooms(ctx, view, dpr); // room names on top, never mirrored
  if (saved.align) marks(ctx, view, dpr, { x: fx(saved.align.floorRef.x + saved.nudge.x), y: saved.align.floorRef.y + saved.nudge.y });
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
}

async function choose(slot) {
  const file = await pickFile();
  if (!file) return;
  toast('Opening drawing…', 20000);
  try {
    const buf = await file.arrayBuffer();
    const fileId = await db.saveFile(file.name, buf);
    saved[slot] = { fileId, name: file.name, page: 1 };
    saved.align = null; // a new drawing needs lining up again
    saved.nudge = { x: 0, y: 0 };
    await loadSlot(slot, saved[slot]);
    await save();
    db.requestPersistence();
    $toast.hidden = true;
    if (dr.roof && dr.floor) startLineUp();
    else render();
  } catch (e) {
    toast('Could not open that PDF: ' + e.message, 6000);
  }
}

async function setPage(slot, n) {
  saved[slot].page = n;
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
function slotCard(slot, label) {
  const d = dr[slot];
  return h('div', { class: 'card filecard' },
    h('div', { class: 'filelabel' }, h('span', { class: `swatch ${slot}` }), label),
    d ? h('div', { class: 'filename' }, d.name) : h('div', { class: 'muted' }, 'No drawing chosen'),
    d && d.pages > 1 ? h('label', { class: 'inline' }, 'Page ',
      h('select', { onchange: (e) => setPage(slot, +e.target.value) },
        Array.from({ length: d.pages }, (_, i) => h('option', { value: i + 1, selected: d.page === i + 1 }, String(i + 1))))) : null,
    h('button', { class: d ? '' : 'primary', onclick: () => choose(slot) }, d ? 'Change' : 'Choose PDF'));
}

function instruction() {
  if (!dr.roof || !dr.floor) return h('p', { class: 'step' }, !dr.roof ? 'Choose the roof plan PDF.' : 'Now choose the floor plan PDF (first or second floor).');
  if (mode === 'pick-roof') return h('p', { class: 'step' }, h('strong', null, 'Line up 1 of 2: '), 'tap a corner of the building on the ROOF plan (e.g. the top-left outside corner of the walls). Drag one finger to aim, lift to place. Two fingers to zoom.');
  if (mode === 'pick-floor') return h('p', { class: 'step' }, h('strong', null, 'Line up 2 of 2: '), 'tap the SAME corner on the FLOOR plan.');
  if (mode === 'move') return h('p', { class: 'step' }, h('strong', null, 'Move roof: '), 'drag with one finger to slide the roof drawing. Tap Done when it sits right.');
  if (!saved.align) return h('p', { class: 'step' }, 'Not lined up yet. Tap ', h('strong', null, 'Line up'), ' and pick the same corner on each drawing.');
  return null;
}

function render() {
  const both = dr.roof && dr.floor;
  const canvas = h('canvas', { 'aria-label': 'Roof plan over floor plan' });
  const picking = mode === 'pick-roof' || mode === 'pick-floor';
  const legend = both && !picking ? h('div', { class: 'legend' },
    saved.colour ? [h('span', { class: 'f' }, '■ Floor plan'), h('span', { class: 'r' }, '■ Roof plan')] : h('span', null, 'Roof plan on top of floor plan')) : null;
  const controls = both ? (picking
    ? h('div', { class: 'toolbar' },
      mode === 'pick-floor' ? h('button', { onclick: () => { mode = 'pick-roof'; render(); } }, '‹ Back to roof') : null,
      h('button', { onclick: () => { mode = 'view'; if (saved.align && !saved.align.floorRef) saved.align = null; render(); } }, 'Cancel'))
    : h('div', { class: 'stack' },
      h('div', { class: 'toolbar' },
        h('button', { class: saved.align ? '' : 'primary', onclick: startLineUp }, saved.align ? 'Line up again' : 'Line up'),
        h('button', { class: mode === 'move' ? 'on' : '', onclick: () => { mode = mode === 'move' ? 'view' : 'move'; if (mode === 'view') save(); render(); } }, mode === 'move' ? 'Done' : 'Move roof'),
        h('button', { onclick: () => viewer.fit(homeBox(), 8) }, 'Fit'),
        h('button', { class: saved.flip ? 'on' : '', 'aria-pressed': String(!!saved.flip), onclick: () => { saved.flip = !saved.flip; save(); render(); } }, saved.flip ? 'Flipped ✓' : 'Flip (opp. hand)')),
      dr.floor.wallSegs
        ? h('label', { class: 'inline' }, h('input', { id: 'walls', type: 'checkbox', checked: saved.wallsOnly, onchange: (e) => { saved.wallsOnly = e.target.checked; save(); viewer.redraw(); } }), 'Floor plan: walls and room names only')
        : h('p', { class: 'muted small' }, 'This floor plan has no separate wall layer, so the whole floor drawing is shown.'),
      h('label', { for: 'opacity' }, 'Roof see-through'),
      h('input', { id: 'opacity', type: 'range', min: 10, max: 100, value: Math.round(saved.opacity * 100), oninput: (e) => { saved.opacity = e.target.value / 100; viewer.redraw(); }, onchange: save }),
      h('label', { class: 'inline' }, h('input', { id: 'colour', type: 'checkbox', checked: saved.colour, onchange: (e) => { saved.colour = e.target.checked; save(); render(); } }), 'Colour the drawings (roof red, floor blue)'),
      saved.nudge.x || saved.nudge.y ? h('button', { class: 'small', onclick: () => { saved.nudge = { x: 0, y: 0 }; save(); viewer.redraw(); render(); } }, 'Undo roof moves') : null)) : null;

  $app.replaceChildren(
    h('div', { class: 'topbar' }, h('h1', null, 'Roof over floor')),
    h('div', { class: 'files' }, slotCard('roof', 'Roof plan'), slotCard('floor', 'Floor plan')),
    instruction() || '',
    both || dr.roof || dr.floor ? h('div', { class: 'canvaswrap' }, canvas,
      both && saved.flip && !picking ? h('div', { class: 'modebar' }, h('span', { class: 'mirrorbadge' }, 'FLIPPED - opposite hand. Roof writing reads backwards.')) : null,
      h('div', { class: 'canvasbtns' },
        h('button', { 'aria-label': 'Zoom in', onclick: () => viewer.zoomBy(1.6) }, '+'),
        h('button', { 'aria-label': 'Zoom out', onclick: () => viewer.zoomBy(1 / 1.6) }, '−'))) : '',
    legend || '',
    controls || '',
    both ? h('p', { class: 'notice' }, NOTICE) : '',
    h('p', { class: 'muted small' }, 'Drawings stay on this phone. Nothing is uploaded.'),
  );

  viewer?.destroy();
  viewer = null;
  if (!(both || dr.roof || dr.floor)) return;
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
  window.__roofline = { dr, saved: () => saved, viewer: () => viewer }; // used by automated tests
  try { saved = { ...saved, ...(await db.kvGet('overlay', {})) }; } catch { /* first run */ }
  for (const slot of ['roof', 'floor']) {
    if (!saved[slot]) continue;
    try { await loadSlot(slot, saved[slot]); } catch (e) { saved[slot] = null; toast(e.message, 5000); }
  }
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
