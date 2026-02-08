# Simple Patch Finder

Live demo: https://ceddc.github.io/simple-patch-finder/

Single-page patch finder for ArcGIS/Esri patches.

- Fast patch list
- Practical filters
- Direct links to the official Esri patch pages

This project is intentionally buildless (one `index.html`) and uses CDN-loaded web components:
- Calcite Design System (primary UI)
- ArcGIS Maps SDK for JavaScript components (light touch, secondary)

## Quick start

1) Download the patches dataset next to the HTML:

```bash
curl -fsSL "https://downloads.esri.com/patch_notification/patches.json" -o patches.json
```

2) Serve locally (required for `fetch()` to work):

```bash
python3 -m http.server 8000
```

3) Open:

- http://localhost:8000/

## How it works

- The UI is a static page (`index.html`) that loads `./patches.json`.
- The site also loads `./patches.meta.json` to show when the dataset was last refreshed.
- The dataset is published by Esri at `https://downloads.esri.com/patch_notification/patches.json`.

## Repo layout

- `index.html` - static shell + metadata
- `css/app.css` - app styling
- `js/app.js` - app logic (no build step)

## About

The goal is speed: find a patch quickly and jump to the official Esri page for full details and downloads.

## Vibe-coded note

This project was vibe-coded with OpenCode and Codex 5.3 at basically "level 0". I did not read much code upfront; I mostly guided the agent and pointed at specific changes.

Could I have coded it myself? Probably. But it would have taken longer with no clear idea upfront of how long, and I have little interest in spending free time coding tables, filters, and JSON parsing. Even after thinking about this for months, I likely would never have started.

## Links

- Official website: https://support.esri.com/
- Feedback/issues: https://github.com/ceddc/simple-patch-finder

## GitHub Pages

This repo includes a GitHub Actions workflow that downloads and commits the latest dataset every 6 hours to `main`:

- `patches.json` (upstream content)
- `patches.meta.json` (refresh timestamp + hash)

To publish the site:

- GitHub repo settings: Pages
- Source: Deploy from a branch
- Branch: `main`
- Folder: `/ (root)`

## Repo notes

- The dataset is refreshed by GitHub Actions (see `.github/workflows/update-dataset.yml`).
