// 用法：node tools/view.mjs <modelUrlPath> <out.png> [clip] [frames=4] [az=90] [el=10]
import puppeteer from 'puppeteer-core';
const [m, out, clip = '0', frames = '4', az = '90', el = '10', hide = '', dist = '1.2'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 800, height: 520 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (mm) => { if (mm.type() === 'error') console.log('[err]', mm.text()); });
await page.goto(`${process.env.BASE_URL || "http://127.0.0.1:5173"}/tools/viewer.html?m=${encodeURIComponent(m)}&hide=${hide}`);
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
const info = await page.evaluate(() => window.__info);
console.log(JSON.stringify({ clips: info.clips, meshes: info.meshes, nb: info.bones.length, bones: info.bones.slice(0, 80) }));
const n = +frames, c = isNaN(+clip) ? clip : +clip;
for (let i = 0; i < n; i++) {
  const r = await page.evaluate((cc, t, a, e, d) => window.__show(cc, t, a, e, d), c, i / n, +az, +el, +dist);
  if (i === 0) console.log(JSON.stringify(r), 'morphs', await page.evaluate(() => window.__morph));
  await page.screenshot({ path: out.replace('.png', `_${i}.png`) });
}
await browser.close();
