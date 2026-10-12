// RoofLine app: screens, routing and flows. Everything runs locally.
import * as db from './db.js';
import { getDrawing, renderRegion, inspectBytes, textPages, tint } from './pdfdoc.js';
import { Viewer } from './viewer.js';
import { drawScene, drawDrawing, drawScaleBar, PALETTES } from './render.js';
import { buildScene, sceneBounds, groupVisible, TEXT_DEFAULTS } from './scene.js';
import { CATEGORIES, describeGroup, snapPoints, defaultVisible } from './classify.js';
import { resolvePlot } from './lookup.js';
import { parseSchedule, validateRows, flagRows, guessMapping } from './schedule.js';
import { scaleFromPoints, makeTransform, errorEstimate, nearestSnap, pointSegDist, mmPerUnitForScale, dist, angleDiffDeg, lineAngleDeg } from './geom.js';
import { renderExport, exportPng, exportPdf, saveBlob, NOTICE } from './export.js';

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');
const FLOORS = ['ground', 'first', 'second'];
const SLOT_LABEL = { roof: 'Roof plan', ground: 'Ground floor', first: 'First floor', second: 'Second floor' };
const TEXT_LABEL = { room: 'Room names', roofnote: 'Roof annotations (TV, RWP, truss…)', dim: 'Dimension text', note: 'Other notes', scale: 'Scale text', plotnote: 'Plot-list notes (filtered by plot)' };

const state = { houseTypes: [], schedule: null, settings: { theme: 'auto' }, recent: [], viewers: [], pendingSchedule: null, floorChoice: {} };

// ---------------------------------------------------------------- helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
/** Replace an element's children; flattens arrays and skips null/false. */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k instanceof Node ? k : String(k))));
}
const msg = (kind, ...body) => h('div', { class: `msg ${kind}` }, ...body);
const list = (items) => h('ul', null, items.map((t) => h('li', null, t)));
const go = (hash) => { location.hash = hash; };
const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const uid = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function toast(t, ms = 2500) {
  $toast.textContent = t;
  $toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { $toast.hidden = true; }, ms);
}
function openSheet(...content) {
  put($sheet, h('button', { class: 'close small', onclick: closeSheet }, 'Close'), ...content);
  $sheet.hidden = false;
}
function closeSheet() { $sheet.hidden = true; put($sheet); }

function isDark() {
  const t = state.settings.theme;
  return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}
const pal = () => (isDark() ? PALETTES.dark : PALETTES.light);
function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

function topbar(title, back = '#/') {
  return h('div', { class: 'topbar' },
    back ? h('button', { class: 'icon', 'aria-label': 'Back', onclick: () => go(back) }, '‹') : null,
    h('h1', null, title),
    h('button', { class: 'icon', 'aria-label': 'Home', onclick: () => go('#/') }, '⌂'));
}

function readFile(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
}
function pickFile(accept) {
  return new Promise((res) => {
    const i = h('input', { type: 'file', accept, style: 'display:none' });
    i.addEventListener('change', () => { res(i.files[0] || null); i.remove(); });
    document.body.append(i);
    i.click();
  });
}

// ---------------------------------------------------------------- data
async function loadAll() {
  state.houseTypes = await db.all('houseTypes');
  state.schedule = await db.kvGet('schedule');
  state.settings = { theme: 'auto', ...(await db.kvGet('settings', {})) };
  state.recent = await db.kvGet('recent', []);
}
async function saveHT(ht) {
  ht.updatedAt = new Date().toISOString();
  await db.put('houseTypes', ht);
  const i = state.houseTypes.findIndex((x) => x.id === ht.id);
  if (i >= 0) state.houseTypes[i] = ht; else state.houseTypes.push(ht);
}
const htById = (id) => state.houseTypes.find((x) => x.id === id);
const floorsOf = (ht) => FLOORS.filter((f) => ht.drawings?.[f]);
const topFloor = (ht) => floorsOf(ht).at(-1);
const currentCal = (ht, floor) => (ht.calibrations?.[floor] || []).at(-1) || null;
const layerSettings = (ht, slot) => {
  ht.layers = ht.layers || {};
  ht.layers[slot] = ht.layers[slot] || { groupVis: {}, catVis: {}, groupCat: {}, textVis: {}, crop: null };
  return ht.layers[slot];
};
function calProblem(ht, floor, cal) {
  if (!cal) return 'Not calibrated yet.';
  const r = ht.drawings.roof;
  const f = ht.drawings[floor];
  if (!r || !f) return 'Drawing missing.';
  if (cal.roofFileId !== r.fileId || cal.roofPage !== r.page || cal.floorFileId !== f.fileId || cal.floorPage !== f.page) {
    return `Calibration v${cal.version} was made with a different drawing file or page. Recalibrate before use.`;
  }
  return null;
}
const siteCheck = (ht, floor, cal) => (ht.siteChecks || []).filter((c) => c.floor === floor && cal && c.calVersion === cal.version).at(-1) || null;
const roleOf = (slot) => (slot === 'roof' ? 'roof' : 'floor');
const catOf = (g, settings) => settings?.groupCat?.[g.key] ?? g.category;

// Raster bitmaps (Method B) and PDF underlays are cached in memory per session.
const bmpCache = new Map();
async function bitmapFor(ht, slot, colour, dpi = 300) {
  const d = ht.drawings[slot];
  const crop = layerSettings(ht, slot).crop;
  const key = `${d.fileId}:${d.page}:${JSON.stringify(crop)}:${colour}:${dpi}`;
  if (!bmpCache.has(key)) {
    bmpCache.set(key, renderRegion(d.fileId, d.page, crop, dpi).then((r) => ({ ...r, canvas: colour ? tint(r.canvas, colour) : r.canvas })));
  }
  return bmpCache.get(key);
}

/** Load drawings for a house type + floor and build the scene for a handing. */
async function loadScene(ht, floor, cal, handing, plot) {
  const roofM = await getDrawing(ht.drawings.roof.fileId, ht.drawings.roof.page, 'roof');
  const floorM = await getDrawing(ht.drawings[floor].fileId, ht.drawings[floor].page, 'floor');
  const raster = roofM.method === 'B' || floorM.method === 'B';
  const P = raster ? PALETTES.light : pal();
  const bitmaps = {};
  const withRaster = async (m, slot, role, colour) => {
    if (m.method !== 'B') return m;
    const b = await bitmapFor(ht, slot, colour);
    bitmaps[role] = b;
    return { ...m, raster: { ...m.raster, crop: b.crop, renderUnitsPerPx: b.unitsPerPx, renderDpi: b.dpi, limited: b.limited } };
  };
  const fM = await withRaster(floorM, floor, 'floor', P.floor);
  const rM = await withRaster(roofM, 'roof', 'roof', P.roof);
  const scene = buildScene(
    { extract: fM, cal: cal.floor, settings: layerSettings(ht, floor) },
    { extract: rM, cal: { ...cal.roof, offset: cal.offset }, settings: layerSettings(ht, 'roof') },
    { handing, plot },
  );
  for (const [role, b] of Object.entries(bitmaps)) {
    if (b.limited) scene.warnings.push(`${role} plan rendered at only ${b.dpi.toFixed(0)} DPI (phone canvas limit). Set a smaller plan area in the layer picker to get 300 DPI.`);
  }
  return { scene, bitmaps, pal: P, roofM, floorM };
}

function sceneSnap(scene) {
  const pts = [];
  for (const L of [scene.floor, scene.roof]) for (const g of L.groups) for (const v of g.segs) pts.push(v);
  return (w, r) => nearestSnap(pts, w, r);
}

/** Error estimate of a stored per-drawing calibration (mm per point / scale %). */
function calError(c, model) {
  const lengthUnits = dist(c.p1, c.p2);
  const k = scaleFromPoints(c.p1, c.p2, c.realMm);
  const imagePx = model?.method === 'B' ? (model.raster?.unitsPerPx || model.raster?.renderUnitsPerPx || 0) : 0;
  return errorEstimate({ k, lengthUnits, pointErrUnits: c.pointErrUnits ?? 0.5, imagePxUnits: imagePx });
}

// ---------------------------------------------------------------- router
let routeSeq = 0;
/** True if the user navigated away while an async screen was loading. */
const stale = (seq) => seq !== routeSeq;

async function route() {
  routeSeq++;
  for (const v of state.viewers) v.destroy?.();
  state.viewers = [];
  closeSheet();
  window.scrollTo(0, 0);
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  try {
    switch (parts[0]) {
      case '': return homeScreen();
      case 'plot': return await plotScreen(parseInt(parts[1], 10));
      case 'types': return typesScreen();
      case 'import': return await importScreen(parts[1]);
      case 'calibrate': return await calibrateScreen(parts[1], parts[2]);
      case 'picker': return await pickerScreen(parts[1], parts[2]);
      case 'settings': return settingsScreen();
      case 'schedule': return scheduleScreen();
      case 'mirror': return await mirrorScreen(parts[1], parts[2]);
      default: return homeScreen();
    }
  } catch (e) {
    console.error(e);
    put($app, topbar('Error'), msg('bad', 'Something went wrong: ', String(e?.message || e)), h('button', { onclick: () => go('#/') }, 'Home'));
  }
}

// ---------------------------------------------------------------- home
function homeScreen() {
  const input = h('input', { class: 'plotinput', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Plot no.', autocomplete: 'off', 'aria-label': 'Plot number' });
  const open = () => {
    const n = parseInt(input.value, 10);
    if (!Number.isInteger(n) || n <= 0) { toast('Type a plot number'); return; }
    go(`#/plot/${n}`);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  const s = state.schedule;
  const status = [];
  if (!s) status.push(msg('warn', 'No plot schedule imported. ', h('a', { href: '#/settings' }, 'Import it in Settings.')));
  else {
    status.push(h('p', { class: 'muted' }, `Schedule: ${s.rows.length} plots from ${s.fileName || 'PDF'} (${(s.importedAt || '').slice(0, 10)})`));
    if (!s.mapping?.confirmed) status.push(msg('warn', 'Column mapping not confirmed. ', h('a', { href: '#/schedule' }, 'Review schedule.')));
  }
  if (!state.houseTypes.length) status.push(msg('warn', 'No house type drawings imported. ', h('a', { href: '#/import' }, 'Import Ellerton Elder first.')));
  put($app, 
    h('div', { class: 'topbar' }, h('h1', null, 'RoofLine'), h('button', { class: 'small', onclick: () => go('#/settings') }, 'Settings')),
    h('div', { class: 'stack' },
      input,
      h('button', { class: 'primary', style: 'width:100%;font-size:22px;min-height:64px', onclick: open }, 'Show plot'),
      ...status,
      state.recent.length ? h('div', null, h('h3', null, 'Recent plots'), h('div', { class: 'chips' }, state.recent.map((n) => h('button', { onclick: () => go(`#/plot/${n}`) }, String(n))))) : null,
      h('div', { class: 'grid2', style: 'margin-top:16px' },
        h('button', { onclick: () => go('#/types') }, 'House types'),
        h('button', { onclick: () => go('#/settings') }, 'Settings')),
      h('p', { class: 'muted', style: 'margin-top:20px;font-size:14px' }, 'Drawings stay on this phone. Nothing is uploaded.'),
    ),
  );
  setTimeout(() => input.focus(), 50);
}

async function addRecent(n) {
  state.recent = [n, ...state.recent.filter((x) => x !== n)].slice(0, 12);
  await db.kvSet('recent', state.recent);
}

// ---------------------------------------------------------------- plot screen
async function plotScreen(n) {
  if (!Number.isInteger(n)) return go('#/');
  put($app, topbar(`Plot ${n}`), h('p', { class: 'muted' }, 'Loading…'));
  const res = resolvePlot(n, state.schedule, state.houseTypes);
  const els = [topbar(`Plot ${n}`)];
  if (res.status === 'not-in-schedule' || res.status === 'no-schedule' || res.status === 'duplicate') {
    els.push(msg('bad', res.warnings.join(' ')), res.status === 'no-schedule' ? h('button', { class: 'primary', onclick: () => go('#/settings') }, 'Import schedule') : null,
      res.status === 'duplicate' ? h('button', { onclick: () => go('#/schedule') }, 'Fix schedule') : null);
    put($app, ...els);
    return;
  }
  const seq = routeSeq;
  await addRecent(n);
  if (stale(seq)) return;
  const m = state.schedule.mapping;
  els.push(h('div', { class: 'card' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('span', { class: 'big' }, res.name || '(no house type)'),
      res.handing ? h('span', { class: `badge ${res.handing === 'Opp' ? 'opp' : 'as'}` }, res.handing === 'Opp' ? 'OPP' : 'AS') : h('span', { class: 'badge b' }, res.handingRaw || '?')),
    h('dl', { class: 'kv' },
      h('dt', null, 'Sales name'), h('dd', null, res.sales || '-'),
      h('dt', null, `Code (${m.codeCol})`), h('dd', null, res.code || '-'),
      h('dt', null, 'Handing'), h('dd', null, res.handingRaw || '-'),
      h('dt', null, 'Roof finish'), h('dd', null, res.finish || '-'),
      h('dt', null, 'Roof type'), h('dd', null, res.roofType || '-'))));
  if (res.status !== 'ok') {
    els.push(msg('bad', list(res.warnings)));
    if (res.status === 'no-drawing') els.push(h('button', { class: 'primary', style: 'width:100%', onclick: () => go(`#/import/new?name=${encodeURIComponent(res.name)}&code=${encodeURIComponent(res.code)}`) }, `Import drawings for ${res.name} ${res.code}`));
    if (res.status === 'bad-row') els.push(h('button', { onclick: () => go('#/schedule') }, 'Fix schedule row'));
    put($app, ...els);
    return;
  }
  if (res.warnings.length) els.push(msg('warn', list(res.warnings)));
  const ht = res.houseType;
  if (!ht.drawings?.roof || !floorsOf(ht).length) {
    els.push(msg('bad', `${ht.name} has no ${!ht.drawings?.roof ? 'roof plan' : 'floor plan'} imported.`), h('button', { class: 'primary', onclick: () => go(`#/import/${ht.id}`) }, 'Import drawings'));
    put($app, ...els);
    return;
  }
  const floors = floorsOf(ht);
  let floor = state.floorChoice[ht.id];
  if (!floors.includes(floor)) floor = topFloor(ht);
  els.push(h('div', { class: 'row' }, h('strong', { style: 'flex:0' }, 'Under roof:'),
    floors.map((f) => h('button', { class: `small ${f === floor ? 'on' : ''}`, onclick: () => { state.floorChoice[ht.id] = f; route(); } }, SLOT_LABEL[f] + (f === topFloor(ht) ? ' (top)' : '')))));
  const cal = currentCal(ht, floor);
  const prob = calProblem(ht, floor, cal);
  if (prob) {
    els.push(msg('bad', prob, ' The overlay is not shown until the roof and floor plans are calibrated and aligned.'),
      h('button', { class: 'primary', style: 'width:100%', onclick: () => go(`#/calibrate/${ht.id}/${floor}`) }, 'Calibrate now'));
    put($app, ...els);
    return;
  }
  const { scene, bitmaps, pal: P, roofM, floorM } = await loadScene(ht, floor, cal, res.handing, n);
  if (stale(seq)) return;
  const check = siteCheck(ht, floor, cal);
  els.push(check
    ? msg('ok', `Checked on site ${check.date}: ${check.note || ''}`)
    : msg('warn', 'Alignment NOT yet checked on site with a tape for this calibration. Use Measure and compare with a tape, then tick "Checked on site".'));
  if (scene.warnings.length) els.push(msg('warn', list(scene.warnings)));

  const opts = { pal: P, opacity: state.settings.opacity ?? 0.8, showFloor: true, showRoof: true, bitmaps, marks: null, dpr: 1 };
  const canvas = h('canvas', { 'aria-label': 'Roof plan over floor plan' });
  const measureBox = h('div', { class: 'measure', hidden: true });
  const meas = { on: false, pts: [] };
  const errF = calError(cal.floor, floorM);
  const errR = calError(cal.roof, roofM);
  const viewer = new Viewer(canvas, {
    draw: (ctx, view, info) => {
      drawScene(ctx, view, scene, { ...opts, dpr: info.dpr, loupe: info.loupe });
      if (!info.loupe) { ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); drawScaleBar(ctx, view, info.w, info.h, P); }
    },
    snap: (w, r) => (meas.on ? sceneSnap(scene)(w, r) : null),
    onPoint: (w, info) => {
      if (meas.pts.length >= 2) meas.pts = [];
      meas.pts.push({ ...w, snapped: info.snapped });
      const marks = { points: meas.pts.map((p, i) => ({ ...p, label: 'AB'[i] })), lines: [] };
      if (meas.pts.length === 2) {
        const [a, b] = meas.pts;
        const d = dist(a, b);
        const e = Math.max(errF.pointMm, errR.pointMm) * Math.SQRT2 + (Math.max(errF.scalePct, errR.scalePct) / 100) * d;
        marks.lines.push({ a, b, label: `${Math.round(d)} mm` });
        put(measureBox, `A→B ${Math.round(d)} mm `, h('small', null, `(±${fmt(e, 0)} mm est.; ${a.snapped && b.snapped ? 'both points snapped' : 'not all points snapped'})`));
      } else put(measureBox, 'Tap/drag to place point B');
      opts.marks = marks;
      viewer.redraw();
    },
  });
  state.viewers.push(viewer);
  const measureBtn = h('button', {
    onclick: () => {
      meas.on = !meas.on;
      meas.pts = [];
      opts.marks = null;
      viewer.setMode(meas.on ? 'point' : 'pan');
      measureBtn.classList.toggle('on', meas.on);
      measureBox.hidden = !meas.on;
      put(measureBox, 'Drag one finger: the orange crosshair sits above your finger. Lift to place A, then B. Two fingers pan/zoom.');
    },
  }, 'Measure');
  const opacity = h('input', { type: 'range', min: 0, max: 100, value: Math.round(opts.opacity * 100), oninput: (e) => { opts.opacity = e.target.value / 100; viewer.redraw(); }, onchange: async (e) => { state.settings.opacity = e.target.value / 100; await db.kvSet('settings', state.settings); } });
  const stamp = () => [
    `Plot ${n}  |  ${res.name}${res.sales ? ' (' + res.sales + ')' : ''}  |  Code ${res.code}  |  ${res.handing}${scene.mirrored ? ' - mirrored from As drawing' : ''}`,
    `Roof over ${SLOT_LABEL[floor]}  |  Roof finish: ${res.finish || '-'}`,
    `Calibration v${cal.version} ${cal.date.slice(0, 10)} (drawing ${cal.drawingCode})  |  floor 1:${fmt(scene.floor.k / mmPerUnitForScale(1), 1)}, roof 1:${fmt(scene.roof.k / mmPerUnitForScale(1), 1)}  |  scale bar on image`,
    check ? `Checked on site ${check.date}: ${check.note || ''}` : 'NOT CHECKED ON SITE',
    `Exported ${new Date().toLocaleString('en-GB')}`,
  ];
  const doExport = async (kind) => {
    const c = renderExport(scene, opts, viewer.view, viewer.w, viewer.h, stamp());
    const name = `plot-${n}-${(res.name || '').replace(/\W+/g, '_')}-${res.handing}`;
    if (kind === 'png') await saveBlob(await exportPng(c), name + '.png');
    else await saveBlob(await exportPdf(c), name + '.pdf');
  };
  const notes = [...scene.floor.notes, ...scene.roof.notes];
  els.push(
    h('div', { class: 'legend' }, h('span', { class: 'f' }, `■ ${SLOT_LABEL[floor]} (blue)`), h('span', { class: 'r' }, '■ Roof (red)')),
    h('div', { class: 'canvaswrap' }, canvas,
      h('div', { class: 'modebar' }, scene.mirrored ? h('span', { class: 'mirrorbadge' }, 'OPP - mirrored from As drawing') : null),
      h('div', { class: 'canvasbtns' },
        h('button', { 'aria-label': 'Zoom in', onclick: () => viewer.zoomBy(1.5) }, '+'),
        h('button', { 'aria-label': 'Zoom out', onclick: () => viewer.zoomBy(1 / 1.5) }, '−'),
        h('button', { 'aria-label': 'Fit', onclick: () => viewer.fit(sceneBounds(scene)) }, '⤢'))),
    h('div', { class: 'notice', role: 'note' }, NOTICE),
    measureBox,
    h('label', null, 'Roof opacity'), opacity,
    h('div', { class: 'toolbar' },
      measureBtn,
      h('button', { onclick: () => layersSheet(ht, floor) }, 'Layers'),
      h('button', { onclick: () => openSheet(h('h2', null, 'Export this view'), h('p', null, 'Stamped with plot, house type, code, handing, scale, calibration date and the setting-out notice.'), h('div', { class: 'grid2' }, h('button', { class: 'primary', onclick: () => doExport('png') }, 'PNG'), h('button', { class: 'primary', onclick: () => doExport('pdf') }, 'PDF'))) }, 'Export'),
      h('button', { onclick: () => siteCheckSheet(ht, floor, cal) }, check ? 'Site check ✓' : 'Checked on site…'),
      h('button', { onclick: () => go(`#/calibrate/${ht.id}/${floor}`) }, 'Calibration'),
      h('button', { onclick: () => go(`#/mirror/${ht.id}/${floor}`) }, 'As / Opp test')),
    notes.length ? h('details', { class: 'card', open: true },
      h('summary', null, `Plot-list notes for plot ${n}`),
      notes.map((nt) => nt.vis === 'show' ? msg('ok', `Applies to plot ${n}: `, nt.str)
        : nt.vis === 'warn' ? msg('warn', 'Could not read the plot list reliably, check the drawing: ', nt.str, nt.reason ? ` (${nt.reason})` : '')
          : h('p', { class: 'muted', style: 'font-size:14px' }, `Hidden (not plot ${n}): ${nt.str}`))) : null,
    h('details', { class: 'card' }, h('summary', null, 'Calibration details'), calSummary(ht, floor, cal, floorM, roofM, scene)),
  );
  put($app, ...els);
  viewer.resize();
  viewer.fit(sceneBounds(scene));
}

function calSummary(ht, floor, cal, floorM, roofM, scene) {
  const eF = calError(cal.floor, floorM);
  const eR = calError(cal.roof, roofM);
  const row = (label, c, e, m) => [h('dt', null, label), h('dd', null,
    `${c.realMm} mm over ${fmt(dist(c.p1, c.p2), 2)} pt → 1:${fmt(scaleFromPoints(c.p1, c.p2, c.realMm) / mmPerUnitForScale(1), 2)}; ±${fmt(e.pointMm, 1)} mm/point, ±${fmt(e.scalePct, 3)}% scale (≈±${fmt(e.per10mMm, 0)} mm over 10 m)` +
    (m.method === 'B' ? `; RASTER: 1 image pixel = ${fmt(e.imagePxMm, 1)} mm` : '; vector'))];
  return h('dl', { class: 'kv' },
    h('dt', null, 'Version'), h('dd', null, `v${cal.version}, ${cal.date.slice(0, 10)}, drawing ${cal.drawingCode}`),
    row('Floor', cal.floor, eF, floorM), row('Roof', cal.roof, eR, roofM),
    h('dt', null, 'Roof ref offset'), h('dd', null, `dx ${cal.offset.dx} mm, dy ${cal.offset.dy} mm`),
    h('dt', null, 'Rotation diff'), h('dd', null, `${fmt(scene.checks.angleDiffDeg, 3)}°${scene.checks.angleDiffDeg > 0.1 ? ' (OVER 0.1° LIMIT)' : ''}`),
    h('dt', null, 'Measure check'), h('dd', null, cal.measureCheck ? `${fmt(cal.measureCheck.measured, 0)} mm measured vs ${cal.measureCheck.expected} mm expected` : '-'),
    cal.note ? [h('dt', null, 'Note'), h('dd', null, cal.note)] : null);
}

function siteCheckSheet(ht, floor, cal) {
  const date = h('input', { type: 'date', value: today() });
  const note = h('textarea', { rows: 3, placeholder: 'e.g. BED 1 wall to ridge: app 2350, tape 2346. OK.' });
  const prev = (ht.siteChecks || []).filter((c) => c.floor === floor);
  openSheet(
    h('h2', null, 'Checked on site'),
    h('p', null, `Record that you compared a measurement on this overlay with a tape on site, for ${ht.name} ${ht.drawingCode}, ${SLOT_LABEL[floor]}, calibration v${cal.version}. A new calibration will need a new check.`),
    h('label', null, 'Date'), date, h('label', null, 'What did you check? (measurements, result)'), note,
    h('button', {
      class: 'primary', style: 'width:100%;margin-top:10px',
      onclick: async () => {
        if (!note.value.trim()) { toast('Write what you measured'); return; }
        ht.siteChecks = [...(ht.siteChecks || []), { date: date.value, note: note.value.trim(), floor, calVersion: cal.version, recordedAt: new Date().toISOString() }];
        await saveHT(ht);
        closeSheet();
        route();
      },
    }, '✓ Checked on site'),
    prev.length ? [h('h3', null, 'Previous checks'), list(prev.map((c) => `${c.date} (cal v${c.calVersion}): ${c.note}`))] : null);
}

function layersSheet(ht, floor) {
  const body = h('div');
  const build = () => {
    put(body, ...['roof', floor].map((slot) => {
      const role = roleOf(slot);
      const s = layerSettings(ht, slot);
      return h('div', { class: 'card' },
        h('h3', null, SLOT_LABEL[slot]),
        CATEGORIES[role].map(([cat, label]) => h('label', { class: 'inline' },
          h('input', {
            type: 'checkbox', checked: s.catVis[cat] ?? defaultVisible(role, cat),
            onchange: async (e) => {
              s.catVis[cat] = e.target.checked;
              // a category switch overrides per-group choices in that category
              const model = await getDrawing(ht.drawings[slot].fileId, ht.drawings[slot].page, role);
              for (const g of model.groups) if (catOf(g, s) === cat) delete s.groupVis[g.key];
              await saveHT(ht);
            },
          }), label)),
        h('h3', null, 'Text'),
        Object.keys(TEXT_DEFAULTS[role]).map((cls) => h('label', { class: 'inline' },
          h('input', { type: 'checkbox', checked: s.textVis[cls] ?? TEXT_DEFAULTS[role][cls], onchange: async (e) => { s.textVis[cls] = e.target.checked; await saveHT(ht); } }),
          TEXT_LABEL[cls])),
        h('button', { onclick: () => go(`#/picker/${ht.id}/${slot}`) }, 'Layer picker (tap individual lines)…'));
    }));
  };
  build();
  openSheet(h('h2', null, 'Layers'), h('p', { class: 'muted' }, 'Changes are saved for this house type. Close to apply.'), body,
    h('button', { class: 'primary', style: 'width:100%', onclick: () => { closeSheet(); route(); } }, 'Apply'));
}

// ---------------------------------------------------------------- house types
function typesScreen() {
  const cards = state.houseTypes.map((ht) => {
    const floors = floorsOf(ht);
    return h('div', { class: 'card' },
      h('div', { class: 'big' }, `${ht.name} `, h('small', null, ht.drawingCode)),
      ht.aliases?.length ? h('p', { class: 'muted' }, 'Also matches: ' + ht.aliases.join(', ')) : null,
      h('ul', null, ['roof', ...FLOORS].filter((s) => ht.drawings?.[s]).map((s) => {
        const d = ht.drawings[s];
        return h('li', null, `${SLOT_LABEL[s]}: ${d.fileName} p${d.page} `, h('span', { class: `badge ${d.method === 'A' ? 'a' : 'b'}` }, d.method === 'A' ? 'Vector (A)' : 'Raster (B)'));
      })),
      floors.map((f) => {
        const cal = currentCal(ht, f);
        const p = calProblem(ht, f, cal);
        const chk = siteCheck(ht, f, cal);
        return h('p', null, h('strong', null, `Roof over ${SLOT_LABEL[f]}: `),
          p ? h('span', { style: 'color:var(--bad)' }, p) : `calibrated v${cal.version} ${cal.date.slice(0, 10)} - `,
          !p ? (chk ? h('span', { style: 'color:var(--ok)' }, `site-checked ${chk.date}`) : h('span', { style: 'color:var(--warn)' }, 'not site-checked')) : null);
      }),
      h('div', { class: 'toolbar' },
        h('button', { class: 'small', onclick: () => go(`#/import/${ht.id}`) }, 'Edit / drawings'),
        floors.map((f) => h('button', { class: 'small', onclick: () => go(`#/calibrate/${ht.id}/${f}`) }, `Calibrate ${f}`)),
        ['roof', ...floors].map((s) => h('button', { class: 'small', onclick: () => go(`#/picker/${ht.id}/${s}`) }, `Layers: ${s}`)),
        floors.map((f) => h('button', { class: 'small', onclick: () => go(`#/mirror/${ht.id}/${f}`) }, `As/Opp test ${f}`)),
        h('button', {
          class: 'small danger',
          onclick: async () => {
            if (!confirm(`Delete ${ht.name} ${ht.drawingCode} and its calibrations? (PDF files stay in storage until "Clear all data".)`)) return;
            await db.del('houseTypes', ht.id);
            state.houseTypes = state.houseTypes.filter((x) => x.id !== ht.id);
            route();
          },
        }, 'Delete')));
  });
  put($app, topbar('House types'),
    h('button', { class: 'primary', style: 'width:100%', onclick: () => go('#/import/new') }, '+ Import house type'),
    cards.length ? cards : h('p', { class: 'muted' }, 'None yet. Start with Ellerton Elder: roof plan + first floor plan.'));
}

// ---------------------------------------------------------------- import
function reportView(rep, selectedPage, onPick) {
  return h('div', null,
    h('p', null, `${rep.pageCount} page(s). Choose the page with the plan:`),
    rep.pages.map((p) => h('div', { class: 'card', style: `border-width:${p.page === selectedPage ? 3 : 1}px;border-color:${p.page === selectedPage ? 'var(--accent)' : 'var(--line)'}` },
      h('label', { class: 'inline' }, h('input', { type: 'radio', name: 'pg' + Math.random(), checked: p.page === selectedPage, onchange: () => onPick(p.page) }),
        h('span', null, h('strong', null, `Page ${p.page}`), ` - ${p.widthMm} × ${p.heightMm} mm (${p.paper}) `, h('span', { class: `badge ${p.method === 'A' ? 'a' : 'b'}` }, p.method === 'A' ? 'Method A: vector' : 'Method B: raster'))),
      h('details', null, h('summary', null, 'Step 0 report'),
        h('dl', { class: 'kv' },
          h('dt', null, 'Operators'), h('dd', null, p.opCount),
          h('dt', null, 'Vector segments'), h('dd', null, p.segCount),
          h('dt', null, 'Images'), h('dd', null, `${p.imageCount} (${Math.round(p.imageCoverage * 100)}% of page)${p.raster ? `, ~${fmt(p.raster.dpi, 0)} DPI` : ''}`),
          h('dt', null, 'Text items'), h('dd', null, p.textItems),
          h('dt', null, 'Room names'), h('dd', null, p.rooms.join(', ') || 'none found'),
          h('dt', null, 'Dimensions'), h('dd', null, p.dims.slice(0, 20).join(', ') || 'none found'),
          h('dt', null, 'Stated scale'), h('dd', null, p.statedScales.map((s) => '1:' + s).join(', ') || 'none found')),
        list(p.reasons)))));
}

async function importScreen(id) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const existing = id && id !== 'new' && !id.startsWith('new?') ? htById(id) : null;
  const ht = existing ? structuredClone(existing) : { id: uid(), name: q.get('name') || '', aliases: [], drawingCode: q.get('code') || '', drawings: {}, calibrations: {}, layers: {}, siteChecks: [], createdAt: new Date().toISOString() };
  const name = h('input', { value: ht.name, placeholder: 'e.g. ELLERTON' });
  const aliases = h('input', { value: (ht.aliases || []).join(', '), placeholder: 'e.g. Ellerton Elder' });
  const code = h('input', { value: ht.drawingCode, placeholder: 'e.g. BELX 2401 AA04' });
  const pending = {}; // slot -> {fileId, fileName, report, page}
  const slotBox = (slot) => {
    const box = h('div', { class: 'card' });
    const draw = () => {
      const cur = pending[slot] || ht.drawings[slot];
      put(box, 
        h('h3', null, SLOT_LABEL[slot]),
        cur ? h('p', null, `${cur.fileName}, page ${cur.page}`) : h('p', { class: 'muted' }, 'None'),
        pending[slot] ? reportView(pending[slot].report, pending[slot].page, (pg) => { pending[slot].page = pg; draw(); }) : null,
        h('div', { class: 'row' },
          h('button', {
            class: 'small',
            onclick: async () => {
              const f = await pickFile('application/pdf,.pdf');
              if (!f) return;
              box.append(h('p', { class: 'muted' }, 'Reading PDF locally…'));
              try {
                const buf = await readFile(f);
                const fileId = await db.saveFile(f.name, buf);
                const report = await inspectBytes(buf);
                const best = report.pages.find((p) => p.method === 'A') || report.pages[0];
                pending[slot] = { fileId, fileName: f.name, report, page: best.page };
              } catch (e) { box.append(msg('bad', 'Could not read this PDF: ' + e.message)); return; }
              draw();
            },
          }, cur ? 'Replace PDF' : 'Choose PDF'),
          cur && slot !== 'roof' ? h('button', { class: 'small danger', onclick: () => { delete pending[slot]; delete ht.drawings[slot]; draw(); } }, 'Remove') : null));
    };
    draw();
    return box;
  };
  put($app, topbar(existing ? `Edit ${ht.name}` : 'Import house type', '#/types'),
    msg('info', 'PDFs are read on this phone only. Each page is inspected (vector or raster, text, room names) before you use it.'),
    h('label', null, 'House type name (as in the schedule "house type" column)'), name,
    h('label', null, 'Other names that match (comma separated, e.g. sales name)'), aliases,
    h('label', null, 'Drawing code (must match the schedule code column exactly, e.g. BELX 2401 AA04)'), code,
    h('p', { class: 'muted' }, 'A plot only uses these drawings when BOTH the code and one of the names match its schedule row.'),
    slotBox('roof'), FLOORS.map(slotBox),
    h('button', {
      class: 'primary', style: 'width:100%',
      onclick: async () => {
        ht.name = name.value.trim();
        ht.aliases = aliases.value.split(',').map((s) => s.trim()).filter(Boolean);
        ht.drawingCode = code.value.trim();
        if (!ht.name || !ht.drawingCode) { toast('Name and drawing code are required'); return; }
        const clash = state.houseTypes.find((x) => x.id !== ht.id && x.drawingCode.replace(/\W/g, '').toUpperCase() === ht.drawingCode.replace(/\W/g, '').toUpperCase() && x.name.toUpperCase() === ht.name.toUpperCase());
        if (clash) { toast('A house type with this name and code already exists'); return; }
        for (const [slot, p] of Object.entries(pending)) {
          const pg = p.report.pages.find((x) => x.page === p.page);
          ht.drawings[slot] = { fileId: p.fileId, fileName: p.fileName, page: p.page, method: pg.method, report: pg, importedAt: new Date().toISOString() };
        }
        if (!ht.drawings.roof) { toast('A roof plan is required'); return; }
        if (!floorsOf(ht).length) { toast('At least one floor plan is required'); return; }
        await saveHT(ht);
        await db.requestPersistence();
        toast('Saved');
        go('#/types');
      },
    }, 'Save house type'));
}

// ---------------------------------------------------------------- calibration wizard
async function calibrateScreen(id, floor) {
  const ht = htById(id);
  if (!ht || !ht.drawings?.[floor] || !ht.drawings.roof) { put($app, topbar('Calibrate'), msg('bad', 'Drawings missing.')); return; }
  const seq = routeSeq;
  const models = {
    roof: await getDrawing(ht.drawings.roof.fileId, ht.drawings.roof.page, 'roof'),
    floor: await getDrawing(ht.drawings[floor].fileId, ht.drawings[floor].page, 'floor'),
  };
  if (stale(seq)) return;
  const slotOf = { roof: 'roof', floor };
  const prev = currentCal(ht, floor);
  const usePrev = prev && !calProblem(ht, floor, prev);
  const d = {
    roof: usePrev ? structuredClone(prev.roof) : { p1: null, p2: null, realMm: null, ref: null },
    floor: usePrev ? structuredClone(prev.floor) : { p1: null, p2: null, realMm: null, ref: null },
    offset: usePrev ? { ...prev.offset } : { dx: 0, dy: 0 },
    offsetConfirmed: false, measure: null, note: '',
  };
  const STEPS = [
    { key: 'roofDim', which: 'roof', title: 'Roof plan: scale', help: 'Pick a known dimension on the ROOF plan, e.g. the "10113 outer faces of wall plates" dimension. Place A and B exactly on its ends, then type the real length.' },
    { key: 'roofRef', which: 'roof', title: 'Roof plan: reference point', help: 'Tap the reference point on the ROOF plan, e.g. the outer corner of the wall plate (outer face). You will say where it is relative to the floor plan reference in step 5.' },
    { key: 'floorDim', which: 'floor', title: `${SLOT_LABEL[floor]}: scale`, help: `Pick a known dimension on the ${SLOT_LABEL[floor].toUpperCase()} plan, e.g. the 10436 overall masonry width. Place A and B on its ends and type the real length.` },
    { key: 'floorRef', which: 'floor', title: `${SLOT_LABEL[floor]}: reference point`, help: 'Tap the reference point on the floor plan, e.g. the outer corner of the masonry on the same corner of the house.' },
    { key: 'offset', which: 'overlay', title: 'Reference offset', help: '' },
    { key: 'check', which: 'overlay', title: 'Check and save', help: '' },
  ];
  let step = 0;
  let target = 'p1';
  let snapAll = false;
  let showPdf = false;
  const underlays = {};
  const P = pal();
  const canvas = h('canvas');
  const panel = h('div');
  const stepsBar = h('div', { class: 'steps' });
  let overlayScene = null;
  let overlayBitmaps = {};
  let checkPts = [];

  const visibleFor = (which) => (g) => groupVisible(g, which === 'roof' ? 'roof' : 'floor', layerSettings(ht, slotOf[which]));
  const marksFor = (which) => {
    const c = d[which];
    const pts = [];
    if (c.p1) pts.push({ ...c.p1, label: 'A' });
    if (c.p2) pts.push({ ...c.p2, label: 'B' });
    if (c.ref) pts.push({ ...c.ref, label: 'REF', colour: '#00b050' });
    return { points: pts, lines: c.p1 && c.p2 ? [{ a: c.p1, b: c.p2, label: c.realMm ? `${c.realMm} mm` : '' }] : [] };
  };
  const viewer = new Viewer(canvas, {
    draw: (ctx, view, info) => {
      const st = STEPS[step];
      if (st.which === 'overlay') {
        const sc = overlayScene;
        drawScene(ctx, view, sc, { pal: sc && (models.roof.method === 'B' || models.floor.method === 'B') ? PALETTES.light : P, opacity: 0.8, bitmaps: overlayBitmaps, dpr: info.dpr, loupe: info.loupe, marks: checkPts.length ? { points: checkPts.map((p, i) => ({ ...p, label: 'AB'[i] })), lines: checkPts.length === 2 ? [{ a: checkPts[0], b: checkPts[1], label: `${Math.round(dist(checkPts[0], checkPts[1]))} mm` }] : [] } : null });
        if (!info.loupe) { ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); drawScaleBar(ctx, view, info.w, info.h, P); }
        return;
      }
      const m = models[st.which];
      const s = layerSettings(ht, slotOf[st.which]);
      drawDrawing(ctx, view, m, {
        pal: m.method === 'B' ? PALETTES.light : P, dpr: info.dpr, isVisible: visibleFor(st.which), catOf: (g) => catOf(g, s),
        showHidden: false, showText: true, underlay: (m.method === 'B' || showPdf) ? underlays[st.which] : null, marks: marksFor(st.which),
      });
    },
    snap: (w, r) => {
      const st = STEPS[step];
      if (st.which === 'overlay') return overlayScene ? sceneSnap(overlayScene)(w, r) : null;
      const m = models[st.which];
      if (m.method === 'B') return null;
      return nearestSnap(snapPoints(m.groups, snapAll ? null : visibleFor(st.which)), w, r);
    },
    onPoint: (w, info) => {
      const st = STEPS[step];
      if (st.which === 'overlay') {
        if (st.key !== 'check') return;
        if (checkPts.length >= 2) checkPts = [];
        checkPts.push(w);
        renderPanel();
        viewer.redraw();
        return;
      }
      const m = models[st.which];
      const renderUpp = underlays[st.which]?.unitsPerPx || 0;
      const err = info.snapped ? 0.02 : Math.max(1.5 / info.s, renderUpp / 2);
      const c = d[st.which];
      const p = { x: w.x, y: w.y };
      if (st.key.endsWith('Ref')) { c.ref = p; c.refErr = err; c.refSnapped = info.snapped; }
      else {
        c[target] = p;
        c[target + 'Err'] = err;
        c[target + 'Snapped'] = info.snapped;
        if (target === 'p1') target = 'p2';
        c.pointErrUnits = Math.max(c.p1Err ?? 0, c.p2Err ?? 0);
        if (m.method === 'B') c.pointErrUnits = Math.max(c.pointErrUnits, m.raster?.unitsPerPx ? m.raster.unitsPerPx / 2 : 0);
      }
      renderPanel();
      viewer.redraw();
    },
  });
  viewer.setMode('point');
  state.viewers.push(viewer);

  async function ensureUnderlay(which) {
    const m = models[which];
    if (underlays[which] || (m.method !== 'B' && !showPdf)) return;
    const slot = slotOf[which];
    const r = await renderRegion(ht.drawings[slot].fileId, ht.drawings[slot].page, null, m.method === 'B' ? 300 : 150);
    underlays[which] = r;
    if (r.limited && m.method === 'B') toast(`Page rendered at ${r.dpi.toFixed(0)} DPI (phone limit). Set a plan area in Layers for more.`);
    viewer.redraw();
  }

  function calOk(c) { return c.p1 && c.p2 && c.realMm > 0 && c.ref && dist(c.p1, c.p2) > 0; }

  function scaleReadout(which) {
    const c = d[which];
    const m = models[which];
    if (!(c.p1 && c.p2)) return h('p', { class: 'muted' }, `Place point ${c.p1 ? 'B' : 'A'}.`);
    const du = dist(c.p1, c.p2);
    const out = [h('p', null, `A–B on drawing: ${fmt(du, 3)} pt (${fmt(du * 25.4 / 72, 2)} mm on paper), angle ${fmt(lineAngleDeg(c.p1, c.p2), 3)}°. ${c.p1Snapped && c.p2Snapped ? 'Both snapped to line ends.' : 'Not snapped: zoom in further for accuracy.'}`)];
    if (c.realMm > 0) {
      const k = scaleFromPoints(c.p1, c.p2, c.realMm);
      const N = k / mmPerUnitForScale(1);
      out.push(h('p', { class: 'big' }, `Scale: 1:${fmt(N, 2)} (${fmt(k, 4)} mm per pt)`));
      const stated = m.report.statedScales || [];
      if (stated.length) {
        const best = stated.reduce((a, b) => (Math.abs(b - N) < Math.abs(a - N) ? b : a));
        const dev = (N / best - 1) * 100;
        out.push(Math.abs(dev) > 0.5
          ? msg('warn', `Drawing says 1:${best} but your calibration gives 1:${fmt(N, 2)} (${fmt(dev, 2)}% off). Check the points and the value you typed, or the PDF is not to scale.`)
          : msg('ok', `Matches the stated scale 1:${best} within ${fmt(Math.abs(dev), 3)}%.`));
      } else out.push(msg('info', 'No stated scale (1:N) found in the drawing text to cross-check against.'));
      const e = errorEstimate({ k, lengthUnits: du, pointErrUnits: c.pointErrUnits ?? 0.5, imagePxUnits: m.method === 'B' ? (m.raster?.unitsPerPx || underlays[which]?.unitsPerPx || 0) : 0 });
      out.push(m.method === 'B'
        ? msg('warn', `RASTER drawing: accuracy is limited by image resolution and your tapping. Estimated ±${fmt(e.pointMm, 1)} mm per point, ±${fmt(e.scalePct, 3)}% scale (≈±${fmt(e.per10mMm, 0)} mm over 10 m). 1 image pixel = ${fmt(e.imagePxMm, 1)} mm.`)
        : h('p', { class: 'muted' }, `Estimated ±${fmt(e.pointMm, 1)} mm per point, ±${fmt(e.scalePct, 3)}% scale (≈±${fmt(e.per10mMm, 0)} mm over 10 m). This is the calibration error only; it cannot detect errors in the drawing itself.`));
    }
    return out;
  }

  function dimChips(which, input) {
    const dims = models[which].report.dims || [];
    if (!dims.length) return null;
    return h('div', null, h('small', null, 'Dimensions found on this drawing (tap to fill, then check it is the one you measured):'),
      h('div', { class: 'chips' }, dims.slice(0, 16).map((v) => h('button', { class: 'small', onclick: () => { input.value = v; input.dispatchEvent(new Event('input')); } }, v))));
  }

  async function buildOverlay() {
    if (!calOk(d.roof) || !calOk(d.floor)) { overlayScene = null; return; }
    const draft = { roof: d.roof, floor: d.floor, offset: d.offset };
    try {
      const r = await loadScene(ht, floor, draft, 'As', -1);
      overlayScene = r.scene;
      overlayBitmaps = r.bitmaps;
    } catch (e) { overlayScene = null; toast(e.message); }
  }

  function renderPanel() {
    const st = STEPS[step];
    put(stepsBar, ...STEPS.map((_, i) => h('span', { class: i < step ? 'done' : i === step ? 'cur' : '' })));
    const nav = h('div', { class: 'grid2', style: 'margin-top:10px' },
      h('button', { disabled: step === 0, onclick: () => setStep(step - 1) }, '‹ Back'),
      step < STEPS.length - 1 ? h('button', { class: 'primary', disabled: !canNext(), onclick: () => setStep(step + 1) }, 'Next ›') : h('span'));
    const body = [h('h2', null, `${step + 1}. ${st.title}`), st.help ? h('p', null, st.help) : null];
    if (st.which !== 'overlay') {
      const m = models[st.which];
      body.push(h('p', null, h('span', { class: `badge ${m.method === 'A' ? 'a' : 'b'}` }, m.method === 'A' ? 'Vector: points snap to line ends (green SNAP)' : 'Raster: no snapping, zoom right in')));
      body.push(h('div', { class: 'row' },
        m.method === 'A' ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: snapAll, onchange: (e) => { snapAll = e.target.checked; } }), 'Snap to hidden lines too') : null,
        m.method === 'A' ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: showPdf, onchange: async (e) => { showPdf = e.target.checked; await ensureUnderlay(st.which); viewer.redraw(); } }), 'Show original PDF underneath') : null));
    }
    if (st.key === 'roofDim' || st.key === 'floorDim') {
      const c = d[st.which];
      const input = h('input', { type: 'text', inputmode: 'decimal', value: c.realMm ?? '', placeholder: 'Real length in mm', oninput: (e) => { const v = parseFloat(e.target.value); c.realMm = v > 0 ? v : null; put(readout, ...[scaleReadout(st.which)].flat()); nextBtn(); viewer.redraw(); } });
      const readout = h('div', null, scaleReadout(st.which));
      body.push(h('div', { class: 'grid2' },
        h('button', { class: target === 'p1' ? 'on' : '', onclick: () => { target = 'p1'; renderPanel(); } }, c.p1 ? 'Re-place A' : 'Place A'),
        h('button', { class: target === 'p2' ? 'on' : '', onclick: () => { target = 'p2'; renderPanel(); } }, c.p2 ? 'Re-place B' : 'Place B')),
      h('label', null, 'Real length A–B (mm)'), input, dimChips(st.which, input), readout);
    }
    if (st.key === 'roofRef' || st.key === 'floorRef') {
      const c = d[st.which];
      body.push(c.ref ? h('p', null, `Reference at (${fmt(c.ref.x, 2)}, ${fmt(c.ref.y, 2)}) pt ${c.refSnapped ? '- snapped' : '- not snapped'}`) : h('p', { class: 'muted' }, 'Not placed yet.'));
    }
    if (st.key === 'offset') body.push(offsetPanel());
    if (st.key === 'check') body.push(checkPanel());
    body.push(nav);
    put(panel, ...body.flat());
    function nextBtn() { const b = nav.querySelector('.primary'); if (b) b.disabled = !canNext(); }
  }

  function canNext() {
    const st = STEPS[step];
    if (st.key === 'roofDim') return !!(d.roof.p1 && d.roof.p2 && d.roof.realMm > 0);
    if (st.key === 'floorDim') return !!(d.floor.p1 && d.floor.p2 && d.floor.realMm > 0);
    if (st.key === 'roofRef') return !!d.roof.ref;
    if (st.key === 'floorRef') return !!d.floor.ref;
    if (st.key === 'offset') return d.offsetConfirmed;
    return true;
  }

  function offsetPanel() {
    const R = d.roof.realMm;
    const F = d.floor.realMm;
    const half = R && F ? (F - R) / 2 : null;
    const dx = h('input', { type: 'text', inputmode: 'decimal', value: d.offset.dx });
    const dy = h('input', { type: 'text', inputmode: 'decimal', value: d.offset.dy });
    const upd = async () => { d.offset = { dx: parseFloat(dx.value) || 0, dy: parseFloat(dy.value) || 0 }; d.offsetConfirmed = false; conf.checked = false; await buildOverlay(); viewer.redraw(); renderNext(); };
    dx.addEventListener('change', upd);
    dy.addEventListener('change', upd);
    const set = (x, y) => { dx.value = x; dy.value = y; upd(); };
    const conf = h('input', { type: 'checkbox', checked: d.offsetConfirmed, onchange: (e) => { d.offsetConfirmed = e.target.checked; renderNext(); } });
    const renderNext = () => { const b = panel.querySelector('.grid2 .primary'); if (b) b.disabled = !canNext(); };
    return [
      h('p', null, 'Where is the ROOF reference point relative to the FLOOR reference point, in real mm, on the As drawing? +dx = roof ref is to the RIGHT, +dy = roof ref is LOWER on the page.'),
      h('p', null, 'If both are the same physical point (e.g. you used the same corner), enter 0 and 0.'),
      half != null ? msg('info', `Your roof dimension is ${R} mm and floor dimension is ${F} mm (difference ${fmt(F - R, 1)} mm). IF the roof dimension is the wall-plate outer faces, centred within the masonry, and both references are the same corner, the plate corner is ${fmt(half, 1)} mm inside the masonry corner in each direction. Only you can confirm this from the drawings: wall plates are not always centred, and the other direction may differ.`) : null,
      half != null ? h('div', { class: 'grid2' },
        h('button', { class: 'small', onclick: () => set(half, half) }, `Top-left corner: +${fmt(half, 1)}, +${fmt(half, 1)}`),
        h('button', { class: 'small', onclick: () => set(-half, half) }, `Top-right: −${fmt(half, 1)}, +${fmt(half, 1)}`),
        h('button', { class: 'small', onclick: () => set(half, -half) }, `Bottom-left: +${fmt(half, 1)}, −${fmt(half, 1)}`),
        h('button', { class: 'small', onclick: () => set(-half, -half) }, `Bottom-right: −${fmt(half, 1)}, −${fmt(half, 1)}`)) : null,
      h('div', { class: 'grid2' }, h('div', null, h('label', null, 'dx (mm)'), dx), h('div', null, h('label', null, 'dy (mm)'), dy)),
      h('button', { class: 'small', onclick: () => set(0, 0) }, 'Same point: 0, 0'),
      h('label', { class: 'inline' }, conf, 'I have checked this offset against the drawings. Look at the preview: the roof wall plates should sit on the walls.'),
    ];
  }

  function checkPanel() {
    if (!overlayScene) return [msg('bad', 'Complete steps 1-4 first.')];
    const ch = overlayScene.checks;
    const out = [];
    out.push(ch.angleDiffDeg > 0.1
      ? msg('bad', `Rotation between the reference lines: ${fmt(ch.angleDiffDeg, 3)}° - over the 0.1° limit. Re-place the A/B points (zoom in, use snapping) or the drawings are not square to each other.`)
      : msg('ok', `Rotation between the reference lines: ${fmt(ch.angleDiffDeg, 3)}° (limit 0.1°).`));
    out.push(h('p', null, `Floor 1:${fmt(ch.kFloor / mmPerUnitForScale(1), 2)}, roof 1:${fmt(ch.kRoof / mmPerUnitForScale(1), 2)}${Math.abs(ch.scaleRatio - 1) > 0.005 ? ` - scales differ by ${fmt((ch.scaleRatio - 1) * 100, 2)}%. Fine only if the drawings really are at different scales.` : ''}`));
    out.push(h('h3', null, 'Measure check (required)'),
      h('p', null, 'Drag to place A and B on the overlay across a dimension you know (e.g. a room width or the ridge length), then type what it should be.'));
    const exp = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Expected mm', value: d.measure?.expected ?? '' });
    const res = h('div');
    const showRes = () => {
      if (checkPts.length < 2) { put(res, h('p', { class: 'muted' }, `Place point ${checkPts.length ? 'B' : 'A'}.`)); d.measure = null; return; }
      const measured = dist(checkPts[0], checkPts[1]);
      const expected = parseFloat(exp.value);
      if (!(expected > 0)) { put(res, h('p', { class: 'big' }, `Measured ${fmt(measured, 0)} mm. Type the expected value.`)); d.measure = null; return; }
      const diff = measured - expected;
      d.measure = { measured, expected, diff };
      put(res, Math.abs(diff) <= 5 ? msg('ok', `Measured ${fmt(measured, 0)} mm, expected ${expected} mm: difference ${fmt(diff, 1)} mm.`)
        : msg('warn', `Measured ${fmt(measured, 0)} mm, expected ${expected} mm: difference ${fmt(diff, 1)} mm. Check your calibration points before saving.`));
    };
    exp.addEventListener('input', () => { showRes(); saveBtn.disabled = !d.measure; });
    showRes();
    const note = h('textarea', { rows: 2, placeholder: 'Note (optional): which dimensions and corners you used' });
    note.addEventListener('input', () => { d.note = note.value; });
    const saveBtn = h('button', {
      class: 'primary', style: 'width:100%;margin-top:10px', disabled: !d.measure,
      onclick: async () => {
        const list0 = ht.calibrations?.[floor] || [];
        const version = (list0.at(-1)?.version || 0) + 1;
        const clean = (c) => ({ p1: c.p1, p2: c.p2, realMm: c.realMm, ref: c.ref, pointErrUnits: c.pointErrUnits ?? 0.5, snapped: { p1: !!c.p1Snapped, p2: !!c.p2Snapped, ref: !!c.refSnapped } });
        ht.calibrations = { ...(ht.calibrations || {}), [floor]: [...list0, {
          version, date: new Date().toISOString(), drawingCode: ht.drawingCode,
          roofFileId: ht.drawings.roof.fileId, roofPage: ht.drawings.roof.page,
          floorFileId: ht.drawings[floor].fileId, floorPage: ht.drawings[floor].page,
          roof: clean(d.roof), floor: clean(d.floor), offset: d.offset,
          angleDiffDeg: overlayScene.checks.angleDiffDeg, measureCheck: d.measure, note: d.note,
        }] };
        await saveHT(ht);
        toast(`Calibration v${version} saved`);
        history.back();
      },
    }, 'Save calibration');
    out.push(h('label', null, 'Expected length (mm)'), exp, res, note, saveBtn,
      h('p', { class: 'muted' }, 'Saving creates a new version; earlier versions are kept. The site-check tick must be redone for the new version.'));
    return out;
  }

  async function setStep(i) {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    target = d[STEPS[step].which]?.p1 ? 'p2' : 'p1';
    if (STEPS[step].which === 'overlay') {
      await buildOverlay();
      checkPts = [];
      viewer.setMode(STEPS[step].key === 'check' ? 'point' : 'pan');
      viewer.fit(overlayScene ? sceneBounds(overlayScene) : null);
    } else {
      viewer.setMode('point');
      await ensureUnderlay(STEPS[step].which);
      const m = models[STEPS[step].which];
      viewer.fit({ x0: 0, y0: 0, x1: m.width, y1: m.height }, 8);
    }
    renderPanel();
    viewer.redraw();
  }

  put($app, topbar(`Calibrate ${ht.name} - roof over ${floor}`, '#/types'), stepsBar,
    usePrev ? msg('info', `Starting from calibration v${prev.version}. Re-place any point you want to change.`) : null,
    h('p', { class: 'muted', style: 'font-size:14px' }, 'One finger: drag the crosshair (it sits above your finger) and lift to place. Two fingers: pan and zoom. Zoom right in on corners.'),
    h('div', { class: 'canvaswrap short' }, canvas, h('div', { class: 'canvasbtns' },
      h('button', { onclick: () => viewer.zoomBy(2) }, '+'), h('button', { onclick: () => viewer.zoomBy(0.5) }, '−'))),
    panel);
  viewer.resize();
  await setStep(0);
}

// ---------------------------------------------------------------- layer picker
async function pickerScreen(id, slot) {
  const ht = htById(id);
  if (!ht?.drawings?.[slot]) { put($app, topbar('Layers'), msg('bad', 'Drawing missing.')); return; }
  const role = roleOf(slot);
  const seq = routeSeq;
  const m = await getDrawing(ht.drawings[slot].fileId, ht.drawings[slot].page, role);
  if (stale(seq)) return;
  const s = layerSettings(ht, slot);
  const P = m.method === 'B' ? PALETTES.light : pal();
  let selected = null;
  let showPdf = m.method === 'B';
  let underlay = null;
  let cropping = null;
  const canvas = h('canvas');
  const info = h('div');
  const listBox = h('div');
  const isVis = (g) => groupVisible(g, role, s);
  const save = async () => { await saveHT(ht); };
  const viewer = new Viewer(canvas, {
    draw: (ctx, view, inf) => drawDrawing(ctx, view, m, {
      pal: P, dpr: inf.dpr, isVisible: isVis, catOf: (g) => catOf(g, s), showHidden: true, highlightKey: selected?.key,
      showText: true, underlay: showPdf ? underlay : null, crop: s.crop || m.autoCrop,
      marks: cropping?.length ? { points: cropping.map((p) => ({ ...p, label: 'corner' })) } : null,
    }),
    onTap: (w, inf) => {
      if (cropping) return;
      let best = null;
      let bd = 14 / inf.s;
      for (const g of m.groups) {
        for (let i = 0; i < g.segs.length; i += 4) {
          const dd = pointSegDist(w.x, w.y, g.segs[i], g.segs[i + 1], g.segs[i + 2], g.segs[i + 3]);
          if (dd < bd) { bd = dd; best = g; }
        }
      }
      selected = best;
      renderInfo();
      viewer.redraw();
    },
    onPoint: async (w) => {
      cropping.push(w);
      if (cropping.length === 2) {
        const [a, b] = cropping;
        s.crop = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
        cropping = null;
        viewer.setMode('pan');
        await save();
        renderList();
        toast('Plan area saved. Lines and text outside it are hidden.');
      }
      viewer.redraw();
    },
  });
  state.viewers.push(viewer);
  const renderInfo = () => {
    if (!selected) { put(info, h('p', { class: 'muted' }, m.method === 'B' ? 'Raster drawing: no line groups to pick. You can still set the plan area.' : 'Tap any line on the drawing to select its group.')); return; }
    const g = selected;
    put(info, h('div', { class: 'card' },
      h('strong', null, 'Selected: '), describeGroup(g),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: isVis(g), onchange: async (e) => { s.groupVis[g.key] = e.target.checked; await save(); viewer.redraw(); renderList(); } }), 'Show this group'),
      h('label', null, 'Category'),
      h('select', { onchange: async (e) => { s.groupCat[g.key] = e.target.value; delete s.groupVis[g.key]; await save(); viewer.redraw(); renderList(); } },
        CATEGORIES[role].map(([c, label]) => h('option', { value: c, selected: catOf(g, s) === c }, label)))));
  };
  const renderList = () => {
    put(listBox, h('h3', null, `Line groups (${m.groups.length})`),
      m.groups.slice().sort((a, b) => b.length - a.length).map((g) => h('label', { class: 'inline', style: selected === g ? 'outline:3px solid var(--accent)' : '' },
        h('input', { type: 'checkbox', checked: isVis(g), onchange: async (e) => { s.groupVis[g.key] = e.target.checked; await save(); viewer.redraw(); } }),
        h('span', { onclick: (e) => { e.preventDefault(); selected = g; renderInfo(); renderList(); viewer.redraw(); } }, `${CATEGORIES[role].find((c) => c[0] === catOf(g, s))?.[1] || catOf(g, s)} - ${describeGroup(g)}`))));
  };
  renderInfo();
  renderList();
  put($app, topbar(`Layers: ${ht.name} ${SLOT_LABEL[slot]}`, '#/types'),
    msg('info', 'Faint lines are hidden in the overlay; dark lines are shown; orange is the selected group. Auto-classification is a guess: check it here. Choices are saved for this house type.'),
    msg('info', s.crop ? 'Plan area (orange dashed box): set by you.' : m.autoCrop ? 'Plan area (orange dashed box): automatic, from the walls/roof outline + 15%. Anything outside it is hidden from the overlay.' : 'No plan area: whole page is used.'),
    h('div', { class: 'canvaswrap short' }, canvas, h('div', { class: 'canvasbtns' }, h('button', { onclick: () => viewer.zoomBy(2) }, '+'), h('button', { onclick: () => viewer.zoomBy(0.5) }, '−'))),
    info,
    h('div', { class: 'toolbar' },
      h('button', { onclick: () => { cropping = []; viewer.setMode('point'); toast('Place two opposite corners of the plan area'); } }, 'Set plan area'),
      h('button', { onclick: async () => { s.crop = null; await save(); viewer.redraw(); } }, 'Clear plan area'),
      h('button', {
        onclick: async () => {
          showPdf = !showPdf;
          if (showPdf && !underlay) underlay = await renderRegion(ht.drawings[slot].fileId, ht.drawings[slot].page, null, m.method === 'B' ? 200 : 150);
          viewer.redraw();
        },
      }, 'Original PDF on/off'),
      h('button', { class: 'danger', onclick: async () => { if (!confirm('Reset all layer choices for this drawing to automatic?')) return; ht.layers[slot] = null; await save(); route(); } }, 'Reset to automatic')),
    listBox);
  viewer.resize();
  viewer.fit({ x0: 0, y0: 0, x1: m.width, y1: m.height }, 8);
  if (showPdf) { underlay = await renderRegion(ht.drawings[slot].fileId, ht.drawings[slot].page, null, 200); viewer.redraw(); }
}

// ---------------------------------------------------------------- As / Opp test
async function mirrorScreen(id, floor) {
  const ht = htById(id);
  const cal = ht && currentCal(ht, floor);
  const prob = ht ? calProblem(ht, floor, cal) : 'Unknown house type';
  if (prob) { put($app, topbar('As / Opp test', '#/types'), msg('bad', prob), ht ? h('button', { class: 'primary', onclick: () => go(`#/calibrate/${id}/${floor}`) }, 'Calibrate') : null); return; }
  const testPlot = -1;
  const seq = routeSeq;
  const A = await loadScene(ht, floor, cal, 'As', testPlot);
  const O = await loadScene(ht, floor, cal, 'Opp', testPlot);
  if (stale(seq)) return;
  const mk = (r, label) => {
    const c = h('canvas');
    const v = new Viewer(c, { draw: (ctx, view, info) => drawScene(ctx, view, r.scene, { pal: r.pal, opacity: 0.8, bitmaps: r.bitmaps, dpr: info.dpr, loupe: info.loupe }) });
    state.viewers.push(v);
    return { el: h('div', null, h('div', { class: 'lbl' }, label), c), v, r };
  };
  const a = mk(A, 'AS (drawing)');
  const o = mk(O, 'OPP (mirrored)');
  put($app, topbar(`As / Opp: ${ht.name}`, '#/types'),
    msg('info', 'Check: walls and roof lines swap sides; the roof stays on the same walls in both; room names stay readable (not back-to-front) and sit in the mirrored rooms. Dimension text is hidden on the Opp view. The axis is vertical, through the floor plan reference point.'),
    h('div', { class: 'side' }, a.el, o.el),
    h('div', { class: 'notice' }, NOTICE));
  for (const x of [a, o]) { x.v.resize(); x.v.fit(sceneBounds(x.r.scene), 8); }
}

// ---------------------------------------------------------------- settings + schedule
function settingsScreen() {
  const s = state.schedule;
  const theme = h('select', { onchange: async (e) => { state.settings.theme = e.target.value; applyTheme(); await db.kvSet('settings', state.settings); } },
    [['auto', 'Follow phone'], ['light', 'Light (bright sun)'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: state.settings.theme === v }, l)));
  const storageInfo = h('p', { class: 'muted' });
  navigator.storage?.estimate?.().then(async (e) => {
    const persisted = await navigator.storage.persisted?.();
    storageInfo.textContent = `Using ${(e.usage / 1e6).toFixed(1)} MB on this device. Storage ${persisted ? 'is protected from automatic clearing' : 'may be cleared by the browser if space runs low - keep a backup'}.`;
  });
  put($app, topbar('Settings'),
    h('div', { class: 'card' }, h('h2', null, 'Plot schedule'),
      s ? h('p', null, `${s.rows.length} plots, ${s.fileName}, imported ${(s.importedAt || '').slice(0, 10)}. Code column: ${s.mapping?.codeCol || '?'}${s.mapping?.confirmed ? '' : ' (NOT CONFIRMED)'}`) : h('p', { class: 'muted' }, 'Not imported.'),
      h('div', { class: 'grid2' },
        h('button', { class: 'primary', onclick: importSchedule }, s ? 'Re-import PDF' : 'Import schedule PDF'),
        s ? h('button', { onclick: () => go('#/schedule') }, 'Review / mapping') : null)),
    h('div', { class: 'card' }, h('h2', null, 'Calibrations'),
      state.houseTypes.length ? state.houseTypes.map((ht) => h('div', null, h('h3', null, `${ht.name} ${ht.drawingCode}`),
        floorsOf(ht).map((f) => {
          const cals = ht.calibrations?.[f] || [];
          return h('div', null, h('strong', null, `Roof over ${SLOT_LABEL[f]}: `), cals.length ? '' : 'none',
            list(cals.slice().reverse().map((c) => `v${c.version} ${c.date.slice(0, 10)} drawing ${c.drawingCode}, roof ${c.roof.realMm} mm / floor ${c.floor.realMm} mm, offset ${c.offset.dx},${c.offset.dy}, rotation ${fmt(c.angleDiffDeg, 3)}°${calProblem(ht, f, c) ? ' (OUT OF DATE)' : ''}${siteCheck(ht, f, c) ? ' - site checked ' + siteCheck(ht, f, c).date : ''}`)),
            h('button', { class: 'small', onclick: () => go(`#/calibrate/${ht.id}/${f}`) }, 'Calibrate'));
        }))) : h('p', { class: 'muted' }, 'No house types.')),
    h('div', { class: 'card' }, h('h2', null, 'Backup'),
      h('p', null, 'A backup contains drawings, schedule and calibrations as one JSON file. It holds confidential drawings: store it somewhere safe.'),
      h('div', { class: 'grid2' },
        h('button', { onclick: async () => { const b = await db.exportBackup(); await saveBlob(new Blob([JSON.stringify(b)], { type: 'application/json' }), `roofline-backup-${today()}.json`); } }, 'Save backup'),
        h('button', {
          onclick: async () => {
            const f = await pickFile('application/json,.json');
            if (!f) return;
            if (!confirm('Restoring replaces house types, calibrations and schedule on this device. Continue?')) return;
            try { await db.importBackup(JSON.parse(await f.text())); await loadAll(); toast('Restored'); route(); } catch (e) { toast('Restore failed: ' + e.message, 5000); }
          },
        }, 'Restore backup'))),
    h('div', { class: 'card' }, h('h2', null, 'Display'), h('label', null, 'Theme'), theme),
    h('div', { class: 'card' }, h('h2', null, 'Storage'), storageInfo,
      h('button', { class: 'danger', onclick: async () => { if (!confirm('Delete ALL drawings, schedule and calibrations from this device?')) return; await db.wipeAll(); await loadAll(); route(); } }, 'Clear all data')),
    h('p', { class: 'muted' }, 'RoofLine runs offline and never sends drawings anywhere. PDF.js (Apache-2.0) is bundled.'));
}

async function importSchedule() {
  const f = await pickFile('application/pdf,.pdf');
  if (!f) return;
  toast('Reading schedule locally…', 10000);
  try {
    const buf = await readFile(f);
    const fileId = await db.saveFile(f.name, buf);
    const pages = await textPages(buf);
    const parsed = parseSchedule(pages);
    if (!parsed.rows.length) { toast('No plot rows found. Is this the variation sheet? Does it contain selectable text?', 6000); return; }
    const prevMap = state.schedule?.mapping;
    const mapping = prevMap && parsed.columns.includes(prevMap.codeCol) ? { ...prevMap, confirmed: false } : guessMapping(parsed.columns);
    state.pendingSchedule = { ...parsed, mapping, fileName: f.name, fileId, importedAt: new Date().toISOString(), expected: state.schedule?.expected || { from: 1, to: 181 } };
    flagRows(state.pendingSchedule.rows, mapping);
    $toast.hidden = true;
    go('#/schedule');
  } catch (e) { toast('Could not read the schedule: ' + e.message, 6000); }
}

function scheduleScreen() {
  const s = state.pendingSchedule || (state.schedule && structuredClone(state.schedule));
  if (!s) { go('#/settings'); return; }
  const isPending = !!state.pendingSchedule;
  let flaggedOnly = s.rows.some((r) => r.flags?.length && !r.reviewed);
  let search = '';
  const m = s.mapping;
  const tableBox = h('div');
  const summary = h('div');
  const colSelect = (key, label, hint) => h('div', null, h('label', null, label), hint ? h('small', null, hint) : null,
    h('select', { onchange: (e) => { m[key] = e.target.value; m.confirmed = false; flagRows(s.rows, m); renderAll(); } },
      h('option', { value: '' }, '(none)'), s.columns.map((c) => h('option', { value: c, selected: m[key] === c }, c))));
  const renderSummary = () => {
    const v = validateRows(s.rows, s.expected.from, s.expected.to);
    const flagged = s.rows.filter((r) => r.flags?.length && !r.reviewed).length;
    put(summary, 
      v.count === s.expected.to - s.expected.from + 1 && !v.missing.length && !v.duplicates.length
        ? msg('ok', `${v.count} plots, ${s.expected.from}-${s.expected.to}, none missing, no duplicates.`)
        : msg('bad', `${v.count} rows parsed. `, v.missing.length ? `Missing plots: ${v.missing.join(', ')}. ` : '', v.duplicates.length ? `Duplicated plots: ${v.duplicates.join(', ')}. ` : '', v.outOfRange.length ? `Outside ${s.expected.from}-${s.expected.to}: ${v.outOfRange.join(', ')}.` : ''),
      flagged ? msg('warn', `${flagged} row(s) flagged as uncertain (highlighted). Check each against the PDF, fix it, then tick "OK".`) : null,
      s.warnings?.length ? msg('warn', list(s.warnings)) : null);
  };
  const renderTable = () => {
    const rows = s.rows.filter((r) => (!flaggedOnly || (r.flags?.length && !r.reviewed)) && (!search || String(r.plot) === search));
    put(tableBox, h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'OK'), s.columns.map((c) => h('th', null, c)), h('th', null, 'Issues'), h('th', null, ''))),
      h('tbody', null, rows.map((r) => h('tr', { class: `${r.flags?.length ? 'flag' : ''} ${r.reviewed ? 'reviewed' : ''}` },
        h('td', null, h('input', { type: 'checkbox', checked: !!r.reviewed, onchange: (e) => { r.reviewed = e.target.checked; renderSummary(); } })),
        s.columns.map((c) => h('td', null, h('input', {
          value: r.cells[c] ?? '', size: Math.max(4, Math.min(28, (r.cells[c] || '').length + 1)),
          onchange: (e) => {
            r.cells[c] = e.target.value.trim();
            if (c === m.plotCol) { r.plot = parseInt(r.cells[c], 10); r.plotRaw = r.cells[c]; }
            r.edited = true;
            const keep = r.reviewed;
            flagRows([r], m);
            r.reviewed = keep;
            renderSummary();
          },
        }))),
        h('td', { class: 'reasons' }, (r.flags || []).join('; ')),
        h('td', null, h('button', { class: 'small danger', onclick: () => { if (confirm(`Delete row for plot ${r.plotRaw}?`)) { s.rows.splice(s.rows.indexOf(r), 1); renderAll(); } } }, '✕'))))))),
    h('button', {
      class: 'small', onclick: () => {
        const n = prompt('Plot number for the new row');
        if (!n) return;
        s.rows.push({ plot: parseInt(n, 10), plotRaw: n, cells: { [m.plotCol]: n }, page: 0, uncertain: ['Added by hand'], flags: ['Added by hand'] });
        s.rows.sort((a, b) => a.plot - b.plot);
        search = String(parseInt(n, 10));
        renderAll();
      },
    }, '+ Add missing row'));
  };
  const renderAll = () => { renderSummary(); renderTable(); };
  const from = h('input', { type: 'text', inputmode: 'numeric', value: s.expected.from, onchange: (e) => { s.expected.from = parseInt(e.target.value, 10) || 1; renderSummary(); } });
  const to = h('input', { type: 'text', inputmode: 'numeric', value: s.expected.to, onchange: (e) => { s.expected.to = parseInt(e.target.value, 10) || 181; renderSummary(); } });
  const codeChoice = h('div', null, h('label', null, 'Which column holds the drawing code that matches your drawing set?'),
    h('small', null, 'e.g. ACTUAL PORTAL CODE "BELX 2401 AA04" vs BASE CODE. The drawing variant (AA04/AA05/AA00) must match, so choose carefully.'),
    s.columns.filter((c) => /CODE/i.test(c)).concat(s.columns.some((c) => /CODE/i.test(c)) ? [] : s.columns).map((c) => h('label', { class: 'inline' },
      h('input', { type: 'radio', name: 'codecol', checked: m.codeCol === c, onchange: () => { m.codeCol = c; m.confirmed = false; flagRows(s.rows, m); renderAll(); } }),
      h('span', null, h('strong', null, c), h('small', null, ` e.g. ${s.rows.slice(0, 3).map((r) => r.cells[c]).filter(Boolean).join(' | ')}`)))));
  const searchBox = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Find plot no.', oninput: (e) => { search = e.target.value.trim(); renderTable(); } });
  renderAll();
  put($app, topbar(isPending ? 'Review imported schedule' : 'Schedule', '#/settings'),
    isPending ? msg('info', `Parsed from ${s.fileName}. Nothing is saved until you press Save. Check highlighted rows against the PDF.`) : null,
    h('div', { class: 'card' }, h('h2', null, 'Column mapping'),
      codeChoice,
      colSelect('nameCol', 'House type name column', 'Matched against the house type name / aliases.'),
      colSelect('handCol', 'Handing column (As / Opp)'),
      colSelect('finishCol', 'Roof finish column'),
      colSelect('roofTypeCol', 'Roof type column'),
      colSelect('salesCol', 'Sales name column (display only)'),
      colSelect('plotCol', 'Plot number column'),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: !!m.confirmed, onchange: (e) => { m.confirmed = e.target.checked; } }), 'I confirm this mapping is correct')),
    h('div', { class: 'card' }, h('h2', null, 'Expected plots'), h('div', { class: 'grid2' }, h('div', null, h('label', null, 'From'), from), h('div', null, h('label', null, 'To'), to))),
    summary,
    h('div', { class: 'row' }, searchBox, h('label', { class: 'inline', style: 'flex:0 0 auto' }, h('input', { type: 'checkbox', checked: flaggedOnly, onchange: (e) => { flaggedOnly = e.target.checked; renderTable(); } }), 'Flagged only')),
    tableBox,
    h('button', {
      class: 'primary', style: 'width:100%;margin-top:12px',
      onclick: async () => {
        if (!m.codeCol || !m.nameCol || !m.handCol) { toast('Choose the code, name and handing columns'); return; }
        if (!m.confirmed && !confirm('The column mapping is not confirmed. Plot screens will show a warning until it is. Save anyway?')) return;
        const v = validateRows(s.rows, s.expected.from, s.expected.to);
        if ((v.missing.length || v.duplicates.length) && !confirm(`There are ${v.missing.length} missing and ${v.duplicates.length} duplicated plot numbers. Save anyway? (Duplicated plots will refuse to open.)`)) return;
        state.schedule = s;
        state.pendingSchedule = null;
        await db.kvSet('schedule', s);
        await db.requestPersistence();
        toast('Schedule saved');
        go('#/settings');
      },
    }, 'Save schedule'));
}

// ---------------------------------------------------------------- boot
async function boot() {
  window.__roofline = state; // read-only hook used by the automated browser tests
  await loadAll();
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => route());
  window.addEventListener('hashchange', route);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
  route();
}
boot();
