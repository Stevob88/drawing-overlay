// Build a renderable scene (world millimetres) from extracted drawings + calibration.
// Pure: no DOM. The same function feeds the screen, the export and the tests.
import { makeTransform, mirrorX, angleDiffDeg, lineAngleDeg } from './geom.js';
import { defaultVisible } from './classify.js';
import { plotNoteVisibility, unknownPlots } from './text.js';

/** Text classes shown by default for each drawing role. */
export const TEXT_DEFAULTS = {
  floor: { room: true, dim: false, roofnote: false, note: false, scale: false, plotnote: true },
  roof: { room: false, dim: false, roofnote: true, note: false, scale: false, plotnote: true },
};

export function groupVisible(g, role, settings) {
  const cat = settings?.groupCat?.[g.key] ?? g.category;
  if (settings?.groupVis && g.key in settings.groupVis) return settings.groupVis[g.key];
  if (settings?.catVis && cat in settings.catVis) return settings.catVis[cat];
  return defaultVisible(role, cat);
}

const inCrop = (crop, x, y) => !crop || (x >= crop.x0 && x <= crop.x1 && y >= crop.y0 && y <= crop.y1);

/**
 * layerInput = { role:'floor'|'roof', extract:{groups, lines, plotNotes, raster?}, cal:{p1,p2,realMm,ref,offset}, settings }
 * opts = { handing:'As'|'Opp', plot:number }
 */
export function buildLayer(input, opts) {
  const { role, extract, cal, settings } = input;
  const T = makeTransform(cal);
  const mirror = opts.handing === 'Opp';
  const mx = mirror ? mirrorX : (x) => x;
  const crop = settings?.crop || extract.autoCrop || null;
  const warnings = [];
  const groups = [];
  for (const g of extract.groups || []) {
    if (!groupVisible(g, role, settings)) continue;
    const out = [];
    const s = g.segs;
    for (let i = 0; i < s.length; i += 4) {
      if (!inCrop(crop, (s[i] + s[i + 2]) / 2, (s[i + 1] + s[i + 3]) / 2)) continue;
      const a = T.toWorld(s[i], s[i + 1]);
      const b = T.toWorld(s[i + 2], s[i + 3]);
      out.push(mx(a.x), a.y, mx(b.x), b.y);
    }
    if (out.length) groups.push({ key: g.key, lw: g.lw, kind: g.kind, category: settings?.groupCat?.[g.key] ?? g.category, segs: Float64Array.from(out) });
  }
  const textVis = { ...TEXT_DEFAULTS[role], ...(settings?.textVis || {}) };
  if (mirror) textVis.dim = false; // dimension text cannot be repositioned reliably when mirrored
  const plotNoteLines = new Set((extract.plotNotes || []).flatMap((n) => n.lineIdx));
  const texts = [];
  (extract.lines || []).forEach((L, i) => {
    if (plotNoteLines.has(i)) return; // handled below with plot filtering
    if (!textVis[L.cls]) return;
    if (!inCrop(crop, L.cx, L.cy)) return;
    const c = T.toWorld(L.cx, L.cy);
    // Text is never mirrored: anchor moves to the mirrored position, glyphs stay readable.
    texts.push({ str: L.str, lines: L.display, x: mx(c.x), y: c.y, angle: normaliseUpright(L.angle), sizeMm: L.size * T.k, cls: L.cls, mirroredGlyphs: false });
  });
  const notes = [];
  if (textVis.plotnote) {
    for (const n of extract.plotNotes || []) {
      // no plot selected (calibration preview, As/Opp test): show notes unfiltered
      const vis = opts.plot > 0 ? plotNoteVisibility(n, opts.plot, opts.knownPlots) : 'all';
      const unknown = unknownPlots(n, opts.knownPlots);
      const reason = [n.reason, unknown.length ? `${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not a plot number in the schedule (typo on the drawing?)` : ''].filter(Boolean).join('; ');
      notes.push({ str: n.str, plots: n.plots, vis, reason, role, source: n.source || 'text' });
      if (!inCrop(crop, n.cx, n.cy)) continue;
      const c = T.toWorld(n.cx, n.cy);
      const first = extract.lines[n.lineIdx[0]];
      const sizeMm = (first?.size || 8) * T.k;
      if (vis === 'hide') {
        // keep a small tag so a vent/PV box on the drawing is never left unexplained
        texts.push({ str: `✗ not for plot ${opts.plot}`, x: mx(c.x), y: c.y, angle: 0, sizeMm: sizeMm * 0.8, cls: 'plotnote', faint: true, mirroredGlyphs: false });
        continue;
      }
      // On the drawing show only the note's label (e.g. "20K vent"); the full list is in the notes panel.
      const label = noteLabel(n.str);
      const tag = vis === 'warn' ? `${label}: check list` : label;
      texts.push({ str: tag, x: mx(c.x), y: c.y, angle: 0, sizeMm: Math.min(sizeMm, 9 * T.k), cls: 'plotnote', warn: vis === 'warn', ok: vis === 'show', faint: vis === 'all', mirroredGlyphs: false });
    }
  }
  if (extract.method === 'B') {
    warnings.push(`${role === 'roof' ? 'Roof' : 'Floor'} plan is a flattened image: no layer separation, no text extraction.`);
    if (mirror) warnings.push('Raster drawing mirrored: any text inside the image is mirrored too and is unreadable. Use the As view to read labels.');
  }
  if (!(extract.lines || []).length && extract.method !== 'B') warnings.push(`${role} plan: no extractable text, so room names and plot notes are unavailable.`);
  return { role, k: T.k, groups, texts, notes, mirror, warnings, raster: extract.raster ? { ...extract.raster, T, crop: extract.raster.crop || crop } : null };
}

/** Short label for a plot-list note: the words before the list ("20K vent", "Rad position"). */
export function noteLabel(str) {
  const words = str.replace(/\bto\s+plots?\b.*$/i, '').replace(/\bplots?\b.*$/i, '').replace(/[\d\/,&\-–:\s]+$/, '').trim();
  const head = (words || str.split(/\d/)[0].trim() || 'Plot note');
  return head.length > 24 ? head.slice(0, 23) + '…' : head;
}

/** Keep text readable: angles in (-90°, 90°]. */
export function normaliseUpright(a) {
  let d = a;
  while (d <= -Math.PI / 2 + 1e-9) d += Math.PI;
  while (d > Math.PI / 2 + 1e-9) d -= Math.PI;
  return d;
}

/** Compare the scale/rotation of the two calibrations. */
export function calibrationChecks(roofCal, floorCal, opts = {}) {
  const out = { warnings: [] };
  const aR = lineAngleDeg(roofCal.p1, roofCal.p2);
  const aF = lineAngleDeg(floorCal.p1, floorCal.p2);
  out.angleDiffDeg = angleDiffDeg(aR, aF);
  if (out.angleDiffDeg > 0.1) out.warnings.push(`Rotation between the two reference lines is ${out.angleDiffDeg.toFixed(3)}° (limit 0.1°). Re-tap the calibration points, or the drawings are not drawn square to each other.`);
  const kR = makeTransform(roofCal).k;
  const kF = makeTransform(floorCal).k;
  out.kRoof = kR;
  out.kFloor = kF;
  out.scaleRatio = kR / kF;
  if (opts.sameScaleExpected && Math.abs(out.scaleRatio - 1) > 0.005) {
    out.warnings.push(`Roof and floor scales differ by ${((out.scaleRatio - 1) * 100).toFixed(2)}%. Fine if the drawings use different scales, otherwise re-check the calibration.`);
  }
  return out;
}

export function buildScene(floorInput, roofInput, opts) {
  const floor = buildLayer({ ...floorInput, role: 'floor', cal: { ...floorInput.cal, offset: { dx: 0, dy: 0 } } }, opts);
  const roof = buildLayer({ ...roofInput, role: 'roof' }, opts);
  const checks = calibrationChecks(roofInput.cal, floorInput.cal, { sameScaleExpected: opts.sameScaleExpected });
  return {
    floor, roof, mirrored: opts.handing === 'Opp', plot: opts.plot,
    warnings: [...checks.warnings, ...floor.warnings, ...roof.warnings], checks,
  };
}

/** World bounding box of a scene (for fit-to-screen). */
export function sceneBounds(scene) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const L of [scene.floor, scene.roof]) {
    for (const g of L.groups) {
      for (let i = 0; i < g.segs.length; i += 2) {
        const x = g.segs[i];
        const y = g.segs[i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (L.raster?.crop) {
      const c = L.raster.crop;
      for (const [x, y] of [[c.x0, c.y0], [c.x1, c.y1]]) {
        const w = L.raster.T.toWorld(x, y);
        const wx = L.mirror ? -w.x : w.x;
        x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); y0 = Math.min(y0, w.y); y1 = Math.max(y1, w.y);
      }
    }
  }
  if (!isFinite(x0)) return { x0: -5000, y0: -5000, x1: 5000, y1: 5000 };
  return { x0, y0, x1, y1 };
}
