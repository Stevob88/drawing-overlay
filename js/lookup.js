// Plot -> house type resolution. Matches on drawing code AND name, never name alone.
import { parseHanding } from './schedule.js';

export const normCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const normName = (s) => (s || '').toUpperCase().replace(/^THE\s+/, '').replace(/[^A-Z0-9]/g, '');

/**
 * Resolve a plot number.
 * Returns { status: 'ok'|'not-in-schedule'|'duplicate'|'no-drawing'|'ambiguous'|'bad-row', row, houseType, handing, warnings[] }
 */
export function resolvePlot(plotNo, schedule, houseTypes) {
  const warnings = [];
  if (!schedule || !schedule.rows?.length) return { status: 'no-schedule', warnings: ['No plot schedule imported yet.'] };
  const m = schedule.mapping;
  if (!m?.confirmed) warnings.push('Column mapping has not been confirmed in Settings.');
  const rows = schedule.rows.filter((r) => r.plot === plotNo);
  if (!rows.length) return { status: 'not-in-schedule', warnings: [`Plot ${plotNo} is not in the schedule.`] };
  if (rows.length > 1) return { status: 'duplicate', rows, warnings: [`Plot ${plotNo} appears ${rows.length} times in the schedule. Fix it in Settings > Schedule.`] };
  const row = rows[0];
  if (row.flags?.length && !row.reviewed) warnings.push(`Schedule row for plot ${plotNo} was flagged during import and has not been reviewed: ${row.flags.join('; ')}`);
  const name = row.cells[m.nameCol] || '';
  const code = row.cells[m.codeCol] || '';
  const handing = parseHanding(row.cells[m.handCol]);
  const info = {
    row, name, code, handing, handingRaw: row.cells[m.handCol] || '',
    finish: row.cells[m.finishCol] || '', roofType: row.cells[m.roofTypeCol] || '',
    sales: row.cells[m.salesCol] || '',
  };
  if (!handing) return { status: 'bad-row', ...info, warnings: [...warnings, `Handing "${info.handingRaw}" for plot ${plotNo} is not As or Opp. Mirroring cannot be decided. Fix the schedule row.`] };
  if (!code) return { status: 'bad-row', ...info, warnings: [...warnings, `No drawing code in column "${m.codeCol}" for plot ${plotNo}.`] };
  const byCode = houseTypes.filter((h) => normCode(h.drawingCode) === normCode(code));
  const matches = byCode.filter((h) => [h.name, ...(h.aliases || [])].some((n) => normName(n) === normName(name)));
  if (matches.length === 1) return { status: 'ok', ...info, houseType: matches[0], warnings };
  if (matches.length > 1) return { status: 'ambiguous', ...info, candidates: matches, warnings: [...warnings, `${matches.length} imported house types match code ${code} and name ${name}.`] };
  if (byCode.length) {
    return { status: 'no-drawing', ...info, warnings: [...warnings, `A drawing with code ${code} is imported, but under the name "${byCode.map((h) => h.name).join('", "')}", not "${name}". Names must match too (or add "${name}" as an alias on that house type).`] };
  }
  return { status: 'no-drawing', ...info, warnings: [...warnings, `No drawings imported for ${name} ${code}.`] };
}
