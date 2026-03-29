#!/usr/bin/env python3
"""Generate RSS feeds for all patches and ArcGIS Enterprise-family patches.

The enterprise-family feed intentionally aggregates server-side ArcGIS Enterprise
components/extensions rather than relying only on the literal
"ArcGIS Enterprise" product token.

By default, an existing RSS file is rewritten only when the relevant feed gains
at least one newly seen patch key compared with the previous dataset snapshot.
Use --force to rewrite regardless.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from email.utils import format_datetime, parsedate_to_datetime
from html import escape
from pathlib import Path
from urllib.parse import quote
import xml.etree.ElementTree as ET

BASE_URL = "https://simplepatchfinder.ceddc.dev/"
ROOT = Path(__file__).resolve().parents[1]
PATCHES_JSON = ROOT / "patches.json"
PATCHES_META_JSON = ROOT / "patches.meta.json"
RSS_XML = ROOT / "rss.xml"
RSS_ENTERPRISE_XML = ROOT / "rss-enterprise.xml"
RSS_SECURITY_CRITICAL_XML = ROOT / "rss-security-critical.xml"
DEFAULT_LIMIT = 50

# Keep this set in sync with the ArcGIS Enterprise aggregate used in js/app.js.
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
class PatchEntry:
    key: str
    name: str
    qfe_id: str
    version: str
    critical_kind: str
    release_date_text: str
    release_date_iso: str
    release_ordinal: int
    products_tokens: tuple[str, ...]
    patch_page_url: str
    permalink: str


def write_text_lf(path: Path, content: str) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def tokenize_csv(value: str) -> list[str]:
    return [t.strip() for t in (value or "").split(",") if t.strip()]


def slugify_patch_name(name: str) -> str:
    s = (name or "").lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"(^-+|-+$)", "", s)
    return s[:180]


def parse_release_date(value: str) -> date | None:
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", (value or "").strip())
    if not m:
        return None
    mm, dd, yyyy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        return date(yyyy, mm, dd)
    except ValueError:
        return None


def classify_critical(raw: object) -> str:
    value = str(raw if raw is not None else "").strip().lower()
    if value == "security":
        return "security"
    if value == "true":
        return "critical"
    return "standard"


def parse_isoish(value: str) -> datetime | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def canonical_patch_url(qfe_id: str, name: str) -> str:
    return f"{BASE_URL}?pid={quote(qfe_id, safe='')}&pn={quote(slugify_patch_name(name), safe='')}"


def identity_key(
    qfe_id: str, version: str, name: str, release_date: str, patch_page_url: str
) -> str:
    return "\x1f".join(
        [
            str(qfe_id or "").strip(),
            str(version or "").strip(),
            str(name or "").strip(),
            str(release_date or "").strip(),
            str(patch_page_url or "").strip(),
        ]
    )


def is_enterprise_family_patch(products_tokens: tuple[str, ...]) -> bool:
    return any(token in ENTERPRISE_FAMILY_TOKENS for token in products_tokens)


def guid_for_key(key: str) -> str:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return f"urn:simple-patch-finder:{digest}"


def load_existing_item_pubdates(path: Path) -> dict[str, datetime]:
    if not path.exists():
        return {}

    try:
        root = ET.parse(path).getroot()
    except Exception:
        return {}

    out: dict[str, datetime] = {}
    for item in root.findall("./channel/item"):
        guid = str(item.findtext("guid", "")).strip()
        pub_date = str(item.findtext("pubDate", "")).strip()
        if not guid or not pub_date:
            continue
        try:
            dt = parsedate_to_datetime(pub_date)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            out[guid] = dt.astimezone(timezone.utc)
        except Exception:
            continue

    return out


def effective_entry_pub_date(
    entry: PatchEntry,
    existing_pub_dates: dict[str, datetime],
    dataset_lastmod: datetime | None,
) -> datetime:
    existing = existing_pub_dates.get(entry_guid(entry))
    if existing:
        return existing
    if dataset_lastmod:
        return dataset_lastmod
    if entry.release_date_iso:
        y, m, d = (int(part) for part in entry.release_date_iso.split("-"))
        return datetime(y, m, d, tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def load_patch_entries(path: Path) -> list[PatchEntry]:
    if not path.exists():
        return []

    raw = json.loads(path.read_text(encoding="utf-8"))
    groups = raw.get("Product") if isinstance(raw, dict) else []
    groups = groups if isinstance(groups, list) else []

    deduped: dict[str, PatchEntry] = {}
    for group in groups:
        version = (
            str(group.get("version", "")).strip() if isinstance(group, dict) else ""
        )
        patches = group.get("patches") if isinstance(group, dict) else []
        patches = patches if isinstance(patches, list) else []
        for patch in patches:
            if not isinstance(patch, dict):
                continue

            qfe_id = str(patch.get("QFE_ID", "")).strip()
            name = str(patch.get("Name", "")).strip()
            critical_kind = classify_critical(patch.get("Critical"))
            release_date_text = str(patch.get("ReleaseDate", "")).strip()
            patch_page_url = str(patch.get("url", "")).strip()
            products_tokens = tuple(tokenize_csv(str(patch.get("Products", ""))))
            release_date = parse_release_date(release_date_text)
            key = identity_key(qfe_id, version, name, release_date_text, patch_page_url)

            if key in deduped:
                continue

            deduped[key] = PatchEntry(
                key=key,
                name=name,
                qfe_id=qfe_id,
                version=version,
                critical_kind=critical_kind,
                release_date_text=release_date_text,
                release_date_iso=release_date.isoformat() if release_date else "",
                release_ordinal=release_date.toordinal() if release_date else -1,
                products_tokens=products_tokens,
                patch_page_url=patch_page_url,
                permalink=canonical_patch_url(qfe_id, name) if qfe_id else BASE_URL,
            )

    return list(deduped.values())


def entries_for_mode(entries: list[PatchEntry], mode: str) -> list[PatchEntry]:
    filtered = entries
    if mode == "enterprise":
        filtered = [
            entry
            for entry in entries
            if is_enterprise_family_patch(entry.products_tokens)
        ]
    elif mode == "security-critical":
        filtered = [
            entry
            for entry in entries
            if entry.critical_kind in {"security", "critical"}
        ]

    return filtered


def feed_entries(
    entries: list[PatchEntry],
    mode: str,
    limit: int,
    existing_pub_dates: dict[str, datetime],
    dataset_lastmod: datetime | None,
) -> list[PatchEntry]:
    filtered = entries_for_mode(entries, mode)

    filtered.sort(
        key=lambda entry: (
            -effective_entry_pub_date(
                entry, existing_pub_dates, dataset_lastmod
            ).timestamp(),
            -entry.release_ordinal,
            entry.name.lower(),
            entry.qfe_id.lower(),
            entry.version.lower(),
        )
    )
    return filtered[:limit]


def read_dataset_lastmod(meta_path: Path) -> datetime | None:
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return parse_isoish(str(meta.get("updated_at_utc", "")).strip())


def feed_channel(mode: str) -> tuple[str, str, str, str]:
    if mode == "enterprise":
        return (
            "Simple Patch Finder - ArcGIS Enterprise RSS",
            "Latest ArcGIS Enterprise server-side component patches from Simple Patch Finder.",
            BASE_URL,
            f"{BASE_URL}rss-enterprise.xml",
        )

    if mode == "security-critical":
        return (
            "Simple Patch Finder - Security and Critical RSS",
            "Latest security and critical patches from Simple Patch Finder.",
            BASE_URL,
            f"{BASE_URL}rss-security-critical.xml",
        )

    return (
        "Simple Patch Finder - All patches RSS",
        "Latest ArcGIS and Esri patches from Simple Patch Finder.",
        BASE_URL,
        f"{BASE_URL}rss.xml",
    )


def entry_title(entry: PatchEntry) -> str:
    if entry.name and entry.qfe_id:
        return f"{entry.name} ({entry.qfe_id})"
    return entry.name or entry.qfe_id or "ArcGIS patch"


def entry_guid(entry: PatchEntry) -> str:
    return guid_for_key(entry.key)


def entry_description(entry: PatchEntry) -> str:
    parts = []
    if entry.version:
        parts.append(f"Version: {entry.version}")
    if entry.critical_kind == "security":
        parts.append("Criticality: Security")
    elif entry.critical_kind == "critical":
        parts.append("Criticality: Critical")
    if entry.release_date_text:
        parts.append(f"Release date: {entry.release_date_text}")
    if entry.products_tokens:
        parts.append(f"Products: {', '.join(entry.products_tokens)}")
    if entry.patch_page_url:
        parts.append(f"Esri patch page: {entry.patch_page_url}")
    return " | ".join(parts)


def build_rss_xml(
    entries: list[PatchEntry],
    mode: str,
    dataset_lastmod: datetime | None,
    existing_pub_dates: dict[str, datetime],
) -> str:
    title, description, site_link, self_link = feed_channel(mode)
    last_build = dataset_lastmod or max(
        (
            effective_entry_pub_date(entry, existing_pub_dates, dataset_lastmod)
            for entry in entries
        ),
        default=datetime.now(timezone.utc),
    )

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
        "  <channel>",
        f"    <title>{escape(title, quote=False)}</title>",
        f"    <description>{escape(description, quote=False)}</description>",
        f"    <link>{escape(site_link, quote=False)}</link>",
        f'    <atom:link href="{escape(self_link)}" rel="self" type="application/rss+xml" />',
        f"    <lastBuildDate>{escape(format_datetime(last_build), quote=False)}</lastBuildDate>",
        "    <language>en-us</language>",
    ]

    for entry in entries:
        lines.extend(
            [
                "    <item>",
                f"      <title>{escape(entry_title(entry), quote=False)}</title>",
                f"      <link>{escape(entry.permalink, quote=False)}</link>",
                f'      <guid isPermaLink="false">{escape(entry_guid(entry), quote=False)}</guid>',
                f"      <pubDate>{escape(format_datetime(effective_entry_pub_date(entry, existing_pub_dates, dataset_lastmod)), quote=False)}</pubDate>",
                f"      <description>{escape(entry_description(entry), quote=False)}</description>",
                "    </item>",
            ]
        )

    lines.extend(["  </channel>", "</rss>"])
    return "\n".join(lines) + "\n"


def maybe_write_feed(
    current_entries: list[PatchEntry],
    previous_entries: list[PatchEntry],
    output_path: Path,
    mode: str,
    limit: int,
    dataset_lastmod: datetime | None,
    force: bool,
) -> str:
    existing_pub_dates = load_existing_item_pubdates(output_path)
    selected_current = feed_entries(
        current_entries, mode, limit, existing_pub_dates, dataset_lastmod
    )

    selected_current_guids = {entry_guid(entry) for entry in selected_current}
    if existing_pub_dates:
        has_new_patch = bool(selected_current_guids - set(existing_pub_dates))
    else:
        previous_guids = {
            entry_guid(entry) for entry in entries_for_mode(previous_entries, mode)
        }
        has_new_patch = bool(selected_current_guids - previous_guids)

    if output_path.exists() and not force and not has_new_patch:
        return f"Skipped {output_path.name}: no new {mode} patches"

    xml = build_rss_xml(selected_current, mode, dataset_lastmod, existing_pub_dates)
    write_text_lf(output_path, xml)
    return f"Wrote {output_path.name}: {len(selected_current)} items"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--current", type=Path, default=PATCHES_JSON, help="Current patches.json path"
    )
    parser.add_argument(
        "--previous",
        type=Path,
        default=None,
        help="Previous patches.json snapshot path",
    )
    parser.add_argument(
        "--meta", type=Path, default=PATCHES_META_JSON, help="patches.meta.json path"
    )
    parser.add_argument(
        "--limit", type=int, default=DEFAULT_LIMIT, help="Max items per feed"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Rewrite feeds even if no new patch is detected",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    current_entries = load_patch_entries(args.current)
    previous_entries = load_patch_entries(args.previous) if args.previous else []
    dataset_lastmod = read_dataset_lastmod(args.meta)

    print(
        maybe_write_feed(
            current_entries=current_entries,
            previous_entries=previous_entries,
            output_path=RSS_XML,
            mode="all",
            limit=args.limit,
            dataset_lastmod=dataset_lastmod,
            force=args.force,
        )
    )
    print(
        maybe_write_feed(
            current_entries=current_entries,
            previous_entries=previous_entries,
            output_path=RSS_ENTERPRISE_XML,
            mode="enterprise",
            limit=args.limit,
            dataset_lastmod=dataset_lastmod,
            force=args.force,
        )
    )
    print(
        maybe_write_feed(
            current_entries=current_entries,
            previous_entries=previous_entries,
            output_path=RSS_SECURITY_CRITICAL_XML,
            mode="security-critical",
            limit=args.limit,
            dataset_lastmod=dataset_lastmod,
            force=args.force,
        )
    )


if __name__ == "__main__":
    main()
