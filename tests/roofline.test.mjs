// RoofLine tests.  Run: npm test
// Synthetic fixtures are generated (tests/fixtures/make_fixtures.py), not real drawings.
// Real drawings in tests/fixtures/real/ (git-ignored) are used when present:
//   ellerton_roof.pdf, ellerton_first_floor.pdf
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { geometry, SYN, REAL } from './helpers.mjs';
import { snapNear, roofToFloorPoint } from '../js/geom.js';
import { statedScale, clipSegs } from '../js/pdf-extract.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('reads line geometry and the stated scale from a vector drawing', async () => {
  const g = await geometry(path.join(SYN, 'ellerton_first_floor.pdf'));
  assert.ok(g.segs.length / 4 > 50);
  assert.equal(g.statedScale, 50);
  assert.ok(near(g.width, 1190.55, 0.1) && near(g.height, 841.89, 0.1));
});

test('stated scale: most common "1:N" on the sheet wins', () => {
  assert.equal(statedScale(['Scale 1:50 @ A3', 'Detail 1:5', 'Scale: 1 : 50']), 50);
  assert.equal(statedScale(['no scale here']), null);
});

test('snapping finds the crossing of a dimension line and its extension line', () => {
  const segs = [380.129, 712.8, 695.489, 712.8, 383.009, 700, 383.009, 720];
  const hit = snapNear(segs, { x: 382, y: 713 }, 3);
  assert.equal(hit.type, 'cross');
  assert.ok(near(hit.x, 383.009, 1e-9) && near(hit.y, 712.8, 1e-9));
  assert.equal(snapNear(segs, { x: 380.2, y: 712.9 }, 1).type, 'end');
});

test('roof is placed so the tapped roof corner lands on the tapped floor corner', () => {
  const align = { roofRef: { x: 383, y: 68.4 }, floorRef: { x: 428.6, y: 106.1 } };
  assert.deepEqual(roofToFloorPoint(383, 68.4, align), { x: 428.6, y: 106.1 });
  const p = roofToFloorPoint(483, 68.4, align); // 100pt along the roof = 100pt along the floor
  assert.ok(near(p.x, 528.6, 1e-9) && near(p.y, 106.1, 1e-9));
  const q = roofToFloorPoint(483, 68.4, align, 2); // roof at 1:100 over floor at 1:50
  assert.ok(near(q.x, 628.6, 1e-9));
  const n = roofToFloorPoint(383, 68.4, align, 1, { x: 5, y: -2 });
  assert.ok(near(n.x, 433.6, 1e-9) && near(n.y, 104.1, 1e-9));
});

test('clipping keeps only the visible part of a line', () => {
  const out = clipSegs([0, 0, 10, 10], { x0: 5, y0: 0, x1: 20, y1: 20 });
  assert.ok(near(out[0], 5, 1e-5) && near(out[1], 5, 1e-5) && near(out[2], 10, 1e-5));
  assert.deepEqual(clipSegs([0, 0, 1, 1], { x0: 5, y0: 5, x1: 6, y1: 6 }), []);
});

// ---------- real drawings (only if present, never committed) ----------
const real = (f) => path.join(REAL, f);
const have = fs.existsSync(real('ellerton_roof.pdf')) && fs.existsSync(real('ellerton_first_floor.pdf'));

test('REAL drawings line up: corner + 5461 width match within 0.5mm at 1:50', { skip: !have && 'no real drawings' }, async () => {
  const roof = await geometry(real('ellerton_roof.pdf'));
  const floor = await geometry(real('ellerton_first_floor.pdf'));
  assert.equal(roof.statedScale, 50);
  assert.equal(floor.statedScale, 50);
  // no phantom lines from the sheet corner
  for (const g of [roof, floor]) {
    for (let i = 0; i < g.segs.length; i += 4) assert.ok(!(g.segs[i] === 0 && g.segs[i + 1] === 0), 'segment from 0,0');
  }
  // tap near the top-left building corner on each (snaps to the exact corner)
  const r = snapNear(roof.segs, { x: 383.2, y: 68.5 }, 2);
  const f = snapNear(floor.segs, { x: 428.8, y: 106.2 }, 2);
  const align = { roofRef: r, floorRef: f };
  // the roof's top-right corner (5461 dimension) must land on the floor's top-right corner
  const roofTR = snapNear(roof.segs, { x: 692.7, y: 68.5 }, 2);
  const floorTR = snapNear(floor.segs, { x: 738.3, y: 106.2 }, 2);
  const p = roofToFloorPoint(roofTR.x, roofTR.y, align);
  const mm = Math.hypot(p.x - floorTR.x, p.y - floorTR.y) * 50 * 25.4 / 72;
  assert.ok(mm < 0.5, `top-right corners ${mm.toFixed(2)} mm apart`);
});

test('REAL: first view finds the house on the floor plan from the tapped corner', { skip: !have && 'no real drawings' }, async () => {
  const { regionAround } = await import('../js/geom.js');
  const floor = await geometry(real('ellerton_first_floor.pdf'));
  const b = regionAround(floor.segs, floor.width, floor.height, { x: 428.6, y: 106.1 }, 8);
  // outside walls run roughly x 425-743, y 106-700 on this sheet
  assert.ok(b.x0 <= 425 && b.x1 >= 743 && b.y0 <= 106 && b.y1 >= 700, JSON.stringify(b));
  assert.ok(b.x1 - b.x0 < 0.5 * floor.width, 'should not take in the whole sheet');
});

test('REAL floor plan: wall layer and room names are found', { skip: !have && 'no real drawings' }, async () => {
  const floor = await geometry(real('ellerton_first_floor.pdf'));
  assert.ok(floor.wallSegs && floor.wallSegs.length / 4 > 1000, 'wall layer');
  const names = floor.rooms.map((r) => r.str);
  for (const n of ['BED 1', 'BED 2', 'BED 3', 'BATH', 'EN-SUITE', 'LANDING']) assert.ok(names.includes(n), n);
  // labels sit inside the house (outside walls roughly x 425-743, y 106-700)
  for (const r of floor.rooms) assert.ok(r.x > 425 && r.x < 743 && r.y > 106 && r.y < 700, `${r.str} at ${r.x},${r.y}`);
});

test('synthetic floor plan has no grey wall layer, so the full drawing is used', async () => {
  const g = await geometry(path.join(SYN, 'ellerton_first_floor.pdf'));
  assert.equal(g.wallSegs, null);
  assert.ok(g.rooms.some((r) => r.str === 'EN-SUITE'));
});

test('REAL roof plan, cleaned: no dimensions, all vent and PV markups kept', { skip: !have && 'no real drawings' }, async () => {
  const roof = await geometry(real('ellerton_roof.pdf'));
  const c = roof.clean;
  // no dimension ticks left (short thick diagonals)
  for (const p of c.paths) {
    for (let i = 0; i < p.segs.length; i += 4) {
      const dx = p.segs[i + 2] - p.segs[i], dy = p.segs[i + 3] - p.segs[i + 1], L = Math.hypot(dx, dy);
      assert.ok(!(p.stroke && !p.markup && p.lw >= 0.7 && L >= 1.5 && L <= 4.5 && Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.2 * L), 'tick left');
    }
  }
  // the 5461 dimension line (y = 712.8, x 380-695) is gone
  assert.ok(!c.paths.some((p) => { for (let i = 0; i < p.segs.length; i += 4) if (Math.abs(p.segs[i + 1] - 712.8) < 0.05 && Math.abs(p.segs[i + 3] - 712.8) < 0.05 && Math.abs(p.segs[i + 2] - p.segs[i]) > 300) return true; return false; }));
  const pink = c.paths.filter((p) => p.markup && p.fillColor === '#fb88ff');
  const yellow = c.paths.filter((p) => p.markup && p.fillColor === '#fcf485');
  assert.equal(pink.length, 4, '20K vent boxes');
  assert.equal(yellow.length, 4, 'PV areas');
  // notes keep the vents, never measurements
  assert.ok(c.notes.some((n) => /20K vent/.test(n.lines.join(' '))));
  assert.ok(!c.notes.some((n) => /^\d+$/.test(n.lines.join('').trim())), 'no bare numbers');
});

test('measurements are removed automatically on any drawing style (synthetic: thin ticks, no 0.96pt ticks)', async () => {
  const g = await geometry(path.join(SYN, 'ellerton_first_floor.pdf'));
  // the 10436 dimension line runs the full width above the house; the 3600 one below it
  const longDim = g.clean.paths.some((p) => { for (let i = 0; i < p.segs.length; i += 4) if (Math.abs(p.segs[i + 1] - p.segs[i + 3]) < 0.05 && Math.abs(p.segs[i + 2] - p.segs[i]) > 580 && p.segs[i + 1] < 160) return true; return false; });
  assert.equal(longDim, false, '10436 dimension line removed');
  // walls are kept: the 0.7pt external wall rectangle is still there
  assert.ok(g.clean.paths.some((p) => p.lw === 0.7 && p.segs.length >= 16));
});

test('REAL floor plan: no dimension lines survive the clean-up, walls do', { skip: !have && 'no real drawings' }, async () => {
  const floor = await geometry(real('ellerton_first_floor.pdf'));
  // the 5461 overall dimension line at the top (y = 35.28) is gone
  const has5461 = floor.clean.paths.some((p) => { for (let i = 0; i < p.segs.length; i += 4) if (Math.abs(p.segs[i + 1] - 35.28) < 0.05 && Math.abs(p.segs[i + 3] - 35.28) < 0.05 && Math.abs(p.segs[i + 2] - p.segs[i]) > 300) return true; return false; });
  assert.equal(has5461, false);
  assert.ok(floor.wallSegs.length / 4 > 1000, 'walls kept');
});

// ---------- different scales on the two drawings ----------
import { measureDimensionScale, snapScale, statedScaleInfo } from '../js/pdf-extract.js';
import { scaleRatio } from '../js/geom.js';

test('scales snap to the nearest standard scale', () => {
  assert.equal(snapScale(49.2), 50);
  assert.equal(snapScale(101.5), 100);
  assert.equal(snapScale(70), null); // not close to any standard scale
});

test('stated scale is corrected for the page it sits on (1:50 @A1 saved on an A3 page is 1:100)', () => {
  const a3 = 420, a1 = 841;
  assert.deepEqual(statedScaleInfo(['Scale 1:50 @ A3'], a3), { n: 50, effective: 50, adjusted: false });
  const r = statedScaleInfo(['1 : 50', '@A1'], a3);
  assert.equal(r.effective, 100);
  assert.equal(r.adjusted, true);
  assert.equal(statedScaleInfo(['1:50', '@A1'], a1).effective, 50);
  assert.equal(statedScaleInfo(['no scale'], a3).effective, null);
});

test('a roof drawn at 1:100 is detected and brought to the floor plan scale 1:50', async () => {
  const floor = await geometry(path.join(SYN, 'ellerton_first_floor.pdf'));
  assert.equal(floor.drawingScale.n, 50);
  for (const [file, source] of [['ellerton_roof_1to100.pdf', 'stated'], ['ellerton_roof_1to100_unstated.pdf', 'dimensions'], ['ellerton_roof_1to100_wrongpaper.pdf', 'stated-page']]) {
    const roof = await geometry(path.join(SYN, file));
    assert.equal(roof.drawingScale.n, 100, file);
    assert.equal(roof.drawingScale.source, source, file);
    const k = scaleRatio(roof.drawingScale.n, floor.drawingScale.n);
    assert.equal(k, 2, file);
    // the roof outline is 10436 + 2 x 300 mm wide: once resized it must measure that on the floor scale
    let x0 = Infinity, x1 = -Infinity;
    for (const p of roof.clean.paths) if (p.lw === 0.7) for (let i = 0; i < p.segs.length; i += 2) { x0 = Math.min(x0, p.segs[i]); x1 = Math.max(x1, p.segs[i]); }
    const mm = (x1 - x0) * k * 50 * 25.4 / 72;
    assert.ok(Math.abs(mm - 11036) < 1, `${file}: roof outline ${mm.toFixed(1)} mm`);
  }
});

test('dimension measurement: the measured scale agrees with the stated scale on the real drawings', { skip: !have && 'no real drawings' }, async () => {
  const roof = await geometry(real('ellerton_roof.pdf'));
  const floor = await geometry(real('ellerton_first_floor.pdf'));
  for (const g of [roof, floor]) {
    assert.equal(g.drawingScale.n, 50);
    assert.equal(g.drawingScale.source, 'dimensions');
    assert.equal(g.drawingScale.disagree, false);
  }
  assert.ok(floor.drawingScale.count >= 20, 'many dimensions measured on the floor plan');
});

// ---------- which linework is "the plan" (never cut a spread-out building) ----------
import { houseArea, inArea } from '../js/geom.js';
// line work as the app sees it: dimensions and sheet border already removed
const planSegs = (g) => { const o = []; for (const p of g.clean.paths) if (!p.markup) for (const v of p.segs) o.push(v); return Float64Array.from(o); };

test('spread-out plan: every wing is kept (even a small one with a room name), the key block is not', async () => {
  const f = await geometry(path.join(SYN, 'bungalow_floor.pdf'));
  const segs = planSegs(f);
  const area = houseArea(segs, f.width, f.height, f.rooms);
  const MMPT = 72 / 25.4 / 50;
  const pt = (xmm, ymm) => [120 + xmm * MMPT, 841.89 - (640 - ymm * MMPT)];
  for (const [name, x, y] of [['wing A', 3500, 2500], ['wing B', 10700, 4000], ['small store wing', 2900, 7350]]) {
    const [px, py] = pt(x, y);
    assert.ok(inArea(area, px, py), `${name} inside the plan area`);
  }
  assert.ok(!inArea(area, 1050, 440), 'key block outside the plan area');
  // the tight first view covers all three wings and not the key
  const fit = houseArea(segs, f.width, f.height, f.rooms, { cell: 10, gap: 2, pad: 0 }).union;
  const [bx, by] = pt(13200, 8100);
  assert.ok(fit.x1 >= bx - 1 && fit.y1 >= by - 1, `fit covers the far corner (${JSON.stringify(fit)})`);
  assert.ok(fit.x1 < 940, 'fit leaves out the key');
});

test('spread-out roof plan: all roof wings are kept', async () => {
  const r = await geometry(path.join(SYN, 'bungalow_roof.pdf'));
  const area = houseArea(planSegs(r), r.width, r.height, []);
  const MMPT = 72 / 25.4 / 50;
  for (const [x, y] of [[3500, 2500], [10700, 4000], [2900, 7350]]) assert.ok(inArea(area, 160 + x * MMPT, 841.89 - (600 - y * MMPT)));
});

test('REAL: the plan area covers the whole house and drops the key block', { skip: !have && 'no real drawings' }, async () => {
  const floor = await geometry(real('ellerton_first_floor.pdf'));
  const roof = await geometry(real('ellerton_roof.pdf'));
  const fa = houseArea(planSegs(floor), floor.width, floor.height, floor.rooms);
  for (const [x, y] of [[430, 110], [740, 110], [430, 698], [740, 698], [585, 400]]) assert.ok(inArea(fa, x, y), `floor ${x},${y}`);
  assert.ok(!inArea(fa, 150, 400), 'electrical key block on the left is outside');
  const ra = houseArea(planSegs(roof), roof.width, roof.height, []);
  for (const [x, y] of [[300, 70], [690, 70], [300, 712], [690, 712], [550, 400]]) assert.ok(inArea(ra, x, y), `roof ${x},${y}`);
  const fit = houseArea(planSegs(floor), floor.width, floor.height, floor.rooms, { cell: 10, gap: 2, pad: 0 }).union;
  assert.ok(fit.x0 <= 425 && fit.x1 >= 743 && fit.y0 <= 106 && fit.y1 >= 700 && fit.x1 - fit.x0 < 0.5 * floor.width, JSON.stringify(fit));
});
