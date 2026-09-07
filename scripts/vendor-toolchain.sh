#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REPO='robalb/x86-64-playground'
UPSTREAM_COMMIT='d617f6a19879157c1debbe0454b6c4cff2ebe094'
OUT='public/vendor/toolchain'

NASM_NAME='nasm.3.00.elf'
NASM_SIZE='1808400'
NASM_BLOB='4954233b5edd322f9ec5da4f371d5127eac1e300'
LD_NAME='gnu-ld.2.43.50.elf'
LD_SIZE='2790840'
LD_BLOB='c5834047a865bdcaaded2fe878b0b4ead1fb2853'

for cmd in curl sha1sum wc awk; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Toolchain vendoring requires '$cmd'." >&2
    exit 1
  fi
done

mkdir -p "$OUT"

raw_url() {
  local name="$1"
  printf 'https://raw.githubusercontent.com/%s/%s/webapp/src/assets/assemblers/%s' \
    "$UPSTREAM_REPO" "$UPSTREAM_COMMIT" "$name"
}

git_blob_sha1() {
  local path="$1"
  local size
  size="$(wc -c < "$path" | tr -d '[:space:]')"
  { printf 'blob %s\0' "$size"; cat "$path"; } | sha1sum | awk '{print $1}'
}

verify_asset() {
  local path="$1"
  local expected_size="$2"
  local expected_blob="$3"
  local actual_size actual_blob
  actual_size="$(wc -c < "$path" | tr -d '[:space:]')"
  if [[ "$actual_size" != "$expected_size" ]]; then
    echo "Unexpected size for $path: $actual_size (expected $expected_size)." >&2
    return 1
  fi
  actual_blob="$(git_blob_sha1 "$path")"
  if [[ "$actual_blob" != "$expected_blob" ]]; then
    echo "Git blob identity mismatch for $path: $actual_blob (expected $expected_blob)." >&2
    return 1
  fi
}

fetch_asset() {
  local name="$1"
  local expected_size="$2"
  local expected_blob="$3"
  local path="$OUT/$name"

  if [[ -f "$path" ]] && verify_asset "$path" "$expected_size" "$expected_blob" >/dev/null 2>&1; then
    printf 'Using verified %s\n' "$path"
  else
    rm -f "$path"
    printf 'Fetching %s from pinned upstream commit %s...\n' "$name" "$UPSTREAM_COMMIT"
    curl --fail --location --retry 3 --retry-delay 1 --output "$path" "$(raw_url "$name")"
    verify_asset "$path" "$expected_size" "$expected_blob"
  fi
  chmod 0755 "$path"
}

fetch_asset "$NASM_NAME" "$NASM_SIZE" "$NASM_BLOB"
fetch_asset "$LD_NAME" "$LD_SIZE" "$LD_BLOB"

printf 'Pinned ASM toolchain ready:\n'
printf '  NASM    %s bytes, git-blob %s\n' "$NASM_SIZE" "$NASM_BLOB"
printf '  GNU ld  %s bytes, git-blob %s\n' "$LD_SIZE" "$LD_BLOB"
printf '  source  https://github.com/%s/tree/%s\n' "$UPSTREAM_REPO" "$UPSTREAM_COMMIT"
