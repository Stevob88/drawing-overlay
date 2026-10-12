// Export the current overlay view as PNG or PDF with a stamped information panel.
import { drawScene, drawScaleBar, PALETTES } from './render.js';

const NOTICE = 'Setting-out aid only. Roof plan vent positions are indicative. Check against the truss layout / designer before fixing.';

/**
 * Render an export canvas. view = the on-screen view (CSS px), w/h = on-screen size.
 * stamp = array of text lines.
 */
export function renderExport(scene, o, view, w, h, stamp) {
  const scale = Math.max(2, Math.ceil(2000 / w));
  const W = Math.round(w * scale);
  const panelLines = [...stamp, NOTICE];
  const lineH = 15 * scale;
  const panelH = Math.round((panelLines.length + 1) * lineH + 10 * scale);
  const H = Math.round(h * scale) + panelH;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const pal = PALETTES.light; // exports are always light for printing
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  drawScene(ctx, view, scene, { ...o, pal, dpr: scale, loupe: false });
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawScaleBar(ctx, view, w, h, pal);
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, h * scale, W, panelH);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  panelLines.forEach((t, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${(i === panelLines.length - 1 ? 11 : 12) * scale}px system-ui, sans-serif`;
    ctx.fillStyle = i === panelLines.length - 1 ? '#a00000' : '#000';
    ctx.fillText(t, 10 * scale, h * scale + 8 * scale + i * lineH, W - 20 * scale);
  });
  return c;
}

const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));

export async function exportPng(canvas) {
  return toBlob(canvas, 'image/png');
}

/** Minimal single-page PDF wrapping a JPEG of the canvas. */
export async function exportPdf(canvas) {
  const jpg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
  const wPt = 842; // A3-ish landscape width; keep aspect
  const hPt = Math.round((wPt * canvas.height) / canvas.width);
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => {
    push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg);
    push('\nendstream');
  });
  const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
  obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => String(offsets[n]).padStart(10, '0') + ' 00000 n \n').join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/** Save/share a blob locally (iOS: share sheet so it can go to Files/Photos). */
export async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export { NOTICE };
