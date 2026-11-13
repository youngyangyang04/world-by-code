// 录制功能冒烟测试：点击“录制 WebM”，等一整遍演出结束，检查下载到的文件
import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
const dir = '/tmp/rec_out'; mkdirSync(dir, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
await page.goto((process.env.BASE_URL || 'http://127.0.0.1:5173') + '/', { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 90000 });
console.log('default format:', await page.$eval('#sel-format', (e) => e.value), '| mp4 option disabled:', await page.$eval('#sel-format [value=mp4]', (e) => e.disabled));
if (process.argv[2]) await page.select('#sel-format', process.argv[2]);
await page.click('#btn-rec');
await new Promise((r) => setTimeout(r, 3000));
console.log('rec label:', await page.$eval('#btn-rec', (e) => e.textContent), '| clock:', await page.$eval('#clock', (e) => e.textContent));
await page.keyboard.press('Space'); await new Promise((r) => setTimeout(r, 600));
console.log('paused label:', await page.$eval('#btn-pause', (e) => e.textContent), '| clock:', await page.$eval('#clock', (e) => e.textContent));
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 21000));
console.log('after loop — rec label:', await page.$eval('#btn-rec', (e) => e.textContent), '| clock:', await page.$eval('#clock', (e) => e.textContent));
await new Promise((r) => setTimeout(r, 1500));
for (const f of readdirSync(dir)) console.log('file', f, statSync(`${dir}/${f}`).size);
console.log(logs.filter((l) => !l.includes('vite')).slice(0, 12).join('\n'));
await browser.close();
