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

## Design process (suggested iteration loop)

Aim for a dense, desktop-first layout that still works on small screens.

- Visual direction:
  - Calcite-first web components in light mode
  - subtle glass surfaces with a blue brand accent
  - "app-like" header actions (reset/share/about)
- Iteration loop (each step ends with a quick review + console check):
  - UI skeleton -> data load -> filters -> performance -> polish -> share links

Suggested milestones:

- Milestone A: Static layout + dialogs (no data)
- Milestone B: Load + normalize dataset; show count; newest-first ordering
- Milestone C: Filters + option lists + reset correctness
- Milestone D: Fast grid + local pagination
- Milestone E: Patch details dialog (files + checksums)
- Milestone F: Shareable URLs (serialize + hydrate)
- Milestone G: Custom version ordering (dropdown + grid)
- Milestone H: Smoke tests + docs

## Functional spec (how the UI behaves)

- Dataset normalization:
  - flatten grouped products/versions into one row per patch
  - tokenize comma-separated `Products` and `Platform`
  - parse `ReleaseDate` (`MM/DD/YYYY`) to `releaseDateMs` for sorting
  - derive file metadata from `PatchFiles[]` (filename, extension)
  - build a lowercase `searchBlob` for fast substring search
- Filters (all ANDed together):
  - text search across name, QFE, version, products/platform strings, release date text, filenames
  - multi-select: product tokens, version, platform tokens, file type (extension)
  - criticality: All / Security / Critical
  - release date range: From/To (inclusive end date)
- Results:
  - default order: newest first
  - local pagination (page size 25 is a good default)
  - link clicks (patch page) must not trigger row-click behavior
- Patch details:
  - modal dialog with scannable hierarchy (facts, links, files, checksums)

## URL sharing (serialize + hydrate)

- Encode current filter state into query params.
- Use compact keys (example mapping):
  - `q` (text), `p` (products), `v` (versions), `os` (platforms), `t` (types), `c` (critical), `from`, `to`
- Multi-select encoding:
  - store the full list in a single param using a delimiter (e.g. `|`) and `encodeURIComponent`
- On page load:
  - hydrate filter state from `location.search`
  - apply values to UI controls
  - render results
- Keep the address bar in sync via `history.replaceState` (no navigation).

## Version ordering (custom comparator)

The dataset "version" labels are not semver. Implement a predictable ordering:

- Numeric versions with major 9-12 are ranked above everything else.
- Special bucket for `9.x` / `9.X`.
- Everything else is “OTHER” and stays at the bottom.
- Bucket precedence stays fixed regardless of sort direction; only within-bucket order flips.

Apply this ordering consistently:

- Version filter dropdown ordering
- Results grid Version column sorting (including repeated header clicks)

## Performance + correctness checklist

- Single source of truth for filter state (use Sets for multi-selects).
- Coalesce filter application (debounce for text; schedule work via `requestAnimationFrame`).
- Skip redundant work using a stable filter signature/key.
- Update the grid with a replace operation (avoid rebuilding large DOM trees).
- Ensure reset/clear paths keep UI controls and internal state in sync.

## Implementation inventory (conceptual modules)

These are the core building blocks you will implement (names are illustrative):

- Dataset:
  - load + normalize (`normalizeDataset`)
  - parsing helpers (release date parsing, CSV tokenization)
  - file helpers (extension, filename parsing; optional file-version inference)
- Filters:
  - predicate evaluation (`passesFilters...`)
  - option derivation (value + count)
  - apply scheduling + stable apply key
- Share URLs:
  - serialize + hydrate multi-select state
- Sorting:
  - custom version comparator with bucket rules
- UI:
  - grid (virtualized + local pagination)
  - modal details dialog
  - safe HTML escaping for any string injected into templates

## Known pitfalls (practical notes)

- `ReleaseDate` parsing is strict; non-matching values should degrade gracefully (treat as 0 and avoid crashes).
- `Critical` is not boolean; normalize string values (`security`, `true`, etc.).
- Missing `PatchFiles`, missing checksums, or missing patch page URLs should not break rendering.
- Some web-component libraries can emit console warnings/errors on reload; keep the console clean and treat warnings as regressions in tests.

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
