#!/usr/bin/env python3
"""Notify the public WebSub hub after selected RSS feeds are live on Pages."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import time
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from generate_rss import BASE_URL, HUB_URL, ROOT

USER_AGENT = "SimplePatchFinder-Publisher/1.0 (+https://simplepatchfinder.ceddc.dev/)"


def is_live(path: Path) -> bool:
    request = Request(BASE_URL + path.name, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=15) as response:
            return response.status == 200 and response.read() == path.read_bytes()
    except (OSError, URLError):
        return False


def notify(paths: list[Path], wait_seconds: int) -> None:
    pending = list(paths)
    deadline = time.monotonic() + wait_seconds
    while pending:
        with ThreadPoolExecutor(max_workers=6) as pool:
            live = list(pool.map(is_live, pending))
        pending = [path for path, ready in zip(pending, live) if not ready]
        if not pending:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Feeds are not yet live; no ping sent: " + ", ".join(path.name for path in pending))
        print(f"Waiting for Pages to serve {len(pending)} changed feeds...", flush=True)
        time.sleep(min(10, max(0, deadline - time.monotonic())))

    fields = [("hub.mode", "publish")] + [("hub.url", BASE_URL + path.name) for path in paths]
    request = Request(
        HUB_URL,
        data=urlencode(fields).encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        if response.status != 204:
            raise RuntimeError(f"Unexpected WebSub response: HTTP {response.status}")
    print(f"WebSub acknowledged {len(paths)} feed notifications (HTTP 204).")
    for path in paths:
        print(BASE_URL + path.name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--changed-file", type=Path, help="Only notify feed filenames in this file; a missing/empty file skips notification")
    parser.add_argument("--wait-seconds", type=int, default=0, help="Maximum wait for the published XML to match the local files")
    args = parser.parse_args()
    available = {path.name: path for path in ROOT.glob("rss*.xml")}
    if args.changed_file:
        names = args.changed_file.read_text(encoding="utf-8").splitlines() if args.changed_file.exists() else []
    else:
        names = sorted(available)
    names = list(dict.fromkeys(name.strip() for name in names if name.strip()))
    if not names:
        print("No changed RSS feeds; no ping sent.")
        return
    unknown = set(names) - available.keys()
    if unknown:
        raise ValueError("Unknown feed filenames: " + ", ".join(sorted(unknown)))
    paths = [available[name] for name in names]
    for path in paths:
        channel = ET.parse(path).getroot().find("channel")
        links = {link.get("rel"): link.get("href") for link in channel.findall("{http://www.w3.org/2005/Atom}link")}
        if links.get("hub") != HUB_URL or links.get("self") != BASE_URL + path.name:
            raise ValueError(f"Invalid WebSub discovery metadata in {path.name}")
    notify(paths, max(0, args.wait_seconds))


if __name__ == "__main__":
    main()
