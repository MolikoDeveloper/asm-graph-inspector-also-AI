#!/usr/bin/env python3
"""Build the pinned Unicorn.js x86 runtime with the local TCI/WASM lifetime fix.

The upstream Unicorn.js adapter patch widens every logical helper argument to an
(i32 lo, i32 hi) pair for the TCI/WASM ABI. For originally narrow arguments it
allocates a temporary TCGv_i64, but the wasm32 path never frees that temporary.
Long TranslationBlocks with code hooks therefore exhaust TCG_MAX_TEMPS during
translation and eventually write past the TCG temporary array.

This driver deliberately patches the already-upstream-patched tcg.c rather than
forking generated JavaScript/WASM. That keeps the fix at the layer where the
lifetime bug exists and makes future per-architecture builds use the same repair.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys


def load_upstream_build(source_root: Path):
    build_path = source_root / "build.py"
    spec = importlib.util.spec_from_file_location("pinned_unicorn_js_build", build_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load upstream build script: {build_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def patch_tcg_argument_lifetime(source_root: Path) -> None:
    tcg_path = source_root / "unicorn" / "qemu" / "tcg" / "tcg.c"
    text = tcg_path.read_text()

    allocation_before = """    /* Unicorn.js (TCI/WASM adapter ABI): every logical helper argument must
     * occupy a full (lo,hi) 32-bit register pair so the adapters can
     * reconstruct it (A1..A6 in helper-adapter.h). Zero-extend narrow args. */
    for (i = 0; i < nargs; i++) {
        int arg_is_64bit = sizemask & (1 << (i+1)*2);
        if (!arg_is_64bit) {
            TCGv_i64 ext_temp = tcg_temp_new_i64(tcg_ctx);
            TCGv_i64 ext_orig = temp_tcgv_i64(tcg_ctx, args[i]);
            tcg_gen_ext32u_i64(tcg_ctx, ext_temp, ext_orig);
            args[i] = tcgv_i64_temp(tcg_ctx, ext_temp);
        }
    }

    op = tcg_emit_op(tcg_ctx, INDEX_op_call);
"""
    allocation_after = """    /* Unicorn.js (TCI/WASM adapter ABI): every logical helper argument must
     * occupy a full (lo,hi) 32-bit register pair so the adapters can
     * reconstruct it (A1..A6 in helper-adapter.h). Zero-extend narrow args.
     *
     * Keep the handles for the widened temporaries. The upstream adapter patch
     * replaced args[i] with these values but did not free them on wasm32,
     * leaking TCG temporaries once per narrow helper argument. */
    TCGv_i64 unicorn_ext_args[MAX_OPC_PARAM] = { 0 };
    for (i = 0; i < nargs; i++) {
        int arg_is_64bit = sizemask & (1 << (i+1)*2);
        if (!arg_is_64bit) {
            TCGv_i64 ext_temp = tcg_temp_new_i64(tcg_ctx);
            TCGv_i64 ext_orig = temp_tcgv_i64(tcg_ctx, args[i]);
            tcg_gen_ext32u_i64(tcg_ctx, ext_temp, ext_orig);
            args[i] = tcgv_i64_temp(tcg_ctx, ext_temp);
            unicorn_ext_args[i] = ext_temp;
        }
    }

    op = tcg_emit_op(tcg_ctx, INDEX_op_call);
"""

    cleanup_before = """    /* Make sure the fields didn't overflow.  */
    tcg_debug_assert(TCGOP_CALLI(op) == real_args);
    tcg_debug_assert(pi <= ARRAY_SIZE(op->args));

#if defined(__sparc__) && !defined(__arch64__)
"""
    cleanup_after = """    /* Make sure the fields didn't overflow.  */
    tcg_debug_assert(TCGOP_CALLI(op) == real_args);
    tcg_debug_assert(pi <= ARRAY_SIZE(op->args));

    /* The call op now owns the last use of each widened argument. Release the
     * temporary immediately, exactly as the native argument-extension path does
     * below, so later instructions in the same TB can reuse the temp slots. */
    for (i = 0; i < nargs; ++i) {
        if (unicorn_ext_args[i]) {
            tcg_temp_free_i64(tcg_ctx, unicorn_ext_args[i]);
        }
    }

#if defined(__sparc__) && !defined(__arch64__)
"""

    if text.count(allocation_before) != 1:
        raise RuntimeError("Pinned Unicorn.js tcg_gen_callN allocation block no longer matches the audited 2.1.4 source")
    text = text.replace(allocation_before, allocation_after, 1)
    if text.count(cleanup_before) != 1:
        raise RuntimeError("Pinned Unicorn.js tcg_gen_callN cleanup anchor no longer matches the audited 2.1.4 source")
    text = text.replace(cleanup_before, cleanup_after, 1)
    tcg_path.write_text(text)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: build-patched-unicorn.py <unicorn.js-source-root>")

    source_root = Path(sys.argv[1]).resolve()
    if not (source_root / "package.json").is_file():
        raise RuntimeError(f"Not a Unicorn.js source checkout: {source_root}")

    os.chdir(source_root)
    upstream = load_upstream_build(source_root)
    upstream.patchUnicorn()
    patch_tcg_argument_lifetime(source_root)
    upstream.generateConstants()
    upstream.compileUnicorn(["x86"])

    output = source_root / "dist" / "unicorn_x86.js"
    if not output.is_file() or output.stat().st_size < 100_000:
        raise RuntimeError(f"Patched Unicorn x86 runtime was not produced correctly: {output}")
    print(f"Patched Unicorn.js x86 runtime built: {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
