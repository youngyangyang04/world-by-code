// 开发用：无头 Chrome 截图。用法：node tools/shot.mjs <outDir> <t1,t2,...> [query]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
const [outDir = '/tmp/shots', times = '2', query = '', optsJson = '{}', tag = ''] = process.argv.slice(2);
const opts = JSON.parse(optsJson);
mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()}`));
await page.goto(`${process.env.BASE_URL || "http://127.0.0.1:5173"}/?debug=1${query ? '&' + query : ''}`, { waitUntil: 'load' });
try {
  await page.waitForFunction('window.__ready === true', { timeout: 60000 });
  for (const t of times.split(',').map(Number)) {
    const info = await page.evaluate((tt, o) => window.__seek(tt, o), t, opts);
    await new Promise((r) => setTimeout(r, 150));
    await page.screenshot({ path: `${outDir}/t${String(t).replace('.', '_')}${tag}.png` });
    console.log('shot', t, JSON.stringify(info ?? null));
  }
} catch (e) { console.log('ERR', e.message); }
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
