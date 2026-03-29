#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT_DIR/patches.json"
META_OUT="$ROOT_DIR/patches.meta.json"
URL="https://downloads.esri.com/patch_notification/patches.json"
PREVIOUS_OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --previous)
      if [[ $# -lt 2 ]]; then
        echo "Error: --previous requires a destination path" >&2
        exit 1
      fi
      PREVIOUS_OUT="$2"
      shift 2
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$PREVIOUS_OUT" && -f "$OUT" ]]; then
  mkdir -p "$(dirname "$PREVIOUS_OUT")"
  cp "$OUT" "$PREVIOUS_OUT"
fi

TMP_OUT="$(mktemp)"
cleanup() {
  rm -f "$TMP_OUT"
}
trap cleanup EXIT

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP_OUT"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$TMP_OUT" "$URL"
else
  echo "Error: need curl or wget" >&2
  exit 1
fi

NEW_SHA="$(python3 - "$TMP_OUT" <<'PY'
import hashlib
import sys
from pathlib import Path

print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"

OLD_SHA=""
if [[ -f "$OUT" ]]; then
  OLD_SHA="$(python3 - "$OUT" <<'PY'
import hashlib
import sys
from pathlib import Path

print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)"
fi

if [[ -f "$OUT" && "$OLD_SHA" == "$NEW_SHA" && -f "$META_OUT" ]]; then
  echo "Dataset unchanged: $OUT"
  exit 0
fi

mv "$TMP_OUT" "$OUT"

UPDATED_AT_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
python3 - "$OUT" "$META_OUT" "$URL" "$UPDATED_AT_UTC" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

patches_path = Path(sys.argv[1])
meta_path = Path(sys.argv[2])
source_url = sys.argv[3]
updated_at_utc = sys.argv[4]

payload = patches_path.read_bytes()
meta = {
    "source_url": source_url,
    "updated_at_utc": updated_at_utc,
    "patches_sha256": hashlib.sha256(payload).hexdigest(),
    "bytes": len(payload),
}
meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "Wrote: $OUT"
echo "Wrote: $META_OUT"
