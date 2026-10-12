// RoofLine test suite.  Run: npm test
// Synthetic fixtures (tests/fixtures/synthetic) are generated, NOT the real drawings.
// Put real PDFs in tests/fixtures/real/ (git-ignored) to run the same checks on them:
//   real/schedule.pdf, real/ellerton_roof.pdf, real/ellerton_first_floor.pdf
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadDrawing, schedulePages, inspect, SYN, REAL } from './helpers.mjs';
import { scaleFromPoints, makeTransform, mirrorX, mirrorPoint, measureMm, dist, errorEstimate } from '../js/geom.js';
import { parseSchedule, validateRows, guessMapping, flagRows } from '../js/schedule.js';
import { resolvePlot } from '../js/lookup.js';
import { buildScene } from '../js/scene.js';
import { parsePlotList, plotNoteVisibility } from '../js/text.js';

const W = 10436;
const WP = 10113;

// ---------- helpers ----------
function bbox(segs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < segs.length; i += 2) {
    x0 = Math.min(x0, segs[i]); x1 = Math.max(x1, segs[i]);
    y0 = Math.min(y0, segs[i + 1]); y1 = Math.max(y1, segs[i + 1]);
  }
  return { x0, y0, x1, y1 };
}
const groupBy = (d, pred) => d.groups.find(pred);

/** Calibrate the synthetic drawings exactly as a user would: tap snapped corners. */
async function calibratedSynthetic() {
  const floor = await loadDrawing(path.join(SYN, 'ellerton_first_floor.pdf'), 'floor');
  const roof = await loadDrawing(path.join(SYN, 'ellerton_roof.pdf'), 'roof');
  const outer = bbox(groupBy(floor, (g) => g.lw === 0.7).segs); // external wall outer face
  const plate = bbox(groupBy(roof, (g) => g.dash).segs); // wall plate outer faces (dashed)
  const floorCal = { p1: { x: outer.x0, y: outer.y0 }, p2: { x: outer.x1, y: outer.y0 }, realMm: W, ref: { x: outer.x0, y: outer.y0 } };
  // Roof reference = wall plate corner, which sits (W-WP)/2 inside the masonry corner.
  const off = (W - WP) / 2;
  const roofCal = { p1: { x: plate.x0, y: plate.y0 }, p2: { x: plate.x1, y: plate.y0 }, realMm: WP, ref: { x: plate.x0, y: plate.y0 }, offset: { dx: off, dy: off } };
  return { floor, roof, floorCal, roofCal, outer, plate };
}

let schedCache;
async function syntheticSchedule() {
  if (schedCache) return schedCache;
  const parsed = parseSchedule(await schedulePages(path.join(SYN, 'plot_schedule.pdf')));
  const mapping = { ...guessMapping(parsed.columns), confirmed: true };
  flagRows(parsed.rows, mapping);
  schedCache = { ...parsed, mapping };
  return schedCache;
}

const ellerton = { id: 'h1', name: 'ELLERTON', aliases: ['Ellerton Elder'], drawingCode: 'BELX 2401 AA04' };

// ---------- required tests ----------

test('schedule parser returns 181 plots with no duplicates (synthetic)', async () => {
  const s = await syntheticSchedule();
  const v = validateRows(s.rows, 1, 181);
  assert.equal(v.count, 181);
  assert.deepEqual(v.duplicates, []);
  assert.deepEqual(v.missing, []);
  const r63 = s.rows.find((r) => r.plot === 63);
  assert.equal(r63.cells['SALES NAME'], 'Hadley (show home variant)', 'wrapped plot 63 cell is joined');
  assert.ok(r63.flags.length > 0, 'wrapped row is flagged for review');
});

test('plot 30 (As) and plot 31 (Opp) resolve to Ellerton with the same drawing code', async () => {
  const s = await syntheticSchedule();
  const r30 = resolvePlot(30, s, [ellerton]);
  const r31 = resolvePlot(31, s, [ellerton]);
  assert.equal(r30.status, 'ok');
  assert.equal(r31.status, 'ok');
  assert.equal(r30.houseType.id, 'h1');
  assert.equal(r31.houseType.id, 'h1');
  assert.equal(r30.code, r31.code);
  assert.equal(r30.handing, 'As');
  assert.equal(r31.handing, 'Opp');
});

test('plot 31 renders mirrored with upright, unmirrored text', async () => {
  const { floor, roof, floorCal, roofCal } = await calibratedSynthetic();
  const as = buildScene({ extract: floor, cal: floorCal }, { extract: roof, cal: roofCal }, { handing: 'As', plot: 30 });
  const opp = buildScene({ extract: floor, cal: floorCal }, { extract: roof, cal: roofCal }, { handing: 'Opp', plot: 31 });
  assert.equal(opp.mirrored, true);
  // geometry mirrored about the floor reference axis x=0
  const wallAs = bbox(as.floor.groups.find((g) => g.lw === 0.7).segs);
  const wallOpp = bbox(opp.floor.groups.find((g) => g.lw === 0.7).segs);
  assert.ok(Math.abs(wallAs.x0 - 0) < 1e-6 && Math.abs(wallAs.x1 - W) < 1);
  assert.ok(Math.abs(wallOpp.x1 - 0) < 1e-6 && Math.abs(wallOpp.x0 + W) < 1);
  // roof wall plate mirrored with the SAME transform (stays aligned to the floor)
  const plateOpp = bbox(opp.roof.groups.find((g) => g.category === 'dashed').segs);
  assert.ok(Math.abs(plateOpp.x1 - -(W - WP) / 2) < 0.5, `plate right edge ${plateOpp.x1}`);
  // text: same strings, mirrored anchor, never mirrored glyphs, upright angle
  const rooms = (sc) => sc.floor.texts.filter((t) => t.cls === 'room');
  assert.equal(rooms(opp).length, 5);
  for (const t of rooms(opp)) {
    const twin = rooms(as).find((u) => u.str === t.str);
    assert.ok(twin, t.str);
    assert.equal(t.x, -twin.x);
    assert.equal(t.y, twin.y);
    assert.equal(t.mirroredGlyphs, false);
    assert.ok(Math.abs(t.angle) < 1e-9, 'upright');
  }
  // dimension text hidden on mirrored views
  assert.equal(opp.floor.texts.filter((t) => t.cls === 'dim').length, 0);
});

test('calibration maths: measure tool returns the known length within 1mm', () => {
  const p1 = { x: 123.4567, y: 456.789 };
  const p2 = { x: 715.1234, y: 461.002 };
  const k = scaleFromPoints(p1, p2, W);
  const T = makeTransform({ p1, p2, realMm: W, ref: p1 });
  assert.ok(Math.abs(measureMm(T.toWorld(p1.x, p1.y), T.toWorld(p2.x, p2.y)) - W) < 1);
  assert.ok(Math.abs(k * dist(p1, p2) - W) < 1e-9);
  // a point half way along measures half the length
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  assert.ok(Math.abs(measureMm(T.toWorld(p1.x, p1.y), T.toWorld(mid.x, mid.y)) - W / 2) < 1);
  assert.throws(() => scaleFromPoints(p1, p1, 100));
  assert.throws(() => scaleFromPoints(p1, p2, 0));
});

test('calibration on synthetic drawings: known features measure correctly within 1mm', async () => {
  const { floor, roof, floorCal, roofCal } = await calibratedSynthetic();
  const sc = buildScene({ extract: floor, cal: floorCal }, { extract: roof, cal: roofCal }, { handing: 'As', plot: 30 });
  const ridge = sc.roof.groups.find((g) => g.lw === 0.5); // ridge + hips layer
  // longest horizontal ridge segment = W - D = 4236 mm
  let best = 0;
  for (let i = 0; i < ridge.segs.length; i += 4) {
    if (Math.abs(ridge.segs[i + 1] - ridge.segs[i + 3]) < 1e-6) best = Math.max(best, Math.abs(ridge.segs[i + 2] - ridge.segs[i]));
  }
  assert.ok(Math.abs(best - (W - 6200)) < 1, `ridge ${best}`);
  // roof wall plate sits 161.5mm inside the masonry face on BOTH sides
  const plate = bbox(sc.roof.groups.find((g) => g.category === 'dashed').segs);
  assert.ok(Math.abs(plate.x0 - 161.5) < 1 && Math.abs(plate.x1 - (W - 161.5)) < 1, JSON.stringify(plate));
  assert.ok(sc.checks.angleDiffDeg <= 0.1);
});

test('mirror maths: mirroring twice returns the original coordinates exactly', () => {
  const pts = [0, 1e-12, -3.3, 10436, 123456.789, 0.1 + 0.2, -0, Number.MIN_VALUE];
  for (const x of pts) {
    assert.equal(mirrorX(mirrorX(x)), x === 0 ? 0 : x);
    const p = { x, y: 17.25 };
    assert.deepEqual(mirrorPoint(mirrorPoint(p)), { x: x === 0 ? 0 : x, y: 17.25 });
  }
});

// ---------- supporting tests ----------

test('plot-list notes filter by selected plot and flag unreadable lists', () => {
  const n = parsePlotList('Rad position to plots: 30, 31, 82-84 & 110');
  assert.deepEqual(n.plots, [30, 31, 82, 83, 84, 110]);
  assert.equal(plotNoteVisibility(n, 83), 'show');
  assert.equal(plotNoteVisibility(n, 85), 'hide');
  const bad = parsePlotList('Plots: see sheet 4 rev C 12');
  assert.equal(bad.uncertain, true);
  assert.equal(plotNoteVisibility(bad, 30), 'warn');
});

test('synthetic drawings are detected as vector (Method A) and the flattened one as raster (Method B)', async () => {
  const a = await inspect(path.join(SYN, 'ellerton_first_floor.pdf'));
  assert.equal(a.pages[0].method, 'A');
  for (const r of ['BED 1', 'BATH', 'EN-SUITE', 'LANDING']) assert.ok(a.pages[0].rooms.includes(r), r);
  assert.ok(a.pages[0].dims.includes('10436'));
  const b = await inspect(path.join(SYN, 'ellerton_first_floor_raster.pdf'));
  assert.equal(b.pages[0].method, 'B');
  assert.ok(Math.abs(b.pages[0].raster.dpi - 150) < 2);
});

test('raster error estimate scales with image resolution', () => {
  const k = 50 * 25.4 / 72; // 1:50
  const lo = errorEstimate({ k, lengthUnits: 590, pointErrUnits: 0.1, imagePxUnits: 72 / 150 });
  const hi = errorEstimate({ k, lengthUnits: 590, pointErrUnits: 0.1, imagePxUnits: 72 / 300 });
  assert.ok(lo.pointMm > hi.pointMm);
  assert.ok(Math.abs(lo.imagePxMm - 8.47) < 0.01, `${lo.imagePxMm}`); // 1px @150dpi @1:50 = 8.47mm
});

test('lookup never falls back: unknown plot, name-only match and code-only match are refused', async () => {
  const s = await syntheticSchedule();
  assert.equal(resolvePlot(999, s, [ellerton]).status, 'not-in-schedule');
  // plot 1 is Ellerton but variant AA05: same name, different code -> no drawing
  assert.equal(resolvePlot(1, s, [ellerton]).status, 'no-drawing');
  // same code but different name -> refused
  assert.equal(resolvePlot(30, s, [{ ...ellerton, name: 'HADLEY', aliases: [] }]).status, 'no-drawing');
});

test('schedule parser handles a vertically centred wrapped cell', () => {
  const it = (str, x, y) => ({ str, x, y, w: str.length * 4, size: 7, angle: 0 });
  const items = [it('PLOT', 30, 50), it('NO', 30, 58), it('HOUSE TYPE', 80, 50), it('HANDINGS', 160, 50)];
  const rowY = [80, 95, 118, 133];
  rowY.forEach((y, i) => { items.push(it(String(i + 62), 30, y), it('ELLERTON', 80, y), it(i % 2 ? 'Opp' : 'As', 160, y)); });
  // plot 63's house type wraps above and below its plot number (centred cell)
  items.splice(items.findIndex((x) => x.str === 'ELLERTON' && x.y === 95), 1, it('ELLERTON', 80, 91), it('(SHOW)', 80, 99));
  const { rows } = parseSchedule([items]);
  assert.deepEqual(rows.map((r) => r.plot), [62, 63, 64, 65]);
  assert.equal(rows[1].cells['HOUSE TYPE'], 'ELLERTON (SHOW)');
  assert.equal(rows[0].cells['HOUSE TYPE'], 'ELLERTON');
});

// ---------- real drawings (only if present, never committed) ----------
const real = (f) => path.join(REAL, f);
const has = (f) => fs.existsSync(real(f));

test('REAL schedule: 181 plots, no duplicates', { skip: !has('schedule.pdf') && 'no tests/fixtures/real/schedule.pdf' }, async () => {
  const p = parseSchedule(await schedulePages(real('schedule.pdf')));
  const v = validateRows(p.rows, 1, 181);
  console.log('REAL schedule columns:', p.columns, 'warnings:', p.warnings, 'validation:', v);
  assert.deepEqual(v.duplicates, []);
  assert.deepEqual(v.missing, []);
  assert.equal(v.count, 181);
  const m = guessMapping(p.columns);
  const r30 = p.rows.find((r) => r.plot === 30);
  const r31 = p.rows.find((r) => r.plot === 31);
  assert.equal(r30.cells[m.codeCol], r31.cells[m.codeCol], 'plots 30 and 31 share a drawing code');
  assert.match(r30.cells[m.handCol], /^as/i);
  assert.match(r31.cells[m.handCol], /^opp/i);
});

for (const f of ['ellerton_roof.pdf', 'ellerton_first_floor.pdf']) {
  test(`REAL ${f}: Step 0 inspection`, { skip: !has(f) && `no tests/fixtures/real/${f}` }, async () => {
    const r = await inspect(real(f));
    console.log(`REAL ${f}:`, JSON.stringify(r, null, 1));
    assert.ok(r.pageCount >= 1);
  });
}

test('automatic plan area covers the building but excludes the title block', async () => {
  const { floor, roof, outer } = await calibratedSynthetic();
  for (const d of [floor, roof]) {
    const c = d.autoCrop;
    assert.ok(c, 'has auto crop');
    assert.ok(c.x1 < 1190.55 - 260, `crop stops before the title block (x1=${c.x1})`);
  }
  assert.ok(floor.autoCrop.x0 < outer.x0 && floor.autoCrop.x1 > outer.x1);
});

test('snapping finds the crossing of a dimension line and its extension line', async () => {
  const { snapNear } = await import('../js/geom.js');
  // dimension line overshoots the extension line (as on the real Ellerton drawings)
  const segs = [380.129, 712.8, 695.489, 712.8, /* extension */ 383.009, 700, 383.009, 720];
  const hit = snapNear(segs, { x: 382, y: 713 }, 3);
  assert.equal(hit.type, 'cross');
  assert.ok(Math.abs(hit.x - 383.009) < 1e-9 && Math.abs(hit.y - 712.8) < 1e-9);
  // far from the crossing, near the overshooting end: snaps to the end
  assert.equal(snapNear(segs, { x: 380.2, y: 712.9 }, 1).type, 'end');
});

test('markup slash lists: ranges, joined wraps, and unknown plot numbers are flagged', async () => {
  const { parsePlotList, plotNoteVisibility } = await import('../js/text.js');
  const n = parsePlotList('20K vent 16/17/26/27/66/67/75/76/82/83/110-113/125');
  assert.deepEqual(n.plots, [16, 17, 26, 27, 66, 67, 75, 76, 82, 83, 110, 111, 112, 113, 125]);
  const known = new Set(Array.from({ length: 181 }, (_, i) => i + 1));
  assert.equal(plotNoteVisibility(n, 30, known), 'hide');
  assert.equal(plotNoteVisibility(n, 112, known), 'show');
  const typo = parsePlotList('20K vent 16/17/26/27/30/31/71/72/66/67/75/756/82/83/110-113/124/125/133/134');
  assert.equal(plotNoteVisibility(typo, 30, known), 'warn', '756 is not a plot: warn, never silently filter');
});

test('one house type can serve several drawing codes (still needs code AND name)', async () => {
  const s = await syntheticSchedule();
  const multi = { id: 'm', name: 'ELLERTON', aliases: ['Ellerton Elder'], drawingCode: 'BELX 2401 AA04, BELX 2401 AA05' };
  assert.equal(resolvePlot(1, s, [multi]).status, 'ok'); // AA05 plot
  assert.equal(resolvePlot(30, s, [multi]).status, 'ok'); // AA04 plot
  assert.equal(resolvePlot(62, s, [multi]).status, 'no-drawing'); // AA00 not listed
});
