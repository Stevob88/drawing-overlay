// Browser test: the roof plan is drawn at 1:100 and the floor plan at 1:50. The app must notice,
// resize the roof to match, and say so. Run: npm run e2e:scales  (screenshots: tests/e2e/out-scales/)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const FIX = path.join(ROOT, 'tests/fixtures/synthetic');
const OUT = path.join(ROOT, 'tests/e2e/out-scales');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8125;
const BASE = `http://localhost:${PORT}/`;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const fail = (m) => { throw new Error('E2E FAIL: ' + m); };

const MM = 72 / 25.4; // points per mm at 1:1
const W = 10436, D = 6200, OVH = 300;
// building corners in page points (viewport, y down). Roof outline starts 300 mm outside the walls.
const floorPt = (xmm, ymm) => [120 + xmm * MM / 50, 841.89 - (640 - ymm * MM / 50)];
const roofPt = (xmm, ymm) => [160 + xmm * MM / 100, 841.89 - (600 - ymm * MM / 100)];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
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

try {
  for (const [roofFile, how] of [
    ['ellerton_roof_1to100.pdf', 'scale stated in the title block'],
    ['ellerton_roof_1to100_unstated.pdf', 'no scale stated (measured from a dimension)'],
    ['ellerton_roof_1to100_wrongpaper.pdf', 'issued 1:50 @A1 but saved on an A3 page'],
  ]) {
    console.log('•', roofFile, '-', how);
    await ctx.clearCookies();
    await page.goto(BASE);
    await page.evaluate(() => indexedDB.deleteDatabase('roofline'));
    await page.reload();
    await page.waitForSelector('text=Choose the roof plan PDF.');
    await choose(0, path.join(FIX, roofFile));
    await page.waitForSelector('text=Now choose the floor plan PDF', { timeout: 60000 });
    await choose(1, path.join(FIX, 'ellerton_first_floor.pdf'));
    await page.waitForSelector('text=Line up 1 of 2', { timeout: 60000 });
    await page.waitForSelector('text=Roof is 1:100, floor is 1:50. The roof is enlarged ×2 to match.');

    // line up: roof outline corner (-300,-300 mm) on floor wall corner (0,0)
    await tapAt(...roofPt(-OVH, -OVH));
    await page.waitForSelector('text=Line up 2 of 2');
    await tapAt(...floorPt(0, 0));
    await page.waitForSelector('text=Line up again');
    await page.waitForTimeout(300);

    // the roof's opposite corner (W+300, D+300) must land (W+600, D+600) mm from the floor corner
    const res = await page.evaluate(([rx, ry]) => {
      const al = window.__roofline.saved().align;
      const p = window.__roofline.roofToFloor(rx, ry);
      return { ratio: window.__roofline.roofRatio(), dx: p.x - al.floorRef.x, dy: p.y - al.floorRef.y };
    }, roofPt(W + OVH, D + OVH));
    const wantX = (W + 2 * OVH) * MM / 50;
    const wantY = (D + 2 * OVH) * MM / 50;
    const errMm = Math.hypot(res.dx - wantX, res.dy - wantY) * 50 / MM;
    console.log(`  ratio ${res.ratio}, far corner off by ${errMm.toFixed(2)} mm (at 1:50)`);
    if (res.ratio !== 2) fail('ratio should be 2, got ' + res.ratio);
    if (errMm > 1) fail(`roof not resized correctly (${errMm.toFixed(2)} mm out)`);
    await page.screenshot({ path: path.join(OUT, roofFile.replace('.pdf', '') + '.png'), fullPage: true });
  }

  console.log('• manual override');
  if (!(await page.locator('#scale-roof').isVisible())) await page.getByText('Drawing scales').click();
  await page.locator('#scale-roof').selectOption('50');
  await page.waitForSelector('text=Both drawings are 1:50. No resizing needed.');
  if ((await page.evaluate(() => window.__roofline.roofRatio())) !== 1) fail('override not applied');
  await page.locator('#scale-roof').selectOption('');
  await page.waitForSelector('text=The roof is enlarged ×2 to match.');

  const errs = errors.filter((e) => !/favicon/.test(e));
  if (errs.length) fail('console errors: ' + errs.join('\n'));
  console.log('SCALES E2E PASSED. Screenshots in', OUT);
} catch (e) {
  await page.screenshot({ path: path.join(OUT, 'zz-failure.png'), fullPage: true }).catch(() => {});
  console.error(e.message);
  console.error('errors:', errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
