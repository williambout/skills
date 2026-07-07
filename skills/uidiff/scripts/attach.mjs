#!/usr/bin/env node
/**
 * UIDiff attach — upload images as native GitHub attachments, the only kind
 * that renders in PRIVATE-repo PR bodies. GitHub has no public API for this,
 * so it drives GitHub's own uploader with a logged-in browser session.
 *
 * One-time setup (opens a Chrome window on a dedicated profile; log in, close):
 *   node scripts/attach.mjs login
 *
 * Check whether the profile has a GitHub session (fast, headless):
 *   node scripts/attach.mjs status
 *   → JSON {ok, loggedIn, user, profile}
 *
 * Upload (fully automatic once logged in):
 *   node scripts/attach.mjs upload --pr https://github.com/o/r/pull/123 a.png b.png
 *   → JSON {ok, urls: {"a.png": "https://github.com/user-attachments/assets/…", …}}
 *
 * The returned URLs work exactly like drag-dropped images: repo-scoped,
 * permission-checked, and rendered in PR bodies for private repos. Nothing is
 * posted to the PR — files go through the comment composer's uploader only.
 */
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const PROFILE = join(homedir(), '.uidiff', 'github-profile');

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pr: { type: 'string' },
    headed: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '90000' },
  },
});

const mode = positionals[0];
const files = positionals.slice(1);

async function launchProfile(headless) {
  await mkdir(PROFILE, { recursive: true });
  let lastErr;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launchPersistentContext(PROFILE, {
        ...(channel ? { channel } : {}),
        headless,
        viewport: headless ? { width: 1400, height: 1000 } : null,
      });
    } catch (err) {
      const missing = /not found|No such file|install/i.test(String(err && err.message));
      if (!missing) throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `No Chrome/Chromium found (${String(lastErr?.message).split('\n')[0]}). ` +
      'Install Google Chrome, or run: npx playwright install chromium'
  );
}

async function login() {
  const context = await launchProfile(false);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://github.com/login').catch(() => {});
  console.error('Log in to GitHub in the Chrome window, then close it to save the session.');
  await new Promise((resolve) => context.on('close', resolve));
  console.log(JSON.stringify({ ok: true, profile: PROFILE }));
}

// Feed the file to each file input on the page until one triggers GitHub's
// upload-policy request. Selector-free on purpose: it survives both the
// classic and the new React PR UI.
async function feedAnyInput(page, file, hrefs, countBefore) {
  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    try {
      await inputs.nth(i).setInputFiles(file, { timeout: 3000 });
    } catch {
      continue;
    }
    for (let tick = 0; tick < 25; tick++) {
      if (hrefs.length > countBefore) return true;
      await page.waitForTimeout(200);
    }
  }
  return false;
}

async function status() {
  const context = await launchProfile(true);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://github.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const user = await page
      .locator('meta[name="user-login"]')
      .first()
      .getAttribute('content')
      .catch(() => null);
    console.log(JSON.stringify({ ok: true, loggedIn: Boolean(user), user: user || null, profile: PROFILE }));
  } finally {
    await context.close();
  }
}

async function upload() {
  if (!opts.pr) throw new Error('upload requires --pr <pull request URL>');
  if (files.length === 0) throw new Error('upload requires at least one image file');
  for (const file of files) {
    await access(file).catch(() => {
      throw new Error(`File not found: ${file}`);
    });
  }

  const context = await launchProfile(!opts.headed);
  try {
    const page = context.pages()[0] ?? (await context.newPage());

    // The asset URL comes from GitHub's upload-policy response — no markup
    // scraping needed, so this is robust to PR-page redesigns.
    const hrefs = [];
    page.on('response', async (res) => {
      if (!res.url().includes('/upload/policies/assets')) return;
      try {
        const body = await res.json();
        if (body?.asset?.href) hrefs.push(body.asset.href);
      } catch {
        // not JSON — ignore
      }
    });

    await page.goto(opts.pr, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500); // let the composer mount

    // GitHub embeds the viewer's login in a meta tag; absent/empty = logged out.
    const user = await page
      .locator('meta[name="user-login"]')
      .first()
      .getAttribute('content')
      .catch(() => null);
    if (!user) {
      throw new Error(
        'Not logged in to GitHub in the UIDiff browser profile. Run once: node scripts/attach.mjs login'
      );
    }

    // Focus a comment box so lazy editors mount their file input.
    for (const sel of ['textarea[name="comment[body]"]', '#new_comment_field', 'textarea']) {
      const box = page.locator(sel).last();
      if ((await box.count()) > 0) {
        await box.click({ timeout: 2000 }).catch(() => {});
        break;
      }
    }

    const deadline = Date.now() + Number(opts.timeout);
    const urls = {};

    for (const file of files) {
      const countBefore = hrefs.length;
      const fed = await feedAnyInput(page, file, hrefs, countBefore);
      if (!fed) {
        throw new Error(
          'No attachment input accepted the file — you may lack access to this PR, or the GitHub UI changed. Re-run with --headed to inspect.'
        );
      }

      while (hrefs.length <= countBefore) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for GitHub upload policy.');
        await page.waitForTimeout(200);
      }
      const href = hrefs[hrefs.length - 1];

      // The policy is issued before the bytes land in storage — poll the asset
      // URL (with session cookies) until it resolves.
      let live = false;
      while (!live && Date.now() < deadline) {
        const res = await page.request.get(href, { maxRedirects: 0 }).catch(() => null);
        const status = res ? res.status() : 0;
        live = status >= 200 && status < 400;
        if (!live) await page.waitForTimeout(700);
      }
      if (!live) throw new Error(`Uploaded asset never became available: ${href}`);
      urls[basename(file)] = href;
    }

    // Best-effort: clear any draft markdown the uploader inserted so no
    // half-written comment lingers in the composer.
    for (const box of await page.locator('textarea').all()) {
      const value = await box.inputValue().catch(() => '');
      if (value.includes('user-attachments') || value.includes('Uploading')) {
        await box.fill('').catch(() => {});
      }
    }

    console.log(JSON.stringify({ ok: true, pr: opts.pr, urls }));
  } finally {
    await context.close();
  }
}

try {
  if (mode === 'login') await login();
  else if (mode === 'status') await status();
  else if (mode === 'upload') await upload();
  else throw new Error(`Unknown mode "${mode}" — use login, status, or upload.`);
} catch (err) {
  console.error(`uidiff: ${err.message || err}`);
  process.exit(1);
}
