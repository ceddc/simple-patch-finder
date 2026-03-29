#!/usr/bin/env python3
"""Generate a single sitemap.xml for search engines.

The sitemap includes:
- homepage
- paginated homepage listing URLs (?page=...)
- single-product landing URLs (?p=...)
- paginated single-product listing URLs (?p=...&page=...)
- patch deep links (?pid=...&pn=...)

Metadata included per URL:
- lastmod
- changefreq
- priority
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date, datetime
from html import escape
from pathlib import Path
from urllib.parse import quote

BASE_URL = "https://simplepatchfinder.ceddc.dev/"
ROOT = Path(__file__).resolve().parents[1]
PATCHES_JSON = ROOT / "patches.json"
PATCHES_META_JSON = ROOT / "patches.meta.json"
SITEMAP_XML = ROOT / "sitemap.xml"
PAGE_SIZE = 25

# Keep this set in sync with js/app.js and scripts/generate_rss.py.
ENTERPRISE_FAMILY_TOKENS = {
    "ArcGIS Enterprise",
    "ArcGIS Server",
    "Portal for ArcGIS",
    "ArcGIS Data Store",
    "ArcGIS GeoEvent Server",
    "GeoEvent",
    "ArcGIS Notebook Server",
    "ArcGIS Mission Server",
    "ArcGIS Video Server",
    "ArcGIS Knowledge Server",
    "ArcGIS Workflow Manager Server",
    "ArcGIS Image Server",
    "ArcGIS Web Adaptor (IIS)",
    "ArcGIS Web Adaptor (Java Platform)",
    "ArcGIS GeoAnalytics Server",
    "ArcGIS Data Interoperability for Server",
    "ArcGIS Maritime for Server",
    "Maritime Server",
    "ArcGIS Roads and Highways for Server",
    "ArcGIS Production Mapping for Server",
    "ArcGIS Defense Mapping for Server",
    "Esri Production Mapping for Server",
    "Esri Defense Mapping for Server",
}


@dataclass(frozen=True)
class UrlEntry:
    loc: str
    lastmod: str = ""
    changefreq: str = ""
    priority: str = ""


def write_text_lf(path: Path, content: str) -> None:
    # Force Unix newlines even when generated on Windows.
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def slugify_patch_name(name: str) -> str:
    s = (name or "").lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"(^-+|-+$)", "", s)
    return s[:180]


def slugify_filter_token(value: str) -> str:
    s = (value or "").lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"(^-+|-+$)", "", s)
    return s[:180]


def tokenize_csv(value: str) -> list[str]:
    return [t.strip() for t in (value or "").split(",") if t.strip()]


def parse_release_date(value: str) -> str:
    """Convert MM/DD/YYYY to YYYY-MM-DD. Returns empty string if invalid."""
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", (value or "").strip())
    if not m:
        return ""
    mm, dd, yyyy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return date(yyyy, mm, dd).isoformat()
    except ValueError:
        return ""


def parse_isoish(value: str) -> datetime | None:
    raw = (value or "").strip()
    if not raw:
        return None

    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        return datetime.fromisoformat(raw)
    except ValueError:
        pass

    try:
        return datetime.combine(date.fromisoformat(raw), datetime.min.time())
    except ValueError:
        return None


def newer_lastmod(a: str, b: str) -> str:
    if not a:
        return b
    if not b:
        return a
    da = parse_isoish(a)
    db = parse_isoish(b)
    if da and db:
        return a if da >= db else b
    return max(a, b)


def read_dataset_lastmod() -> str:
    if not PATCHES_META_JSON.exists():
        return ""
    try:
        meta = json.loads(PATCHES_META_JSON.read_text(encoding="utf-8"))
        return str(meta.get("updated_at_utc", "")).strip()
    except Exception:
        return ""


def get_max_page(total_rows: int) -> int:
    if total_rows <= 0:
        return 1
    return max(1, (total_rows + PAGE_SIZE - 1) // PAGE_SIZE)


def write_urlset(path: Path, entries: list[UrlEntry]) -> None:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]

    for e in entries:
        lines.append("  <url>")
        lines.append(f"    <loc>{escape(e.loc, quote=False)}</loc>")
        if e.lastmod:
            lines.append(f"    <lastmod>{escape(e.lastmod, quote=False)}</lastmod>")
        if e.changefreq:
            lines.append(
                f"    <changefreq>{escape(e.changefreq, quote=False)}</changefreq>"
            )
        if e.priority:
            lines.append(f"    <priority>{escape(e.priority, quote=False)}</priority>")
        lines.append("  </url>")

    lines.append("</urlset>")
    write_text_lf(path, "\n".join(lines) + "\n")


def build_entries() -> list[UrlEntry]:
    raw = json.loads(PATCHES_JSON.read_text(encoding="utf-8"))
    groups = raw.get("Product") if isinstance(raw, dict) else []
    groups = groups if isinstance(groups, list) else []

    dataset_lastmod = read_dataset_lastmod()
    product_lastmods: dict[str, str] = {}
    product_counts: dict[str, int] = {}
    patch_entries: dict[str, UrlEntry] = {}
    total_rows = 0
    enterprise_lastmod = ""
    enterprise_count = 0

    for g in groups:
        patches = g.get("patches") if isinstance(g, dict) else []
        patches = patches if isinstance(patches, list) else []
        for p in patches:
            if not isinstance(p, dict):
                continue

            rel = parse_release_date(str(p.get("ReleaseDate", ""))) or dataset_lastmod
            total_rows += 1
            products = tokenize_csv(str(p.get("Products", "")))

            for prod in products:
                if not prod:
                    continue
                product_lastmods[prod] = newer_lastmod(
                    product_lastmods.get(prod, ""), rel
                )
                product_counts[prod] = product_counts.get(prod, 0) + 1

            if any(prod in ENTERPRISE_FAMILY_TOKENS for prod in products):
                enterprise_lastmod = newer_lastmod(enterprise_lastmod, rel)
                enterprise_count += 1

            pid = str(p.get("QFE_ID", "")).strip()
            name = str(p.get("Name", "")).strip()
            if not pid:
                continue

            pn = slugify_patch_name(name)
            loc = f"{BASE_URL}?pid={quote(pid, safe='')}&pn={quote(pn, safe='')}"
            current = patch_entries.get(loc)
            if current is None:
                patch_entries[loc] = UrlEntry(
                    loc=loc,
                    lastmod=rel,
                    changefreq="monthly",
                    priority="0.7",
                )
            else:
                patch_entries[loc] = UrlEntry(
                    loc=loc,
                    lastmod=newer_lastmod(current.lastmod, rel),
                    changefreq=current.changefreq,
                    priority=current.priority,
                )

    entries: list[UrlEntry] = [
        UrlEntry(
            loc=BASE_URL,
            lastmod=dataset_lastmod,
            changefreq="daily",
            priority="1.0",
        )
    ]

    for page in range(2, get_max_page(total_rows) + 1):
        entries.append(
            UrlEntry(
                loc=f"{BASE_URL}?page={page}",
                lastmod=dataset_lastmod,
                changefreq="daily",
                priority="0.9",
            )
        )

    if enterprise_count:
        product_lastmods["ArcGIS Enterprise"] = enterprise_lastmod
        product_counts["ArcGIS Enterprise"] = enterprise_count

    for prod in sorted(product_lastmods):
        pslug = slugify_filter_token(prod)
        if not pslug:
            continue
        entries.append(
            UrlEntry(
                loc=f"{BASE_URL}?p={quote(pslug, safe='')}",
                lastmod=product_lastmods[prod],
                changefreq="weekly",
                priority="0.8",
            )
        )

        for page in range(2, get_max_page(product_counts.get(prod, 0)) + 1):
            entries.append(
                UrlEntry(
                    loc=f"{BASE_URL}?p={quote(pslug, safe='')}&page={page}",
                    lastmod=product_lastmods[prod],
                    changefreq="weekly",
                    priority="0.7",
                )
            )

    entries.extend(patch_entries[k] for k in sorted(patch_entries))
    return entries


def main() -> None:
    entries = build_entries()
    write_urlset(SITEMAP_XML, entries)


if __name__ == "__main__":
    main()
