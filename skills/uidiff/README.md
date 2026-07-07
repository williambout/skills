# UIDiff

Capture **before/after** screenshots of UI you're changing — production vs local dev — and get a markdown comparison table ready to paste into a GitHub PR.

A **Claude Code skill**: invoke `/uidiff` and Claude finds your dev server and production origin, derives a stable selector for the element you changed, captures both sides with headless Chrome, visually verifies the shots, and hands you the table + PNGs.

## Install

```bash
npx skills add williambout/skills --skill uidiff
```

Or for development, from a clone of this repo:

```bash
cd skills/uidiff
npm install
ln -sfn "$(pwd)" ~/.claude/skills/uidiff
```

Then in any project: `/uidiff` (or just ask for "before/after screenshots for my PR"). The workflow Claude follows is in [SKILL.md](SKILL.md).

## The capture script

Usable directly, too (from this directory):

```bash
# element shot (selector first, text as fallback)
node scripts/capture.mjs shoot --url http://localhost:3000/settings \
  --selector '[data-testid="save"]' --text "Save changes" --out after.png

# full page / viewport
node scripts/capture.mjs shoot --url https://app.example.com/settings --full --out before.png

# one labeled BEFORE/AFTER composite
node scripts/capture.mjs stitch --before before.png --after after.png --out combined.png
```

Flags: `--width/--height` (viewport, default 1280×800), `--wait <ms>` (settle time), `--dpr <n>` (device scale factor, default 2), `--dark`, `--storage-state auth.json` (login-walled pages). Prints a JSON result line; forces `reducedMotion`, and everything — including stitched composites — renders at 2× for retina-crisp output.

## Publishing

Screenshots are captured to a temp dir (never into your repo) and uploaded straight to GitHub by `scripts/publish.mjs`: it pushes them to an orphan `uidiff-assets` branch via the Git Data API (`gh` CLI auth; your working tree and PR diff stay untouched) and returns SHA-pinned `raw.githubusercontent.com` URLs. The skill then edits the PR description itself, inserting a rendering table between `<!-- uidiff -->` markers so re-runs update in place:

```markdown
| UI | Before | After |
| --- | --- | --- |
| **Save button** | <img alt="before" src="https://raw.githubusercontent.com/…" width="420"> | <img alt="after" src="https://raw.githubusercontent.com/…" width="420"> |
```

**Private repos**: GitHub's image proxy can't read private files, so raw URLs don't render there — and GitHub has no public API for the attachments that do. `scripts/attach.mjs` closes that gap: it drives GitHub's own uploader through a logged-in browser session on the PR page and returns `github.com/user-attachments` URLs, which render in private PR bodies with repo-scoped permissions. One-time setup: `node <skill dir>/scripts/attach.mjs login` (log in to GitHub in the window that opens, close it); after that, private repos are zero-manual-step too — Claude will prompt you for this the first time it's needed.
