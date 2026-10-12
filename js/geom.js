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
