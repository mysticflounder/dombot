#!/usr/bin/env bash
#
# Runs everything that can be verified without Chrome: syntax checks, the
# manifest, and the unit tests (agent loop with a fake API, DOM tools and
# saved-change logic under jsdom).
#
# What needs a real browser is in docs/verify.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> extension syntax"
for js in "$ROOT"/extension/*.js; do
  node --check "$js"
  echo "    ok  $(basename "$js")"
done

echo "==> manifest parses"
node -p "JSON.parse(require('fs').readFileSync('$ROOT/extension/manifest.json','utf8')).name" | sed 's/^/    /'

if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "==> installing test dependencies"
  (cd "$ROOT" && npm install --silent)
fi

echo "==> unit tests"
(cd "$ROOT" && npm run --silent test:unit)

echo "==> dependency audit"
(cd "$ROOT" && npm audit --audit-level=high) || {
  echo "    audit reported high-severity findings" >&2
  exit 1
}
