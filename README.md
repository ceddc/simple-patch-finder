# Simple Patch Finder

Live demo: https://simplepatchfinder.ceddc.dev/

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
./scripts/fetch_patches.sh
```

That command refreshes `patches.json` and `patches.meta.json`. Rebuild the sitemap and RSS feeds with:

```bash
python3 scripts/generate_sitemap.py
python3 scripts/generate_rss.py --force
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
- `rss.xml` - latest 50 unique patches feed
- `rss-enterprise.xml` - latest 50 ArcGIS Enterprise server-side component patches
- `rss-security-critical.xml` - latest 50 security and critical patches

## About

The goal is speed: find a patch quickly and jump to the official Esri page for full details and downloads.

- Official website: https://support.esri.com/
- Feedback/issues: https://github.com/ceddc/simple-patch-finder

## GitHub Pages

This repo includes a GitHub Actions workflow that refreshes the dataset every 3 hours (UTC) and regenerates:

- `patches.json`
- `patches.meta.json`
- `sitemap.xml`
- `rss.xml`
- `rss-enterprise.xml`
- `rss-security-critical.xml`

To publish the site:

- GitHub repo settings: Pages
- Source: Deploy from a branch
- Branch: `main`
- Folder: `/ (root)`

The site includes crawl files for search engines:

- `robots.txt`
- `sitemap.xml` (single sitemap with homepage, product pages, and patch permalinks)

## Repo notes

- `patches.json` can be refreshed locally with `./scripts/fetch_patches.sh`.
- Regenerate `sitemap.xml` and both RSS feeds after dataset updates with:

```bash
python3 scripts/generate_sitemap.py
python3 scripts/generate_rss.py --force
```

- `rss.xml` covers all patches; `rss-enterprise.xml` uses the same ArcGIS Enterprise server-side component aggregate as the UI's `ArcGIS Enterprise` product selection.
- `rss-security-critical.xml` covers patches classified as `Security` or `Critical` by the app's existing criticality logic.
- Existing RSS files are only rewritten automatically when a newly seen patch appears in that feed.
