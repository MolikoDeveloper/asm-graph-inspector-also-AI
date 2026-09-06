#!/usr/bin/env bash
set -euo pipefail

PLAYGROUND_COMMIT='d617f6a19879157c1debbe0454b6c4cff2ebe094'
BLINK_COMMIT='71487ee40869b3ccac6cac9bb7a45d71484978d6'
BASE="https://raw.githubusercontent.com/robalb/x86-64-playground/${PLAYGROUND_COMMIT}"
BLINK_BASE="https://raw.githubusercontent.com/robalb/blink/${BLINK_COMMIT}"
OUT='public/vendor/blink'
mkdir -p "$OUT"

fetch() {
  local url="$1" output="$2"
  curl --fail --location --silent --show-error "$url" --output "$output"
}

fetch "$BASE/webapp/src/assets/blinkenlib.js" "$OUT/blinkenlib.js"
fetch "$BASE/webapp/src/assets/blinkenlib.wasm" "$OUT/blinkenlib.wasm"
fetch "$BASE/LICENSE.txt" "$OUT/LICENSE.x86-64-playground.txt"
fetch "$BLINK_BASE/LICENSE" "$OUT/LICENSE.blink.txt"

check_blob() {
  local file="$1" expected="$2"
  local actual
  actual="$(git hash-object "$file")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Blink vendor integrity failure: $file" >&2
    echo "expected git blob $expected" >&2
    echo "actual   git blob $actual" >&2
    exit 1
  fi
}

check_size() {
  local file="$1" expected="$2"
  local actual
  actual="$(wc -c < "$file" | tr -d ' ')"
  if [[ "$actual" != "$expected" ]]; then
    echo "Blink vendor size mismatch: $file expected=$expected actual=$actual" >&2
    exit 1
  fi
}

check_blob "$OUT/blinkenlib.js" '32e194ea123f41601b647422a288dce185a84acf'
check_blob "$OUT/blinkenlib.wasm" 'da021e8215a9b0377282c439c72db7f8863f61eb'
check_blob "$OUT/LICENSE.x86-64-playground.txt" '709a034739fc1429460a8322c7758a71ec0cea53'
check_blob "$OUT/LICENSE.blink.txt" '421b40f5cffc6e4f52b18f1dfa100218a882dc35'
check_size "$OUT/blinkenlib.js" 204023
check_size "$OUT/blinkenlib.wasm" 246871

printf 'Vendored Blink Process Sandbox assets:\n  x86-64-playground %s\n  blink fork         %s\n' "$PLAYGROUND_COMMIT" "$BLINK_COMMIT"
