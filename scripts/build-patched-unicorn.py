#!/usr/bin/env python3
"""Build the pinned Unicorn.js x86 runtime with local WASM correctness fixes.

The upstream Unicorn.js adapter patch widens every logical helper argument to an
(i32 lo, i32 hi) pair for the TCI/WASM ABI. For originally narrow arguments it
allocates a temporary TCGv_i64, but the wasm32 path never frees that temporary.
Long TranslationBlocks with code hooks therefore exhaust TCG_MAX_TEMPS during
translation and eventually write past the TCG temporary array.

The Emscripten-backed RAM allocator can also recycle a host allocation after
uc_mem_unmap without clearing its bytes. Native anonymous mappings commonly get
zero-filled pages from the host OS, but the Unicorn API cannot rely on that when
compiled to wasm32. The Linux userspace session requires Linux MAP_ANONYMOUS and
ELF BSS zero-fill semantics, so every ordinary uc_mem_map RAM block is cleared at
creation. Preallocated uc_mem_map_ptr memory is deliberately left untouched.

This driver deliberately patches the already-upstream-patched sources rather
than forking generated JavaScript/WASM. That keeps both repairs at the layers
where their invariants belong and makes future per-architecture builds use the
same fixes.
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


def patch_ram_zero_fill(source_root: Path) -> None:
    memory_path = source_root / "unicorn" / "qemu" / "softmmu" / "memory.c"
    text = memory_path.read_text()

    mapping_before = """    memory_region_init_ram(uc, ram, size, perms);
    if (ram->addr == -1 || !ram->ram_block) {
        // out of memory
        g_free(ram);
        return NULL;
    }

    memory_region_add_subregion_overlap(uc->system_memory, begin, ram, uc->snapshot_level);
"""
    mapping_after = """    memory_region_init_ram(uc, ram, size, perms);
    if (ram->addr == -1 || !ram->ram_block) {
        // out of memory
        g_free(ram);
        return NULL;
    }

    /* wasm32 malloc may recycle bytes from a previously unmapped RAMBlock.
     * uc_mem_map represents newly-created ordinary RAM, so make its initial
     * contents deterministic and preserve anonymous/BSS zero-page semantics. */
    memset(ramblock_ptr(ram->ram_block, 0), 0, size);

    memory_region_add_subregion_overlap(uc->system_memory, begin, ram, uc->snapshot_level);
"""

    if text.count(mapping_before) != 1:
        raise RuntimeError("Pinned Unicorn memory_map block no longer matches the audited 2.1.4 source")
    memory_path.write_text(text.replace(mapping_before, mapping_after, 1))


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
    patch_ram_zero_fill(source_root)
    upstream.generateConstants()
    upstream.compileUnicorn(["x86"])

    output = source_root / "dist" / "unicorn_x86.js"
    if not output.is_file() or output.stat().st_size < 100_000:
        raise RuntimeError(f"Patched Unicorn.js x86 runtime was not produced correctly: {output}")
    print(f"Patched Unicorn.js x86 runtime built: {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
