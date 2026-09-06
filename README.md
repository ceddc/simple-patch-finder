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
- `js/seo.js` - early route canonical metadata, independent of UI dependencies
- `rss.xml` - latest 50 unique patches feed
- `rss-enterprise.xml` - latest 50 ArcGIS Enterprise server-side component patches
- `rss-security-critical.xml` - latest 50 security and critical patches
- Version feeds add the version before `.xml`, for example `rss-12.1.xml`, `rss-enterprise-12.0.xml`, and `rss-security-critical-11.3.xml`.

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
- Version-specific variants of all three feeds for 12.1, 12.0, 11.5, 11.4, and 11.3

To publish the site:

- GitHub repo settings: Pages
- Source: Deploy from a branch
- Branch: `main`
- Folder: `/ (root)`

The site includes crawl files for search engines:

- `robots.txt`
- `sitemap.xml` (homepage, product categories, and 50 recent patch permalinks)

## Repo notes

- `patches.json` can be refreshed locally with `./scripts/fetch_patches.sh`.
- Regenerate `sitemap.xml` and all RSS feeds after dataset updates with:

```bash
python3 scripts/generate_sitemap.py
python3 scripts/generate_rss.py --force
```

- `rss.xml` covers all patches; `rss-enterprise.xml` uses the same ArcGIS Enterprise server-side component aggregate as the UI's `ArcGIS Enterprise` product selection.
- `rss-security-critical.xml` covers patches classified as `Security` or `Critical` by the app's existing criticality logic.
- Each RSS button opens a dropdown with All versions, 12.1, 12.0, 11.5, 11.4, and 11.3. Version feeds contain up to 50 patches for that exact dataset version within the selected feed category.
- Existing RSS files are only rewritten automatically when a newly seen patch appears in that feed.

## Search indexing

The homepage, single-product category pages, and valid patch detail pages are indexable. Search/filter combinations, pagination after page one, and invalid patch IDs use `noindex,follow`. Keep these app URLs crawlable so search engines can read their metadata. The sitemap includes the homepage, product categories, and the 50 latest unique patch permalinks. Older valid patch links remain indexable; the sitemap limit prioritizes recent content rather than generating hundreds of new landing pages. Official Esri links remain the source for full patch information and downloads.

Canonical URLs and clear route exclusions are initialized before UI dependencies load. The dataset then validates product and patch routes. Excluded routes do not advertise competing canonical URLs; clearing filters restores the appropriate listing metadata. `/index.html` and the legacy project path redirect to the canonical domain; unknown paths remain 404s. Maintenance files are excluded from the Pages build.

After deployment, use Google Search Console URL Inspection on the homepage and representative category/patch pages. Compare the live test with the indexed result, check Google's selected canonical, and request indexing after the live test passes. Search/filter and pagination exclusions are intentional. Submit `https://simplepatchfinder.ceddc.dev/sitemap.xml`. Deployment cannot force or guarantee Google's indexing decision.

## RSS discovery and notifications

All 18 RSS feeds are advertised with absolute autodiscovery links in the HTML head, described as DataFeed resources in the site's structured metadata, and declared as feed sitemaps in robots.txt. The existing page sitemap retains its product categories and latest 50 patch permalinks.

Each RSS feed advertises [Google's public WebSub hub](https://pubsubhubbub.appspot.com/). When the dataset workflow changes a feed, it waits for that exact XML to be served by Pages before notifying the hub. Unchanged feeds are not pinged. A notification failure is visible in the workflow without blocking dataset publication.

To notify the hub once for every published feed:

```bash
python3 scripts/notify_rss.py
```

RSS discovery follows the [RSS Advisory Board specification](https://www.rssboard.org/rss-autodiscovery); feed sitemaps follow [Google's sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap). A successful ping acknowledges the notification; it does not confirm a directory listing or search indexing.
