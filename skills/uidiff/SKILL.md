---
name: uidiff
description: Capture before/after screenshots of UI changes — production vs local dev — and produce a markdown comparison table ready for a GitHub PR. Use when the user wants before/after captures of UI work, a visual comparison of an element or page against production, or a PR-ready screenshot table. Triggers on "before/after", "screenshot my change for the PR", "compare with production", "visual diff of this component".
---

# UIDiff — before/after captures for pull requests

Capture the **before** (production or the base branch) and **after** (local dev) of the UI the user changed, verify both captures visually, upload the images to GitHub, and put a rendering before/after table directly into the PR description. No screenshots are left in the user's repo or working tree.

## Setup (once per machine)

The capture script lives in this skill's directory and needs `playwright-core` (it drives the user's installed Chrome — no browser download):

```bash
cd <this skill's directory> && [ -d node_modules ] || npm install --silent
```

**First-time GitHub login (private repos only).** Uploading images that render in a private-repo PR requires the user's GitHub browser session. As soon as you know the target repo is private (`gh repo view --json isPrivate`), check for a session **before capturing anything**:

```bash
node scripts/attach.mjs status   # → {"loggedIn": true|false, "user": …}
```

If `loggedIn` is false, stop and ask the user to complete the one-time login:

> First-time setup: run `node <skill dir>/scripts/attach.mjs login` — a Chrome window opens on a dedicated profile (separate from your regular browser). Log in to GitHub there, then close the window. You'll never need to do this again; after that, uploads are fully automatic.

Wait for them to confirm (or re-run `status`) before proceeding. Don't silently fall back to the manual drag-drop flow without offering the login first.

## Workflow

### 1. Establish the three inputs

- **Local URL** — find the running dev server (check common ports, `package.json` scripts, or ask the shell: `lsof -nP -iTCP -sTCP:LISTEN | grep -i node`). If nothing is running, start the dev server yourself and wait for it to be ready.
- **Production origin** — look for it in the repo (`vercel.json`, deployment config, README, `homepage` in package.json) before asking the user. The "before" URL is the production origin + the same path as the local URL. If there is no production deployment, use the base branch: stash/checkout, capture, and restore — or ask which baseline the user wants.
- **Target element** — the user usually names a component ("the save button", "settings header"). Read the source of that component to derive a **stable selector**, preferring in this order: `data-testid`/`data-test`/`data-cy` → `id` → `aria-label` → a short semantic CSS path (avoid hashed/utility class names — Tailwind classes change with the diff and CSS-module hashes differ between builds). Also note the element's visible text for the `--text` fallback. If the user wants the whole page, skip the selector.

### 2. Capture both sides

Run the bundled script from the skill directory (paths below relative to it). Capture **after** (local) first — it confirms the selector works before you touch production:

```bash
node scripts/capture.mjs shoot --url http://localhost:3000/settings \
  --selector '[data-testid="save-button"]' --text "Save changes" \
  --out uidiff/01-save-button-after.png

node scripts/capture.mjs shoot --url https://app.example.com/settings \
  --selector '[data-testid="save-button"]' --text "Save changes" \
  --out uidiff/01-save-button-before.png
```

Write outputs into a **temp dir** (`TMP=$(mktemp -d)`), never into the user's repo. Name files `NN-<slug>-before|after.png` — the filename becomes the uploaded asset name.

Flags: `--full` (full page), `--width/--height` (viewport, default 1280×800), `--wait <ms>` (extra settle time for hydration/animations, default 400), `--dpr <n>` (device scale factor, **default 2** — retina-crisp output; don't lower it for PR screenshots), `--dark` (dark color scheme), `--storage-state auth.json` (for login-walled pages — create one with `npx playwright codegen --save-storage=auth.json <url>`).

The script prints a JSON line with the output path, dimensions, and which selector matched. On "element not found", it lists what it tried — refine the selector by reading the production DOM (`curl` the page or capture `--full` and look) rather than guessing repeatedly.

### 3. Verify with your own eyes

Read both PNGs. Confirm: (a) they show the same element/region, (b) the *after* actually shows the user's change, (c) nothing embarrassing is in frame (real user data, seeded garbage). If the two sides show different data (prod data vs local fixtures), say so in the PR note. If a capture is wrong, fix the selector or add `--wait`, and re-shoot — don't ship a bad capture.

### 4. Publish the images to GitHub

Upload all PNGs from the temp dir in one call (requires an authenticated `gh`; run from inside the user's repo so the target resolves automatically):

```bash
node scripts/publish.mjs --prefix save-button "$TMP"/*.png
```

This pushes the images to an orphan `uidiff-assets` branch via the Git Data API — the user's working tree, PR branch, and diff are untouched — and prints a JSON map of `filename → raw.githubusercontent.com URL` pinned to the commit SHA.

**Private repos won't render raw URLs** (the output has `private: true` and a stderr warning). For private repos, skip `publish.mjs` entirely and upload as **native GitHub attachments** instead — the only image kind that renders in private PR bodies:

```bash
node scripts/attach.mjs upload --pr "$(gh pr view --json url --jq .url)" "$TMP"/*.png
```

This drives GitHub's own uploader through a logged-in browser session against the PR page (nothing is posted — only the composer's uploader is used) and prints `filename → https://github.com/user-attachments/assets/…` URLs. Use them in the table exactly like raw URLs. You already verified the session during setup; if it still errors with **"Not logged in"** (expired session), repeat the first-time login ask from Setup and retry. Only if the user declines the login, fall back to the manual flow: leave the PNGs in the temp dir, give the user its path, emit the table with `_drop \`<file>\` here_` placeholders, and explain the drag-drop step. Never write captures to the Desktop or into the repo. After the user confirms the images are in the PR, delete the temp dir.

`attach.mjs` needs an existing PR (attachments are uploaded via the PR's own page). If there's no PR yet on a private repo, create it first (with the user's go-ahead) or leave the placeholder table.

### 5. Update the PR description

Build the table with the uploaded URLs, wrapped in markers so re-runs replace instead of duplicate:

```markdown
<!-- uidiff:start -->
## UI changes

| UI | Before | After |
| --- | --- | --- |
| **Save button** | <img alt="before" src="<raw-url>" width="420"> | <img alt="after" src="<raw-url>" width="420"> |
<!-- uidiff:end -->
```

Use `<img … width="420">` rather than `![]()` so side-by-side cells stay readable. The block is the heading + table only — don't add capture-metadata captions (viewport size, scale, which server, "same state on both sides") to the PR; that detail belongs in your chat summary to the user, not the PR body. The one exception: a short note when the two sides genuinely differ in data (see step 3). Then edit the PR body directly:

1. `gh pr view --json number,body,url` for the current branch.
2. If the body already contains a `<!-- uidiff:start -->…<!-- uidiff:end -->` block, replace it; otherwise append the block.
3. `gh pr edit <number> --body-file <tmpfile>` — never pass the body inline (quoting).
4. Show the user the PR URL and the table you inserted.

If there's no PR yet, ask nothing — print the ready-to-paste table (the URLs already work) and note it can be auto-inserted once a PR exists, or create the PR if the user already asked for one.

**Always delete the temp dir when finished** — immediately after a successful automated upload, or, in the manual drag-drop fallback, right after the user confirms the images are in the PR. No capture files should outlive the run anywhere on disk.

Also available: a single stitched image (`node scripts/capture.mjs stitch --before b.png --after a.png --out combined.png`) — publish it the same way when the user prefers one image over a table.

## Multiple changes

One table row per UI area. Capture all pairs, verify all, emit one table. Keep row names in the user's vocabulary ("Settings header"), not selector syntax.

## Pitfalls

- **Different viewport = different layout.** Use the same `--width/--height` for both sides (the default already ensures this).
- **Animations/carousels** make flaky captures — `reducedMotion` is already forced, but add `--wait` for entrance animations or skeleton loaders.
- **Production behind auth**: use `--storage-state`; never ask the user to paste credentials into the chat.
- **Local-only element** (new UI): there is no production match — capture only the after and put "—" in the Before cell rather than a misleading screenshot.
