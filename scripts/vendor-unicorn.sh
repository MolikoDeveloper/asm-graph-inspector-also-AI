#!/usr/bin/env bash
set -euo pipefail

UNICORN_VERSION="2.1.4"
PACKAGE="@alexaltea/unicorn-js"
DEST="public/vendor/unicorn"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT"
mkdir -p "$DEST"

printf 'Vendoring %s@%s (x86-only SINGLE_FILE WASM runtime)\n' "$PACKAGE" "$UNICORN_VERSION"
(
  cd "$TMP"
  npm pack "$PACKAGE@$UNICORN_VERSION" --ignore-scripts --silent >/dev/null
  TARBALL="$(find . -maxdepth 1 -type f -name '*.tgz' -print -quit)"
  test -n "$TARBALL"
  tar -xzf "$TARBALL"
)

PACKAGE_DIR="$TMP/package"
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (p.name !== process.argv[2] || p.version !== process.argv[3]) {
  throw new Error(`Unexpected Unicorn package identity: ${p.name}@${p.version}`);
}
' "$PACKAGE_DIR/package.json" "$PACKAGE" "$UNICORN_VERSION"

test -s "$PACKAGE_DIR/dist/unicorn_x86.js"
cp "$PACKAGE_DIR/dist/unicorn_x86.js" "$DEST/unicorn_x86.js"

if [[ -f "$PACKAGE_DIR/LICENSE" ]]; then
  cp "$PACKAGE_DIR/LICENSE" "$DEST/LICENSE.unicorn-js.txt"
else
  echo "Pinned Unicorn npm package did not contain LICENSE; refusing to vendor." >&2
  exit 1
fi

# The x86 release is emitted with Emscripten SINGLE_FILE=1. Guard against
# accidentally switching to an asset that expects an untracked .wasm sibling.
grep -q "MUnicorn" "$DEST/unicorn_x86.js"
grep -q "WebAssembly" "$DEST/unicorn_x86.js"

BYTES="$(wc -c < "$DEST/unicorn_x86.js" | tr -d ' ')"
SHA256="$(sha256sum "$DEST/unicorn_x86.js" | awk '{print $1}')"
printf 'Unicorn x86 runtime ready: %s bytes · sha256 %s\n' "$BYTES" "$SHA256"
