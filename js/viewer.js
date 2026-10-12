// Canvas viewer with pinch-zoom / pan and a precision "point" mode.
// Point mode: drag one finger; a crosshair sits ABOVE the finger (so the finger never
// hides it) and a magnifier loupe shows the area. Lift to place the point.
// world -> screen (CSS px):  sx = x * s + tx,  sy = y * s + ty

const LOUPE_R = 70;
const LOUPE_ZOOM = 4;
const FINGER_OFFSET = 80;

export class Viewer {
  constructor(canvas, { draw, onPoint, onTap, snap } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.draw = draw || (() => {});
    this.onPoint = onPoint || null;
    this.onTap = onTap || null;
    this.snap = snap || null;
    this.view = { s: 1, tx: 0, ty: 0 };
    this.mode = 'pan';
    this.pointers = new Map();
    this.cross = null; // {x,y} screen
    this.snapHit = null;
    this.overlay = null; // extra draw fn in screen space
    this._raf = 0;
    this._bind();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
  }

  destroy() { this._ro.disconnect(); this.canvas.replaceWith(this.canvas.cloneNode()); }

  setMode(m) { this.mode = m; this.cross = null; this.redraw(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.redraw();
  }

  fit(b, pad = 24) {
    if (!b || !this.w) return;
    const bw = Math.max(1e-9, b.x1 - b.x0);
    const bh = Math.max(1e-9, b.y1 - b.y0);
    const s = Math.min((this.w - 2 * pad) / bw, (this.h - 2 * pad) / bh);
    this.view = { s, tx: (this.w - bw * s) / 2 - b.x0 * s, ty: (this.h - bh * s) / 2 - b.y0 * s };
    this.redraw();
  }

  toWorld(sx, sy) { return { x: (sx - this.view.tx) / this.view.s, y: (sy - this.view.ty) / this.view.s }; }
  toScreen(x, y) { return { x: x * this.view.s + this.view.tx, y: y * this.view.s + this.view.ty }; }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._paint(); });
  }

  _paint() {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw(ctx, this.view, { w: this.w, h: this.h, dpr });
    if (this.overlay) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.overlay(ctx, this); }
    if (this.mode === 'point' && this.cross) this._paintLoupe();
  }

  _paintLoupe() {
    const { ctx, dpr, cross } = this;
    const target = this.snapHit ? this.toScreen(this.snapHit.x, this.snapHit.y) : cross;
    // loupe in the top corner away from the finger
    const lx = cross.x < this.w / 2 ? this.w - LOUPE_R - 10 : LOUPE_R + 10;
    const ly = LOUPE_R + 10;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.arc(lx, ly, LOUPE_R, 0, Math.PI * 2);
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue('--paper') || '#fff';
    ctx.fill();
    ctx.clip();
    const v = { s: this.view.s * LOUPE_ZOOM, tx: 0, ty: 0 };
    const w = this.toWorld(target.x, target.y);
    v.tx = lx - w.x * v.s;
    v.ty = ly - w.y * v.s;
    this.draw(ctx, v, { w: this.w, h: this.h, dpr, loupe: true });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = '#ff8c00';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx - LOUPE_R, ly); ctx.lineTo(lx + LOUPE_R, ly);
    ctx.moveTo(lx, ly - LOUPE_R); ctx.lineTo(lx, ly + LOUPE_R);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(lx, ly, LOUPE_R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#ff8c00';
    ctx.lineWidth = 2;
    ctx.stroke();
    // crosshair on the drawing
    ctx.strokeStyle = '#ff8c00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(target.x - 18, target.y); ctx.lineTo(target.x + 18, target.y);
    ctx.moveTo(target.x, target.y - 18); ctx.lineTo(target.x, target.y + 18);
    ctx.stroke();
    if (this.snapHit) {
      ctx.strokeStyle = '#00b050';
      ctx.lineWidth = 2;
      ctx.strokeRect(target.x - 7, target.y - 7, 14, 14);
      ctx.fillStyle = '#00b050';
      ctx.font = 'bold 12px system-ui';
      ctx.fillText('SNAP', lx - 16, ly + LOUPE_R - 10);
    }
    ctx.restore();
  }

  _updateCross(e) {
    const r = this.canvas.getBoundingClientRect();
    const off = e.pointerType === 'mouse' ? 0 : FINGER_OFFSET;
    this.cross = { x: e.clientX - r.left, y: e.clientY - r.top - off };
    const w = this.toWorld(this.cross.x, this.cross.y);
    this.snapHit = this.snap ? this.snap(w, 14 / this.view.s) : null;
    this.redraw();
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    let last = null; // pinch state
    let tapStart = null;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        tapStart = { x: e.clientX, y: e.clientY, t: performance.now() };
        if (this.mode === 'point') this._updateCross(e);
      } else {
        tapStart = null;
        this.cross = null; // second finger cancels point placement
        last = null;
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = c.getBoundingClientRect();
        if (last) {
          const k = d / last.d;
          const mx = mid.x - r.left;
          const my = mid.y - r.top;
          // keep the world point under the previous midpoint under the new midpoint
          this.view.tx = mx - (last.mx - this.view.tx) * k;
          this.view.ty = my - (last.my - this.view.ty) * k;
          this.view.s *= k;
        }
        last = { d, mx: mid.x - r.left, my: mid.y - r.top };
        this.redraw();
        return;
      }
      if (this.mode === 'point') { this._updateCross(e); return; }
      this.view.tx += e.clientX - prev.x;
      this.view.ty += e.clientY - prev.y;
      this.redraw();
    });
    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) last = null;
      if (this.pointers.size > 0) return;
      if (this.mode === 'point' && this.cross && e.type === 'pointerup') {
        const w = this.snapHit ? { x: this.snapHit.x, y: this.snapHit.y } : this.toWorld(this.cross.x, this.cross.y);
        const info = { snapped: !!this.snapHit, s: this.view.s };
        this.cross = null;
        this.snapHit = null;
        this.redraw();
        this.onPoint?.(w, info);
        return;
      }
      if (tapStart && e.type === 'pointerup' && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) < 8 && performance.now() - tapStart.t < 400) {
        const r = c.getBoundingClientRect();
        this.onTap?.(this.toWorld(e.clientX - r.left, e.clientY - r.top), { s: this.view.s });
      }
      tapStart = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const k = Math.exp(-e.deltaY * 0.0015);
      this.view.tx = mx - (mx - this.view.tx) * k;
      this.view.ty = my - (my - this.view.ty) * k;
      this.view.s *= k;
      this.redraw();
    }, { passive: false });
  }

  zoomBy(k) {
    const mx = this.w / 2;
    const my = this.h / 2;
    this.view.tx = mx - (mx - this.view.tx) * k;
    this.view.ty = my - (my - this.view.ty) * k;
    this.view.s *= k;
    this.redraw();
  }
}
