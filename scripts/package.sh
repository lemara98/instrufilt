#!/usr/bin/env bash
# Build the Chrome Web Store zip for Instrufilt.
#
# Ported from Karafilt's scripts/package.sh: the repo doubles as the dev
# workspace (docs/, test/, wasm sources, vendor manifest), so the zip is built
# from an explicit WHITELIST — never from the repo root. The manifest CSP is
# transformed for production: the localhost entries used for local website
# development (:3000) are stripped so the shipped manifest contains no dev
# endpoints.
#
# Usage: scripts/package.sh        → dist/instrufilt-<version>.zip
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# ── Whitelist: everything the extension needs at runtime, nothing else ──────
FILES=(
  service-worker.js
  offscreen.html
  offscreen.js
  worklet-processor.js
  LICENSE
)
DIRS=(
  sidepanel
  shared
  icons
)

for f in "${FILES[@]}"; do cp "$f" "$STAGE/"; done
for d in "${DIRS[@]}"; do cp -r "$d" "$STAGE/"; done
# Only the manifest-declared content scripts ship.
mkdir -p "$STAGE/content"
cp content/media-bridge.js "$STAGE/content/"
cp content/site-adapters.js "$STAGE/content/"
cp content/spotify-bridge.js "$STAGE/content/"
mkdir -p "$STAGE/wasm/build"
cp wasm/build/vocal_isolate.wasm "$STAGE/wasm/build/"

# ── Production manifest: strip dev-only CSP entries ─────────────────────────
python3 - "$STAGE" <<'PY'
import json, sys

stage = sys.argv[1]
manifest = json.load(open("manifest.json"))

csp = manifest["content_security_policy"]["extension_pages"]
drop = {"http://localhost:3000", "http://127.0.0.1:3000"}
parts = [t for t in csp.split() if t not in drop]
manifest["content_security_policy"]["extension_pages"] = " ".join(parts)

# Belt-and-suspenders: no localhost match patterns may ship in content scripts
# (none are declared today, but the transform must stay true if one appears).
for cs in manifest.get("content_scripts", []):
    if "matches" in cs:
        cs["matches"] = [m for m in cs["matches"]
                         if "localhost" not in m and "127.0.0.1" not in m]

json.dump(manifest, open(f"{stage}/manifest.json", "w"), indent=2)
PY

# ── Safety net: every manifest-referenced file must exist in the stage ──────
python3 - "$STAGE" <<'PY'
import json, os, sys

stage = sys.argv[1]
manifest = json.load(open(f"{stage}/manifest.json"))
missing = []

def check(p):
    if p and not os.path.exists(os.path.join(stage, p)):
        missing.append(p)

for cs in manifest.get("content_scripts", []):
    for p in cs.get("js", []) + cs.get("css", []):
        check(p)
check(manifest.get("background", {}).get("service_worker"))
check(manifest.get("side_panel", {}).get("default_path"))
if missing:
    sys.exit("package.sh: manifest references files missing from the stage: " + ", ".join(missing))
PY

# ── Safety net: no dev endpoints may survive in the shipped files ───────────
if grep -rn "localhost\|127\.0\.0\.1" "$STAGE" --include="*.js" --include="*.json" --include="*.html"; then
  echo "ERROR: localhost reference found in packaged files (see above)" >&2
  exit 1
fi

mkdir -p dist
OUT="$ROOT/dist/instrufilt-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" .)

echo "Packaged: dist/instrufilt-$VERSION.zip"
unzip -l "$OUT" | tail -1
