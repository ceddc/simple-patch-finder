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

  fQ: document.getElementById("f-q"),
  fProducts: document.getElementById("f-products"),
  fVersions: document.getElementById("f-versions"),
  fPlatforms: document.getElementById("f-platforms"),
  fTypes: document.getElementById("f-types"),
  fCritical: document.getElementById("f-critical"),
  fFrom: document.getElementById("f-from"),
  fTo: document.getElementById("f-to"),

  btnShare: document.getElementById("btn-share"),
  btnReset: document.getElementById("btn-reset"),
  btnResetFilters: document.getElementById("btn-reset-filters"),
};

const PAGE_SIZE = 25;

let grid = null;
let gridInitTries = 0;
let gridBuilt = false;
let pendingGridData = null;

let calciteReadyPromise = null;

let datasetEpoch = 0;
let lastApplyKey = "";

let datasetLoadedAt = null;
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
  return params;
}

function buildShareUrl() {
  // Full, absolute URL used by the Share button and for copying.
  const params = serializeFiltersToParams();
  const base = `${location.origin}${location.pathname}`;
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function syncLocationToFilters() {
  // Keep the address bar in sync with current filters (shareable URL), without navigation.
  // Only include non-default filters to keep URLs short and stable.
  const params = serializeFiltersToParams();
  const qs = params.toString();
  const desired = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash || ""}`;
  const current = `${location.pathname}${location.search}${location.hash || ""}`;
  if (desired === current) return;
  if (desired === lastSyncedLocation) return;
  try {
    history.replaceState({}, "", desired);
    lastSyncedLocation = desired;
  } catch {
    // ignore
  }
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
}

// --- Core parsing helpers ---

function setStatusText(text) {
  baseCountText = text;
  updateDatasetHint();
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
    if (t) parts.push(`Updated: ${t}`);
  }
  if (datasetLoadedAt) {
    const t = formatLocalDateTime(datasetLoadedAt);
    if (t) parts.push(`Loaded: ${t}`);
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

  return {
    products: toSortedList(productCounts),
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
  const v = comboboxEl.value;
  if (Array.isArray(v)) return new Set(v.map(String).filter(Boolean));
  if (typeof v === "string" && v) return new Set([v]);
  // Fallback
  const selected = comboboxEl.selectedItems || [];
  return new Set(selected.map((i) => i.value).filter(Boolean));
}

function clearCombobox(comboboxEl) {
  comboboxEl.value = [];
  if ("filterText" in comboboxEl) comboboxEl.filterText = "";
}

function setComboboxValues(comboboxEl, values) {
  comboboxEl.value = Array.from(values || []);
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
  // Calcite Block is a shadow-DOM component; we add a small accent by styling
  // its internal header node after upgrade. This is purely visual.
  try {
    const block = document.querySelector("calcite-block.help-block");
    const sr = block && block.shadowRoot;
    if (!sr) return false;
    const header = sr.querySelector("header#header") || sr.querySelector("header.header");
    if (!header) return false;

    // Keep this subtle: small accent, square corners, muted color.
    header.style.boxSizing = "border-box";
    header.style.overflow = "visible";
    header.style.borderTopLeftRadius = "0px";
    header.style.borderBottomLeftRadius = "0px";

    // Use inset shadow to avoid shifting layout like a real border would.
    header.style.boxShadow =
      "inset 5px 0 0 color-mix(in srgb, var(--calcite-color-status-success) 55%, var(--calcite-color-border-1))";
    return true;
  } catch {
    return false;
  }
}

function wireHelpBlockHeaderAccent() {
  const block = document.querySelector("calcite-block.help-block");
  if (!block) return;
  if (block.dataset && block.dataset.accentWired === "1") return;
  if (block.dataset) block.dataset.accentWired = "1";

  const apply = () => {
    // Defer slightly in case the component re-renders after the event.
    setTimeout(() => {
      applyHelpBlockHeaderAccent();
    }, 0);
  };

  block.addEventListener("calciteBlockOpen", apply);
  block.addEventListener("calciteBlockClose", apply);
  block.addEventListener("calciteBlockExpand", apply);
  block.addEventListener("calciteBlockCollapse", apply);
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
}

function criticalLabel(kind) {
  if (kind === "security") return { label: "Security", icon: "lock", chipClass: "crit-chip--security" };
  if (kind === "critical") return { label: "Critical", icon: "exclamation-mark-triangle", chipClass: "crit-chip--critical" };
  return { label: "Standard", icon: "circle", chipClass: "crit-chip--standard" };
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
}

function openPatch(p) {
  if (!p) return;
  renderDialog(p);
  els.dlg.open = true;
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
          const label = escapeHtml(String(d.criticalDisplay || ""));
          if (kind === "security") {
            return `<span class="crit-badge crit-badge--security">${label}</span>`;
          }
          if (kind === "critical") {
            return `<span class="crit-badge crit-badge--critical">${label}</span>`;
          }
          return `<span class="crit-badge crit-badge--standard">${label}</span>`;
        },
      },
      {
        title: "Links",
        field: "patchPageUrl",
        width: 150,
        widthShrink: 1,
        hozAlign: "left",
        headerSort: false,
        formatter: (cell) => {
          const d = cell.getRow().getData();
          const rawUrl = String(d.patchPageUrl || "").trim();
          if (!rawUrl) return `<span class="dim">&mdash;</span>`;
          const url = escapeAttr(rawUrl);
          return `<a class="patch-link-btn accent-2" href="${url}" target="_blank" rel="noopener noreferrer">Patch page</a>`;
        },
        cellClick: (e) => {
          // Don't trigger rowClick when interacting with links.
          e.stopPropagation();
        },
      },
    ],
  });

  grid.on("rowClick", (e, row) => {
    const path = e.composedPath?.() || [];
    const clickedLinkish = path.some((n) => {
      if (!(n instanceof HTMLElement)) return false;
      return n.matches?.("a, calcite-button, button");
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
  const crit = criticalLabel(p.criticalKind);

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

  const fileRowsHtml = filesSorted
    .map((f) => {
      const v = escapeHtml(f.fileVersion || p.version || "");
      return (
        `<calcite-table-row>
          <calcite-table-cell>${v}</calcite-table-cell>
          <calcite-table-cell>${escapeHtml(f.filename)}</calcite-table-cell>
          <calcite-table-cell>
            <div class="url-full">
              <calcite-link href="${escapeAttr(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.url)}</calcite-link>
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
              <calcite-chip
                class="crit-chip ${crit.chipClass}"
                scale="s"
                kind="neutral"
                appearance="outline"
                icon="${escapeAttr(crit.icon)}"
                label="${escapeAttr(crit.label)}"
              >${escapeHtml(crit.label)}</calcite-chip>
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
              p.patchPageUrl
                ? `<div class="url-full"><calcite-link href="${escapeAttr(p.patchPageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.patchPageUrl)}</calcite-link></div>`
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
let applyPending = false;
let lastSyncedLocation = "";
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
    const t = e?.target;
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
    scheduleApply();
  }

  for (const el of [els.fProducts, els.fVersions, els.fPlatforms, els.fTypes]) {
    el.addEventListener("calciteComboboxChange", onCombobox);
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
    const url = buildShareUrl();
    els.shareLink.href = url;
    els.shareLink.textContent = url;
    const titleEl = els.shareAlert.querySelector('[slot="title"]');
    const msgEl = els.shareAlert.querySelector('[slot="message"]');

    const setShareButtonState = (state) => {
      if (shareBtnTimer) {
        clearTimeout(shareBtnTimer);
        shareBtnTimer = null;
      }
      if (state === "copied") {
        els.btnShare.setAttribute("icon-start", "check");
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
    };

    const copyToClipboard = async (text) => {
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
    };

    try {
      const ok = await copyToClipboard(url);
      if (!ok) throw new Error("copy failed");
      els.shareAlert.kind = "success";
      els.shareAlert.icon = "check-circle";
      if (titleEl) titleEl.textContent = "Copied";
      setShareButtonState("copied");
      if (msgEl) {
        const hint = msgEl.querySelector(".share-hint");
        if (hint) hint.remove();
        const span = document.createElement("span");
        span.className = "share-hint";
        span.textContent = "Share link copied. ";
        msgEl.prepend(span);
      }
    } catch {
      // Clipboard can fail in some environments; the alert still shows the URL.
      els.shareAlert.kind = "info";
      els.shareAlert.icon = "information";
      if (titleEl) titleEl.textContent = "Share link";
      setShareButtonState("default");
    }
    els.shareAlert.open = true;
  });

  if (els.btnReset) els.btnReset.addEventListener("click", resetFilters);
  if (els.btnResetFilters) els.btnResetFilters.addEventListener("click", resetFilters);

}

async function loadDataset() {
  // Load raw dataset and normalize into PatchRow[].
  setStatusText("Loading...");
  try {
    const res = await fetch("./patches.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} loading ./patches.json`);
    datasetLoadedAt = new Date();
    updateDatasetHint();
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

    // applyAndRender sets the count text.
    applyAndRender();
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
    applyHelpBlockHeaderAccent();
    wireHelpBlockHeaderAccent();
  })
  .catch(() => {
    // ignore
  });

loadDataset();
