// Set canonical and robots metadata before UI dependencies load.
// Leave candidate category/patch pages indexable until the dataset validates them.
(function () {
  const base = "https://simplepatchfinder.ceddc.dev/";
  const params = new URLSearchParams(location.search);
  const output = new URLSearchParams();
  const pid = String(params.get("pid") || params.get("amp;pid") || "").trim();
  const products = [...new Set(String(params.get("p") || "").split("|").map(value => {
    try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
  }).filter(Boolean))];
  const slugs = [...new Set(products.map(value => value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180)).filter(Boolean))];
  const facets = ["q", "v", "os", "t", "from", "to"];
  let noindex = facets.some(key => String(params.get(key) || "").trim())
    || slugs.length > 1 || ["security", "critical"].includes(String(params.get("c") || "").trim())
    || Number.parseInt(params.get("page"), 10) > 1;

  if (pid) {
    noindex = !/^[A-Za-z0-9._-]{2,80}$/.test(pid);
    output.set("pid", pid);
    const pn = String(params.get("pn") || params.get("amp;pn") || "").trim().toLowerCase();
    if (/^[a-z0-9-]{2,180}$/.test(pn)) output.set("pn", pn);
  } else if (slugs.length === 1) {
    output.set("p", slugs[0]);
  }
  if (noindex) {
    document.querySelector('meta[name="robots"]').content = "noindex,follow";
    return;
  }
  const link = document.createElement("link");
  link.rel = "canonical";
  link.href = base + (output.size ? "?" + output.toString() : "");
  document.head.appendChild(link);
})();
