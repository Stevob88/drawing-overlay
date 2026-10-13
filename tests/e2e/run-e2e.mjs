// End-to-end run of the app in headless Chromium at iPhone size.
//   npm run e2e         synthetic drawings (screenshots: tests/e2e/out/)
//   npm run e2e:real    real drawings in tests/fixtures/real/ (git-ignored; out-real/)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REALRUN = process.argv.includes('--real');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const FIX = path.join(ROOT, 'tests/fixtures', REALRUN ? 'real' : 'synthetic');
const OUT = path.join(ROOT, 'tests/e2e', REALRUN ? 'out-real' : 'out');
const ROOF = path.join(FIX, 'ellerton_roof.pdf');
const FLOOR = path.join(FIX, 'ellerton_first_floor.pdf');
if (!fs.existsSync(ROOF) || !fs.existsSync(FLOOR)) { console.log('Drawings not present, skipping'); process.exit(0); }
// The same building corner on each drawing (page points). Real: top-left outside corner of
// the walls. Synthetic: top-left corner of the roof outline / external wall.
const CORNERS = REALRUN
  ? { roof: [383.2, 68.5], floor: [428.8, 106.2] }
  : { roof: [142.992, 224.882], floor: [120, 201.89] };
fs.mkdirSync(OUT, { recursive: true });

const PORT = REALRUN ? 8124 : 8123;
const BASE = `http://localhost:${PORT}/`;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const fail = (m) => { throw new Error('E2E FAIL: ' + m); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'allow' });
const page = await ctx.newPage();
const external = [];
page.on('request', (r) => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u); });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
const canvasShot = (n) => page.locator('.canvaswrap canvas').screenshot({ path: path.join(OUT, n + '.png') });
const step = (s) => console.log('•', s);
const text = () => page.locator('#app').innerText();

async function choose(nth, file) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Choose PDF|Change/ }).nth(nth).click()]);
  await fc.setFiles(file);
}
/** Zoom on a page point, then tap it with the mouse (no finger offset). */
async function tapAt(x, y, zoom = 8) {
  const pos = await page.evaluate(([x, y, zoom]) => {
    const v = window.__roofline.viewer();
    v.canvas.scrollIntoView({ block: 'center' });
    v.view.s = zoom; v.view.tx = v.w / 2 - x * zoom; v.view.ty = v.h / 2 - y * zoom; v.redraw();
    const r = v.canvas.getBoundingClientRect();
    return { x: r.left + x * zoom + v.view.tx, y: r.top + y * zoom + v.view.ty };
  }, [x, y, zoom]);
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.move(pos.x + 0.3, pos.y);
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.up();
  await page.waitForTimeout(150);
}

try {
  step('start: choose roof, then floor');
  await page.goto(BASE);
  await page.waitForSelector('text=Choose the roof plan PDF.');
  await shot('01-start');
  await choose(0, ROOF);
  await page.waitForSelector('text=Now choose the floor plan PDF', { timeout: 60000 });
  await choose(1, FLOOR);
  await page.waitForSelector('text=Line up 1 of 2', { timeout: 60000 });
  await page.waitForTimeout(300);
  await shot('02-lineup-roof');

  step('line up: same corner on each drawing');
  await tapAt(...CORNERS.roof);
  await page.waitForSelector('text=Line up 2 of 2');
  await tapAt(...CORNERS.floor);
  await page.waitForSelector('text=Line up again');
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(400);
  await shot('03-overlay');
  await canvasShot('03b-overlay-canvas');
  const al = await page.evaluate(() => window.__roofline.saved().align);
  console.log('  corners used: roof', al.roofRef.x.toFixed(2), al.roofRef.y.toFixed(2), '| floor', al.floorRef.x.toFixed(2), al.floorRef.y.toFixed(2));

  step('move roof, then undo');
  await page.getByRole('button', { name: 'Move roof' }).click();
  const box = await page.locator('.canvaswrap canvas').boundingBox();
  await page.mouse.move(box.x + 150, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 170, box.y + 210, { steps: 4 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForSelector('text=Undo roof moves');
  await page.getByRole('button', { name: 'Undo roof moves' }).click();
  if (/Undo roof moves/.test(await text())) fail('undo did not clear the move');

  step('reload keeps both drawings and the line-up');
  await page.reload();
  await page.waitForSelector('text=Line up again', { timeout: 60000 });
  const t = await text();
  if (!t.includes(path.basename(ROOF)) || !t.includes(path.basename(FLOOR))) fail('drawings not remembered');

  step('works offline');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 }).catch(() => {});
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 });
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('text=Line up again', { timeout: 60000 });
  await ctx.setOffline(false);

  if (external.length) fail('external requests: ' + external.join(', '));
  const errs = errors.filter((e) => !/favicon/.test(e));
  if (errs.length) fail('console/page errors: ' + errs.join('\n'));
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
