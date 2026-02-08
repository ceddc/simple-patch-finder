# Simple Patch Finder

Single-page patch finder for ArcGIS/Esri patches.

- Fast patch list
- Practical filters
- Direct links to the official Esri patch pages

This project is intentionally buildless (one `index.html`) and uses CDN-loaded web components:
- Calcite Design System (primary UI)
- ArcGIS Maps SDK for JavaScript components (light touch, secondary)

## Quick start

1) Fetch the patches dataset next to the HTML:

```bash
./scripts/fetch_patches.sh
```

2) Serve locally (required for `fetch()` to work):

```bash
python3 -m http.server 8000
```

3) Open:

- http://localhost:8000/

## How it works

- The UI is a static page that loads `./patches.json`.
- The dataset is published by Esri at `https://downloads.esri.com/patch_notification/patches.json`.

## About

The goal is speed: find a patch quickly and jump to the official Esri page for full details and downloads.

- Official website: https://support.esri.com/
- Feedback/issues: https://github.com/ceddc/simple-patch-finder

## GitHub Pages

This repo includes a GitHub Actions workflow that downloads and commits the latest `patches.json` daily to `main`.

To publish the site:

- GitHub repo settings: Pages
- Source: Deploy from a branch
- Branch: `main`
- Folder: `/ (root)`

## Repo notes

- `patches.json` can be refreshed locally with `./scripts/fetch_patches.sh`.
- `patches.json` is also refreshed daily by GitHub Actions (see `.github/workflows/update-dataset.yml`).
