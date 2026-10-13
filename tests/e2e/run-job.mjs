// Browser test: set up a job on a computer, "Send to phone", open the file on an iPhone
// (separate browser storage) and check it arrives lined up, flipped and the same.
// Run: npm run e2e:job  (screenshots: tests/e2e/out-export/)
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const FIX = path.join(ROOT, 'tests/fixtures/synthetic');
const OUT = path.join(ROOT, 'tests/e2e/out-export');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8128;
const BASE = `http://localhost:${PORT}/`;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const fail = (m) => { throw new Error('JOB E2E FAIL: ' + m); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
const errors = [];
const watch = (page) => { page.on('pageerror', (e) => errors.push(String(e))); page.on('dialog', (d) => d.accept()); };

try {
  console.log('• computer: set up and send');
  const pc = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
  const page = await pc.newPage();
  watch(page);
  await page.goto(BASE);
  const choose = async (n, f) => { const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /Choose PDF|Change/ }).nth(n).click()]); await fc.setFiles(f); };
  await choose(0, path.join(FIX, 'ellerton_roof_1to100.pdf'));
  await page.waitForSelector('text=Now choose the floor plan PDF', { timeout: 60000 });
  await choose(1, path.join(FIX, 'ellerton_first_floor.pdf'));
  await page.waitForSelector('text=Line up 1 of 2', { timeout: 60000 });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.evaluate(() => { const s = window.__roofline.saved(); s.align = { roofRef: { x: 155.7, y: 233.4 }, floorRef: { x: 120, y: 201.89 } }; s.nudge = { x: 3, y: -2 }; s.flip = true; s.scaleOverride = { roof: 100, floor: null }; window.__roofline.render(); });
  await page.waitForSelector('text=Send to phone');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Send to phone' }).click()]);
  const job = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(job);
  console.log('  sent', dl.suggestedFilename(), Math.round(fs.statSync(job).size / 1024), 'KB');
  const want = await page.evaluate(() => { const s = window.__roofline.saved(); return JSON.stringify([s.align, s.nudge, s.flip, s.scaleOverride, s.roof.name, s.floor.name]); });

  console.log('• iPhone: open the job file');
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const p2 = await phone.newPage();
  watch(p2);
  await p2.goto(BASE);
  await p2.waitForSelector('text=Choose the roof plan PDF.');
  // a PDF picked by mistake is refused with a clear message
  let [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.getByRole('button', { name: 'Open a job sent from your computer' }).click()]);
  await fc.setFiles(path.join(FIX, 'ellerton_first_floor.pdf'));
  await p2.waitForSelector('text=Use Choose PDF for drawings');
  [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.getByRole('button', { name: 'Open a job sent from your computer' }).click()]);
  await fc.setFiles(job);
  await p2.waitForSelector('text=Job opened, lined up and ready.', { timeout: 60000 });
  await p2.waitForSelector('text=FLIPPED');
  const got = await p2.evaluate(() => { const s = window.__roofline.saved(); return JSON.stringify([s.align, s.nudge, s.flip, s.scaleOverride, s.roof.name, s.floor.name]); });
  if (got !== want) fail(`job differs\n  sent ${want}\n  got  ${got}`);
  await p2.reload();
  await p2.waitForSelector('text=Line up again', { timeout: 60000 });
  await p2.screenshot({ path: path.join(OUT, 'job-on-phone.png'), fullPage: true });
  if (errors.length) fail('page errors: ' + errors.join('\n'));
  console.log('JOB E2E PASSED');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
