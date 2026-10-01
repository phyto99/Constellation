/**
 * Regenerates game/gallery-screenshots/ — the static preview images
 * gallery.html shows by default instead of auto-loading ~65 live iframes.
 *
 * Run whenever gallery.html's GROUPS array changes (new item, renamed
 * item, or a previously-missing build like geobridge/c4d finally exists).
 * Requires the game server running on :2567 (`node server.js`).
 *
 * Usage (playwright isn't a project dependency — fetched on demand):
 *   npx -p playwright node shoot-gallery.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const GALLERY_PATH = path.join(__dirname, 'gallery.html');
const OUT_DIR = path.join(__dirname, 'gallery-screenshots');
const BASE = process.env.GALLERY_BASE || 'http://localhost:2567';

// Pull GROUPS straight out of gallery.html — single source of truth,
// no hand-maintained duplicate list to drift out of sync.
const src = fs.readFileSync(GALLERY_PATH, 'utf8');
const m = src.match(/const GROUPS = (\[[\s\S]*?\n\]);/);
if (!m) { console.error('Could not find GROUPS array in gallery.html'); process.exit(1); }
const GROUPS = new Function('return ' + m[1])();

const items = [];
GROUPS.forEach(g => g.items.forEach(it => items.push(it)));
console.log(`${items.length} items to shoot against ${BASE}`);

function slug(item) {
  return item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

fs.mkdirSync(OUT_DIR, { recursive: true });

async function shootOne(browser, item) {
  const slugName = slug(item);
  const outPath = path.join(OUT_DIR, slugName + '.jpg');
  const context = await browser.newContext({ viewport: { width: 1120, height: 800 } });
  const page = await context.newPage();
  let status = 'ok';
  try {
    const resp = await page.goto(BASE + item.url, { waitUntil: 'load', timeout: 7000 }).catch(() => null);
    if (resp && !resp.ok() && resp.status() !== 304) status = 'http-' + resp.status();
    await page.waitForTimeout(700); // let client JS paint (mock data, canvas init, etc.)
    await page.screenshot({ path: outPath, type: 'jpeg', quality: 68 });
  } catch (e) {
    status = 'error: ' + e.message.split('\n')[0];
  }
  await context.close();
  return { name: item.name, url: item.url, slug: slugName, status };
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  const CONCURRENCY = 5;
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const item = items[idx++];
      const r = await shootOne(browser, item);
      results.push(r);
      console.log(`[${results.length}/${items.length}] ${r.status.padEnd(10)} ${r.name}  (${r.url})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, '_manifest.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status !== 'ok');
  console.log(`\nDone. ${results.length - failed.length}/${results.length} ok.`);
  if (failed.length) {
    console.log('Failed:');
    failed.forEach(f => console.log(`  ${f.status}  ${f.name}  ${f.url}`));
  }
})();
