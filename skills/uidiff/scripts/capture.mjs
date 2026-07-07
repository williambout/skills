#!/usr/bin/env node
/**
 * UIDiff capture — screenshot a page or element using the installed Chrome.
 *
 * Shoot a page or element:
 *   node scripts/capture.mjs shoot --url http://localhost:3000/settings \
 *     [--selector '[data-testid="save"]'] [--text "Save changes"] \
 *     [--out after.png] [--width 1280] [--height 800] [--full] \
 *     [--wait 400] [--dpr 2] [--dark] [--storage-state auth.json]
 *
 * Stitch two shots into one labeled BEFORE/AFTER image:
 *   node scripts/capture.mjs stitch --before b.png --after a.png --out combined.png
 *
 * Prints a JSON result line on success; exits non-zero with a message on failure.
 * When both --selector and --text are given, the selector is tried first and
 * text is the fallback.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    selector: { type: 'string' },
    text: { type: 'string' },
    out: { type: 'string', default: 'shot.png' },
    width: { type: 'string', default: '1280' },
    height: { type: 'string', default: '800' },
    full: { type: 'boolean', default: false },
    wait: { type: 'string', default: '400' },
    dpr: { type: 'string', default: '2' },
    dark: { type: 'boolean', default: false },
    'storage-state': { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
  },
});

const mode = positionals[0] || 'shoot';

async function launch() {
  let lastErr;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launch(channel ? { channel } : {});
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `No Chrome/Chromium found (${lastErr?.message?.split('\n')[0]}). ` +
      'Install Google Chrome, or run: npx playwright install chromium'
  );
}

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function shoot() {
  if (!opts.url) throw new Error('shoot requires --url');

  const browser = await launch();
  try {
    const context = await browser.newContext({
      viewport: { width: Number(opts.width), height: Number(opts.height) },
      deviceScaleFactor: Number(opts.dpr),
      reducedMotion: 'reduce',
      colorScheme: opts.dark ? 'dark' : 'light',
      ...(opts['storage-state'] ? { storageState: opts['storage-state'] } : {}),
    });
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: 'load', timeout: 45000 });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(Number(opts.wait));

    let matched = null;
    if (opts.selector || opts.text) {
      const candidates = [];
      if (opts.selector) {
        candidates.push({ loc: page.locator(opts.selector).first(), by: opts.selector });
      }
      if (opts.text) {
        candidates.push({
          loc: page.getByText(opts.text, { exact: false }).first(),
          by: `text=${opts.text}`,
        });
      }

      let found = null;
      for (const c of candidates) {
        try {
          await c.loc.waitFor({ state: 'visible', timeout: 6000 });
          found = c;
          break;
        } catch {
          // try the next candidate
        }
      }
      if (!found) {
        throw new Error(
          'Element not found on ' + opts.url + ' — tried: ' + candidates.map((c) => c.by).join('  |  ')
        );
      }
      matched = found.by;
      await found.loc.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await found.loc.screenshot({ path: opts.out });
    } else {
      await page.screenshot({ path: opts.out, fullPage: opts.full });
    }

    const { width, height } = pngSize(await readFile(opts.out));
    console.log(JSON.stringify({ ok: true, out: opts.out, width, height, url: page.url(), matched }));
  } finally {
    await browser.close();
  }
}

async function stitch() {
  if (!opts.before || !opts.after) throw new Error('stitch requires --before and --after');

  const [b, a] = await Promise.all([readFile(opts.before), readFile(opts.after)]);
  const src = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

  // The composite page renders at 2x so labels are crisp; the source PNGs are
  // already device pixels, so they're shown at half CSS size (zoom: .5) to map
  // 1:1 into the 2x output with no resampling.
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #141210; }
    #wrap { display: inline-flex; gap: 24px; padding: 20px; align-items: flex-start; }
    figure { margin: 0; }
    figcaption { font: 600 16px ui-monospace, Menlo, monospace; letter-spacing: .12em; margin-bottom: 10px; }
    .b figcaption { color: #9a9083; }
    .a figcaption { color: #f2a33c; }
    img { display: block; zoom: 0.5; max-width: 2800px; height: auto; border-radius: 12px; }
  </style><div id="wrap">
    <figure class="b"><figcaption>BEFORE</figcaption><img src="${src(b)}"></figure>
    <figure class="a"><figcaption>AFTER</figcaption><img src="${src(a)}"></figure>
  </div>`;

  const browser = await launch();
  try {
    const context = await browser.newContext({ deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.setContent(html);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.locator('#wrap').screenshot({ path: opts.out });
    const { width, height } = pngSize(await readFile(opts.out));
    console.log(JSON.stringify({ ok: true, out: opts.out, width, height }));
  } finally {
    await browser.close();
  }
}

try {
  if (mode === 'shoot') await shoot();
  else if (mode === 'stitch') await stitch();
  else throw new Error(`Unknown mode "${mode}" — use shoot or stitch.`);
} catch (err) {
  console.error(`uidiff: ${err.message || err}`);
  process.exit(1);
}
