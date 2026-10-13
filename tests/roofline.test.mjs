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
