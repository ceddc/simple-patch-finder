#!/usr/bin/env python3
"""Generate sitemap files for GitHub Pages deployment.

Output files:
- sitemap.xml            (sitemap index)
- sitemap-pages.xml      (homepage + product-filter URLs)
- sitemap-patches.xml    (patch deep links)
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from html import escape
from pathlib import Path
from typing import Iterable
from urllib.parse import quote

BASE_URL = "https://ceddc.github.io/simple-patch-finder/"
ROOT = Path(__file__).resolve().parents[1]
PATCHES_JSON = ROOT / "patches.json"
PATCHES_META_JSON = ROOT / "patches.meta.json"
SITEMAP_INDEX_XML = ROOT / "sitemap.xml"
SITEMAP_PAGES_XML = ROOT / "sitemap-pages.xml"
SITEMAP_PATCHES_XML = ROOT / "sitemap-patches.xml"


@dataclass(frozen=True)
class UrlEntry:
    loc: str
    lastmod: str = ""


def slugify_patch_name(name: str) -> str:
    s = (name or "").lower()
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


def read_dataset_lastmod() -> str:
    if not PATCHES_META_JSON.exists():
        return ""
    try:
        meta = json.loads(PATCHES_META_JSON.read_text(encoding="utf-8"))
        return str(meta.get("updated_at_utc", "")).strip()
    except Exception:
        return ""


def build_entries() -> tuple[list[UrlEntry], list[UrlEntry], str]:
    raw = json.loads(PATCHES_JSON.read_text(encoding="utf-8"))
    groups = raw.get("Product") if isinstance(raw, dict) else []
    groups = groups if isinstance(groups, list) else []

    dataset_lastmod = read_dataset_lastmod()
    product_lastmods: dict[str, str] = {}
    patch_entries: dict[str, UrlEntry] = {}

    for g in groups:
        patches = g.get("patches") if isinstance(g, dict) else []
        patches = patches if isinstance(patches, list) else []
        for p in patches:
            if not isinstance(p, dict):
                continue

            rel = parse_release_date(str(p.get("ReleaseDate", "")))

            for prod in tokenize_csv(str(p.get("Products", ""))):
                if not prod:
                    continue
                prev = product_lastmods.get(prod, "")
                if rel and (not prev or rel > prev):
                    product_lastmods[prod] = rel
                elif not prev and dataset_lastmod:
                    product_lastmods[prod] = dataset_lastmod

            pid = str(p.get("QFE_ID", "")).strip()
            name = str(p.get("Name", "")).strip()
            if not pid:
                continue

            pn = slugify_patch_name(name)
            loc = f"{BASE_URL}?pid={quote(pid, safe='')}&pn={quote(pn, safe='')}"
            lastmod = rel or dataset_lastmod
            existing = patch_entries.get(loc)
            if existing is None:
                patch_entries[loc] = UrlEntry(loc=loc, lastmod=lastmod)
            elif lastmod and (not existing.lastmod or lastmod > existing.lastmod):
                patch_entries[loc] = UrlEntry(loc=loc, lastmod=lastmod)

    page_entries = [UrlEntry(loc=BASE_URL, lastmod=dataset_lastmod)]
    for prod in sorted(product_lastmods):
        loc = f"{BASE_URL}?p={quote(prod, safe='')}"
        page_entries.append(
            UrlEntry(loc=loc, lastmod=product_lastmods.get(prod, "") or dataset_lastmod)
        )

    patch_list = [patch_entries[k] for k in sorted(patch_entries)]
    return page_entries, patch_list, dataset_lastmod


def write_urlset(path: Path, entries: Iterable[UrlEntry]) -> None:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for e in entries:
        lines.append("  <url>")
        lines.append(f"    <loc>{escape(e.loc, quote=False)}</loc>")
        if e.lastmod:
            lines.append(f"    <lastmod>{escape(e.lastmod, quote=False)}</lastmod>")
        lines.append("  </url>")
    lines.append("</urlset>")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_sitemap_index(dataset_lastmod: str) -> None:
    items = [
        UrlEntry(loc=f"{BASE_URL}sitemap-pages.xml", lastmod=dataset_lastmod),
        UrlEntry(loc=f"{BASE_URL}sitemap-patches.xml", lastmod=dataset_lastmod),
    ]

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for item in items:
        lines.append("  <sitemap>")
        lines.append(f"    <loc>{escape(item.loc, quote=False)}</loc>")
        if item.lastmod:
            lines.append(f"    <lastmod>{escape(item.lastmod, quote=False)}</lastmod>")
        lines.append("  </sitemap>")
    lines.append("</sitemapindex>")
    SITEMAP_INDEX_XML.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    pages, patches, dataset_lastmod = build_entries()
    write_urlset(SITEMAP_PAGES_XML, pages)
    write_urlset(SITEMAP_PATCHES_XML, patches)
    write_sitemap_index(dataset_lastmod)


if __name__ == "__main__":
    main()
