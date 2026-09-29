// Frame renderer: serves this folder, drives headless Chromium, writes PNG frames.
//   node render.cjs stills 0.2 1.1 3.4 ...   -> out/still_<t>.png (single sample, quick look)
//   node render.cjs frames [workers] [sub]   -> out/frames/f_00000.png ... (motion-blurred)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const OUT = process.env.OUT_DIR || path.join(ROOT, 'out');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.ttf': 'font/ttf', '.wav': 'audio/wav' };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(p, (err, buf) => {
        if (err) { rsp.writeHead(404); rsp.end(); return; }
        rsp.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        rsp.end(buf);
      });
    }).listen(0, () => res(srv));
  });
}

async function openPage(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.evaluate(() => window.motionReady);
  await page.addStyleTag({ content: 'canvas{width:1920px!important;height:1080px!important;margin:0!important}' });
  const cdp = await page.context().newCDPSession(page);
  return { page, cdp };
}

async function shot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

(async () => {
  const mode = process.argv[2] || 'stills';
  const srv = await serve();
  const port = srv.address().port;
  const browser = await chromium.launch({ args: ['--disable-gpu-vsync', '--force-color-profile=srgb'] });
  fs.mkdirSync(OUT, { recursive: true });
  if (mode === 'stills') {
    const { page, cdp } = await openPage(browser, port);
    for (const t of process.argv.slice(3).map(Number)) {
      await page.evaluate(tt => { const M = window.MOTION; M.renderFrame(Math.round(tt * M.FPS), 1); }, t);
      await shot(cdp, path.join(OUT, `still_${t.toFixed(2)}.png`));
    }
  } else {
    const workers = +(process.argv[3] || 3), sub = +(process.argv[4] || 4);
    const dir = path.join(OUT, 'frames'); fs.mkdirSync(dir, { recursive: true });
    const total = 900;
    const only = process.env.RANGE ? process.env.RANGE.split('-').map(Number) : [0, total - 1];
    let next = only[0], done = 0; const t0 = Date.now();
    await Promise.all(Array.from({ length: workers }, async () => {
      const { page, cdp } = await openPage(browser, port);
      while (next <= only[1]) {
        const f = next++;
        await page.evaluate(([ff, s]) => window.MOTION.renderFrame(ff, s), [f, sub]);
        await shot(cdp, path.join(dir, `f_${String(f).padStart(5, '0')}.png`));
        if (++done % 30 === 0) console.log(`${done} frames  ${((Date.now() - t0) / done).toFixed(0)} ms/frame`);
      }
    }));
  }
  await browser.close();
  srv.close();
})();
