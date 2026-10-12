// Pure geometry for calibration, alignment, mirroring and error estimates.
// "Drawing units" (u) = PDF points in page viewport space (y down, scale 1).
// "World" = real millimetres, origin at the FLOOR plan reference point, y down.

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Angle of the line a->b in degrees, normalised to (-90, 90] so direction of tapping does not matter. */
export function lineAngleDeg(a, b) {
  let d = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  while (d <= -90) d += 180;
  while (d > 90) d -= 180;
  return d;
}

/** Smallest difference between two undirected line angles, in degrees (0..90). */
export function angleDiffDeg(a, b) {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/**
 * Scale calibration from two tapped points and the real length.
 * Returns mm per drawing unit. Throws on degenerate input (never guesses).
 */
export function scaleFromPoints(p1, p2, realMm) {
  const du = dist(p1, p2);
  if (!(realMm > 0)) throw new Error('Real length must be a positive number of mm');
  if (!(du > 0)) throw new Error('The two calibration points are identical');
  return realMm / du;
}

/**
 * Build the transform for one drawing: drawing units -> world mm.
 * cal = { p1, p2, realMm, ref, offset? } ; offset = {dx, dy} in mm, position of this
 * drawing's reference point relative to the floor reference (0,0 for the floor plan).
 */
export function makeTransform(cal) {
  const k = scaleFromPoints(cal.p1, cal.p2, cal.realMm);
  const ox = cal.offset?.dx ?? 0;
  const oy = cal.offset?.dy ?? 0;
  const rx = cal.ref.x;
  const ry = cal.ref.y;
  return {
    k,
    toWorld: (x, y) => ({ x: (x - rx) * k + ox, y: (y - ry) * k + oy }),
    toDrawing: (wx, wy) => ({ x: (wx - ox) / k + rx, y: (wy - oy) / k + ry }),
    // flat array version for speed: returns [a, c, e, b, d, f] style affine (no rotation)
    affine: { a: k, d: k, e: ox - rx * k, f: oy - ry * k },
  };
}

/**
 * Mirror about the vertical axis x = 0 in world space. The world origin is the floor
 * reference point, so the axis passes through the calibrated reference. Negation is
 * exact in IEEE floating point, so mirror(mirror(p)) === p bit-for-bit.
 */
export const mirrorX = (x) => (x === 0 ? 0 : -x);
export const mirrorPoint = (p) => ({ x: mirrorX(p.x), y: p.y });

/** Measure distance in mm between two world points. */
export const measureMm = (a, b) => dist(a, b);

/**
 * Estimated accuracy for a calibration.
 * pointErrUnits: uncertainty of one tapped point in drawing units (tap precision or snap).
 * imagePxUnits: size of one source image pixel in drawing units (raster only, else 0).
 */
export function errorEstimate({ k, lengthUnits, pointErrUnits, imagePxUnits = 0 }) {
  const eUnits = Math.hypot(pointErrUnits, imagePxUnits / 2);
  const pointMm = eUnits * k;
  const scaleRel = (Math.SQRT2 * eUnits) / lengthUnits; // relative scale error
  return {
    pointMm, // error of a single located point
    scalePct: scaleRel * 100,
    per10mMm: scaleRel * 10000 + Math.SQRT2 * pointMm, // over a 10 m measured run
    imagePxMm: imagePxUnits * k,
  };
}

/** Expected mm-per-unit for a stated drawing scale (1:N) with PDF points. */
export const mmPerUnitForScale = (n) => (n * 25.4) / 72;

/** Find nearest snap candidate (segment endpoint or midpoint) within radius (units). */
export function nearestSnap(candidates, p, radius) {
  let best = null;
  let bd = radius;
  for (let i = 0; i < candidates.length; i += 2) {
    const d = Math.hypot(candidates[i] - p.x, candidates[i + 1] - p.y);
    if (d <= bd) {
      bd = d;
      best = { x: candidates[i], y: candidates[i + 1], d };
    }
  }
  return best;
}

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
