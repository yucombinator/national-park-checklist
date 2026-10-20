#!/usr/bin/env bash
# Sync the park checklist into the static site repo and preview it.
#
#   scripts/deploy_site.sh          # sync + print preview URLs
#   scripts/deploy_site.sh --push   # sync, commit and push
#
# The site is plain static files, served at https://<domain>/parkchecklist/.
# Build inputs live in tools/ (including a ~500 MB download cache) and are
# never shipped.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="${PARK_SITE_REPO:-$HOME/dev/yucombinator.github.io}"
DEST="$SITE/parkchecklist"
PORT="${PARK_SITE_PORT:-8850}"

if [[ ! -d "$SITE/.git" ]]; then
  echo "site repo not found at $SITE" >&2
  exit 1
fi

BRANCH="$(git -C "$SITE" branch --show-current)"
if [[ "$BRANCH" != "main" && "${PARK_SITE_BRANCH:-}" != "main" ]]; then
  echo "refusing to deploy: site repo is on '$BRANCH', not 'main'" >&2
  exit 1
fi
if [[ -n "$(git -C "$SITE" status --porcelain)" ]]; then
  echo "refusing to deploy: site repo has uncommitted changes" >&2
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'tools/' \
  --exclude 'scripts/' \
  --exclude 'data/drive.json' \
  --exclude 'node_modules/' \
  "$HERE/" "$DEST/"

echo "synced $(du -sh "$DEST" | cut -f1) -> $DEST"

# GitHub Pages serves assets with a 10-minute cache. Stamp every module and
# stylesheet reference so a deploy is actually visible on the next load.
STAMP="$(date +%Y%m%d%H%M%S)"
find "$DEST/js" -name '*.js' -exec sed -i '' -E \
  "s|from \"\./([a-z-]+\.js)\"|from \"./\1?v=$STAMP\"|g" {} +
sed -i '' -E "s|src=\"js/main\.js(\?[^\"]*)?\"|src=\"js/main.js?v=$STAMP\"|" "$DEST/index.html"
sed -i '' -E "s|href=\"css/park\.css(\?[^\"]*)?\"|href=\"css/park.css?v=$STAMP\"|" "$DEST/index.html"
echo "stamped assets with v=$STAMP"

if ! grep -q 'href="/parkchecklist/"' "$SITE/index.html"; then
  echo "note: $SITE/index.html has no /parkchecklist/ link — add one to the calling card"
fi

if [[ "${1:-}" == "--push" ]]; then
  git -C "$SITE" add parkchecklist index.html
  git -C "$SITE" commit -m "Update national park checklist at /parkchecklist/"
  git -C "$SITE" push origin main
  echo "pushed"
else
  echo "preview: python3 -m http.server $PORT --directory $SITE"
  echo "  http://127.0.0.1:$PORT/parkchecklist/"
fi
