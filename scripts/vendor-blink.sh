#!/usr/bin/env bash
set -euo pipefail

# Build the Process Sandbox from the pinned Blink fork instead of downloading
# x86-64-playground's precompiled --disable-all artifact. That upstream artifact
# disables x87, which makes Blink advertise a CPU below glibc's x86-64-baseline
# requirement even when the uploaded libc itself only requires baseline.

BLINK_COMMIT='71487ee40869b3ccac6cac9bb7a45d71484978d6'
BLINK_REPO='https://github.com/robalb/blink.git'
PROFILE='asm-graph-inspector-linux-x86-64-baseline-v1'
PROFILE_SCHEMA='asm-graph.blink-build-profile/v1'
OUT='public/vendor/blink'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEADLESS_SIGNAL_PATCH="$ROOT/scripts/patches/blink-headless-signal-state.patch"

requirements=(git make emconfigure emmake emcc sha256sum)
for cmd in "${requirements[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Blink source build requires '$cmd'." >&2
    echo "Install/activate Emscripten (the upstream browser fork was tested with emsdk 3.1.64), then retry." >&2
    exit 1
  fi
done

if [[ ! -f "$HEADLESS_SIGNAL_PATCH" ]]; then
  echo "Blink source build is missing $HEADLESS_SIGNAL_PATCH." >&2
  exit 1
fi

mkdir -p "$OUT"
work="$(mktemp -d "${TMPDIR:-/tmp}/asm-graph-blink.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

printf 'Fetching Blink %s...\n' "$BLINK_COMMIT"
git -C "$work" init -q
git -C "$work" remote add origin "$BLINK_REPO"
git -C "$work" fetch -q --depth 1 origin "$BLINK_COMMIT"
git -C "$work" checkout -q --detach FETCH_HEAD
printf 'Applying ASM Graph Inspector headless signal-state patch...\n'
git -C "$work" apply --check "$HEADLESS_SIGNAL_PATCH"
git -C "$work" apply "$HEADLESS_SIGNAL_PATCH"

# Keep the Emscripten contract aligned with robalb/x86-64-playground, but use a
# CPU/process profile suitable for contemporary baseline glibc:
#   --disable-all     browser-safe/minimal starting point
#   --enable-x87      CPUID FPU bit + x87 implementation (required by baseline)
#   --enable-mmx      advertised MMX must match an enabled implementation
#   --enable-nonposix glibc/ld-linux need Linux-specific syscall surfaces
# JIT intentionally remains disabled by --disable-all; browser execution is an
# interpreter/debugger and must not claim executable host memory.
exported_runtime_methods='["UTF8ToString","stringToNewUTF8","AsciiToString","FS","callMain","addFunction","wasmExports"]'
emscripten_flags="-sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 -sALLOW_TABLE_GROWTH=1 -sEXIT_RUNTIME=0 -sEXPORT_ES6=1 -sMODULARIZE -sEXPORT_NAME=blinkenlib -sEXPORTED_RUNTIME_METHODS='$exported_runtime_methods'"
cppflags='-DHTML -D_FILE_OFFSET_BITS=64 -D_DARWIN_C_SOURCE -D_DEFAULT_SOURCE -D_BSD_SOURCE -D_GNU_SOURCE'

(
  cd "$work"
  emconfigure ./configure \
    --disable-all \
    --enable-x87 \
    --enable-mmx \
    --enable-nonposix \
    LDFLAGS="$emscripten_flags" \
    CPPFLAGS="$cppflags"
  emmake make o//blink/blinkenlib.js
)

cp "$work/o/blink/blinkenlib.js" "$OUT/blinkenlib.js"
cp "$work/o/blink/blinkenlib.wasm" "$OUT/blinkenlib.wasm"
cp "$work/LICENSE" "$OUT/LICENSE.blink.txt"

js_sha="$(sha256sum "$OUT/blinkenlib.js" | awk '{print $1}')"
wasm_sha="$(sha256sum "$OUT/blinkenlib.wasm" | awk '{print $1}')"
emcc_version="$(emcc --version | head -n 1 | sed 's/"/\\"/g')"

cat > "$OUT/build-profile.json" <<JSON
{
  "schema": "$PROFILE_SCHEMA",
  "profile": "$PROFILE",
  "blinkCommit": "$BLINK_COMMIT",
  "cpu": {
    "architecture": "x86-64",
    "isaLevel": "x86-64-baseline",
    "x87": true,
    "mmx": true,
    "sse": true,
    "sse2": true
  },
  "build": {
    "disableJit": true,
    "nonPosixLinuxApis": true,
    "headlessSignalRegisters": true,
    "configure": ["--disable-all", "--enable-x87", "--enable-mmx", "--enable-nonposix"],
    "emscripten": "$emcc_version"
  },
  "artifacts": {
    "jsSha256": "$js_sha",
    "wasmSha256": "$wasm_sha"
  }
}
JSON

printf 'Built ASM Graph Inspector Blink Process Sandbox:\n'
printf '  source  %s\n' "$BLINK_COMMIT"
printf '  profile %s\n' "$PROFILE"
printf '  crash   headless signal register snapshots enabled\n'
printf '  JS      %s\n' "$js_sha"
printf '  WASM    %s\n' "$wasm_sha"
