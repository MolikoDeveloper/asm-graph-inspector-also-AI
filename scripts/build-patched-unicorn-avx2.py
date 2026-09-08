#!/usr/bin/env python3
"""Build the pinned Unicorn.js x86 runtime with the AVX2 feature-branch layer.

Keep the stable WASM correctness repairs in build-patched-unicorn.py. This
wrapper reuses those repairs, applies the incremental AVX/AVX2 translator
layers, and only then compiles the vendored runtime.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys

from unicorn_avx2_extension import (
    patch_avx2_map38_lane_local_ops,
    patch_avx2_packed_integer_ops,
)
from unicorn_avx2_variable_shifts import (
    patch_avx2_variable_shift_decoder,
    patch_avx2_variable_shift_helpers,
)
from unicorn_avx2_broadcast import (
    patch_avx2_broadcast_decoder,
    patch_avx2_broadcast_helpers,
)
from unicorn_avx2_vpermd import (
    patch_avx2_vpermd_decoder,
    patch_avx2_vpermd_helper,
)


def load_base_builder(script_dir: Path):
    path = script_dir / "build-patched-unicorn.py"
    spec = importlib.util.spec_from_file_location("asm_graph_base_unicorn_builder", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load base Unicorn builder: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: build-patched-unicorn-avx2.py <unicorn.js-source-root>")

    source_root = Path(sys.argv[1]).resolve()
    if not (source_root / "package.json").is_file():
        raise RuntimeError(f"Not a Unicorn.js source checkout: {source_root}")

    script_dir = Path(__file__).resolve().parent
    base = load_base_builder(script_dir)

    os.chdir(source_root)
    upstream = base.load_upstream_build(source_root)
    upstream.patchUnicorn()
    base.patch_tcg_argument_lifetime(source_root)
    base.patch_ram_zero_fill(source_root)
    base.patch_avx_vector_basics(source_root)
    patch_avx2_packed_integer_ops(source_root)
    patch_avx2_map38_lane_local_ops(source_root)
    patch_avx2_variable_shift_helpers(source_root)
    patch_avx2_variable_shift_decoder(source_root)
    patch_avx2_broadcast_helpers(source_root)
    patch_avx2_broadcast_decoder(source_root)
    patch_avx2_vpermd_helper(source_root)
    patch_avx2_vpermd_decoder(source_root)
    upstream.generateConstants()
    upstream.compileUnicorn(["x86"])

    output = source_root / "dist" / "unicorn_x86.js"
    if not output.is_file() or output.stat().st_size < 100_000:
        raise RuntimeError(
            f"Patched Unicorn.js AVX2 x86 runtime was not produced correctly: {output}"
        )
    print(f"Patched Unicorn.js AVX2 x86 runtime built: {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
