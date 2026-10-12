// Plot schedule ("variation sheet") parser. Input: text items per page with
// { str, x, y (baseline, y down), w, size }. Output rows with uncertainty flags.
// Built to be robust rather than clever: anything it is unsure of is flagged for review.

const isPlotNo = (s) => /^\d{1,4}[A-Z]?$/.test(s.trim());

function clusterLines(items, tolFactor = 0.45) {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.y - it.y) <= tolFactor * Math.max(L.size, it.size)) L.items.push(it);
    else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  return lines;
}

/** Find header columns on a page. Returns { columns:[{name,x0,x1}], headerBottom, plotCol } or null */
function findHeader(items) {
  const plotItem = items
    .filter((it) => /^PLOT(\s*NO\.?)?$/i.test(it.str.trim()) || /^PLOT\s+NUMBER$/i.test(it.str.trim()))
    .sort((a, b) => a.y - b.y)[0];
  if (!plotItem) return null;
  const size = plotItem.size;
  const lines = clusterLines(items.filter((it) => it.y >= plotItem.y - 0.5 * size));
  const header = [];
  for (const L of lines) {
    if (L.y > plotItem.y + 4 * size) break;
    // first data line: has a plot number roughly under the PLOT header
    const hasNumberUnderPlot = L.items.some((it) => isPlotNo(it.str) && Math.abs(it.x - plotItem.x) < 3 * size);
    if (hasNumberUnderPlot && L.y > plotItem.y) break;
    header.push(...L.items);
  }
  const cols = [];
  for (const it of header.sort((a, b) => a.x - b.x)) {
    const x0 = it.x;
    const x1 = it.x + it.w;
    const c = cols.find((c) => x0 <= c.x1 + 1 && x1 >= c.x0 - 1);
    if (c) { c.parts.push(it); c.x0 = Math.min(c.x0, x0); c.x1 = Math.max(c.x1, x1); }
    else cols.push({ x0, x1, parts: [it] });
  }
  cols.sort((a, b) => a.x0 - b.x0);
  const columns = cols.map((c) => ({
    name: c.parts.sort((a, b) => a.y - b.y || a.x - b.x).map((p) => p.str.trim()).join(' ').replace(/\s+/g, ' ').toUpperCase(),
    x0: c.x0, x1: c.x1,
  }));
  // boundaries halfway between one header's end and the next header's start
  for (let i = 0; i < columns.length; i++) {
    columns[i].left = i === 0 ? -Infinity : (columns[i - 1].x1 + columns[i].x0) / 2;
    columns[i].right = i === columns.length - 1 ? Infinity : (columns[i].x1 + columns[i + 1].x0) / 2;
  }
  const headerBottom = Math.max(...header.map((h) => h.y));
  const plotCol = columns.findIndex((c) => c.name.startsWith('PLOT'));
  return { columns, headerBottom, plotCol, size };
}

function colIndexFor(columns, it) {
  // assign by start x; centred values narrower than the header still start inside it
  for (let i = 0; i < columns.length; i++) if (it.x >= columns[i].left && it.x < columns[i].right) return i;
  return -1;
}

/**
 * pages: Array<Array<item>>. Returns { columns: string[], rows: Row[], warnings: string[] }
 * Row = { plot:number|null, plotRaw, cells: {COL: value}, page, uncertain: string[] }
 */
export function parseSchedule(pages) {
  const rows = [];
  const warnings = [];
  let columnNames = null;
  pages.forEach((rawItems, pi) => {
    const items = rawItems.filter((it) => it.str && it.str.trim() && Math.abs(it.angle || 0) < 0.01);
    const hdr = findHeader(items);
    if (!hdr) { warnings.push(`Page ${pi + 1}: no "PLOT NO" header found - page skipped.`); return; }
    const names = hdr.columns.map((c) => c.name);
    if (!columnNames) columnNames = names;
    else if (names.join('|') !== columnNames.join('|')) warnings.push(`Page ${pi + 1}: header differs from page 1 (${names.join(', ')}).`);
    const body = items.filter((it) => it.y > hdr.headerBottom + 0.3 * hdr.size);
    const pc = hdr.columns[hdr.plotCol];
    const anchors = body
      .filter((it) => isPlotNo(it.str) && colIndexFor(hdr.columns, it) === hdr.plotCol)
      .sort((a, b) => a.y - b.y);
    if (!anchors.length) { warnings.push(`Page ${pi + 1}: header found but no plot numbers under it.`); return; }
    const pitches = anchors.slice(1).map((a, i) => a.y - anchors[i].y).sort((a, b) => a - b);
    const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 2 * hdr.size;
    const top = anchors[0].y - 0.8 * pitch;
    const bottom = anchors[anchors.length - 1].y + 1.6 * pitch;
    const pageRows = anchors.map((a) => ({ anchor: a, cellItems: hdr.columns.map(() => []), uncertain: [] }));
    for (const L of clusterLines(body)) {
      if (L.y < top || L.y > bottom) continue;
      // nearest anchor by baseline distance
      let best = 0;
      let bd = Infinity;
      let second = Infinity;
      anchors.forEach((a, i) => {
        const d = Math.abs(a.y - L.y);
        if (d < bd) { second = bd; bd = d; best = i; } else if (d < second) second = d;
      });
      const row = pageRows[best];
      if (bd > 0.3 * hdr.size && second < Infinity && bd / second > 0.7) {
        row.uncertain.push(`Text "${L.items.map((i) => i.str).join(' ').slice(0, 40)}" is about equally close to two rows`);
      }
      for (const it of L.items) {
        if (it === row.anchor) continue;
        const ci = colIndexFor(hdr.columns, it);
        if (ci < 0) { row.uncertain.push(`"${it.str}" is outside all columns`); continue; }
        if (ci === hdr.plotCol && isPlotNo(it.str)) { row.uncertain.push(`Second plot number "${it.str}" in the same row`); continue; }
        row.cellItems[ci].push(it);
      }
    }
    for (const r of pageRows) {
      const cells = {};
      hdr.columns.forEach((c, ci) => {
        const its = r.cellItems[ci].sort((a, b) => a.y - b.y || a.x - b.x);
        const lineCount = new Set(its.map((i) => Math.round(i.y))).size;
        cells[c.name] = its.map((i) => i.str.trim()).join(' ').replace(/\s+/g, ' ').trim();
        if (lineCount > 1 && ci !== hdr.plotCol) r.uncertain.push(`${c.name} wraps onto ${lineCount} lines - joined, please check`);
      });
      cells[pc.name] = r.anchor.str.trim();
      rows.push({ plot: parseInt(r.anchor.str, 10), plotRaw: r.anchor.str.trim(), cells, page: pi + 1, uncertain: r.uncertain });
    }
  });
  return { columns: columnNames || [], rows, warnings };
}

/** Check plot numbering against the expected range. */
export function validateRows(rows, expectedFrom = 1, expectedTo = 181) {
  const seen = new Map();
  for (const r of rows) seen.set(r.plot, (seen.get(r.plot) || 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
  const missing = [];
  for (let p = expectedFrom; p <= expectedTo; p++) if (!seen.has(p)) missing.push(p);
  const outOfRange = rows.filter((r) => r.plot < expectedFrom || r.plot > expectedTo).map((r) => r.plotRaw);
  return { count: rows.length, duplicates, missing, outOfRange };
}

/** Flag rows missing essential values for the chosen mapping. */
export function flagRows(rows, mapping) {
  for (const r of rows) {
    r.flags = [...r.uncertain];
    for (const key of ['nameCol', 'codeCol', 'handCol']) {
      const col = mapping[key];
      if (col && !r.cells[col]) r.flags.push(`${col} is blank`);
    }
    const h = r.cells[mapping.handCol];
    if (h && !parseHanding(h)) r.flags.push(`Handing "${h}" not recognised (expected As or Opp)`);
  }
  return rows;
}

export function parseHanding(s) {
  const t = (s || '').trim().toLowerCase();
  if (/^opp(osite|\.)?$/.test(t)) return 'Opp';
  if (/^as(\s*drawn)?$/.test(t)) return 'As';
  return null;
}

/** Guess a sensible default mapping from header names (the user must confirm it). */
export function guessMapping(columns) {
  const find = (...res) => columns.find((c) => res.some((re) => re.test(c))) || '';
  return {
    plotCol: find(/^PLOT/),
    nameCol: find(/^HOUSE TYPE$/, /HOUSE\s*TYPE/),
    salesCol: find(/SALES/),
    codeCol: find(/ACTUAL\s*PORTAL/, /PORTAL/, /BASE\s*CODE/),
    handCol: find(/HANDING/),
    finishCol: find(/ROOF\s*FINISH/),
    roofTypeCol: find(/ROOF\s*TYPE/),
    confirmed: false,
  };
}
