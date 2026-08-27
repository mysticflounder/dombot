#!/usr/bin/env bash
#
# Builds DomBot: icons, manifest validation, syntax checks, and a zip of the
# extension directory that "Load unpacked" or the Web Store can take.
#
# Usage: scripts/build.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT/extension"
DIST_DIR="$ROOT/dist"

echo "==> icons"
node "$ROOT/scripts/make-icons.js" | sed 's/^/    /'

echo "==> validating manifest"
node -e '
  const fs = require("fs");
  const path = require("path");
  const file = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));

  if (manifest.manifest_version !== 3) throw new Error("manifest_version must be 3 for Chrome");
  for (const key of ["name", "version", "background", "content_scripts", "action", "options_ui", "icons"]) {
    if (!(key in manifest)) throw new Error(`manifest is missing ${key}`);
  }
  if (!manifest.background.service_worker) throw new Error("background.service_worker is required");

  // Every file the manifest points at must exist, or Chrome refuses the load
  // with a generic error.
  const dir = path.dirname(file);
  const referenced = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((cs) => cs.js ?? []),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.options_ui?.page,
  ].filter(Boolean);
  for (const rel of new Set(referenced)) {
    if (!fs.existsSync(path.join(dir, rel))) throw new Error(`manifest references ${rel}, which does not exist`);
  }

  // Chrome rejects any file or directory whose name starts with "_".
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith("_")) throw new Error(`${path.join(d, e.name)}: names starting with "_" are reserved by Chrome`);
    return e.isDirectory() ? walk(path.join(d, e.name)) : [];
  });
  walk(dir);

  console.log(`    ${manifest.name} v${manifest.version} — ${new Set(referenced).size} files referenced, all present`);
' "$EXT_DIR/manifest.json"

echo "==> syntax-checking extension scripts"
for js in "$EXT_DIR"/*.js; do
  node --check "$js"
  echo "    ok  $(basename "$js")"
done

echo "==> packaging"
VERSION="$(node -p "require('$EXT_DIR/manifest.json').version")"
mkdir -p "$DIST_DIR"
ZIP="$DIST_DIR/dombot-$VERSION.zip"
rm -f "$ZIP"
# manifest.json must sit at the archive root, so zip from inside extension/.
(cd "$EXT_DIR" && zip -q -r -FS "$ZIP" . -x '.*' -x '__MACOSX/*')
echo "    $ZIP ($(du -h "$ZIP" | cut -f1))"

echo
echo "Build complete. To install:"
echo "  chrome://extensions  ->  Developer mode  ->  Load unpacked  ->  $EXT_DIR"
echo "Then open the extension's options page and paste an Anthropic API key."
