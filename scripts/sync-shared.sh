#!/usr/bin/env bash
#
# Sync files vendored verbatim from Karafilt, per vendor/MANIFEST.json.
#
#   scripts/sync-shared.sh              pull upstream -> here, refresh hashes
#   scripts/sync-shared.sh --check      verify only, copy nothing
#   scripts/sync-shared.sh --from PATH  point at a Karafilt checkout
#
# --check distinguishes two failures, which is the entire point of the script:
#
#   LOCAL TAMPER   a vendored file here no longer matches its recorded hash.
#                  Someone edited a vendored file in place. Hard fail (exit 1),
#                  always checkable, and the CI gate.
#
#   UPSTREAM DRIFT Karafilt's copy has moved on. Informational (exit 2), and
#                  only checkable when a Karafilt checkout is present. Set
#                  STRICT_VENDOR=1 to make it fail too.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_ROOT/vendor/MANIFEST.json"

CHECK_ONLY=0
UPSTREAM="${KARAFILT_REPO:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --from)  UPSTREAM="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

[ -f "$MANIFEST" ] || { echo "ERROR: $MANIFEST not found" >&2; exit 1; }

if [ -z "$UPSTREAM" ]; then
  UPSTREAM="$REPO_ROOT/$(jq -r '.upstream.defaultPath' "$MANIFEST")"
fi

have_upstream=0
[ -d "$UPSTREAM" ] && have_upstream=1

hash_of() { sha256sum "$1" | cut -d' ' -f1; }

mapfile -t PATHS < <(jq -r '.files[].path' "$MANIFEST")

tampered=()   # local file != recorded hash
drifted=()    # upstream file != recorded hash
missing=()    # local file absent
nosource=()   # upstream file absent
copied=()

for rel in "${PATHS[@]}"; do
  local_file="$REPO_ROOT/$rel"
  up_file="$UPSTREAM/$rel"
  recorded="$(jq -r --arg p "$rel" '.files[] | select(.path == $p) | .sha256' "$MANIFEST")"

  if [ "$CHECK_ONLY" -eq 1 ]; then
    if [ ! -f "$local_file" ]; then missing+=("$rel"); continue; fi
    # A null hash means "not yet recorded" (bootstrap), not a pass.
    if [ "$recorded" = "null" ]; then tampered+=("$rel (no hash recorded — run sync-shared.sh)"); continue; fi
    [ "$(hash_of "$local_file")" != "$recorded" ] && tampered+=("$rel")
    if [ "$have_upstream" -eq 1 ]; then
      if [ ! -f "$up_file" ]; then nosource+=("$rel")
      elif [ "$(hash_of "$up_file")" != "$recorded" ]; then drifted+=("$rel"); fi
    fi
    continue
  fi

  # --- sync mode ---
  if [ "$have_upstream" -ne 1 ]; then
    echo "ERROR: upstream not found at $UPSTREAM" >&2
    echo "       pass --from PATH or set KARAFILT_REPO" >&2
    exit 1
  fi
  if [ ! -f "$up_file" ]; then nosource+=("$rel"); continue; fi

  before=""
  [ -f "$local_file" ] && before="$(hash_of "$local_file")"
  mkdir -p "$(dirname "$local_file")"
  cp "$up_file" "$local_file"
  after="$(hash_of "$local_file")"
  [ "$before" != "$after" ] && copied+=("$rel")
done

if [ "$CHECK_ONLY" -eq 1 ]; then
  status=0
  if [ ${#missing[@]} -gt 0 ]; then
    echo "MISSING — vendored file absent:"; printf '  %s\n' "${missing[@]}"; status=1
  fi
  if [ ${#tampered[@]} -gt 0 ]; then
    echo "LOCAL TAMPER — vendored file edited in place (hash != manifest):"
    printf '  %s\n' "${tampered[@]}"
    echo "  Fix: revert the edit, or move the file out of vendor/MANIFEST.json"
    echo "       into _promotions with a reason."
    status=1
  fi
  if [ ${#nosource[@]} -gt 0 ]; then
    echo "NO SOURCE — not present upstream:"; printf '  %s\n' "${nosource[@]}"; status=1
  fi
  if [ ${#drifted[@]} -gt 0 ]; then
    echo "UPSTREAM DRIFT — Karafilt has moved on (run scripts/sync-shared.sh):"
    printf '  %s\n' "${drifted[@]}"
    if [ "${STRICT_VENDOR:-0}" = "1" ]; then status=1
    elif [ "$status" -eq 0 ]; then status=2; fi
  fi
  if [ "$have_upstream" -ne 1 ]; then
    echo "note: upstream absent at $UPSTREAM — hash integrity checked, drift not."
  fi
  [ "$status" -eq 0 ] && echo "vendor: ${#PATHS[@]} files OK"
  exit "$status"
fi

# Refresh recorded hashes, preserving every other field in the manifest.
tmp="$(mktemp)"
node - "$MANIFEST" "$REPO_ROOT" > "$tmp" <<'NODE'
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const [manifestPath, root] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const entry of m.files) {
  const f = path.join(root, entry.path);
  entry.sha256 = fs.existsSync(f)
    ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")
    : null;
}
process.stdout.write(JSON.stringify(m, null, 2) + "\n");
NODE
mv "$tmp" "$MANIFEST"

if [ ${#nosource[@]} -gt 0 ]; then
  echo "WARNING — listed in the manifest but absent upstream:"; printf '  %s\n' "${nosource[@]}"
fi
if [ ${#copied[@]} -eq 0 ]; then
  echo "vendor: ${#PATHS[@]} files, already up to date"
else
  echo "vendor: ${#PATHS[@]} files, ${#copied[@]} updated:"; printf '  %s\n' "${copied[@]}"
fi
