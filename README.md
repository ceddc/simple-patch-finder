# Simple Patch Finder

Live demo: https://ceddc.github.io/simple-patch-finder/

Single-page patch finder for ArcGIS/Esri patches.

- Fast patch list
- Practical filters
- Shareable filtered URLs
- Custom version ordering
- Direct links to the official Esri patch pages

This project is intentionally buildless (one `index.html`) and uses CDN-loaded dependencies:
- Calcite Design System (primary UI)
- Tabulator (table/grid UI, sorting, local pagination)

## Quick start

1) Download the patches dataset next to the HTML:

```bash
curl -fsSL "https://downloads.esri.com/patch_notification/patches.json" -o patches.json
```

Note: `patches.meta.json` is normally created by GitHub Actions. If it is missing locally, the app still loads but the dataset "Updated" timestamp is unavailable.

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

- Official website: https://support.esri.com/
- Feedback/issues: https://github.com/ceddc/simple-patch-finder

## GitHub Pages

This repo includes a GitHub Actions workflow that downloads and commits the latest dataset every 3 hours (UTC) to `main`:

- `patches.json` (upstream content)
- `patches.meta.json` (refresh timestamp + hash)
- `sitemap.xml` (single sitemap with homepage, product pages, and patch permalinks)

Schedule: `00:12`, `03:12`, `06:12`, `09:12`, `12:12`, `15:12`, `18:12`, `21:12` (UTC).

To publish the site:

- GitHub repo settings: Pages
- Source: Deploy from a branch
- Branch: `main`
- Folder: `/ (root)`

The site includes crawl files for search engines:

- `robots.txt`
- `sitemap.xml` (single sitemap with homepage, product pages, and patch permalinks)

## Repo notes

- The dataset and sitemap are refreshed by GitHub Actions (see `.github/workflows/update-dataset.yml`).
