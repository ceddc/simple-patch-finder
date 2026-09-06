#!/usr/bin/env python3
"""Submit product categories and a bounded set of recent patch permalinks."""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlencode, urlparse
import xml.etree.ElementTree as ET

from generate_rss import ENTERPRISE_FAMILY_TOKENS, parse_release_date, slugify_patch_name, tokenize_csv

BASE_URL = "https://simplepatchfinder.ceddc.dev/"
ROOT = Path(__file__).resolve().parents[1]
LATEST_PATCH_LIMIT = 50
NS = "http://www.sitemaps.org/schemas/sitemap/0.9"


def build_urls() -> list[str]:
    data = json.loads((ROOT / "patches.json").read_text(encoding="utf-8"))
    products: set[str] = set()
    patches: dict[str, date] = {}
    for group in data["Product"]:
        for patch in group["patches"]:
            products.update(tokenize_csv(str(patch.get("Products", ""))))
            pid = str(patch.get("QFE_ID", "")).strip()
            name = str(patch.get("Name", "")).strip()
            official = urlparse(str(patch.get("url", "")).strip())
            if not re.fullmatch(r"[A-Za-z0-9._-]{2,80}", pid) or not name:
                continue
            if official.scheme not in {"http", "https"} or not official.netloc:
                continue
            route = {"pid": pid}
            slug = slugify_patch_name(name)
            if slug:
                route["pn"] = slug
            url = BASE_URL + "?" + urlencode(route)
            released = parse_release_date(str(patch.get("ReleaseDate", ""))) or date.min
            patches[url] = max(patches.get(url, date.min), released)

    if products & ENTERPRISE_FAMILY_TOKENS:
        products.add("ArcGIS Enterprise")
    categories = sorted({slugify_patch_name(product) for product in products} - {""})
    urls = [BASE_URL] + [BASE_URL + "?" + urlencode({"p": slug}) for slug in categories]
    urls.extend(sorted(patches, key=lambda url: (patches[url], url), reverse=True)[:LATEST_PATCH_LIMIT])
    return urls


def main() -> None:
    ET.register_namespace("", NS)
    root = ET.Element(f"{{{NS}}}urlset")
    for url in build_urls():
        entry = ET.SubElement(root, f"{{{NS}}}url")
        ET.SubElement(entry, f"{{{NS}}}loc").text = url
        if url == BASE_URL:
            try:
                meta = json.loads((ROOT / "patches.meta.json").read_text(encoding="utf-8"))
                value = str(meta.get("updated_at_utc", "")).strip()
                datetime.fromisoformat(value.replace("Z", "+00:00"))
                ET.SubElement(entry, f"{{{NS}}}lastmod").text = value
            except (OSError, ValueError, TypeError, AttributeError):
                pass
        # Release dates are not modification dates. Omit category/patch lastmod
        # until per-page modification history is available.
    ET.indent(root, space="  ")
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n"
    (ROOT / "sitemap.xml").write_text(xml, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
