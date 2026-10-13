// Geometry helpers: snapping taps to line ends/crossings, and 2x3 affine matrices.

/**
 * Precision snap: line ends AND line crossings near p (within r drawing units).
 * segs = flat [x1,y1,x2,y2,...]. Crossings matter on CAD drawings, where dimension lines
 * overshoot the extension lines: the measured point is the crossing, not the line end.
 * Returns { x, y, d, type: 'end' | 'cross' } or null.
 */
export function snapNear(segs, p, r) {
  const near = [];
  let best = null;
  const consider = (x, y, type) => {
    const d = Math.hypot(x - p.x, y - p.y);
    // a crossing that coincides with a line end counts as a crossing
    if (d <= r && (!best || d < best.d - 1e-6 || (type === 'cross' && d <= best.d + 1e-6))) best = { x, y, d, type };
  };
  for (let i = 0; i < segs.length; i += 4) {
    const x1 = segs[i], y1 = segs[i + 1], x2 = segs[i + 2], y2 = segs[i + 3];
    if (pointSegDist(p.x, p.y, x1, y1, x2, y2) > r) continue;
    consider(x1, y1, 'end');
    consider(x2, y2, 'end');
    if (near.length < 400) near.push(i);
  }
  for (let a = 0; a < near.length; a++) {
    for (let b = a + 1; b < near.length; b++) {
      const i = near[a], j = near[b];
      const hit = segIntersect(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], segs[j], segs[j + 1], segs[j + 2], segs[j + 3]);
      if (hit) consider(hit[0], hit[1], 'cross');
    }
  }
  return best;
}

/** Intersection of two segments (not parallel), or null. */
export function segIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  const l1 = Math.hypot(x2 - x1, y2 - y1);
  const l2 = Math.hypot(x4 - x3, y4 - y3);
  if (!l1 || !l2 || Math.abs(den) < 1e-9 * l1 * l2 * 1e3) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  const eps = 1e-6;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/** Distance from point to segment, used for tap-to-identify line group. */
export function pointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Roof page point -> floor page point. align = { roofRef, floorRef } (the same building
 * corner tapped on each drawing), k = roof/floor scale ratio (1 when both are e.g. 1:50),
 * nudge = extra slide in floor points. Without align, the two sheets sit page-on-page.
 */
export function roofToFloorPoint(x, y, align, k = 1, nudge = { x: 0, y: 0 }) {
  if (!align?.roofRef || !align?.floorRef) return { x: x * k + nudge.x, y: y * k + nudge.y };
  return {
    x: (x - align.roofRef.x) * k + align.floorRef.x + nudge.x,
    y: (y - align.roofRef.y) * k + align.floorRef.y + nudge.y,
  };
}

/** 2x3 affine helpers [a,b,c,d,e,f] as in PDF / canvas */
export const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const invert = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

/**
 * The drawing around a point: flood-fill over a grid of cells that contain linework,
 * starting at the cell holding `seed`. Separate blocks on the sheet (keys, schedules,
 * title block) are left out when there is a clear gap. Returns a box or null.
 */
export function regionAround(segs, width, height, seed, cell = 10) {
  const nx = Math.ceil(width / cell);
  const ny = Math.ceil(height / cell);
  const ink = new Float32Array(nx * ny);
  for (let i = 0; i < segs.length; i += 4) {
    const x = (segs[i] + segs[i + 2]) / 2;
    const y = (segs[i + 1] + segs[i + 3]) / 2;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue;
    ink[cy * nx + cx] += Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]);
  }
  const sx = Math.floor(seed.x / cell);
  const sy = Math.floor(seed.y / cell);
  if (sx < 0 || sy < 0 || sx >= nx || sy >= ny) return null;
  const seen = new Uint8Array(nx * ny);
  const stack = [sy * nx + sx];
  seen[stack[0]] = 1;
  let x0 = sx, x1 = sx, y0 = sy, y1 = sy;
  while (stack.length) {
    const c = stack.pop();
    const cx = c % nx;
    const cy = (c - cx) / nx;
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ax = cx + dx;
        const ay = cy + dy;
        if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
        const a = ay * nx + ax;
        if (seen[a] || ink[a] < cell * 0.5) continue;
        seen[a] = 1;
        stack.push(a);
      }
    }
  }
  return { x0: x0 * cell, y0: y0 * cell, x1: (x1 + 1) * cell, y1: (y1 + 1) * cell };
}
