#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT_DIR/patches.json"
META_OUT="$ROOT_DIR/patches.meta.json"
URL="https://downloads.esri.com/patch_notification/patches.json"
PREVIOUS_OUT=""

write_meta() {
  local payload_path="$1"
  local meta_path="$2"
  local source_url="$3"
  local updated_at_utc="$4"
  local checked_at_utc="$5"

  python3 - "$payload_path" "$meta_path" "$source_url" "$updated_at_utc" "$checked_at_utc" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

payload_path = Path(sys.argv[1])
meta_path = Path(sys.argv[2])
source_url = sys.argv[3]
updated_at_utc = sys.argv[4]
checked_at_utc = sys.argv[5]

payload = payload_path.read_bytes()
meta = {
    "source_url": source_url,
    "updated_at_utc": updated_at_utc,
    "checked_at_utc": checked_at_utc,
    "patches_sha256": hashlib.sha256(payload).hexdigest(),
    "bytes": len(payload),
}
meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

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

RUN_AT_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ -f "$OUT" && "$OLD_SHA" == "$NEW_SHA" ]]; then
  PREVIOUS_UPDATED_AT_UTC=""
  if [[ -f "$META_OUT" ]]; then
    PREVIOUS_UPDATED_AT_UTC="$(python3 - "$META_OUT" <<'PY'
import json
import sys
from pathlib import Path

meta_path = Path(sys.argv[1])
try:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
except Exception:
    meta = {}
print(str(meta.get("updated_at_utc", "")).strip())
PY
)"
  fi

  if [[ -z "$PREVIOUS_UPDATED_AT_UTC" ]]; then
    PREVIOUS_UPDATED_AT_UTC="$RUN_AT_UTC"
  fi

  write_meta "$TMP_OUT" "$META_OUT" "$URL" "$PREVIOUS_UPDATED_AT_UTC" "$RUN_AT_UTC"
  echo "Dataset unchanged: $OUT"
  echo "Wrote: $META_OUT"
  exit 0
fi

mv "$TMP_OUT" "$OUT"

write_meta "$OUT" "$META_OUT" "$URL" "$RUN_AT_UTC" "$RUN_AT_UTC"

echo "Wrote: $OUT"
echo "Wrote: $META_OUT"
