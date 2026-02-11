#!/usr/bin/env python3
"""Generate sitemap.xml for GitHub Pages deployment.

Includes:
- homepage
- product-filter URLs (?p=...)
- patch deep links (?pid=...&pn=...)
"""

from __future__ import annotations

import json
import re
from html import escape
from pathlib import Path
from urllib.parse import quote

BASE_URL = "https://ceddc.github.io/simple-patch-finder/"
ROOT = Path(__file__).resolve().parents[1]
PATCHES_JSON = ROOT / "patches.json"
PATCHES_META_JSON = ROOT / "patches.meta.json"
SITEMAP_XML = ROOT / "sitemap.xml"


def slugify_patch_name(name: str) -> str:
    s = (name or "").lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"(^-+|-+$)", "", s)
    return s[:180]


def tokenize_csv(value: str) -> list[str]:
    return [t.strip() for t in (value or "").split(",") if t.strip()]


def main() -> None:
    raw = json.loads(PATCHES_JSON.read_text(encoding="utf-8"))
    groups = raw.get("Product") if isinstance(raw, dict) else []
    groups = groups if isinstance(groups, list) else []

    products: set[str] = set()
    patch_urls: set[str] = set()

    for g in groups:
        patches = g.get("patches") if isinstance(g, dict) else []
        patches = patches if isinstance(patches, list) else []
        for p in patches:
            if not isinstance(p, dict):
                continue

            for prod in tokenize_csv(str(p.get("Products", ""))):
                products.add(prod)

            pid = str(p.get("QFE_ID", "")).strip()
            name = str(p.get("Name", "")).strip()
            if not pid:
                continue

            pn = slugify_patch_name(name)
            url = f"{BASE_URL}?pid={quote(pid, safe='')}&pn={quote(pn, safe='')}"
            patch_urls.add(url)

    product_urls = {f"{BASE_URL}?p={quote(prod, safe='')}" for prod in products if prod}

    lastmod = ""
    if PATCHES_META_JSON.exists():
        try:
            meta = json.loads(PATCHES_META_JSON.read_text(encoding="utf-8"))
            lastmod = str(meta.get("updated_at_utc", "")).strip()
        except Exception:
            lastmod = ""

    urls = [BASE_URL] + sorted(product_urls) + sorted(patch_urls)

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for u in urls:
        lines.append("  <url>")
        lines.append(f"    <loc>{escape(u, quote=False)}</loc>")
        if lastmod:
            lines.append(f"    <lastmod>{escape(lastmod, quote=False)}</lastmod>")
        lines.append("  </url>")
    lines.append("</urlset>")

    SITEMAP_XML.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
