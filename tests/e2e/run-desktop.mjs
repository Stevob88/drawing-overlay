// Browser test at laptop size: the drawing canvas must fill its box once the side column is
// tall (it used to stop at a fixed height, cutting off the bottom). Run: npm run e2e:desktop
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT='/home/user/drawing-overlay', FIX=ROOT+'/tests/fixtures/synthetic/';
const server = spawn('python3', ['-m','http.server','8131','--bind','127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise(r=>setTimeout(r,800));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await b.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
await page.goto('http://localhost:8131/');
const choose = async (n,f)=>{ const [fc]=await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button',{name:/Choose PDF|Change/}).nth(n).click()]); await fc.setFiles(f); };
await choose(0, FIX+'ellerton_roof_1to100.pdf');
await page.waitForSelector('text=Now choose the floor plan PDF',{timeout:60000});
await choose(1, FIX+'ellerton_first_floor.pdf');
await page.waitForSelector('text=Line up 1 of 2',{timeout:60000});
await page.waitForTimeout(500);

const MM=72/25.4;
const floorPt=(x,y)=>[120+x*MM/50, 841.89-(640-y*MM/50)];
const roofPt=(x,y)=>[160+x*MM/100, 841.89-(600-y*MM/100)];
async function tapAt(x,y,zoom=8){const pos=await page.evaluate(([x,y,zoom])=>{const v=window.__roofline.viewer();v.view.s=zoom;v.view.tx=v.w/2-x*zoom;v.view.ty=v.h/2-y*zoom;v.redraw();const r=v.canvas.getBoundingClientRect();return{x:r.left+x*zoom+v.view.tx,y:r.top+y*zoom+v.view.ty};},[x,y,zoom]);
await page.mouse.move(pos.x,pos.y);await page.mouse.down();await page.mouse.move(pos.x+0.3,pos.y);await page.mouse.move(pos.x,pos.y);await page.mouse.up();await page.waitForTimeout(150);}
await tapAt(...roofPt(-300,-300)); await page.waitForSelector('text=Line up 2 of 2'); await tapAt(...floorPt(0,0));
await page.waitForSelector('text=Line up again'); await page.waitForTimeout(300);
if (await page.getByText('Drawing scales').count()) await page.getByText('Drawing scales').click();
await page.waitForTimeout(500);
const sz = await page.evaluate(()=>({wrap:document.querySelector('.canvaswrap').getBoundingClientRect().height, canvas:document.querySelector('.canvaswrap canvas').getBoundingClientRect().height}));
console.log('box', sz.wrap, 'canvas', sz.canvas);
if (sz.canvas < sz.wrap - 4) { console.error('DESKTOP E2E FAIL: canvas shorter than its box'); process.exitCode = 1; } else console.log('DESKTOP E2E PASSED');

// full screen: the drawing fills the window, the buttons come with it, Esc returns
for (const vp of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  await page.setViewportSize(vp);
  await page.getByRole('button', { name: 'Full screen' }).click();
  await page.waitForTimeout(400);
  const f = await page.evaluate(() => ({ c: document.querySelector('.canvaswrap canvas').getBoundingClientRect().toJSON(), fit: !!document.querySelector('.fullbar button') }));
  console.log('full screen', vp.width, 'canvas', Math.round(f.c.width), 'x', Math.round(f.c.height));
  if (f.c.width < vp.width - 2 || f.c.height < vp.height - 160 || !f.fit) { console.error('DESKTOP E2E FAIL: full screen does not fill the window'); process.exitCode = 1; }
  const ver = await page.locator('.foot .version').innerText();
console.log('footer:', ver);
if (!/^Version \d+ · \d+ \w+ \d{4}$/.test(ver)) { console.error('DESKTOP E2E FAIL: no version in footer'); process.exitCode = 1; }
await page.locator('.foot .version').click();
await page.waitForSelector('text=/latest version|Version \\d+\\./');
if (process.argv[2]) await page.screenshot({ path: process.argv[2].replace('.png', `-full${vp.width}.png`) });
  if (vp.width > 500) await page.keyboard.press('Escape'); else await page.getByRole('button', { name: 'Exit full screen' }).click();
  await page.waitForTimeout(300);
  if (await page.locator('.canvaswrap.full').count()) { console.error('DESKTOP E2E FAIL: full screen did not close'); process.exitCode = 1; }
}
await page.setViewportSize({ width: 1366, height: 768 });
if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
await b.close(); server.kill();
