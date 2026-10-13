// End-to-end run of the real app in headless Chromium at iPhone size, using the
// SYNTHETIC fixtures. Run: npm run e2e   (screenshots go to tests/e2e/out/)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadDrawing, SYN } from '../helpers.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUT = path.join(ROOT, 'tests/e2e/out');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8123;
const BASE = `http://localhost:${PORT}/`;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const fail = (m) => { throw new Error('E2E FAIL: ' + m); };
const bbox = (segs) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let i = 0; i < segs.length; i += 2) { x0 = Math.min(x0, segs[i]); x1 = Math.max(x1, segs[i]); y0 = Math.min(y0, segs[i + 1]); y1 = Math.max(y1, segs[i + 1]); } return { x0, y0, x1, y1 }; };
const floorM = await loadDrawing(path.join(SYN, 'ellerton_first_floor.pdf'), 'floor');
const roofM = await loadDrawing(path.join(SYN, 'ellerton_roof.pdf'), 'roof');
const outer = bbox(floorM.groups.find((g) => g.lw === 0.7).segs);
const plate = bbox(roofM.groups.find((g) => g.dash).segs);

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

try {
  step('home');
  await page.goto(BASE);
  await page.waitForSelector('.plotinput');
  await shot('01-home');

  step('import schedule');
  await page.goto(BASE + '#/settings');
  await choose(/Import schedule PDF/, path.join(SYN, 'plot_schedule.pdf'));
  await page.waitForSelector('text=Review imported schedule');
  await shot('02-schedule-review');
  const summary = await page.locator('.msg').allInnerTexts();
  if (!summary.some((t) => t.includes('181 plots'))) fail('schedule summary: ' + summary.join(' | '));
  await page.getByText('I confirm this mapping is correct').click();
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await page.waitForSelector('text=Plot schedule');

  step('plot 30 with no drawings');
  await page.goto(BASE + '#/plot/30');
  await page.waitForSelector('text=No drawings imported for ELLERTON.');
  await page.getByRole('button', { name: /Import drawings for ELLERTON/ }).click();
  await page.waitForSelector('text=Import house type');
  if ((await page.locator('input').nth(0).inputValue()) !== 'ELLERTON') fail('name not prefilled');
  await page.locator('input').nth(1).fill('Ellerton Elder');
  await choose('Choose PDF', path.join(SYN, 'ellerton_roof.pdf'), 0);
  await page.waitForSelector('text=Method A: vector');
  await choose('Choose PDF', path.join(SYN, 'ellerton_first_floor.pdf'), 1); // ground=0 after roof replaced? first floor slot
  await page.waitForTimeout(500);
  await shot('03-import');
  await page.getByRole('button', { name: 'Save house type' }).click();
  await page.waitForSelector('text=House types');
  const typesText = await page.locator('#app').innerText();
  if (!/Roof plan: ellerton_roof\.pdf/.test(typesText)) fail('roof not saved: ' + typesText);
  const floorSlot = /First floor: ellerton_first_floor/.test(typesText) ? 'first' : /Ground floor/.test(typesText) ? 'ground' : null;
  if (!floorSlot) fail('floor not saved');
  if (floorSlot !== 'first') console.log('  NOTE: floor plan went into', floorSlot);

  step('plot 30 not calibrated -> calibrate');
  await page.goto(BASE + '#/plot/30');
  await page.waitForSelector('text=Not calibrated yet.');
  await page.getByRole('button', { name: /Set up overlay/ }).click();
  await page.getByRole('button', { name: 'Full calibration' }).click();
  await page.waitForSelector('text=1. Roof plan: scale');
  await page.waitForTimeout(300);
  await zoomAround(plate.x0, plate.y0, 4);
  await tapWorld(plate.x0 + 0.6, plate.y0 + 0.4); // slightly off: must snap
  await zoomAround(plate.x1, plate.y0, 1);
  await tapWorld(plate.x1 - 0.5, plate.y0 + 0.3);
  await page.getByPlaceholder('Real length in mm').fill('10113');
  await page.waitForTimeout(100);
  await shot('04-cal-roof-scale');
  const roofReadout = await page.locator('#app').innerText();
  if (!/A snapped to a line (end|crossing), B snapped to a line (end|crossing)/.test(roofReadout)) fail('roof points not snapped');
  if (!/Matches the stated scale 1:50/.test(roofReadout)) fail('roof scale check: ' + roofReadout.slice(-600));
  await page.getByRole('button', { name: 'Next ›' }).click();
  await zoomAround(plate.x0, plate.y0, 1);
  await tapWorld(plate.x0 + 0.3, plate.y0 - 0.2);
  await page.getByRole('button', { name: 'Next ›' }).click();
  await page.waitForSelector('text=3. First floor: scale');
  await zoomAround(outer.x0, outer.y0, 4);
  await tapWorld(outer.x0, outer.y0);
  await zoomAround(outer.x1, outer.y0, 1);
  await tapWorld(outer.x1, outer.y0);
  await page.getByPlaceholder('Real length in mm').fill('10436');
  await page.waitForTimeout(100);
  if (!/Matches the stated scale 1:50/.test(await page.locator('#app').innerText())) fail('floor scale check');
  await page.getByRole('button', { name: 'Next ›' }).click();
  await zoomAround(outer.x0, outer.y0, 1);
  await tapWorld(outer.x0, outer.y0);
  await page.getByRole('button', { name: 'Next ›' }).click();
  await page.waitForSelector('text=5. Reference offset');
  await page.getByRole('button', { name: /Top-left corner/ }).click();
  await page.waitForTimeout(300);
  await page.getByText('I have checked this offset').click();
  await shot('05-cal-offset');
  await page.getByRole('button', { name: 'Next ›' }).click();
  await page.waitForSelector('text=6. Check and save');
  await page.waitForTimeout(300);
  await zoomAround(0, 0, 1);
  await tapWorld(0, 0);
  await zoomAround(10436, 0, 1);
  await tapWorld(10436, 0);
  await page.getByPlaceholder('Expected mm').fill('10436');
  await page.waitForTimeout(100);
  await shot('06-cal-check');
  const chk = await page.locator('#app').innerText();
  const md = chk.match(/difference (-?[\d.]+) mm/);
  if (!md || Math.abs(parseFloat(md[1])) > 1) fail('measure check diff: ' + (md && md[1]));
  if (!/Rotation between the reference lines: 0\.000°/.test(chk)) fail('rotation not 0');
  await page.getByRole('button', { name: 'Save calibration' }).click();
  await page.waitForSelector('text=Not tape-checked on site yet');

  step('plot 30 overlay (As)');
  await page.waitForTimeout(400);
  await shot('07-plot30-as');
  const p30 = await page.locator('#app').innerText();
  if (/OPP - mirrored/.test(p30)) fail('plot 30 shows mirrored');
  if (!/Applies to plot 30: Rad position to plots: 30, 31/.test(p30)) fail('plot note not shown for 30');
  if (!/Hidden \(not plot 30\): Solar PV/.test(p30)) fail('other plot note not hidden');
  if (!/Setting-out aid only\. Roof plan vent positions are indicative\. Check against the truss layout \/ designer before fixing\./.test(p30)) fail('notice missing');

  step('measure tool on plot 30: ridge length');
  await page.getByRole('button', { name: 'Measure' }).click();
  await zoomAround(6200 / 2, 6200 / 2, 3);
  await tapWorld(3100 + 0.3, 3100);
  await zoomAround(10436 - 3100, 3100, 1);
  await tapWorld(10436 - 3100, 3100 - 0.2);
  const mtext = await page.locator('.measure').innerText();
  console.log('  measure:', mtext);
  if (!/A→B 4236 mm/.test(mtext)) fail('ridge measure: ' + mtext);
  await page.getByRole('button', { name: 'Measure' }).click();

  step('export PNG');
  await page.getByRole('button', { name: 'Export' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'PNG' }).click()]);
  await dl.saveAs(path.join(OUT, 'export-plot30.png'));
  await page.getByRole('button', { name: 'Close' }).click();
  const [dl2] = await Promise.all([page.waitForEvent('download'), (async () => { await page.getByRole('button', { name: 'Export' }).click(); await page.getByRole('button', { name: 'PDF' }).click(); })()]);
  await dl2.saveAs(path.join(OUT, 'export-plot30.pdf'));

  step('site check');
  await page.getByRole('button', { name: 'Checked on site…' }).click();
  await page.locator('textarea').fill('E2E: ridge 4236 on app vs drawing 4236');
  await page.getByRole('button', { name: '✓ Checked on site' }).click();
  await page.waitForSelector('text=Checked on site ' + new Date().toISOString().slice(0, 10));

  step('plot 31 overlay (Opp)');
  await page.goto(BASE + '#/plot/31');
  await page.waitForSelector('text=OPP - mirrored from As drawing');
  await page.waitForTimeout(400);
  await shot('08-plot31-opp');

  step('As / Opp test');
  await page.goto(BASE + `#/mirror/${await page.evaluate(() => window.__roofline.houseTypes[0].id)}/${floorSlot}`);
  await page.waitForSelector('text=OPP (mirrored)');
  await page.waitForTimeout(400);
  await shot('09-mirror-test');

  step('layer picker');
  await page.goto(BASE + `#/picker/${await page.evaluate(() => window.__roofline.houseTypes[0].id)}/${floorSlot}`);
  await page.waitForSelector('text=Line groups');
  await page.waitForTimeout(300);
  await shot('10-picker');

  step('plot not in schedule + dark mode');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(BASE + '#/plot/999');
  await page.waitForSelector('text=Plot 999 is not in the schedule.');
  await page.goto(BASE + '#/plot/31');
  await page.waitForSelector('text=OPP - mirrored from As drawing');
  await page.waitForTimeout(400);
  await shot('11-plot31-dark');

  step('offline reload');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 10000 }).catch(() => {});
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 10000 });
  await ctx.setOffline(true);
  await page.goto(BASE + '#/plot/30');
  await page.waitForSelector('text=Setting-out aid only', { timeout: 15000 });
  await ctx.setOffline(false);
  console.log('  offline: plot 30 loaded from cache');

  if (external.length) fail('external requests: ' + external.join(', '));
  const realErrors = errors.filter((e) => !/favicon/.test(e));
  if (realErrors.length) fail('console/page errors: ' + realErrors.join('\n'));
  console.log('E2E PASSED. Screenshots in', OUT);
} catch (e) {
  await shot('zz-failure').catch(() => {});
  console.error(e.message);
  console.error('errors:', errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
