// Canvas drawing for the overlay scene (world mm) and single drawings (drawing units).

export const PALETTES = {
  light: { paper: '#ffffff', floor: '#0047c2', roof: '#d40000', ink: '#111111', faint: 'rgba(0,0,0,0.15)', hi: '#ff8c00', halo: 'rgba(255,255,255,0.85)', warnBg: '#ffd84d', warnInk: '#000' },
  dark: { paper: '#0b0f14', floor: '#5aa9ff', roof: '#ff5c5c', ink: '#e8eef5', faint: 'rgba(255,255,255,0.16)', hi: '#ffa733', halo: 'rgba(11,15,20,0.85)', warnBg: '#ffd84d', warnInk: '#000' },
};

const lwPx = (lw, cat) => {
  const base = Math.min(3, Math.max(0.7, (lw || 0.25) * 2.2));
  return cat === 'walls' || cat === 'outline' ? Math.max(base, 1.6) : base;
};

function strokeSegs(ctx, segs, view) {
  const { s, tx, ty } = view;
  ctx.beginPath();
  for (let i = 0; i < segs.length; i += 4) {
    ctx.moveTo(segs[i] * s + tx, segs[i + 1] * s + ty);
    ctx.lineTo(segs[i + 2] * s + tx, segs[i + 3] * s + ty);
  }
  ctx.stroke();
}

function drawText(ctx, view, t, colour, pal) {
  const px = Math.max(10, Math.min(30, t.sizeMm * view.s));
  const x = t.x * view.s + view.tx;
  const y = t.y * view.s + view.ty;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t.angle || 0); // never a negative scale: glyphs are never mirrored
  ctx.font = `${t.cls === 'room' ? 'bold ' : ''}${px}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = t.warn ? '⚠ ' + t.str : t.str;
  if (t.warn) {
    const w = ctx.measureText(label).width;
    ctx.fillStyle = pal.warnBg;
    ctx.fillRect(-w / 2 - 3, -px * 0.65, w + 6, px * 1.3);
    ctx.fillStyle = pal.warnInk;
  } else {
    ctx.lineWidth = 3;
    ctx.strokeStyle = pal.halo;
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = colour;
  }
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

function drawRaster(ctx, view, layer, bmp, dpr) {
  const { T, crop } = layer.raster;
  const k = T.k;
  const upp = bmp.unitsPerPx;
  const m = layer.mirror ? -1 : 1;
  const a = T.affine;
  const wx0 = k * crop.x0 + a.e;
  const wy0 = k * crop.y0 + a.f;
  ctx.save();
  ctx.setTransform(dpr * view.s * m * k * upp, 0, 0, dpr * view.s * k * upp, dpr * (view.s * m * wx0 + view.tx), dpr * (view.s * wy0 + view.ty));
  ctx.imageSmoothingEnabled = view.s * k * upp < 1;
  ctx.drawImage(bmp.canvas, 0, 0);
  ctx.restore();
}

function drawLayer(ctx, view, layer, colour, pal, o) {
  if (layer.raster && o.bitmaps?.[layer.role]) {
    ctx.globalCompositeOperation = 'multiply';
    drawRaster(ctx, view, layer, o.bitmaps[layer.role], o.dpr);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.strokeStyle = colour;
  ctx.lineCap = 'round';
  for (const g of layer.groups) {
    ctx.lineWidth = lwPx(g.lw, g.category);
    ctx.setLineDash(g.category === 'dashed' ? [6, 4] : []);
    strokeSegs(ctx, g.segs, view);
  }
  ctx.setLineDash([]);
  for (const t of layer.texts) drawText(ctx, view, t, colour, pal);
}

/** Overlay scene: floor (blue) under roof (red, adjustable opacity). */
export function drawScene(ctx, view, scene, o) {
  const pal = o.pal;
  ctx.fillStyle = pal.paper;
  ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
  if (!scene) return;
  if (o.showFloor !== false) { ctx.globalAlpha = 1; drawLayer(ctx, view, scene.floor, pal.floor, pal, o); }
  if (o.showRoof !== false) { ctx.globalAlpha = o.opacity ?? 0.85; drawLayer(ctx, view, scene.roof, pal.roof, pal, o); }
  ctx.globalAlpha = 1;
  // reference origin marker (floor reference = world 0,0)
  if (!o.loupe) {
    const p = { x: view.tx, y: view.ty };
    ctx.strokeStyle = pal.hi;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
  }
  drawMarks(ctx, view, o.marks, pal);
}

/** Single drawing in its own units (calibration + layer picker). */
export function drawDrawing(ctx, view, model, o) {
  const pal = o.pal;
  ctx.fillStyle = pal.paper;
  ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
  if (o.underlay) {
    const u = o.underlay;
    ctx.save();
    const sc = view.s * u.unitsPerPx * o.dpr;
    ctx.setTransform(sc, 0, 0, sc, o.dpr * (u.crop.x0 * view.s + view.tx), o.dpr * (u.crop.y0 * view.s + view.ty));
    ctx.globalAlpha = model.method === 'B' ? 1 : (o.underlayAlpha ?? 0.35);
    ctx.drawImage(u.canvas, 0, 0);
    ctx.restore();
  }
  for (const g of model.groups || []) {
    const vis = o.isVisible(g);
    const hi = o.highlightKey === g.key;
    if (!vis && !o.showHidden && !hi) continue;
    ctx.strokeStyle = hi ? pal.hi : vis ? pal.ink : pal.faint;
    ctx.lineWidth = hi ? 3 : lwPx(g.lw, o.catOf(g));
    ctx.setLineDash(g.dash && !hi ? [5, 3] : []);
    strokeSegs(ctx, g.segs, view);
  }
  ctx.setLineDash([]);
  if (o.showText) {
    for (const L of model.lines || []) {
      ctx.globalAlpha = L.cls === 'room' ? 1 : 0.55;
      drawText(ctx, view, { str: L.str, x: L.cx, y: L.cy, angle: L.angle, sizeMm: L.size, cls: L.cls }, L.cls === 'room' ? pal.floor : pal.ink, pal);
      ctx.globalAlpha = 1;
    }
  }
  if (o.crop) {
    const c = o.crop;
    ctx.strokeStyle = pal.hi;
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeRect(c.x0 * view.s + view.tx, c.y0 * view.s + view.ty, (c.x1 - c.x0) * view.s, (c.y1 - c.y0) * view.s);
    ctx.setLineDash([]);
  }
  drawMarks(ctx, view, o.marks, pal);
}

/** marks: [{x,y,label,colour}] plus optional lines [{a,b,label}] */
export function drawMarks(ctx, view, marks, pal) {
  if (!marks) return;
  for (const L of marks.lines || []) {
    const a = { x: L.a.x * view.s + view.tx, y: L.a.y * view.s + view.ty };
    const b = { x: L.b.x * view.s + view.tx, y: L.b.y * view.s + view.ty };
    ctx.strokeStyle = L.colour || pal.hi;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    if (L.label) {
      ctx.font = 'bold 15px system-ui, sans-serif';
      const w = ctx.measureText(L.label).width;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.fillStyle = pal.hi;
      ctx.fillRect(m.x - w / 2 - 5, m.y - 22, w + 10, 20);
      ctx.fillStyle = '#000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(L.label, m.x, m.y - 12);
    }
  }
  for (const m of marks.points || []) {
    const p = { x: m.x * view.s + view.tx, y: m.y * view.s + view.ty };
    ctx.strokeStyle = m.colour || pal.hi;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - 10, p.y); ctx.lineTo(p.x + 10, p.y);
    ctx.moveTo(p.x, p.y - 10); ctx.lineTo(p.x, p.y + 10);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.stroke();
    if (m.label) {
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = m.colour || pal.hi;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(m.label, p.x + 8, p.y - 6);
    }
  }
}

/** Scale bar in screen space for a world in mm. */
export function drawScaleBar(ctx, view, w, h, pal) {
  const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const mm = nice.find((n) => n * view.s >= 80) || nice[nice.length - 1];
  const len = mm * view.s;
  const x = 12;
  const y = h - 14;
  ctx.fillStyle = pal.halo;
  ctx.fillRect(x - 6, y - 22, len + 12, 30);
  ctx.strokeStyle = pal.ink;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 6); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 6);
  ctx.stroke();
  ctx.fillStyle = pal.ink;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(mm >= 1000 ? `${mm / 1000} m` : `${mm} mm`, x + len / 2, y - 6);
}
