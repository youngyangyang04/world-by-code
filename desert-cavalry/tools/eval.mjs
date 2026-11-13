// 用法：node tools/eval.mjs <pagePath> '<js expression returning JSON-able>'
import puppeteer from 'puppeteer-core';
const [path, expr] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1200, height: 675 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${process.env.BASE_URL || "http://127.0.0.1:5173"}${path}`);
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
console.log(JSON.stringify(await page.evaluate(expr)));
await browser.close();
