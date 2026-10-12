// Group extracted paths into "line groups" by style, then auto-classify each group.
// Auto-classification is a starting point only: the layer picker lets the user override
// every group and the choice is saved per house type.

export const CATEGORIES = {
  floor: [
    ['walls', 'Walls', true],
    ['openings', 'Openings (near walls)', true],
    ['dimensions', 'Dimensions', false],
    ['symbols', 'Symbols / electrical', false],
    ['hatch', 'Hatching', false],
    ['thin', 'Other thin lines', false],
    ['other', 'Other', false],
  ],
  roof: [
    ['outline', 'Roof outline', true],
    ['ridge', 'Ridge / hips / valleys', true],
    ['dashed', 'Dashed (wall plates, hidden)', true],
    ['markers', 'Vents / markers (coloured)', true],
    ['dimensions', 'Dimensions', false],
    ['hatch', 'Hatching', false],
    ['thin', 'Other thin lines', false],
    ['other', 'Other', false],
  ],
};

export const defaultVisible = (role, cat) => !!CATEGORIES[role].find((c) => c[0] === cat)?.[2];

const isGrey = (hex) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) < 40;
};
const isWhite = (hex) => hex === '#ffffff';
const segLen = (s, i) => Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]);

function styleKey(p) {
  if (p.stroke) return `S|${p.lw.toFixed(2)}|${p.color}|${p.dash || 'solid'}`;
  return `F|${p.fillColor}`;
}

/** Is a group mostly short parallel strokes (hatching)? */
function looksLikeHatch(segs) {
  const n = segs.length / 4;
  if (n < 10) return false;
  const bins = new Map();
  let total = 0;
  for (let i = 0; i < segs.length; i += 4) {
    const L = segLen(segs, i);
    if (L === 0) continue;
    let a = Math.round((Math.atan2(segs[i + 3] - segs[i + 1], segs[i + 2] - segs[i]) * 180) / Math.PI);
    a = ((a % 180) + 180) % 180;
    bins.set(a, (bins.get(a) || 0) + 1);
    total++;
  }
  const top = Math.max(...bins.values());
  // most segments share one oblique angle (not 0/90, which walls use)
  const topAngle = [...bins.entries()].find(([, v]) => v === top)[0];
  return top / total > 0.7 && topAngle % 90 !== 0;
}

/**
 * Build groups from extracted paths.
 * Returns [{ id, key, kind:'stroke'|'fill', lw, color, dash, segs:Float32Array, count, length, category }]
 */
export function buildGroups(paths, role) {
  const map = new Map();
  for (const p of paths) {
    if (!p.stroke && p.fill && isWhite(p.fillColor)) continue; // white masking fills
    if (p.stroke && isWhite(p.color) && !p.fill) continue;
    const key = styleKey(p);
    let g = map.get(key);
    if (!g) {
      g = { key, kind: p.stroke ? 'stroke' : 'fill', lw: p.lw, color: p.stroke ? p.color : p.fillColor, dash: p.dash || '', segs: [] };
      map.set(key, g);
    }
    for (const v of p.segs) g.segs.push(v);
  }
  const groups = [...map.values()].map((g, i) => {
    let length = 0;
    for (let j = 0; j < g.segs.length; j += 4) length += segLen(g.segs, j);
    return { ...g, id: 'g' + i, count: g.segs.length / 4, length, hatch: looksLikeHatch(g.segs) };
  });
  autoClassify(groups, role);
  if (role === 'floor') splitOpenings(groups);
  for (const g of groups) g.segs = Float32Array.from(g.segs);
  return groups;
}

export function autoClassify(groups, role) {
  const strokes = groups.filter((g) => g.kind === 'stroke');
  const total = strokes.reduce((n, g) => n + g.length, 0) || 1;
  // thickest style that carries a meaningful share of the drawing
  const significant = strokes.filter((g) => g.length / total > 0.02 && isGrey(g.color) && !g.dash && !g.hatch);
  const maxW = Math.max(0.01, ...significant.map((g) => g.lw));
  for (const g of groups) {
    const grey = isGrey(g.color);
    if (g.kind === 'fill') { g.category = role === 'floor' && grey ? 'walls' : 'other'; continue; }
    if (g.hatch) { g.category = 'hatch'; continue; }
    if (role === 'floor') {
      if (!grey) g.category = 'symbols';
      else if (g.dash) g.category = 'other';
      else if (g.lw >= 0.6 * maxW && g.lw > 0) g.category = 'walls';
      else g.category = 'thin';
    } else {
      if (!grey) g.category = 'markers';
      else if (g.dash) g.category = 'dashed';
      else if (g.lw >= 0.9 * maxW && g.lw > 0) g.category = 'outline';
      else if (g.lw >= 0.6 * maxW && g.lw > 0) g.category = 'ridge';
      else g.category = 'thin';
    }
  }
}

/**
 * Floor plans: thin segments with both ends inside the wall band are probably window/door
 * openings. Split them into their own group so they can be shown while the rest of the
 * thin lines (dimensions, furniture) stay hidden.
 */
function splitOpenings(groups) {
  const walls = groups.filter((g) => g.category === 'walls' && g.kind === 'stroke');
  if (!walls.length) return;
  const wsegs = walls.flatMap((g) => g.segs);
  const band = estimateWallBand(wsegs);
  if (!band) return;
  const near = (x, y) => {
    for (let i = 0; i < wsegs.length; i += 4) {
      if (distPtSeg(x, y, wsegs[i], wsegs[i + 1], wsegs[i + 2], wsegs[i + 3]) <= band) return true;
    }
    return false;
  };
  const extra = [];
  for (const g of groups) {
    if (g.category !== 'thin') continue;
    const inBand = [];
    const rest = [];
    for (let i = 0; i < g.segs.length; i += 4) {
      const s = g.segs.slice(i, i + 4);
      const L = segLen(s, 0);
      // opening lines are short relative to the plan and both ends sit in the wall band
      if (L < band * 12 && near(s[0], s[1]) && near(s[2], s[3])) inBand.push(...s);
      else rest.push(...s);
    }
    if (inBand.length && rest.length) {
      g.segs = rest;
      g.count = rest.length / 4;
      g.length = sumLen(rest);
      extra.push({ ...g, id: g.id + 'o', key: g.key + '|nearwall', segs: inBand, count: inBand.length / 4, length: sumLen(inBand), category: 'openings' });
    } else if (inBand.length) g.category = 'openings';
  }
  groups.push(...extra);
}

const sumLen = (s) => { let n = 0; for (let i = 0; i < s.length; i += 4) n += segLen(s, i); return n; };

function distPtSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Typical spacing between parallel, overlapping wall lines (= wall thickness on paper). */
export function estimateWallBand(s) {
  const ds = [];
  const n = s.length / 4;
  for (let i = 0; i < n && i < 400; i++) {
    const a = i * 4;
    const ax = s[a + 2] - s[a];
    const ay = s[a + 3] - s[a + 1];
    const la = Math.hypot(ax, ay);
    if (la === 0) continue;
    let best = Infinity;
    for (let j = 0; j < n && j < 400; j++) {
      if (i === j) continue;
      const b = j * 4;
      const bx = s[b + 2] - s[b];
      const by = s[b + 3] - s[b + 1];
      const lb = Math.hypot(bx, by);
      if (lb === 0) continue;
      if (Math.abs(ax * by - ay * bx) / (la * lb) > 0.01) continue; // not parallel
      const d = Math.abs((s[b] - s[a]) * ay - (s[b + 1] - s[a + 1]) * ax) / la;
      if (d < 0.5 || d >= best) continue;
      best = d;
    }
    if (best < Infinity) ds.push(best);
  }
  if (!ds.length) return null;
  ds.sort((a, b) => a - b);
  return ds[Math.floor(ds.length / 2)] * 1.1;
}

/** Snap candidates: endpoints of all visible segments, flat [x,y,x,y...] */
export function snapPoints(groups, visible) {
  const out = [];
  for (const g of groups) {
    if (visible && !visible(g)) continue;
    for (let i = 0; i < g.segs.length; i += 4) out.push(g.segs[i], g.segs[i + 1], g.segs[i + 2], g.segs[i + 3]);
  }
  return out;
}

export function describeGroup(g) {
  const style = g.kind === 'fill' ? 'filled' : `${g.lw.toFixed(2)}pt ${g.dash ? 'dashed' : 'solid'}`;
  return `${style} ${g.color} · ${g.count} lines`;
}
