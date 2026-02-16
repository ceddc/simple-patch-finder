// Simple Patch Finder
//
// High-level flow:
// - Load `./patches.json` (same-origin)
// - Normalize upstream schema into a flat array of patch rows
// - Derive filter option lists (value + count)
// - Hydrate filters from URL query params (shareable links)
// - Apply filters client-side and render with Tabulator

// This project intentionally uses no build step.
// Vendor dependencies (Calcite + Tabulator) are loaded via <script>/<link> in index.html.

/**
 * @typedef {Object} PatchFile
 * @property {string} url
 * @property {string} filename
 * @property {string} ext
 * @property {string} fileVersion
 */

/**
 * @typedef {Object} PatchRow
 * @property {string} name
 * @property {string} qfeId
 * @property {string} version
 * @property {string[]} productsTokens
 * @property {string} productsDisplay
 * @property {string[]} platformTokens
 * @property {string} releaseDateText
 * @property {number} releaseDateMs
 * @property {string} criticalKind
 * @property {string} criticalDisplay
 * @property {string} patchPageUrl
 * @property {PatchFile[]} files
 * @property {string[]} types
 * @property {string[]} md5
 * @property {string[]} sha256
 * @property {string} searchBlob
 */

// --- DOM refs ---
const els = {
  grid: document.getElementById("grid"),
  textCount: document.getElementById("text-count"),
  dlg: document.getElementById("dlg"),
  dlgBody: document.getElementById("dlg-body"),

  shareAlert: document.getElementById("share-alert"),
  shareLink: document.getElementById("share-link"),
  btnDlgShare: document.getElementById("btn-dlg-share"),

  fQ: document.getElementById("f-q"),
  fProducts: document.getElementById("f-products"),
  fVersions: document.getElementById("f-versions"),
  fPlatforms: document.getElementById("f-platforms"),
  fTypes: document.getElementById("f-types"),
  fCritical: document.getElementById("f-critical"),
  fFrom: document.getElementById("f-from"),
  fTo: document.getElementById("f-to"),

  btnShare: document.getElementById("btn-share"),
  btnTogglePanel: document.getElementById("btn-toggle-panel"),
  btnReset: document.getElementById("btn-reset"),
  btnResetFilters: document.getElementById("btn-reset-filters"),
};

const PAGE_SIZE = 25;

let grid = null;
let gridInitTries = 0;
let gridBuilt = false;
let pendingGridData = null;

let calciteReadyPromise = null;
const comboboxSyncing = new WeakSet();

let datasetEpoch = 0;
let lastApplyKey = "";

let datasetUpdatedAtUtc = null;

let baseCountText = "";

let versionSortMode = "asc";

const state = {
  // `all` is the normalized dataset.
  // `filtered` is the derived list used to render the grid.
  all: [],
  filtered: [],
  options: {
    products: [],
    versions: [],
    platforms: [],
    types: [],
  },
  filters: {
    // Multi-select filters are stored as Sets for fast membership checks.
    q: "",
    products: new Set(),
    versions: new Set(),
    platforms: new Set(),
    types: new Set(),
    critical: "all",
    from: "",
    to: "",
  },
};

const DEFAULT_PAGE_TITLE = String(document.title || "ArcGIS Patch Download Search (Unofficial) | Enterprise, Server, Data Store");
const TITLE_BRAND = "Simple Patch Finder";

let activePatch = null;
let patchRoute = { pid: "", pn: "" };

// --- URL state (shareable links) ---

function encodeList(values) {
  // Encode multi-selects into a single query param value.
  // We use a delimiter ('|') so URLs stay compact and stable.
  return Array.from(values || [])
    .map((v) => encodeURIComponent(String(v)))
    .join("|");
}

function decodeList(s) {
  if (!s) return [];
  return String(s)
    .split("|")
    .map((v) => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    })
    .map((v) => String(v).trim())
    .filter(Boolean);
}

function slugifyPatchName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function normalizePatchRoute(pid, pn) {
  const outPid = String(pid || "").trim();
  const outPn = String(pn || "").trim().toLowerCase();
  return {
    pid: outPid,
    pn: outPid ? outPn : "",
  };
}

function isLikelyPid(value) {
  return /^[A-Za-z0-9._-]{2,80}$/.test(String(value || ""));
}

function isLikelySlug(value) {
  return /^[a-z0-9-]{2,180}$/.test(String(value || ""));
}

function isKnownProductValue(value) {
  const wanted = String(value || "").trim();
  if (!wanted) return false;
  const opts = Array.isArray(state.options?.products) ? state.options.products : [];
  if (!opts.length) return false;
  return opts.some((o) => String(o?.value || "").trim() === wanted);
}

function readPatchRouteFromParams(params) {
  if (!params) return { pid: "", pn: "" };
  const route = normalizePatchRoute(params.get("pid"), params.get("pn"));
  if (!isLikelyPid(route.pid)) return { pid: "", pn: "" };
  if (route.pn && !isLikelySlug(route.pn)) return { pid: route.pid, pn: "" };
  return route;
}

function patchRouteFromPatch(p) {
  if (!p) return { pid: "", pn: "" };
  const pid = String(p.qfeId || "").trim();
  const pn = slugifyPatchName(p.name || "");
  return normalizePatchRoute(pid, pn);
}

function selectedSingleProduct() {
  if (!state.filters.products || state.filters.products.size !== 1) return "";
  const product = String(Array.from(state.filters.products)[0] || "").trim();
  if (!product) return "";
  return isKnownProductValue(product) ? product : "";
}

function buildSeoCanonicalUrl() {
  const base = `${location.origin}${location.pathname}`;
  const params = new URLSearchParams(location.search);

  // Canonicalize only the routes we intentionally want indexed:
  // - patch details: pid(+pn)
  // - single product landing: p=<one product>
  // Everything else canonicalizes to the homepage.
  const pid = String(params.get("pid") || "").trim();
  const pn = String(params.get("pn") || "").trim().toLowerCase();
  if (pid && isLikelyPid(pid) && (!pn || isLikelySlug(pn))) {
    const match = findPatchByRoute({ pid, pn });
    if (match) {
      const out = new URLSearchParams();
      out.set("pid", String(match.qfeId || "").trim());
      out.set("pn", slugifyPatchName(match.name || ""));
      return `${base}?${out.toString()}`;
    }
  }

  const products = decodeList(params.get("p"));
  if (products.length === 1 && isKnownProductValue(products[0])) {
    const out = new URLSearchParams();
    out.set("p", products[0]);
    return `${base}?${out.toString()}`;
  }

  return base;
}

function ensureCanonicalLinkEl() {
  let el = document.querySelector('link[rel="canonical"]');
  if (el) return el;
  el = document.createElement("link");
  el.setAttribute("rel", "canonical");
  document.head.appendChild(el);
  return el;
}

function updateRouteSeoMeta() {
  const href = buildSeoCanonicalUrl();

  try {
    const canonical = ensureCanonicalLinkEl();
    if (canonical.getAttribute("href") !== href) canonical.setAttribute("href", href);
  } catch {
    // ignore
  }

  try {
    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl && ogUrl.getAttribute("content") !== href) ogUrl.setAttribute("content", href);
  } catch {
    // ignore
  }
}

function updatePageTitle() {
  if (activePatch) {
    const name = String(activePatch.name || "").trim();
    const pid = String(activePatch.qfeId || "").trim();
    if (name && pid) {
      document.title = `${name} (${pid}) | ${TITLE_BRAND}`;
      return;
    }
    if (name) {
      document.title = `${name} | ${TITLE_BRAND}`;
      return;
    }
  }

  const product = selectedSingleProduct();
  if (product) {
    document.title = `${product} patches | ${TITLE_BRAND}`;
    return;
  }

  document.title = DEFAULT_PAGE_TITLE;
}

function findPatchByRoute(route) {
  const pid = String(route?.pid || "").trim().toLowerCase();
  if (!pid) return null;
  const candidates = (state.all || []).filter((p) => String(p.qfeId || "").trim().toLowerCase() === pid);
  if (!candidates.length) return null;

  const slug = String(route?.pn || "").trim().toLowerCase();
  if (slug) {
    const exact = candidates.find((p) => slugifyPatchName(p.name || "") === slug);
    if (exact) return exact;
  }

  return candidates[0];
}

function serializeFiltersToParams() {
  // Only emit non-default filters to keep URLs short/stable.
  const f = state.filters;
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.products.size) params.set("p", encodeList(f.products));
  if (f.versions.size) params.set("v", encodeList(f.versions));
  if (f.platforms.size) params.set("os", encodeList(f.platforms));
  if (f.types.size) params.set("t", encodeList(f.types));
  if (f.critical && f.critical !== "all") params.set("c", f.critical);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (patchRoute.pid) params.set("pid", patchRoute.pid);
  if (patchRoute.pn) params.set("pn", patchRoute.pn);
  return params;
}

function buildShareUrl() {
  // Full, absolute URL used by the Share button and for copying.
  const params = serializeFiltersToParams();
  const base = `${location.origin}${location.pathname}`;
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function buildPatchPermalinkUrl(patch) {
  if (!patch) return buildShareUrl();
  const route = patchRouteFromPatch(patch);
  if (!route.pid) return buildShareUrl();

  const params = new URLSearchParams();
  params.set("pid", route.pid);
  if (route.pn) params.set("pn", route.pn);
  return `${location.origin}${location.pathname}?${params.toString()}`;
}

function syncLocationToFilters() {
  // Keep the address bar in sync with current filters (shareable URL), without navigation.
  // Only include non-default filters to keep URLs short and stable.
  const params = serializeFiltersToParams();
  const qs = params.toString();
  const desired = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash || ""}`;
  const current = `${location.pathname}${location.search}${location.hash || ""}`;
  if (desired === current) {
    updateRouteSeoMeta();
    updatePageTitle();
    return;
  }
  if (desired === lastSyncedLocation) {
    updateRouteSeoMeta();
    updatePageTitle();
    return;
  }
  try {
    history.replaceState({}, "", desired);
    lastSyncedLocation = desired;
  } catch {
    // ignore
  }

  updateRouteSeoMeta();
  updatePageTitle();
}

function hydrateFiltersFromLocation() {
  // Hydrate filter state from query params (supports shareable URLs).
  const params = new URLSearchParams(location.search);
  const q = String(params.get("q") || "").trim();
  const products = new Set(decodeList(params.get("p")));
  const versions = new Set(decodeList(params.get("v")));
  const platforms = new Set(decodeList(params.get("os")));
  const types = new Set(decodeList(params.get("t")));
  const critical = String(params.get("c") || "all").trim() || "all";
  const from = String(params.get("from") || "").trim();
  const to = String(params.get("to") || "").trim();

  state.filters.q = q;
  state.filters.products = products;
  state.filters.versions = versions;
  state.filters.platforms = platforms;
  state.filters.types = types;
  state.filters.critical = ["all", "security", "critical"].includes(critical) ? critical : "all";
  state.filters.from = from;
  state.filters.to = to;
  patchRoute = readPatchRouteFromParams(params);

  updateRouteSeoMeta();
  updatePageTitle();
}

// --- Core parsing helpers ---

function setStatusText(text) {
  baseCountText = text;
  updateDatasetHint();
}

function findComboboxCountChip(comboboxEl) {
  const sr = comboboxEl && comboboxEl.shadowRoot;
  if (!sr) return null;

  const chips = Array.from(sr.querySelectorAll("calcite-chip"));
  if (!chips.length) return null;
  if (chips.length === 1) return chips[0];

  // Prefer a chip whose visible text is a number/count.
  for (const c of chips) {
    const t = String(c.textContent || "").trim();
    if (/^\d+(?:\s+selected)?$/.test(t)) return c;
  }
  return chips[0];
}

function comboboxItemHumanLabel(item) {
  if (!item) return "";
  const pick = (...vals) => {
    for (const v of vals) {
      const s = String(v || "").trim();
      if (s) return s;
    }
    return "";
  };

  try {
    return pick(
      item.textLabel,
      item.label,
      item.heading,
      item.getAttribute && item.getAttribute("text-label"),
      item.getAttribute && item.getAttribute("label"),
      item.getAttribute && item.getAttribute("heading"),
      item.value,
      item.textContent
    );
  } catch {
    return "";
  }
}

function readSingleSelectedHumanLabel(comboboxEl) {
  if (!comboboxEl) return "";

  // Prefer Calcite's selectedItems collection when available.
  try {
    const selected = comboboxEl.selectedItems;
    if (Array.isArray(selected) && selected.length === 1) {
      return comboboxItemHumanLabel(selected[0]);
    }
  } catch {
    // ignore
  }

  // Fall back to scanning the items.
  try {
    const items = comboboxEl.querySelectorAll("calcite-combobox-item");
    if (!items || !items.length) return "";
    let hit = null;
    for (const it of items) {
      if (it && it.selected) {
        if (hit) return ""; // more than one selected
        hit = it;
      }
    }
    return comboboxItemHumanLabel(hit);
  } catch {
    // ignore
  }

  // Final fallback: in this app, combobox values are already human-friendly.
  try {
    const set = readSelectedSet(comboboxEl);
    if (set && set.size === 1) return Array.from(set)[0];
  } catch {
    // ignore
  }

  return "";
}

function patchComboboxCountChip(comboboxEl, selectedValues) {
  if (!comboboxEl) return;
  const chip = findComboboxCountChip(comboboxEl);
  if (!chip) return;

  let n = 0;
  let single = "";

  if (selectedValues instanceof Set) {
    n = selectedValues.size;
    if (n === 1) single = String(Array.from(selectedValues)[0] || "").trim();
  } else if (Array.isArray(selectedValues)) {
    n = selectedValues.length;
    if (n === 1) single = String(selectedValues[0] || "").trim();
  } else {
    n = Number(selectedValues || 0);
  }

  // When nothing is selected, Calcite should hide/remove the chip.
  // Avoid mutating chip content while it is being torn down.
  if (n <= 0) return;

  if (n === 1 && !single) single = readSingleSelectedHumanLabel(comboboxEl);

  const desired = n === 1 ? single || "1 selected" : `${n} selected`;

  try {
    if (String(chip.textContent || "").trim() === desired) return;
  } catch {
    // ignore
  }

  // Be careful: this chip is created/managed internally by Calcite. Prefer
  // updating via component props/attrs or an existing label node.

  // Try public-ish component fields/attrs first (don't early-return;
  // some Calcite internals may not render from these fields).
  try {
    if ("label" in chip) chip.label = desired;
  } catch {
    // ignore
  }

  try {
    if ("textLabel" in chip) chip.textLabel = desired;
  } catch {
    // ignore
  }

  try {
    if ("value" in chip) chip.value = desired;
  } catch {
    // ignore
  }

  try {
    chip.setAttribute("label", desired);
    chip.setAttribute("value", desired);
    chip.setAttribute("text-label", desired);
  } catch {
    // ignore
  }

  try {
    if (String(chip.textContent || "").trim() === desired) return;
  } catch {
    // ignore
  }

  try {
    // If the chip has a shadow root, try to update its internal label element.
    // (This avoids touching the chip's light DOM children.)
    const sr = chip.shadowRoot;
    if (sr) {
      const label = sr.querySelector('[part="text"], [part="label"]');
      if (label) {
        label.textContent = desired;
      }
    }
  } catch {
    // ignore
  }

  try {
    if (String(chip.textContent || "").trim() === desired) return;
  } catch {
    // ignore
  }

  try {
    // Update first matching text node without removing element children.
    for (const node of Array.from(chip.childNodes || [])) {
      if (node && node.nodeType === Node.TEXT_NODE) {
        const t = String(node.nodeValue || "").trim();
        if (/^\d+(?:\s+selected)?$/.test(t) || t === "") {
          node.nodeValue = desired;
          return;
        }
      }
    }

    // Fall back: if the chip only contains a single element child, update it.
    if (chip.childElementCount === 1) {
      const el = chip.firstElementChild;
      if (el) {
        const t = String(el.textContent || "").trim();
        if (/^\d+(?:\s+selected)?$/.test(t) || t === "") {
          el.textContent = desired;
          return;
        }
      }
    }
  } catch {
    // ignore
  }

  // Last resort.
  try {
    chip.textContent = desired;
  } catch {
    // ignore
  }
}

function patchAllComboboxCountChips() {
  // Calcite's internal chip can be created/replaced asynchronously (and can lag
  // behind the selection event), so apply a few times with small delays.
  const applyOnce = () => {
    patchComboboxCountChip(els.fProducts, state.filters.products);
    patchComboboxCountChip(els.fVersions, state.filters.versions);
    patchComboboxCountChip(els.fPlatforms, state.filters.platforms);
    patchComboboxCountChip(els.fTypes, state.filters.types);
  };

  requestAnimationFrame(() => requestAnimationFrame(applyOnce));
  setTimeout(applyOnce, 0);
  setTimeout(applyOnce, 60);
  setTimeout(applyOnce, 180);
}

function formatLocalDateTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (!dt || Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function updateDatasetHint() {
  const base = String(baseCountText || "").trim();
  const parts = [];
  if (datasetUpdatedAtUtc) {
    const t = formatLocalDateTime(datasetUpdatedAtUtc);
    if (t) parts.push(`Last updated: ${t}`);
  }

  // Don't add suffix to initial Loading/Missing states.
  const suppress = base.startsWith("Loading") || base.startsWith("Missing");
  els.textCount.textContent = parts.length && !suppress ? `${base} | ${parts.join(" | ")}` : base;
}

async function loadDatasetMeta() {
  try {
    const res = await fetch("./patches.meta.json", { cache: "no-store" });
    if (!res.ok) return;
    const meta = await res.json();
    const utc = meta && meta.updated_at_utc;
    if (typeof utc === "string" && utc) {
      datasetUpdatedAtUtc = utc;
      updateDatasetHint();
    }
  } catch {
    // ignore
  }
}

function parseReleaseDateMs(mmddyyyy) {
  if (!mmddyyyy || typeof mmddyyyy !== "string") return 0;
  const m = mmddyyyy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

function isoDateToMs(iso) {
  if (!iso || typeof iso !== "string") return 0;
  const d = new Date(iso + "T00:00:00Z");
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

function getExt(url) {
  const u = String(url || "").split("?")[0];
  const last = u.split("/").pop() || "";
  const i = last.lastIndexOf(".");
  if (i <= 0) return "";
  return last.slice(i + 1).toLowerCase();
}

function filenameFromUrl(url) {
  const u = String(url || "").split("?")[0];
  return u.split("/").pop() || url;
}

function tokenizeCsv(s) {
  return String(s || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function classifyCritical(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "security") return "security";
  if (v === "true") return "critical";
  return "standard";
}

const esriEraVersionCache = new Map();

function parseEsriEraVersion(versionStr) {
  const cacheKey = String(versionStr || "").trim();
  if (cacheKey) {
    const hit = esriEraVersionCache.get(cacheKey);
    if (hit) return hit;
  }

  const raw = String(versionStr || "").trim();
  if (!raw) return { kind: "other", raw };

  // Special bucket: 9.x/9.X (non-numeric minor)
  if (/^9\.[xX]\b/.test(raw)) {
    const out = { kind: "9x", raw, major: 9, minor: -1, patch: -1 };
    esriEraVersionCache.set(raw, out);
    return out;
  }

  // Numeric versions: only treat major 9-12 as "Esri era" versions.
  const m = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (m) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = m[3] != null ? Number(m[3]) : 0;
    if (
      Number.isFinite(major) &&
      Number.isFinite(minor) &&
      Number.isFinite(patch) &&
      major >= 9 &&
      major <= 12
    ) {
      const out = { kind: "num", raw, major, minor, patch };
      esriEraVersionCache.set(raw, out);
      return out;
    }
  }

  const out = { kind: "other", raw };
  esriEraVersionCache.set(raw, out);
  return out;
}

function compareEsriEraVersions(a, b, dir) {
  // Esri-era ordering: numeric 9-12 versions come first, then 9.x, then everything else.
  // Bucket precedence stays fixed regardless of sort direction.
  const A = parseEsriEraVersion(a);
  const B = parseEsriEraVersion(b);

  // Bucket precedence stays fixed regardless of sort direction:
  // numeric (9-12) > 9.x > other
  const rank = (v) => (v.kind === "num" ? 2 : v.kind === "9x" ? 1 : 0);
  const rA = rank(A);
  const rB = rank(B);
  if (rA !== rB) return rB - rA;

  const isAsc = dir === "asc";

  if (A.kind === "num" && B.kind === "num") {
    if (A.major !== B.major) return isAsc ? A.major - B.major : B.major - A.major;
    if (A.minor !== B.minor) return isAsc ? A.minor - B.minor : B.minor - A.minor;
    return isAsc ? A.patch - B.patch : B.patch - A.patch;
  }

  // Keep string buckets stable and predictable.
  if (A.raw === B.raw) return 0;
  return isAsc ? A.raw.localeCompare(B.raw) : B.raw.localeCompare(A.raw);
}

// --- Dataset normalization + option derivation ---

function compareEsriEraVersionsDesc(a, b) {
  return compareEsriEraVersions(a, b, "desc");
}

function normalizeDataset(data) {
  // Flatten Esri's JSON into a row-per-patch array.
  // Upstream groups patches under Product[] entries keyed by `version`.
  const groups = Array.isArray(data?.Product) ? data.Product : [];
  const patches = [];

  for (const g of groups) {
    const version = String(g?.version ?? "").trim();
    const list = Array.isArray(g?.patches) ? g.patches : [];
    for (const p of list) {
      const name = String(p?.Name ?? "");
      const qfeId = String(p?.QFE_ID ?? "");
      const productsRaw = String(p?.Products ?? "");
      const platformRaw = String(p?.Platform ?? "");
      const releaseDateText = String(p?.ReleaseDate ?? "");
      const releaseDateMs = parseReleaseDateMs(releaseDateText);
      const criticalKind = classifyCritical(p?.Critical);

        const patchFiles = Array.isArray(p?.PatchFiles) ? p.PatchFiles : [];
        const files = patchFiles.map((url) => {
          const filename = filenameFromUrl(url);
          const fileVersion = inferFileVersionFromUrl(url) || "";
          return { url: String(url), filename, ext: getExt(url), fileVersion };
        });

      const typeSet = new Set(files.map((f) => f.ext).filter(Boolean));
      const productsTokens = tokenizeCsv(productsRaw);
      const platformTokens = tokenizeCsv(platformRaw);

      const md5 = Array.isArray(p?.MD5sums) ? p.MD5sums : [];
      const sha256 = Array.isArray(p?.SHA256sums) ? p.SHA256sums : [];

      const searchBlob = (
        [
          name,
          qfeId,
          version,
          productsRaw,
          platformRaw,
          releaseDateText,
          files.map((f) => f.filename).join(" "),
        ].join(" | ")
      ).toLowerCase();

      const productsClamp = clampTextTokens(productsTokens, 2);
      const productsDisplay = productsClamp.more ? `${productsClamp.text} +${productsClamp.more}` : productsClamp.text;

      patches.push({
        name,
        qfeId,
        version,
        productsRaw,
        productsTokens,
        productsDisplay,
        platformRaw,
        platformTokens,
        releaseDateText,
        releaseDateMs,
        criticalRaw: p?.Critical,
        criticalKind,
        criticalDisplay: criticalLabel(criticalKind).label,
        patchPageUrl: String(p?.url ?? ""),
        files,
        types: Array.from(typeSet),
        md5,
        sha256,
        searchBlob,
      });
    }
  }

  patches.sort((a, b) => {
    if (b.releaseDateMs !== a.releaseDateMs) return b.releaseDateMs - a.releaseDateMs;
    const n = a.name.localeCompare(b.name);
    if (n !== 0) return n;
    return a.qfeId.localeCompare(b.qfeId);
  });

  return patches;
}

function buildOptions(patches) {
  // Build filter option lists (value + count), derived from the dataset.
  const productCounts = new Map();
  const versionCounts = new Map();
  const platformCounts = new Map();
  const typeCounts = new Map();

  for (const p of patches) {
    versionCounts.set(p.version, (versionCounts.get(p.version) || 0) + 1);
    for (const t of p.productsTokens) productCounts.set(t, (productCounts.get(t) || 0) + 1);
    for (const t of p.platformTokens) platformCounts.set(t, (platformCounts.get(t) || 0) + 1);
    for (const t of p.types) typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  }

  function toSortedList(m) {
    return Array.from(m.entries())
      .filter(([k]) => k)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }));
  }

  const versions = Array.from(versionCounts.entries())
    .filter(([k]) => k)
    .sort((a, b) => {
      const v = compareEsriEraVersionsDesc(a[0], b[0]);
      if (v !== 0) return v;
      // Stable tie-breaker: show the more common version first.
      return b[1] - a[1];
    })
    .map(([value, count]) => ({ value, count }));

  const productsAll = toSortedList(productCounts);
  const priority = [
    "ArcGIS Enterprise",
    "ArcGIS Server",
    "Portal for ArcGIS",
    "ArcGIS Data Store",
    "ArcGIS Web Adaptor (IIS)",
    "ArcMap",
  ];
  const prioritySet = new Set(priority);
  const byValue = new Map(productsAll.map((it) => [it.value, it]));
  const products = [];
  for (const p of priority) {
    const hit = byValue.get(p);
    if (hit) products.push(hit);
  }
  for (const it of productsAll) {
    if (!prioritySet.has(it.value)) products.push(it);
  }

  return {
    products,
    versions,
    platforms: toSortedList(platformCounts),
    types: toSortedList(typeCounts),
  };
}

// --- Filtering engine ---

function setComboboxItems(el, items) {
  el.innerHTML = "";
  for (const it of items) {
    const item = document.createElement("calcite-combobox-item");
    item.value = it.value;
    item.heading = it.value;
    item.description = `${it.count} patches`;
    el.appendChild(item);
  }
}

function readSelectedSet(comboboxEl) {
  // Prefer item-driven selection state. In some interactions Calcite updates `.value`
  // asynchronously, so reading from items/selectedItems is more reliable.
  try {
    const selected = comboboxEl.selectedItems;
    if (Array.isArray(selected)) {
      return new Set(selected.map((i) => String(i.value)).filter(Boolean));
    }
  } catch {
    // ignore
  }

  try {
    const items = comboboxEl.querySelectorAll("calcite-combobox-item");
    if (items && items.length) {
      const out = [];
      for (const it of items) {
        if (it.selected) out.push(String(it.value));
      }
      return new Set(out.filter(Boolean));
    }
  } catch {
    // ignore
  }

  const v = comboboxEl.value;
  if (Array.isArray(v)) return new Set(v.map(String).filter(Boolean));
  if (typeof v === "string" && v) return new Set([v]);
  return new Set();
}

function clearCombobox(comboboxEl) {
  try {
    comboboxSyncing.add(comboboxEl);
    comboboxEl.value = [];
  } finally {
    requestAnimationFrame(() => comboboxSyncing.delete(comboboxEl));
  }
  if ("filterText" in comboboxEl) comboboxEl.filterText = "";
}

function setComboboxValues(comboboxEl, values) {
  try {
    comboboxSyncing.add(comboboxEl);
    comboboxEl.value = Array.from(values || []);
  } finally {
    requestAnimationFrame(() => comboboxSyncing.delete(comboboxEl));
  }
  if ("filterText" in comboboxEl) comboboxEl.filterText = "";
}

function ensureCalciteReady() {
  // Calcite components are loaded via a module script in index.html.
  // If we set component properties before the elements are upgraded, the upgrade
  // can clobber those values and the UI won't reflect URL-hydrated state.
  if (calciteReadyPromise) return calciteReadyPromise;
  calciteReadyPromise = (async () => {
    try {
      if (!window.customElements || typeof window.customElements.whenDefined !== "function") return;

      await Promise.all([
        window.customElements.whenDefined("calcite-input-text"),
        window.customElements.whenDefined("calcite-combobox"),
        window.customElements.whenDefined("calcite-segmented-control"),
        window.customElements.whenDefined("calcite-input-date-picker"),
        window.customElements.whenDefined("calcite-shell-panel"),
        window.customElements.whenDefined("calcite-block"),
      ]);

      const nodes = [
        els.fQ,
        els.fProducts,
        els.fVersions,
        els.fPlatforms,
        els.fTypes,
        els.fCritical,
        els.fFrom,
        els.fTo,
        document.querySelector("calcite-block.help-block"),
      ].filter(Boolean);

      await Promise.all(
        nodes.map((el) => {
          try {
            return typeof el.componentOnReady === "function" ? el.componentOnReady() : null;
          } catch {
            return null;
          }
        })
      );
    } catch {
      // ignore
    }
  })();
  return calciteReadyPromise;
}

function applyHelpBlockHeaderAccent() {
  // Calcite Block renders its header in shadow DOM.
  // Apply a subtle left accent using inline styles and re-apply after toggles.
  try {
    const block = document.querySelector("calcite-block.help-block");
    const sr = block && block.shadowRoot;
    if (!sr) return false;

    // Keep selectors defensive across Calcite versions.
    const header = sr.querySelector("header#header") || sr.querySelector("header.header") || sr.querySelector("header");
    if (!header) return false;

    // Use inset shadow instead of border to avoid layout shifts.
    header.style.boxSizing = "border-box";
    header.style.boxShadow = "inset 5px 0 0 var(--calcite-color-status-success)";
    return true;
  } catch {
    return false;
  }
}

function wireHelpBlockHeaderAccent() {
  const block = document.querySelector("calcite-block.help-block");
  if (!block) return;
  if (block.dataset && block.dataset.helpAccentWired === "1") return;
  if (block.dataset) block.dataset.helpAccentWired = "1";

  const apply = () => {
    // Defer slightly in case the component re-renders after the event.
    requestAnimationFrame(() => {
      setTimeout(() => {
        applyHelpBlockHeaderAccent();
      }, 0);
    });
  };

  block.addEventListener("calciteBlockOpen", apply);
  block.addEventListener("calciteBlockClose", apply);
  block.addEventListener("calciteBlockExpand", apply);
  block.addEventListener("calciteBlockCollapse", apply);
}

function syncShellPanelDisplayMode() {
  const panel = document.getElementById("panel-start");
  if (!panel) return;
  const resultsPanel = document.querySelector("calcite-panel.results-card");

  const mql = window.matchMedia("(max-width: 900px)");
  const setMode = () => {
    // Per Calcite guidance, switch shell panel modes at smaller viewports.
    // On mobile, show overlay and collapse by default (single-column layout).
    // On larger screens, show docked two-column layout.
    const mobile = mql.matches;
    panel.setAttribute("display-mode", mobile ? "overlay" : "dock");
    if (mobile) panel.setAttribute("collapsed", "");
    else panel.removeAttribute("collapsed");

    if (resultsPanel) {
      if (!resultsPanel.dataset.desktopHeading) {
        resultsPanel.dataset.desktopHeading = resultsPanel.getAttribute("heading") || "Patches";
        resultsPanel.dataset.desktopDescription = resultsPanel.getAttribute("description") || "";
      }

      if (mobile) {
        resultsPanel.setAttribute("heading", "Simple Patch Finder");
        resultsPanel.setAttribute("description", "");
      } else {
        resultsPanel.setAttribute("heading", resultsPanel.dataset.desktopHeading || "Patches");
        resultsPanel.setAttribute("description", resultsPanel.dataset.desktopDescription || "");
      }
    }
  };

  setMode();
  try {
    if (typeof mql.addEventListener === "function") mql.addEventListener("change", setMode);
    else if (typeof mql.addListener === "function") mql.addListener(setMode);
  } catch {
    // ignore
  }
}

function setCriticalUI(value) {
  const v = String(value || "all");
  try {
    if (els.fCritical && "value" in els.fCritical) {
      // Segmented control exposes a `value` property for the selected item.
      els.fCritical.value = v;
    }
  } catch {
    // ignore
  }

  const items = els.fCritical.querySelectorAll("calcite-segmented-control-item");
  for (const it of items) {
    const on = String(it.value) === v;
    try {
      it.checked = on;
    } catch {
      // ignore
    }
    if (on) it.setAttribute("checked", "");
    else it.removeAttribute("checked");
  }
}

function applyFiltersToUI() {
  els.fQ.value = state.filters.q;
  setComboboxValues(els.fProducts, state.filters.products);
  setComboboxValues(els.fVersions, state.filters.versions);
  setComboboxValues(els.fPlatforms, state.filters.platforms);
  setComboboxValues(els.fTypes, state.filters.types);
  setCriticalUI(state.filters.critical);
  els.fFrom.value = state.filters.from;
  els.fTo.value = state.filters.to;
  patchAllComboboxCountChips();
}

function criticalLabel(kind) {
  if (kind === "security") return { label: "Security", icon: "lock", chipClass: "crit-chip--security" };
  if (kind === "critical") return { label: "Critical", icon: "exclamation-mark-triangle", chipClass: "crit-chip--critical" };
  return { label: "Standard", icon: "circle", chipClass: "crit-chip--standard" };
}

function criticalBadgeClass(kind) {
  if (kind === "security") return "crit-badge--security";
  if (kind === "critical") return "crit-badge--critical";
  return "crit-badge--standard";
}

function renderCriticalBadgeHtml(kind, label) {
  const cls = criticalBadgeClass(String(kind || "standard"));
  const text = escapeHtml(String(label || criticalLabel(kind).label || "Standard"));
  return `<span class="crit-badge ${cls}">${text}</span>`;
}

function inferFileVersionFromUrl(url) {
  const u = String(url || "");
  const name = filenameFromUrl(u);
  const candidates = new Set();

  // Prefer explicit separators: 11.4, 11_4, 10-9-1, etc.
  const s = `${u} ${name}`;
  const sepRe = /\b(9|10|11|12)[._-](\d{1,2})(?:[._-](\d{1,2}))?\b/g;
  for (const m of s.matchAll(sepRe)) {
    const major = m[1];
    const minor = m[2];
    const patch = m[3];
    candidates.add(patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`);
  }

  // Some ArcGIS filenames encode versions as digits: ArcGIS-111 -> 11.1, ArcGIS-114 -> 11.4, ArcGIS-1091 -> 10.9.1.
  // Restrict to the ArcGIS prefix to avoid misreading unrelated numeric tokens.
  const arcRe = /\barcgis[-_]?((?:9|10|11|12)(?:\d)(?:\d)?)\b/i;
  const arc = name.match(arcRe);
  if (arc && arc[1]) {
    const digits = arc[1];
    const m3 = digits.match(/^(9|10|11|12)(\d)(\d)?$/);
    if (m3) {
      const major = m3[1];
      const minor = m3[2];
      const patch = m3[3];
      candidates.add(patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`);
    }
  }

  if (!candidates.size) return "";

  // Pick the newest-looking candidate to keep ordering consistent.
  const list = Array.from(candidates);
  list.sort((a, b) => compareEsriEraVersionsDesc(a, b));
  return list[0] || "";
}

function clampTextTokens(tokens, max) {
  if (!tokens.length) return { text: "", more: 0 };
  if (tokens.length <= max) return { text: tokens.join(", "), more: 0 };
  return { text: tokens.slice(0, max).join(", "), more: tokens.length - max };
}

function anyTokenSelected(tokens, selectedSet) {
  if (!selectedSet || !selectedSet.size) return true;
  for (const t of tokens || []) {
    if (selectedSet.has(t)) return true;
  }
  return false;
}

function passesFiltersWithContext(p, qLower, fromMs, toMs) {
  // Fast, side-effect-free predicate used by applyAndRender.
  const f = state.filters;

  if (qLower) {
    if (!p.searchBlob.includes(qLower)) return false;
  }

  if (f.critical !== "all" && p.criticalKind !== f.critical) return false;

  if (!anyTokenSelected(p.productsTokens, f.products)) return false;

  if (f.versions.size && !f.versions.has(p.version)) return false;

  if (!anyTokenSelected(p.platformTokens, f.platforms)) return false;

  if (!anyTokenSelected(p.types, f.types)) return false;

  if (fromMs && p.releaseDateMs && p.releaseDateMs < fromMs) return false;
  // Inclusive end-date (treat "To" as end of day, local UI value is YYYY-MM-DD).
  if (toMs && p.releaseDateMs && p.releaseDateMs > toMs + 24 * 60 * 60 * 1000 - 1) return false;

  return true;
}

// --- Apply loop + rendering ---

function stableKeyFromSet(s) {
  return Array.from(s || [])
    .map(String)
    .sort((a, b) => a.localeCompare(b))
    .join("\u001f");
}

function computeApplyKey() {
  // A stable signature of the current filter state.
  // Used to avoid recomputing and re-rendering when nothing materially changed.
  const f = state.filters;
  return [
    datasetEpoch,
    String(f.q || "").trim().toLowerCase(),
    stableKeyFromSet(f.products),
    stableKeyFromSet(f.versions),
    stableKeyFromSet(f.platforms),
    stableKeyFromSet(f.types),
    String(f.critical || "all"),
    String(f.from || ""),
    String(f.to || ""),
  ].join("|");
}

function hasActiveFilters() {
  const f = state.filters;
  return Boolean(
    (f.q && f.q.trim()) ||
      f.products.size ||
      f.versions.size ||
      f.platforms.size ||
      f.types.size ||
      (f.critical && f.critical !== "all") ||
      f.from ||
      f.to
  );
}

function applyAndRender() {
  // Central "render pipeline". Any UI event should update state and call scheduleApply().
  const key = computeApplyKey();
  if (key === lastApplyKey) return;
  lastApplyKey = key;

  const active = hasActiveFilters();

  if (!active) {
    // Fast path: no need to scan the dataset if nothing is being filtered.
    state.filtered = state.all;
    renderGrid();
    try {
      if (gridBuilt && grid && typeof grid.setPage === "function") grid.setPage(1);
    } catch {
      // ignore
    }

    baseCountText = `${state.all.length.toLocaleString()} patches`;
    updateDatasetHint();
    syncLocationToFilters();
    updatePageTitle();
    return;
  }

  const qLower = String(state.filters.q || "").trim().toLowerCase();
  const fromMs = state.filters.from ? isoDateToMs(state.filters.from) : 0;
  const toMs = state.filters.to ? isoDateToMs(state.filters.to) : 0;

  state.filtered = state.all.filter((p) => passesFiltersWithContext(p, qLower, fromMs, toMs));
  renderGrid();

  // When filters change, reset pagination so the user doesn't land on an empty page.
  try {
    if (gridBuilt && grid && typeof grid.setPage === "function") grid.setPage(1);
  } catch {
    // ignore
  }

  const total = state.all.length;
  const shown = state.filtered.length;
  baseCountText = `${shown.toLocaleString()} / ${total.toLocaleString()} patches`;
  updateDatasetHint();

  syncLocationToFilters();
  updatePageTitle();
}

function clearPatchRoute() {
  activePatch = null;
  patchRoute = { pid: "", pn: "" };
  setDialogShareButtonState("default");
  updateDialogShareActionState();
  syncLocationToFilters();
  updatePageTitle();
}

function openPatch(p, opts = {}) {
  if (!p) return;
  const syncRoute = opts.syncRoute !== false;

  activePatch = p;
  if (syncRoute) patchRoute = patchRouteFromPatch(p);

  renderDialog(p);
  setDialogShareButtonState("default");
  updateDialogShareActionState();
  els.dlg.open = true;

  if (syncRoute) syncLocationToFilters();
  updatePageTitle();
}

function openPatchFromRouteIfNeeded() {
  if (!patchRoute.pid) return;
  const p = findPatchByRoute(patchRoute);
  if (!p) return;
  openPatch(p, { syncRoute: true });
}


function ensureGrid() {
  // Create the Tabulator instance once the vendor script is available.
  // Note: Tabulator is loaded via a classic deferred script, while this file is an ES module.
  // Some browsers/CDN timing can invert the expected order, so we poll defensively.
  if (grid) return true;
  // Wait for Tabulator CDN script.
  // eslint-disable-next-line no-undef
  if (typeof Tabulator === "undefined") {
    gridInitTries += 1;
    if (gridInitTries > 200) return false;
    setTimeout(() => {
      ensureGrid();
    }, 25);
    return false;
  }
  // eslint-disable-next-line no-undef
  grid = new Tabulator(els.grid, {
    height: "100%",
    layout: "fitColumns",
    autoResize: false,
    reactiveData: false,
    index: "_id",
    pagination: "local",
    paginationSize: PAGE_SIZE,
    paginationSizeSelector: false,
    sortMode: "local",
    data: [],
    placeholder: "No results",
    initialSort: [{ column: "releaseDateMs", dir: "desc" }],
    columns: [
      {
        title: "Patch",
        field: "name",
        sorter: "string",
        widthGrow: 7,
        minWidth: 340,
        formatter: (cell) => {
          const d = cell.getRow().getData();
          const name = escapeHtml(d.name || "(untitled patch)");
          const qfe = escapeHtml(d.qfeId || "");
          const rel = escapeHtml(d.releaseDateText || "");
          return `<div class="patch-name"><div>${name}</div><div class="patch-meta"><span class="mono">${qfe}</span><span>${rel}</span></div></div>`;
        },
      },
      {
        title: "Products",
        field: "productsDisplay",
        sorter: "string",
        widthGrow: 2,
        minWidth: 200,
        tooltip: (e, cell) => (cell.getRow().getData().productsTokens || []).join(", "),
      },
            {
              title: "Version",
              field: "version",
        width: 110,
        widthShrink: 1,
        // We enforce bucket precedence regardless of sort direction.
        // We also avoid Tabulator's internal inversion by always sorting "asc"
        // while switching our comparator direction.
        sorter: (a, b) => compareEsriEraVersions(a, b, versionSortMode),
              headerClick: (e, column) => {
                e.stopPropagation();
                versionSortMode = versionSortMode === "desc" ? "asc" : "desc";
                const colEl = column.getElement?.();
                // Keep Tabulator's dir fixed; our sorter uses versionSortMode.
                column.getTable().setSort([{ column: "version", dir: "asc" }]);

                // Sync the built-in Tabulator arrow to our effective sort direction.
                // Tabulator will set aria-sort based on its internal sort (always asc here),
                // so we override after it updates.
                if (colEl) {
                  requestAnimationFrame(() => {
                    colEl.setAttribute("aria-sort", versionSortMode === "asc" ? "ascending" : "descending");

              // Clear sort state visuals on other headers.
              const headers = colEl.closest(".tabulator-header");
              headers?.querySelectorAll(".tabulator-col").forEach((n) => {
                if (n !== colEl && (n.getAttribute("aria-sort") === "ascending" || n.getAttribute("aria-sort") === "descending")) {
                  n.setAttribute("aria-sort", "none");
                }
              });
            });
          }
        },
      },
      {
        title: "Platform",
        field: "platformRaw",
        sorter: "string",
        width: 150,
        widthShrink: 1,
        formatter: (cell) => {
          const d = cell.getRow().getData();
          return escapeHtml((d.platformTokens || []).join(", "));
        },
      },
      {
        title: "Release",
        field: "releaseDateMs",
        sorter: "number",
        width: 110,
        widthShrink: 1,
        formatter: (cell) => escapeHtml(cell.getRow().getData().releaseDateText || ""),
      },
      {
        title: "Critical",
        field: "criticalDisplay",
        sorter: "string",
        width: 130,
        widthShrink: 1,
        formatter: (cell) => {
          const d = cell.getRow().getData();
          const kind = String(d.criticalKind || "standard");
          const label = String(d.criticalDisplay || "");
          return renderCriticalBadgeHtml(kind, label);
        },
      },
      {
        title: "Links",
        field: "patchPageUrl",
        width: 110,
        widthShrink: 1,
        hozAlign: "left",
        headerSort: false,
        formatter: (cell) => {
          const d = cell.getRow().getData();
          const rawUrl = String(d.patchPageUrl || "").trim();
          const safeUrl = sanitizeHttpUrl(rawUrl);
          const url = safeUrl ? escapeAttr(safeUrl) : "";
          const ext =
            url
              ? `<calcite-action class="row-action row-action--ext" data-action="ext" data-url="${url}" icon="launch" text="Open Esri page" label="Open Esri page" scale="s"></calcite-action>`
              : `<calcite-action class="row-action row-action--ext" data-action="ext" icon="launch" text="Open Esri page" label="Open Esri page" scale="s" disabled></calcite-action>`;
          return `
            <div class="row-actions">
              <calcite-action class="row-action row-action--info" data-action="info" icon="information" text="Details" label="Details" scale="s"></calcite-action>
              ${ext}
            </div>
          `;
        },
        cellClick: (e, cell) => {
          const t = e.target;
          const el = t && typeof t.closest === "function" ? t.closest("[data-action]") : null;
          if (!el) return;

          const action = el.getAttribute("data-action") || "";
          if (action === "info") {
            e.stopPropagation();
            try {
              const row = cell && typeof cell.getRow === "function" ? cell.getRow() : null;
              const d = row && typeof row.getData === "function" ? row.getData() : null;
              if (d) openPatch(d);
            } catch {
              // ignore
            }
            return;
          }

          if (action === "ext") {
            // Open external link and prevent row click opening the dialog.
            e.stopPropagation();
            const raw = String(el.getAttribute("data-url") || "").trim();
            const href = sanitizeHttpUrl(raw);
            if (href) {
              try {
                window.open(href, "_blank", "noopener,noreferrer");
              } catch {
                // ignore
              }
            }
            return;
          }
        },
      },
    ],
  });

  grid.on("rowClick", (e, row) => {
    const path = e.composedPath?.() || [];
    const clickedLinkish = path.some((n) => {
      if (!(n instanceof HTMLElement)) return false;
      return n.matches?.("a, calcite-button, calcite-action, button");
    });
    if (clickedLinkish) return;
    openPatch(row.getData());
  });

  grid.on("tableBuilt", () => {
    gridBuilt = true;

    // Initial visual state for Version header.
    try {
      const versionCol = grid.getColumn("version");
      const el = versionCol?.getElement?.();
      if (el) el.setAttribute("aria-sort", versionSortMode === "asc" ? "ascending" : "descending");
    } catch {
      // Ignore; header will still work via click handling.
    }

    if (pendingGridData) {
      grid.setData(pendingGridData);
      pendingGridData = null;
    }
  });

  return true;
}

// Prevent occasional teardown errors on navigation/reload.
window.addEventListener("beforeunload", () => {
  try {
    if (grid && typeof grid.destroy === "function") grid.destroy();
  } catch {
    // ignore
  }
});

function renderGrid() {
  if (!ensureGrid()) {
    // Grid not ready yet; try again shortly.
    setTimeout(renderGrid, 25);
    return;
  }

  if (!gridBuilt) {
    pendingGridData = state.filtered;
    return;
  }

  // replaceData is faster than rebuilding the table.
  grid.replaceData(state.filtered);
}

function renderDialog(p) {
  // Patch details dialog is built as HTML strings for speed and simplicity.
  // All dynamic content is escaped via escapeHtml/escapeAttr.
  els.dlg.heading = p.name || "Patch";
  const critLabel = String(p.criticalDisplay || criticalLabel(p.criticalKind).label || "Standard");

  const products = p.productsTokens.length ? p.productsTokens.join(", ") : p.productsRaw;
  const platforms = p.platformTokens.length ? p.platformTokens.join(", ") : p.platformRaw;

  const md5Text = (p.md5 || []).join("\n");
  const shaText = (p.sha256 || []).join("\n");

  const filesSorted = (p.files || []).slice().sort((a, b) => {
    const av = a.fileVersion || "";
    const bv = b.fileVersion || "";
    const isA = av && av === p.version;
    const isB = bv && bv === p.version;
    if (isA !== isB) return isA ? -1 : 1;
    const cmp = compareEsriEraVersionsDesc(av || p.version || "", bv || p.version || "");
    if (cmp !== 0) return cmp;
    return String(a.filename || "").localeCompare(String(b.filename || ""));
  });

  const safePatchPageUrl = sanitizeHttpUrl(p.patchPageUrl);

  const fileRowsHtml = filesSorted
    .map((f) => {
      const v = escapeHtml(f.fileVersion || p.version || "");
      const safeFileUrl = sanitizeHttpUrl(f.url);
      return (
        `<calcite-table-row>
          <calcite-table-cell>${v}</calcite-table-cell>
          <calcite-table-cell>${escapeHtml(f.filename)}</calcite-table-cell>
          <calcite-table-cell>
            <div class="url-full">
              ${
                safeFileUrl
                  ? `<calcite-link href="${escapeAttr(safeFileUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safeFileUrl)}</calcite-link>`
                  : `<span class="dim">Invalid URL</span>`
              }
            </div>
          </calcite-table-cell>
        </calcite-table-row>`
      );
    })
    .join("");

  els.dlgBody.innerHTML = `
    <div class="dlg-wrap">
      <div class="dlg-summary">
        <div class="dlg-summary-title">
          <div class="dlg-critical"></div>
        </div>

        <div class="dlg-facts">
          <div class="dlg-fact">
            <div class="k">Version</div>
            <div class="v">${escapeHtml(p.version || "")}</div>
            <div style="margin-top: 6px">
              ${renderCriticalBadgeHtml(p.criticalKind, critLabel)}
            </div>
          </div>
          <div class="dlg-fact"><div class="k">Release</div><div class="v">${escapeHtml(p.releaseDateText || "")}</div></div>
          <div class="dlg-fact"><div class="k">QFE</div><div class="v mono">${p.qfeId ? escapeHtml(p.qfeId) : "&mdash;"}</div></div>
          <div class="dlg-fact"><div class="k">Platform</div><div class="v">${escapeHtml(platforms || "")}</div></div>
        </div>
      </div>

      <div class="dlg-section">
        <div class="dlg-section-header">Context</div>
        <div class="dlg-section-body">
          <div>
            <div class="dim" style="margin-bottom: 4px">Products</div>
            <div>${escapeHtml(products || "")}</div>
          </div>

          <div>
            <div class="dim" style="margin-bottom: 4px">Patch page</div>
            ${
              safePatchPageUrl
                ? `<div class="url-full"><calcite-link href="${escapeAttr(safePatchPageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safePatchPageUrl)}</calcite-link></div>`
                : `<div class="dim">&mdash;</div>`
            }
          </div>
        </div>
      </div>

      <div class="dlg-section">
        <div class="dlg-section-header">Files</div>
        <div class="dlg-section-body">
          ${
            p.files.length
              ? `<calcite-table caption="Patch files" bordered striped>
                  <calcite-table-row slot="table-header">
                    <calcite-table-header heading="Version"></calcite-table-header>
                    <calcite-table-header heading="File"></calcite-table-header>
                    <calcite-table-header heading="Link"></calcite-table-header>
                  </calcite-table-row>
                  ${fileRowsHtml}
                </calcite-table>`
              : `<div class="dim">No PatchFiles listed.</div>`
          }
        </div>
      </div>

      ${(p.md5 && p.md5.length) || (p.sha256 && p.sha256.length)
        ? `
        <div class="dlg-section">
          <div class="dlg-section-header">Checksums</div>
          <div class="dlg-section-body">
            ${p.sha256 && p.sha256.length ? `<div class="mono" style="white-space: pre-wrap">${escapeHtml(shaText)}</div>` : ""}
            ${p.md5 && p.md5.length ? `<div class="mono" style="white-space: pre-wrap">${escapeHtml(md5Text)}</div>` : ""}
          </div>
        </div>`
        : ""}
    </div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(s) {
  // Keep it simple; used only for href values.
  return escapeHtml(s).replaceAll("`", "");
}

function sanitizeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw, window.location.origin);
    const proto = String(parsed.protocol || "").toLowerCase();
    if (proto !== "http:" && proto !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function resetFilters() {
  state.filters.q = "";
  state.filters.products = new Set();
  state.filters.versions = new Set();
  state.filters.platforms = new Set();
  state.filters.types = new Set();
  state.filters.critical = "all";
  state.filters.from = "";
  state.filters.to = "";

  applyFiltersToUI();
  scheduleApply();
}

let qTimer = null;
let shareBtnTimer = null;
let shareBtnDefaultText = null;
let shareBtnDefaultIcon = null;
let dlgShareBtnTimer = null;
let dlgShareDefaultText = null;
let dlgShareDefaultIcon = null;
let applyPending = false;
let lastSyncedLocation = "";

function setMainShareButtonState(state) {
  if (shareBtnTimer) {
    clearTimeout(shareBtnTimer);
    shareBtnTimer = null;
  }
  if (state === "copied") {
    els.btnShare.setAttribute("icon-start", "check-circle");
    els.btnShare.textContent = "Copied";
    shareBtnTimer = setTimeout(() => {
      els.btnShare.setAttribute("icon-start", shareBtnDefaultIcon || "link");
      els.btnShare.textContent = shareBtnDefaultText || "Share";
      shareBtnTimer = null;
    }, 2200);
    return;
  }
  els.btnShare.setAttribute("icon-start", shareBtnDefaultIcon || "link");
  els.btnShare.textContent = shareBtnDefaultText || "Share";
}

function setDialogShareButtonState(state) {
  if (!els.btnDlgShare) return;
  if (dlgShareBtnTimer) {
    clearTimeout(dlgShareBtnTimer);
    dlgShareBtnTimer = null;
  }

  if (state === "copied") {
    els.btnDlgShare.setAttribute("icon-start", "check-circle");
    els.btnDlgShare.textContent = "Copied";
    dlgShareBtnTimer = setTimeout(() => {
      els.btnDlgShare.setAttribute("icon-start", dlgShareDefaultIcon || "link");
      els.btnDlgShare.textContent = dlgShareDefaultText || "Permalink";
      dlgShareBtnTimer = null;
    }, 2200);
    return;
  }

  els.btnDlgShare.setAttribute("icon-start", dlgShareDefaultIcon || "link");
  els.btnDlgShare.textContent = dlgShareDefaultText || "Permalink";
}

async function copyToClipboard(text) {
  // Prefer modern Clipboard API, but keep an execCommand fallback for more environments.
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand fallback
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

async function shareUrlWithAlert(url, opts = {}) {
  const titleEl = els.shareAlert.querySelector('[slot="title"]');
  const msgEl = els.shareAlert.querySelector('[slot="message"]');

  els.shareLink.href = url;
  els.shareLink.textContent = url;

  try {
    const ok = await copyToClipboard(url);
    if (!ok) throw new Error("copy failed");
    els.shareAlert.kind = "success";
    els.shareAlert.icon = "check-circle";
    if (titleEl) titleEl.textContent = opts.copiedTitle || "Copied";
    if (typeof opts.onCopied === "function") opts.onCopied();
    if (msgEl) {
      const hint = msgEl.querySelector(".share-hint");
      if (hint) hint.remove();
      const span = document.createElement("span");
      span.className = "share-hint";
      span.textContent = (opts.copiedPrefix || "Share link copied. ");
      msgEl.prepend(span);
    }
  } catch {
    // Clipboard can fail in some environments; the alert still shows the URL.
    els.shareAlert.kind = "info";
    els.shareAlert.icon = "information";
    if (titleEl) titleEl.textContent = opts.defaultTitle || "Share link";
    if (typeof opts.onCopyFailed === "function") opts.onCopyFailed();
  }

  els.shareAlert.open = true;
}

function updateDialogShareActionState() {
  if (!els.btnDlgShare) return;
  const enabled = !!activePatch;
  try {
    els.btnDlgShare.disabled = !enabled;
  } catch {
    // ignore
  }
  if (enabled) els.btnDlgShare.removeAttribute("disabled");
  else els.btnDlgShare.setAttribute("disabled", "");
}

function scheduleApply() {
  // Batch rapid UI events into one apply pass per animation frame.
  if (applyPending) return;
  applyPending = true;
  requestAnimationFrame(() => {
    applyPending = false;
    applyAndRender();
  });
}

function wireEvents() {
  // Wire all UI controls -> state updates -> scheduleApply.
  // Search input uses a debounce to avoid thrashing the grid while typing.
  // Capture default share button state once.
  if (shareBtnDefaultText == null) shareBtnDefaultText = String(els.btnShare.textContent || "").trim() || "Share";
  if (shareBtnDefaultIcon == null) shareBtnDefaultIcon = els.btnShare.getAttribute("icon-start") || "link";
  if (els.btnDlgShare && dlgShareDefaultText == null) {
    dlgShareDefaultText = String(els.btnDlgShare.textContent || "").trim() || "Permalink";
  }
  if (els.btnDlgShare && dlgShareDefaultIcon == null) {
    dlgShareDefaultIcon = els.btnDlgShare.getAttribute("icon-start") || "link";
  }

  if (els.dlg) {
    const onDialogClose = () => {
      if (!els.dlg.open && (activePatch || patchRoute.pid || patchRoute.pn)) clearPatchRoute();
    };

    els.dlg.addEventListener("calciteDialogClose", onDialogClose);
    els.dlg.addEventListener("close", onDialogClose);

    const obs = new MutationObserver(onDialogClose);
    obs.observe(els.dlg, { attributes: true, attributeFilter: ["open"] });
  }

  const onQueryInput = () => {
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.filters.q = String(els.fQ.value || "").trim();
      scheduleApply();
    }, 350);
  };

  const syncQueryAfterUiClear = () => {
    // Calcite's clear button can clear the visible value without dispatching `input`.
    // Read the value after the click/keydown cycle and apply if it changed.
    setTimeout(() => {
      const next = String(els.fQ.value || "").trim();
      if (next !== state.filters.q) {
        state.filters.q = next;
        scheduleApply();
      }
    }, 0);
  };

  // Calcite emits custom events for clearable/value changes; listen to both.
  els.fQ.addEventListener("input", onQueryInput);
  els.fQ.addEventListener("calciteInputInput", onQueryInput);
  els.fQ.addEventListener("calciteInputChange", onQueryInput);
  els.fQ.addEventListener("click", (e) => {
    const path = e.composedPath?.() || [];
    // Note: this relies on an internal Calcite className ("clear-button") as a fallback.
    const clickedClear = path.some((n) => n instanceof HTMLElement && n.classList?.contains("clear-button"));
    if (clickedClear) syncQueryAfterUiClear();
  });
  els.fQ.addEventListener("keydown", (e) => {
    if (e.key === "Escape") syncQueryAfterUiClear();
  });

  function onCombobox(e) {
    // Calcite updates `.value`/`selectedItems` asynchronously for some interactions.
    // Defer reading selections to ensure state has settled (especially on unselect).
    requestAnimationFrame(() => {
      const t = e?.target;

      if (t && comboboxSyncing.has(t)) return;

      if (t === els.fProducts) state.filters.products = readSelectedSet(els.fProducts);
      else if (t === els.fVersions) state.filters.versions = readSelectedSet(els.fVersions);
      else if (t === els.fPlatforms) state.filters.platforms = readSelectedSet(els.fPlatforms);
      else if (t === els.fTypes) state.filters.types = readSelectedSet(els.fTypes);
      else {
        // Fallback: update everything.
        state.filters.products = readSelectedSet(els.fProducts);
        state.filters.versions = readSelectedSet(els.fVersions);
        state.filters.platforms = readSelectedSet(els.fPlatforms);
        state.filters.types = readSelectedSet(els.fTypes);
      }

      patchAllComboboxCountChips();
      scheduleApply();
    });
  }

  for (const el of [els.fProducts, els.fVersions, els.fPlatforms, els.fTypes]) {
    el.addEventListener("calciteComboboxChange", onCombobox);
    // When a selected chip is removed via its close button, Calcite emits a
    // dedicated event. Listen to it so URL + count update on unselect.
    el.addEventListener("calciteComboboxChipClose", onCombobox);
  }

  els.fCritical.addEventListener("calciteSegmentedControlChange", () => {
    const selected = els.fCritical.selectedItem;
    state.filters.critical = String(selected?.value || "all");
    scheduleApply();
  });

  function onDate() {
    state.filters.from = String(els.fFrom.value || "");
    state.filters.to = String(els.fTo.value || "");
    scheduleApply();
  }

  els.fFrom.addEventListener("calciteInputDatePickerChange", onDate);
  els.fTo.addEventListener("calciteInputDatePickerChange", onDate);

  els.btnShare.addEventListener("click", async () => {
    // Share button updates an alert and attempts to copy the URL.
    await shareUrlWithAlert(buildShareUrl(), {
      copiedTitle: "Copied",
      defaultTitle: "Share link",
      copiedPrefix: "Share link copied. ",
      onCopied: () => setMainShareButtonState("copied"),
      onCopyFailed: () => setMainShareButtonState("default"),
    });
  });

  if (els.btnDlgShare) {
    els.btnDlgShare.addEventListener("click", async () => {
      if (!activePatch) return;
      await shareUrlWithAlert(buildPatchPermalinkUrl(activePatch), {
        copiedTitle: "Permalink copied",
        defaultTitle: "Patch permalink",
        copiedPrefix: "Patch permalink copied. ",
        onCopied: () => setDialogShareButtonState("copied"),
        onCopyFailed: () => setDialogShareButtonState("default"),
      });
    });
  }

  updateDialogShareActionState();

  if (els.btnTogglePanel) {
    els.btnTogglePanel.addEventListener("click", () => {
      const panel = document.getElementById("panel-start");
      if (!panel) return;
      const mobile = window.matchMedia("(max-width: 900px)").matches;
      if (!mobile) return;

      const collapsed = panel.hasAttribute("collapsed") || !!panel.collapsed;
      if (collapsed) {
        panel.removeAttribute("collapsed");
        try {
          panel.collapsed = false;
        } catch {
          // ignore
        }
      } else {
        panel.setAttribute("collapsed", "");
        try {
          panel.collapsed = true;
        } catch {
          // ignore
        }
      }
    });
  }

  if (els.btnReset) els.btnReset.addEventListener("click", resetFilters);
  if (els.btnResetFilters) els.btnResetFilters.addEventListener("click", resetFilters);

}

async function loadDataset() {
  // Load raw dataset and normalize into PatchRow[].
  setStatusText("Loading...");
  try {
    const res = await fetch("./patches.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ./patches.json`);
    const data = await res.json();
    state.all = normalizeDataset(data);
    state.options = buildOptions(state.all);
    datasetEpoch += 1;
    lastApplyKey = "";

    setComboboxItems(els.fProducts, state.options.products);
    setComboboxItems(els.fVersions, state.options.versions);
    setComboboxItems(els.fPlatforms, state.options.platforms);
    setComboboxItems(els.fTypes, state.options.types);

    window.__spf = {
      versionsOrdered: state.options.versions.map((v) => v.value),
      compareEsriEraVersions,
    };

    // Ensure UI reflects any URL-hydrated filter state.
    await ensureCalciteReady();
    applyFiltersToUI();
    wireHelpBlockHeaderAccent();
    applyHelpBlockHeaderAccent();

    // applyAndRender sets the count text.
    applyAndRender();
    openPatchFromRouteIfNeeded();
  } catch (err) {
    setStatusText("Missing patches.json");
    // keep current status text
    // Clear table body rows.
    state.all = [];
    state.filtered = [];
    if (grid) grid.replaceData([]);
    if (grid) grid.setOptions({ placeholder: "Missing ./patches.json (see About)" });
    console.error(err);
  }
}

hydrateFiltersFromLocation();
wireEvents();
loadDatasetMeta();

// If filters were hydrated from the URL, apply them after Calcite upgrades.
// (loadDataset will do this again after options are populated.)
ensureCalciteReady()
  .then(() => {
    applyFiltersToUI();
    syncShellPanelDisplayMode();
    wireHelpBlockHeaderAccent();
    applyHelpBlockHeaderAccent();
  })
  .catch(() => {
    // ignore
  });

loadDataset();
