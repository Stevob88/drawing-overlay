// Group extracted paths into "line groups" by style, then auto-classify each group.
// Auto-classification is a starting point only: the layer picker lets the user override
// every group and the choice is saved per house type.

export const CATEGORIES = {
  floor: [
    ['walls', 'Walls', true],
    ['context', 'Other drawing lines (shown faint)', true],
    ['openings', 'Openings', true],
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
    ['roofline', 'Other roof lines', true],
    ['dimensions', 'Dimensions', false],
    ['hatch', 'Hatching', false],
    ['thin', 'Other thin lines', false],
    ['other', 'Other', false],
  ],
};
// NB floor 'thin' and roof 'thin' stay in the lists for user overrides saved earlier.

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
  for (const g of groups) g.segs = Float32Array.from(g.segs);
  return groups;
}

export function autoClassify(groups, role) {
  const strokes = groups.filter((g) => g.kind === 'stroke');
  const total = strokes.reduce((n, g) => n + g.length, 0) || 1;
  const lum = (hex) => (parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)) / 3;
  for (const g of groups) {
    const grey = isGrey(g.color);
    const white = g.color === '#ffffff';
    if (white) { g.category = 'other'; continue; } // white masks / markup note boxes
    if (g.hatch) { g.category = 'hatch'; continue; }
    if (role === 'floor') {
      if (g.kind === 'fill') g.category = grey ? 'walls' : 'symbols'; // solid wall poche
      else if (!grey) g.category = 'symbols';
      else if (g.dash) g.category = 'other';
      // CAD templates commonly draw wall outlines/poche in mid grey with everything else
      // in black: a substantial mid-grey stroke group is taken as walls.
      else if (lum(g.color) > 60 && lum(g.color) < 210 && g.length / total > 0.05) g.category = 'walls';
      else g.category = 'context';
    } else {
      if (g.kind === 'fill') g.category = grey ? 'roofline' : 'markers';
      else if (!grey) g.category = 'markers';
      else if (g.dash) g.category = 'dashed';
      else g.category = 'roofline';
    }
  }
  // Thickest substantial black stroke on a floor plan is walls when no grey wall layer exists
  if (role === 'floor' && !groups.some((g) => g.category === 'walls' && g.kind === 'stroke')) {
    const cands = strokes.filter((g) => g.category === 'context' && g.length / total > 0.03);
    const maxW = Math.max(0, ...cands.map((g) => g.lw));
    for (const g of cands) if (maxW > 0 && g.lw >= 0.6 * maxW && cands.some((h) => h.lw < 0.6 * maxW)) g.category = 'walls';
  }
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
