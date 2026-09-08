#!/usr/bin/env bash
set -euo pipefail

UNICORN_VERSION="2.1.4"
UNICORN_JS_COMMIT="1220477c7fb0f8fe4b500f4bd211de52f6dfe638"
UNICORN_CORE_COMMIT="8028ec436f2d9376525352dd38ed9ed6b9f6be10"
UNICORN_JS_REPO="https://github.com/AlexAltea/unicorn.js.git"
DEST="public/vendor/unicorn"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT"
mkdir -p "$DEST"
SOURCE_DIR="$TMP/unicorn.js"

printf 'Building pinned Unicorn.js %s from source (x86-only SINGLE_FILE WASM runtime)\n' "$UNICORN_VERSION"
git init -q "$SOURCE_DIR"
git -C "$SOURCE_DIR" remote add origin "$UNICORN_JS_REPO"
git -C "$SOURCE_DIR" fetch -q --depth 1 origin "$UNICORN_JS_COMMIT"
git -C "$SOURCE_DIR" checkout -q --detach FETCH_HEAD

ACTUAL_UNICORN_JS_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
if [[ "$ACTUAL_UNICORN_JS_COMMIT" != "$UNICORN_JS_COMMIT" ]]; then
  echo "Unexpected Unicorn.js source commit: $ACTUAL_UNICORN_JS_COMMIT" >&2
  exit 1
fi

node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (p.name !== "@alexaltea/unicorn-js" || p.version !== process.argv[2]) {
  throw new Error(`Unexpected Unicorn.js source identity: ${p.name}@${p.version}`);
}
' "$SOURCE_DIR/package.json" "$UNICORN_VERSION"

git -C "$SOURCE_DIR" submodule update --init --depth 1 unicorn
ACTUAL_UNICORN_CORE_COMMIT="$(git -C "$SOURCE_DIR/unicorn" rev-parse HEAD)"
if [[ "$ACTUAL_UNICORN_CORE_COMMIT" != "$UNICORN_CORE_COMMIT" ]]; then
  echo "Unexpected Unicorn core submodule commit: $ACTUAL_UNICORN_CORE_COMMIT" >&2
  exit 1
fi

python3 "$ROOT/scripts/build-patched-unicorn-avx2.py" "$SOURCE_DIR"

test -s "$SOURCE_DIR/dist/unicorn_x86.js"
cp "$SOURCE_DIR/dist/unicorn_x86.js" "$DEST/unicorn_x86.js"

if [[ -f "$SOURCE_DIR/LICENSE" ]]; then
  cp "$SOURCE_DIR/LICENSE" "$DEST/LICENSE.unicorn-js.txt"
else
  echo "Pinned Unicorn.js source did not contain LICENSE; refusing to vendor." >&2
  exit 1
fi

# The x86 release is emitted with Emscripten SINGLE_FILE=1. Guard against
# accidentally switching to an asset that expects an untracked .wasm sibling.
grep -q "MUnicorn" "$DEST/unicorn_x86.js"
grep -q "WebAssembly" "$DEST/unicorn_x86.js"

BYTES="$(wc -c < "$DEST/unicorn_x86.js" | tr -d ' ')"
SHA256="$(sha256sum "$DEST/unicorn_x86.js" | awk '{print $1}')"
printf 'Patched Unicorn x86 runtime ready: %s bytes · sha256 %s\n' "$BYTES" "$SHA256"
printf '  unicorn.js %s\n' "$UNICORN_JS_COMMIT"
printf '  unicorn    %s\n' "$UNICORN_CORE_COMMIT"
