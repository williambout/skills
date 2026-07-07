#!/usr/bin/env node
/**
 * UIDiff publish — upload screenshots to an asset branch of a GitHub repo and
 * print raw.githubusercontent.com URLs that render directly in PR bodies.
 *
 *   node scripts/publish.mjs [--repo owner/name] [--branch uidiff-assets] \
 *     [--prefix save-button] shot1.png [shot2.png ...]
 *
 * Uses the Git Data API through an authenticated `gh` CLI, so nothing touches
 * the local working tree or the PR branch. The asset branch is created as an
 * orphan on first use; every publish appends one commit and URLs are pinned
 * to that commit SHA. Prints JSON: {ok, repo, branch, commit, private, urls}.
 *
 * Note: raw URLs render in PR bodies only for PUBLIC repos (GitHub's image
 * proxy can't fetch private files) — `private: true` in the output means the
 * caller should fall back to manual drag-drop attachments.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    branch: { type: 'string', default: 'uidiff-assets' },
    prefix: { type: 'string' },
  },
});

function gh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) =>
      reject(e.code === 'ENOENT' ? new Error('`gh` CLI not found — install it and run `gh auth login`.') : e)
    );
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(err || out).trim()}`));
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

async function api(path, method, body) {
  const args = ['api', ...(method ? ['-X', method] : []), path, ...(body ? ['--input', '-'] : [])];
  return JSON.parse(await gh(args, body ? JSON.stringify(body) : undefined));
}

if (files.length === 0) {
  console.error('uidiff: publish requires at least one image file');
  process.exit(1);
}

try {
  const repo =
    opts.repo ||
    (await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])).trim();
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error(`Could not resolve a repo (got "${repo}") — pass --repo owner/name.`);

  const { isPrivate } = await api(`repos/${repo}`, undefined).then((r) => ({ isPrivate: r.private }));

  // Upload each image as a blob.
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = `${stamp}-${opts.prefix || 'shots'}-${Date.now().toString(36)}`;
  const entries = [];
  for (const file of files) {
    const content = (await readFile(file)).toString('base64');
    const blob = await api(`repos/${repo}/git/blobs`, 'POST', { content, encoding: 'base64' });
    entries.push({ path: `${dir}/${basename(file)}`, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Find the asset branch (append) or prepare an orphan first commit.
  let parent = null;
  let baseTree = null;
  try {
    const ref = await api(`repos/${repo}/git/ref/heads/${opts.branch}`);
    parent = ref.object.sha;
    baseTree = (await api(`repos/${repo}/git/commits/${parent}`)).tree.sha;
  } catch {
    // branch doesn't exist yet — first commit will be an orphan
  }

  const tree = await api(`repos/${repo}/git/trees`, 'POST', {
    tree: entries,
    ...(baseTree ? { base_tree: baseTree } : {}),
  });
  const commit = await api(`repos/${repo}/git/commits`, 'POST', {
    message: `uidiff: ${dir}`,
    tree: tree.sha,
    parents: parent ? [parent] : [],
  });
  if (parent) {
    await api(`repos/${repo}/git/refs/heads/${opts.branch}`, 'PATCH', { sha: commit.sha });
  } else {
    await api(`repos/${repo}/git/refs`, 'POST', { ref: `refs/heads/${opts.branch}`, sha: commit.sha });
  }

  const urls = {};
  for (const e of entries) {
    const path = e.path.split('/').map(encodeURIComponent).join('/');
    urls[basename(e.path)] = `https://raw.githubusercontent.com/${repo}/${commit.sha}/${path}`;
  }

  if (isPrivate) {
    console.error(
      'uidiff: warning — this repo is PRIVATE; raw URLs will NOT render in the PR body. Use drag-drop attachments instead.'
    );
  }
  console.log(JSON.stringify({ ok: true, repo, branch: opts.branch, commit: commit.sha, private: isPrivate, urls }));
} catch (err) {
  console.error(`uidiff: ${err.message || err}`);
  process.exit(1);
}
