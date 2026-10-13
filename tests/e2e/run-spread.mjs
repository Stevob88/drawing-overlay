// Browser test: a spread-out bungalow (wings separated by gaps, a small store wing, a key block).
// Nothing of the building may be cut off. Run: npm run e2e:spread  (screenshots: tests/e2e/out-spread/)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const FIX = path.join(ROOT, 'tests/fixtures/synthetic');
const OUT = path.join(ROOT, 'tests/e2e/out-spread');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8126;
const BASE = `http://localhost:${PORT}/`;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const fail = (m) => { throw new Error('E2E FAIL: ' + m); };
const MMPT = 72 / 25.4 / 50;
const floorPt = (x, y) => [120 + x * MMPT, 841.89 - (640 - y * MMPT)];
const roofPt = (x, y) => [160 + x * MMPT, 841.89 - (600 - y * MMPT)];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const choose = async (n, f) => { const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Choose PDF|Change/ }).nth(n).click()]); await fc.setFiles(f); };
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
/** Count non-white pixels of the canvas inside a floor-page rectangle (points). */
const inkIn = (rect) => page.evaluate((r) => {
  const v = window.__roofline.viewer();
  const c = v.canvas, ctx2 = c.getContext('2d');
  const x0 = Math.max(0, Math.floor((r[0] * v.view.s + v.view.tx) * v.dpr)), y0 = Math.max(0, Math.floor((r[1] * v.view.s + v.view.ty) * v.dpr));
  const x1 = Math.min(c.width, Math.ceil((r[2] * v.view.s + v.view.tx) * v.dpr)), y1 = Math.min(c.height, Math.ceil((r[3] * v.view.s + v.view.ty) * v.dpr));
  if (x1 <= x0 || y1 <= y0) return -1; // off screen
  const d = ctx2.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) n++;
  return n;
}, rect);

try {
  await page.goto(BASE);
  await page.waitForSelector('text=Choose the roof plan PDF.');
  await choose(0, path.join(FIX, 'bungalow_roof.pdf'));
  await page.waitForSelector('text=Now choose the floor plan PDF', { timeout: 60000 });
  await choose(1, path.join(FIX, 'bungalow_floor.pdf'));
  await page.waitForSelector('text=Line up 1 of 2', { timeout: 60000 });
  await tapAt(...roofPt(-300, -300));
  await page.waitForSelector('text=Line up 2 of 2');
  await tapAt(...floorPt(0, 0));
  await page.waitForSelector('text=Line up again');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'bungalow.png'), fullPage: true });

  const box = await page.evaluate(() => window.__roofline.homeBox());
  const [farX, farY] = floorPt(13200, 8100);
  console.log('first view box', JSON.stringify(box, (k, v) => (typeof v === 'number' ? Math.round(v) : v)), 'far corner', Math.round(farX), Math.round(farY));
  if (!(box.x1 >= farX && box.y1 >= farY)) fail('first view does not include the whole building');

  // every wing must actually be drawn on the canvas (wing interiors hold furniture lines)
  for (const [name, a, b] of [['wing A', [500, 500], [6500, 4500]], ['wing B', [8700, 2500], [12700, 5500]], ['store wing', [2000, 6600], [3800, 8100]]]) {
    const [x0, y0] = floorPt(...a);
    const [x1, y1] = floorPt(...b);
    const n = await inkIn([x0, y0, x1, y1]);
    console.log(`  ${name}: ${n} drawn pixels`);
    if (n < 30) fail(`${name} is missing from the overlay (${n} px)`);
  }
  // the key block (far right) is hidden; switching the crop off brings it back
  const keyRect = [940, 100, 1200, 540];
  const keyOn = await inkIn(keyRect);
  await page.locator('#crop').evaluate((el) => el.click());
  await page.waitForTimeout(300);
  await page.evaluate(() => { const v = window.__roofline.viewer(); v.view.s = 0.5; v.view.tx = 20; v.view.ty = 20; v.redraw(); });
  await page.waitForTimeout(200);
  const keyOff = await inkIn([940, 100, 1200, 540]);
  console.log(`  key block: ${keyOn} px with crop on, ${keyOff} px with crop off`);
  if (keyOff <= 0) fail('crop switch off should show the key block');
  await page.screenshot({ path: path.join(OUT, 'bungalow-crop-off.png'), fullPage: true });

  const errs = errors.filter((e) => !/favicon/.test(e));
  if (errs.length) fail('console errors: ' + errs.join('\n'));
  console.log('SPREAD E2E PASSED. Screenshots in', OUT);
} catch (e) {
  await page.screenshot({ path: path.join(OUT, 'zz-failure.png'), fullPage: true }).catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
