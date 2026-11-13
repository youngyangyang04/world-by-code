// 用法：node tools/htest.mjs <out.png> "px,py,pz,tx,ty,tz,fov" [query]
import puppeteer from 'puppeteer-core';
const [out, view, query = ''] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], defaultViewport: { width: 1500, height: 700 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (mm) => { if (mm.type() === 'error' || mm.type() === 'warn') console.log('[' + mm.type() + ']', mm.text().slice(0, 1500)); });
await page.goto(`${process.env.BASE_URL || "http://127.0.0.1:5173"}/tools/horse_test.html?${query}`);
try { await page.waitForFunction('window.__ready === true', { timeout: 60000 }); console.log(JSON.stringify(await page.evaluate(() => window.__info)));
  await page.evaluate((v) => window.__view(...v), view.split(',').map(Number)); await page.screenshot({ path: out }); } catch (e) { console.log('ERR', e.message); }
await browser.close();
