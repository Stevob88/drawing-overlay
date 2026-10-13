// Browser test: download, print and clear, on a computer and on an iPhone-sized touch screen.
// Run: npm run e2e:export  (screenshots and the downloaded picture: tests/e2e/out-export/)
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const FIX = path.join(ROOT, 'tests/fixtures/synthetic');
const OUT = path.join(ROOT, 'tests/e2e/out-export');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8127;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const fail = (m) => { throw new Error('EXPORT E2E FAIL: ' + m); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());

async function run(label, ctxOpts) {
  console.log('•', label);
  const ctx = await browser.newContext({ ...ctxOpts, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://localhost:${PORT}/`);
  const choose = async (n, f) => { const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Choose PDF|Change/ }).nth(n).click()]); await fc.setFiles(f); };
  await choose(0, path.join(FIX, 'ellerton_roof.pdf'));
  await page.waitForSelector('text=Now choose the floor plan PDF', { timeout: 60000 });
  await choose(1, path.join(FIX, 'ellerton_first_floor.pdf'));
  await page.waitForSelector('text=Line up 1 of 2', { timeout: 60000 });
  // line up by setting the same corner on each (the line-up itself is covered by e2e)
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.evaluate(() => { const s = window.__roofline.saved(); s.align = { roofRef: { x: 142.992, y: 224.882 }, floorRef: { x: 120, y: 201.89 } }; });
  await page.getByRole('button', { name: 'Fit' }).click(); // re-render with the line-up
  await page.evaluate(() => window.__roofline.render());
  await page.waitForSelector('text=Print');
  await page.screenshot({ path: path.join(OUT, `${label}-screen.png`), fullPage: true });

  // show only the roof / only the floor: count red and blue ink on the canvas
  const ink = () => page.evaluate(() => {
    const c = window.__roofline.viewer().canvas; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i] - d[i + 1] > 50 && d[i] - d[i + 2] > 50 && Math.abs(d[i + 1] - d[i + 2]) < 40) red++; else if (d[i + 2] - d[i] > 60) blue++; }
    return { red, blue };
  });
  for (const [btn, wantRed, wantBlue] of [['Roof plan', true, false], ['Roof plan', true, true], ['Floor plan', false, true], ['Roof plan', true, false], ['Roof plan', true, true]]) {
    await page.locator('.showswitch button', { hasText: btn }).click();
    await page.waitForTimeout(200);
    const n = await ink();
    console.log(`  show ${btn}: red ${n.red}, blue ${n.blue}`);
    if ((n.red > 500) !== wantRed || (n.blue > 500) !== wantBlue) fail(`show ${btn} wrong`);
    await page.locator('.canvaswrap').screenshot({ path: path.join(OUT, `${label}-show-${btn.replace(' ', '')}-${n.red > 500 ? 'R' : ''}${n.blue > 500 ? 'F' : ''}.png`) });
  }

  // download (computer) / share sheet (iPhone)
  if (ctxOpts.hasTouch) {
    await page.evaluate(() => { for (const [k, v] of Object.entries({ canShare: () => true, share: async (d) => { window.__shared = d.files.map((f) => [f.name, f.type, f.size]); } })) Object.defineProperty(Navigator.prototype, k, { value: v, configurable: true }); });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => window.__shared, null, { timeout: 8000 }).catch(async () => fail('share: ' + await page.locator('#toast').innerText()));
    const shared = await page.evaluate(() => window.__shared);
    console.log('  shared', JSON.stringify(shared));
    if (shared[0][1] !== 'image/png' || shared[0][2] < 20000) fail('nothing sensible shared');
  } else {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
    const file = path.join(OUT, `${label}-download.png`);
    await dl.saveAs(file);
    const png = fs.readFileSync(file);
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    console.log('  downloaded', dl.suggestedFilename(), w, 'x', h);
    if (w < 3000 || h < 2000) fail('picture too small');
  }

  // print: the page shows only the picture when printed
  await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await page.getByRole('button', { name: 'Print' }).click();
  await page.waitForFunction(() => window.__printed);
  await page.emulateMedia({ media: 'print' });
  const pr = await page.evaluate(() => ({ img: document.querySelector('#printout img')?.naturalWidth, app: getComputedStyle(document.getElementById('app')).display }));
  await page.screenshot({ path: path.join(OUT, `${label}-print.png`) });
  await page.emulateMedia({ media: 'screen' });
  console.log('  print picture', pr.img, 'app hidden:', pr.app === 'none');
  if (!(pr.img > 2000) || pr.app !== 'none') fail('print view wrong');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));

  // clear
  await page.getByRole('button', { name: 'Clear' }).click();
  await page.waitForSelector('text=Choose the roof plan PDF.');
  const left = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('roofline'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').count(); q.onsuccess = () => res(q.result); }; }));
  await page.reload();
  await page.waitForSelector('text=Choose the roof plan PDF.');
  console.log('  cleared, files left on device:', left);
  if (left !== 0) fail('files still stored');
  await page.screenshot({ path: path.join(OUT, `${label}-cleared.png`), fullPage: true });
  if (errors.length) fail('page errors: ' + errors.join('\n'));
  await ctx.close();
}

try {
  await run('computer', { viewport: { width: 1366, height: 768 } });
  await run('iphone', { ...devices['iPhone 13'], defaultBrowserType: undefined });
  console.log('EXPORT E2E PASSED. Screenshots in', OUT);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
