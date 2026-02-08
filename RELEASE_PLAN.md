# Release Plan (Public)

This repo is intentionally buildless: one `index.html` served as static files.

## What this app does

- Downloads a public patch dataset (`patches.json`).
- Loads `./patches.json` in the browser.
- Normalizes it into a flat list of patches.
- Provides client-side search + filters + a fast results grid.

## Build outline (how to create the full app)

This is the condensed build plan for recreating the application from scratch.

1) Scaffold

- Start with a buildless static site: one `index.html`.
- Keep everything client-side (no backend).

2) UI skeleton

- Layout: header + left filters + main results grid.
- Add an About dialog explaining what the tool is and linking to the upstream dataset.

3) Load + normalize the dataset

- Fetch `./patches.json` (same-origin) on page load.
- Normalize the upstream structure into a flat array of patch rows.
- Parse `ReleaseDate` (`MM/DD/YYYY`) into a sortable timestamp.

Upstream schema shape (at time of writing):

- Top level: `{ "Product": [ { "version": string, "patches": Patch[] }, ... ] }`
- Common patch fields: `Name`, `Products`, `Platform`, `url`, `QFE_ID`, `ReleaseDate`, `Critical`, `PatchFiles`, `SHA256sums`, `MD5sums`

4) Filtering + sorting

- Text search across name/QFE/product/platform/filenames.
- Multi-select filters:
  - product (tokenize comma-separated `Products`)
  - version (from the parent group `version`)
  - platform (tokenize comma-separated `Platform`)
  - file type (derived from `PatchFiles` URL extensions)
- Criticality filter: All / Security / Critical (normalize `Critical` values).
- Date range filter (From/To).
- Default ordering: newest first (release date descending).

5) Results grid + details dialog

- Render results in a fast grid (client-side paging is fine).
- Row click opens a modal dialog:
  - patch metadata
  - patch page link (`url`)
  - file download links (`PatchFiles[]`)
  - checksums when present (`MD5sums`, `SHA256sums`)

6) Optional verification

- Add a basic browser smoke test (e.g., Playwright) that:
  - loads the page
  - waits for results
  - checks newest-first ordering
  - applies a filter and asserts results change

## Data source

- Upstream JSON: `https://downloads.esri.com/patch_notification/patches.json`
- Repo-local copy: `./patches.json`

## Local dev

1) Start a local server (required for `fetch()`):

```bash
python3 -m http.server 8000
```

2) Open:

- `http://localhost:8000/`

Note: `patches.json` must exist next to `index.html`. For this public repo, the GitHub Action is expected to keep it up to date.

## GitHub Action: keep dataset fresh

- Workflow: `.github/workflows/update-dataset.yml`
- On schedule (and on manual run), it downloads the latest `patches.json` and commits it to `main` only when it changes.

## Publish

GitHub Pages (static hosting):

1) Repository settings -> Pages
2) Source: Deploy from a branch
3) Branch: `main`
4) Folder: `/ (root)`

Once Pages is enabled and `patches.json` has been committed by the workflow, the site should load with data.
