// Text grouping, classification and plot-list parsing. Pure functions.

/** Merge pdf.js text items that sit on the same baseline into lines. */
export function groupTextLines(items) {
  const lines = [];
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  for (const it of sorted) {
    const c = Math.cos(it.angle);
    const s = Math.sin(it.angle);
    const u = it.x * c + it.y * s; // along text direction
    const v = -it.x * s + it.y * c; // across
    let best = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 60; i--) {
      const L = lines[i];
      if (Math.abs(L.angle - it.angle) > 0.02) continue;
      if (Math.abs(L.size - it.size) > 0.3 * Math.max(L.size, it.size)) continue;
      if (Math.abs(L.v - v) > 0.35 * it.size) continue;
      const gap = u - L.uEnd;
      if (gap < -0.3 * it.size || gap > 1.0 * it.size) continue;
      best = { L, gap };
      break;
    }
    if (best) {
      const { L, gap } = best;
      const needSpace = gap > 0.2 * it.size && !L.str.endsWith(' ') && !it.str.startsWith(' ');
      L.str += (needSpace ? ' ' : '') + it.str;
      L.uEnd = Math.max(L.uEnd, u + it.w);
    } else {
      lines.push({ str: it.str, x: it.x, y: it.y, angle: it.angle, size: it.size, u, v, uStart: u, uEnd: u + it.w });
    }
  }
  return lines.map((L) => {
    const w = L.uEnd - L.uStart;
    const c = Math.cos(L.angle);
    const s = Math.sin(L.angle);
    // centre of the text box (baseline start + half width along, half height "up")
    const cx = L.x + (w / 2) * c + (L.size / 2.8) * s;
    const cy = L.y + (w / 2) * s - (L.size / 2.8) * c;
    return { str: L.str.replace(/\s+/g, ' ').trim(), x: L.x, y: L.y, angle: L.angle, size: L.size, w, cx, cy };
  });
}

const ROOM = /^(BED(ROOM)?\s*\d+|MASTER\s+BED(ROOM)?|BATH(ROOM)?|EN[\s-]?SUITE|LANDING|WC|CLOAKS?(\s*ROOM)?|STUDY|STORE|CUPB(OARD)?|AIRING(\s+CUPBOARD)?|KITCHEN(\s*\/\s*\w+)?|LOUNGE|LIVING(\s+ROOM)?|DINING(\s+ROOM)?|HALL(WAY)?|UTILITY|DRESSING|LOFT|GARAGE|FAMILY(\s+ROOM)?)\b/i;
const DIM = /^[\d\s.,x×()-]*\d{2,}[\d\s.,x×()-]*$/;
const ROOFNOTE = /\b(TV|tile\s*vents?|vents?|RWP|SVP|truss(es|ed)?|ridge|hips?|valleys?|soakers?|flue|dry\s*verge|eaves|gutter|solar|PV|loft\s*hatch|tank|velux|rooflight)\b/i;

export function classifyText(str) {
  const s = str.trim();
  if (/\bplots?\b/i.test(s) && /\d/.test(s)) return 'plotnote';
  if (ROOM.test(s) && s.length <= 30) return 'room';
  if (DIM.test(s)) return 'dim';
  if (/\b1\s*:\s*\d{1,4}\b/.test(s)) return 'scale';
  if (ROOFNOTE.test(s)) return 'roofnote';
  return 'note';
}

const JOINERS = new Set(['and', '&', 'to', 'only', 'incl', 'incl.', 'inclusive', 'nos', 'nos.', 'no', 'no.', 'plot', 'plots']);

/**
 * Parse a plot list from a note, e.g. "Rad position to plots: 30, 31, 82-84 & 110".
 * Returns { plots: number[], uncertain: bool, reason } or null if the text has no plot list.
 */
export function parsePlotList(str) {
  const m = str.match(/\bplots?\b\s*(?:nos?\.?)?\s*[:\-–]?\s*(.*)$/i);
  if (!m) return null;
  const tail = m[1];
  const toks = tail.split(/[\s,;]+/).filter(Boolean);
  const plots = [];
  let uncertain = false;
  let reason = '';
  let i = 0;
  let stoppedAt = -1;
  while (i < toks.length) {
    const t = toks[i].replace(/[.)]$/, '');
    const range = t.match(/^(\d{1,3})[-–](\d{1,3})$/);
    if (range) {
      const a = +range[1];
      const b = +range[2];
      if (b < a || b - a > 60) { uncertain = true; reason = `Odd range "${t}"`; }
      else for (let n = a; n <= b; n++) plots.push(n);
      i++; continue;
    }
    if (/^\d{1,3}$/.test(t)) {
      if (toks[i + 1]?.toLowerCase() === 'to' && /^\d{1,3}$/.test(toks[i + 2] ?? '')) {
        const a = +t;
        const b = +toks[i + 2];
        if (b < a || b - a > 60) { uncertain = true; reason = `Odd range "${t} to ${toks[i + 2]}"`; }
        else for (let n = a; n <= b; n++) plots.push(n);
        i += 3; continue;
      }
      plots.push(+t); i++; continue;
    }
    if (JOINERS.has(t.toLowerCase())) { i++; continue; }
    stoppedAt = i;
    break;
  }
  if (stoppedAt >= 0) {
    const rest = toks.slice(stoppedAt).join(' ');
    if (/\d/.test(rest)) { uncertain = true; reason = `Unparsed numbers after the list: "${rest}"`; }
  }
  if (!plots.length) { uncertain = true; reason = reason || 'Mentions plots but no plot numbers could be read'; }
  return { plots: [...new Set(plots)], uncertain, reason };
}

/**
 * Join plot-note lines with continuation lines directly below them (wrapped lists)
 * and parse each. Returns [{ str, lineIdx:[...], plots, uncertain, reason, cx, cy }]
 */
export function extractPlotNotes(lines) {
  const out = [];
  const used = new Set();
  lines.forEach((L, i) => {
    if (used.has(i) || L.cls !== 'plotnote') return;
    let str = L.str;
    const idx = [i];
    let last = L;
    // continuation: next line below, similar size, mostly numbers/commas
    for (;;) {
      const nextI = lines.findIndex((M, j) => !used.has(j) && !idx.includes(j) &&
        Math.abs(M.angle - last.angle) < 0.02 && Math.abs(M.size - last.size) < 0.3 * last.size &&
        M.y > last.y && M.y - last.y < 1.9 * last.size && Math.abs(M.x - L.x) < 40 * last.size &&
        /^[\d\s,&\-–.]+(and[\d\s,&\-–.]*)*$/i.test(M.str));
      if (nextI < 0) break;
      idx.push(nextI);
      str += ' ' + lines[nextI].str;
      last = lines[nextI];
    }
    idx.forEach((j) => used.add(j));
    const parsed = parsePlotList(str);
    if (parsed) out.push({ str, lineIdx: idx, ...parsed, cx: L.cx, cy: L.cy });
  });
  return out;
}

/** Decide visibility of a plot note for the selected plot. */
export function plotNoteVisibility(note, plot) {
  if (note.uncertain) return 'warn';
  return note.plots.includes(plot) ? 'show' : 'hide';
}
