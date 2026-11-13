// 实时帧率测量 + 点击“开始”后的音频/交互冒烟测试
import puppeteer from 'puppeteer-core';
const [w = '1920', h = '1080', query = ''] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  defaultViewport: { width: +w, height: +h } });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto((process.env.BASE_URL || 'http://127.0.0.1:5173') + '/?' + query, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 90000 });
await page.click('#btn-start');
await new Promise((r) => setTimeout(r, 2500));
const res = await page.evaluate(() => new Promise((resolve) => {
  let n = 0; const t0 = performance.now(); const dts = []; let last = t0;
  const tick = (t) => { n++; dts.push(t - last); last = t; if (t - t0 < 5000) requestAnimationFrame(tick); else { dts.sort((a, b) => a - b); resolve({ fps: n / ((t - t0) / 1000), p50: dts[dts.length >> 1], p95: dts[Math.floor(dts.length * 0.95)], canvas: [document.getElementById('view').width, document.getElementById('view').height], clock: document.getElementById('clock').textContent }); } };
  requestAnimationFrame(tick);
}));
console.log(JSON.stringify(res));
await page.screenshot({ path: '/tmp/shots/live.png' });
console.log(logs.filter((l) => !l.includes('vite')).slice(0, 20).join('\n'));
await browser.close();
