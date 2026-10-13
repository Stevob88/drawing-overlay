// End-to-end run on the REAL Ellerton drawings + variation sheet, if present in
// tests/fixtures/real/ (git-ignored). Run: npm run e2e:real  (screenshots: tests/e2e/out-real/)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadDrawing, SYN } from '../helpers.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'tests/e2e/out-real');
const REALDIR = path.join(ROOT, 'tests/fixtures/real');
if (!fs.existsSync(path.join(REALDIR, 'schedule.pdf'))) { console.log('No real fixtures, skipping'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8124;
const BASE = `http://localhost:${PORT}/`;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const fail = (m) => { throw new Error('E2E FAIL: ' + m); };
const bbox = (segs) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let i = 0; i < segs.length; i += 2) { x0 = Math.min(x0, segs[i]); x1 = Math.max(x1, segs[i]); y0 = Math.min(y0, segs[i + 1]); y1 = Math.max(y1, segs[i + 1]); } return { x0, y0, x1, y1 }; };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true, serviceWorkers: 'allow' });
const page = await ctx.newPage();
const external = [];
page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
const step = (s) => console.log('•', s);

async function choose(buttonName, file, nth = 0) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: buttonName }).nth(nth).click()]);
  await fc.setFiles(file);
}
/** Click a world/drawing point on the active viewer (mouse: no finger offset). */
async function tapWorld(x, y, vi = 0) {
  const pos = await page.evaluate(([x, y, vi]) => {
    const v = window.__roofline.viewers[vi];
    const r0 = v.canvas.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > innerHeight) v.canvas.scrollIntoView({ block: 'center' });
    const r = v.canvas.getBoundingClientRect();
    return { x: r.left + x * v.view.s + v.view.tx, y: r.top + y * v.view.s + v.view.ty };
  }, [x, y, vi]);
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.move(pos.x + 0.2, pos.y);
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.up();
  await page.waitForTimeout(80);
}
async function zoomAround(x, y, k, vi = 0) {
  await page.evaluate(([x, y, k, vi]) => {
    const v = window.__roofline.viewers[vi];
    v.view.s *= k; v.view.tx = v.w / 2 - x * v.view.s; v.view.ty = v.h / 2 - y * v.view.s; v.redraw();
  }, [x, y, k, vi]);
}


// Points found from the drawings: where the extension lines cross the 10436 dimension line,
// and the top-left outer corner of the building (5461 extension line x, 10436 top y).
const ROOF = { a: [326.609, 68.4], b: [326.609, 660], ref: [383.009, 68.4] };
const FLOOR = { a: [365.249, 106.08], b: [365.249, 697.68], ref: [428.609, 106.08] };
async function place(pt) { await zoomAround(pt[0], pt[1], 1); await tapWorld(pt[0] + 0.15, pt[1] + 0.1); }
const text = () => page.locator('#app').innerText();

try {
  step('import real schedule');
  await page.goto(BASE + '#/settings');
  await choose(/Import schedule PDF/, path.join(REALDIR, 'schedule.pdf'));
  await page.waitForSelector('text=Review imported schedule', { timeout: 60000 });
  await shot('01-schedule-review');
  const sum = await page.locator('.msg').allInnerTexts();
  console.log('  ', sum.join(' | ').slice(0, 300));
  if (!sum.some((t) => /181 plots, 1-181, none missing, no duplicates/.test(t))) fail('schedule summary');
  await page.getByText('I confirm this mapping is correct').click();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await page.waitForSelector('text=Plot schedule');

  step('plot 30 -> import drawings');
  await page.goto(BASE + '#/plot/30');
  await page.waitForSelector('text=No drawings imported for Ellerton BELX 2401 AA04');
  await page.getByRole('button', { name: /Import drawings for/ }).click();
  await page.waitForSelector('text=Import house type');
  await page.locator('input').nth(1).fill('Elder');
  await page.locator('input').nth(2).fill('BELX 2401 AA04, BELX 2401 AA05');
  await choose('Choose PDF', path.join(REALDIR, 'ellerton_roof.pdf'), 0);
  await page.waitForSelector('text=Method A: vector', { timeout: 60000 });
  await choose('Choose PDF', path.join(REALDIR, 'ellerton_first_floor.pdf'), 1);
  await page.waitForFunction(() => document.querySelectorAll('.badge.a').length >= 2, null, { timeout: 60000 });
  await shot('02-import');
  await page.getByRole('button', { name: 'Save house type' }).click();
  await page.waitForSelector('text=House types');

  let t;
  step('quick setup: one corner tap per drawing, scale from the stated 1:50');
  await page.goto(BASE + '#/plot/30');
  await page.getByRole('button', { name: /Set up overlay/ }).click();
  await page.waitForSelector('text=1. Roof plan: tap a corner', { timeout: 60000 });
  await page.waitForTimeout(500);
  await zoomAround(ROOF.ref[0], ROOF.ref[1], 10);
  await tapWorld(ROOF.ref[0] + 0.15, ROOF.ref[1] + 0.1);
  console.log('  roof ref:', ((await text()).match(/Reference at[^\n]*/) || [''])[0]);
  await page.getByRole('button', { name: 'Next ›' }).click();
  await page.waitForSelector('text=2. First floor: tap the same corner');
  await page.waitForTimeout(300);
  await zoomAround(FLOOR.ref[0], FLOOR.ref[1], 10);
  await tapWorld(FLOOR.ref[0] + 0.15, FLOOR.ref[1] + 0.1);
  console.log('  floor ref:', ((await text()).match(/Reference at[^\n]*/) || [''])[0]);
  await page.getByRole('button', { name: 'Next ›' }).click();
  await page.waitForSelector('text=3. Check and save');
  await page.waitForTimeout(500);
  await zoomAround(0, 0, 6);
  await tapWorld(0.5, 0.5);
  await zoomAround(5461, 0, 1);
  await tapWorld(5461 - 0.5, 0.5);
  await page.getByPlaceholder('Expected mm').fill('5461');
  await page.waitForTimeout(150);
  console.log('  optional measure check:', ((await text()).match(/Measured[^\n]*/) || [''])[0]);
  await shot('05-quick-check');
  await page.getByRole('button', { name: 'Save calibration' }).click();
  await page.waitForSelector('text=Not tape-checked on site yet', { timeout: 60000 });
  await page.waitForTimeout(600);
  await shot('06-plot30');
  await page.locator('.canvaswrap canvas').screenshot({ path: path.join(OUT, '06b-plot30-canvas.png') });
  t = await text();
  console.log('  plot 30 notes:\n   ' + (t.split('Plot-list notes for plot 30')[1] || '').split('Calibration details')[0].trim().replace(/\n+/g, '\n   '));
  if (/OPP - mirrored/.test(t)) fail('30 mirrored');

  step('plot 31 (Opp) and plot 16 (AA05)');
  await page.goto(BASE + '#/plot/31');
  await page.waitForSelector('text=OPP - mirrored from As drawing', { timeout: 60000 });
  await page.waitForTimeout(600);
  await shot('07-plot31-opp');
  await page.locator('.canvaswrap canvas').screenshot({ path: path.join(OUT, '07b-plot31-canvas.png') });
  await page.goto(BASE + '#/plot/16');
  await page.waitForSelector('text=Roof opacity', { timeout: 60000 });
  t = await text();
  console.log('  plot 16 notes:\n   ' + (t.split('Plot-list notes for plot 16')[1] || '').split('Calibration details')[0].trim().replace(/\n+/g, '\n   '));
  await page.goto(BASE + '#/plot/7');
  await page.waitForSelector('text=No drawings imported');
  console.log('  plot 7 (BELX 2403 AA05):', ((await text()).match(/No drawings imported[^\n]*/) || [''])[0]);

  step('As/Opp test + pickers');
  const id = await page.evaluate(() => window.__roofline.houseTypes[0].id);
  await page.goto(BASE + `#/mirror/${id}/first`);
  await page.waitForSelector('text=OPP (mirrored)', { timeout: 60000 });
  await page.waitForTimeout(600);
  await shot('08-mirror');
  for (const slot of ['roof', 'first']) {
    await page.goto(BASE + `#/picker/${id}/${slot}`);
    await page.waitForSelector('text=Line groups', { timeout: 60000 });
    await page.waitForTimeout(600);
    await shot('09-picker-' + slot);
  }
  if (external.length) fail('external requests: ' + external.join(', '));
  const realErrors = errors.filter((e) => !/favicon/.test(e));
  if (realErrors.length) fail('console/page errors: ' + realErrors.join('\n'));
  console.log('REAL E2E PASSED. Screenshots in', OUT);
} catch (e) {
  await shot('zz-failure').catch(() => {});
  console.error(e.message);
  console.error('errors:', errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
