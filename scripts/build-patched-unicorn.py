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

The pinned QEMU 5 x86 translator parses VEX prefixes but rejects every VEX.L=1
instruction and generic SSE lowering ignores VEX.vvvv. A deliberately small
vector patch therefore establishes truthful AVX three-operand XOR semantics plus
the minimum AVX2 256-bit move/XOR closure. All other VEX.256 instructions remain
illegal and CPUID AVX2 is not advertised by this patch.

This driver deliberately patches the already-upstream-patched sources rather
than forking generated JavaScript/WASM. That keeps repairs at the layers where
their invariants belong and makes future per-architecture builds use the same
fixes.
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


def patch_avx_vector_basics(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    helper_before = """static inline void gen_op_movq_env_0(DisasContext *s, int d_offset)
{
    TCGContext *tcg_ctx = s->uc->tcg_ctx;

    tcg_gen_movi_i64(tcg_ctx, s->tmp1_i64, 0);
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env, d_offset);
}

typedef void (*SSEFunc_i_ep)(TCGContext *s, TCGv_i32 val, TCGv_ptr env, TCGv_ptr reg);
"""
    helper_after = """static inline void gen_op_movq_env_0(DisasContext *s, int d_offset)
{
    TCGContext *tcg_ctx = s->uc->tcg_ctx;

    tcg_gen_movi_i64(tcg_ctx, s->tmp1_i64, 0);
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env, d_offset);
}

/* Minimal AVX/AVX2 state helpers. CPUX86State already stores each vector
 * register in a 512-bit ZMMReg, so the low four qwords are sufficient for YMM.
 * Keep these operations scalar at TCG level so the TCI/WASM backend does not
 * depend on host SIMD or TCG vector-register support. */
static inline void gen_ldy_env_A0(DisasContext *s, int offset)
{
    TCGContext *tcg_ctx = s->uc->tcg_ctx;
    int mem_index = s->mem_index;

    tcg_gen_qemu_ld_i64(tcg_ctx, s->tmp1_i64, s->A0, mem_index, MO_LEQ);
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   offset + offsetof(ZMMReg, ZMM_Q(0)));
    tcg_gen_addi_tl(tcg_ctx, s->tmp0, s->A0, 8);
    tcg_gen_qemu_ld_i64(tcg_ctx, s->tmp1_i64, s->tmp0, mem_index, MO_LEQ);
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   offset + offsetof(ZMMReg, ZMM_Q(1)));
    tcg_gen_addi_tl(tcg_ctx, s->tmp0, s->A0, 16);
    tcg_gen_qemu_ld_i64(tcg_ctx, s->tmp1_i64, s->tmp0, mem_index, MO_LEQ);
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   offset + offsetof(ZMMReg, ZMM_Q(2)));
    tcg_gen_addi_tl(tcg_ctx, s->tmp0, s->A0, 24);
    tcg_gen_qemu_ld_i64(tcg_ctx, s->tmp1_i64, s->tmp0, mem_index, MO_LEQ);
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   offset + offsetof(ZMMReg, ZMM_Q(3)));
}

static inline void gen_sty_env_A0(DisasContext *s, int offset)
{
    TCGContext *tcg_ctx = s->uc->tcg_ctx;
    int mem_index = s->mem_index;

    tcg_gen_ld_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   offset + offsetof(ZMMReg, ZMM_Q(0)));
    tcg_gen_qemu_st_i64(tcg_ctx, s->tmp1_i64, s->A0, mem_index, MO_LEQ);
    tcg_gen_addi_tl(tcg_ctx, s->tmp0, s->A0, 8);
    tcg_gen_ld_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   offset + offsetof(ZMMReg, ZMM_Q(1)));
    tcg_gen_qemu_st_i64(tcg_ctx, s->tmp1_i64, s->tmp0, mem_index, MO_LEQ);
    tcg_gen_addi_tl(tcg_ctx, s->tmp0, s->A0, 16);
    tcg_gen_ld_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   offset + offsetof(ZMMReg, ZMM_Q(2)));
    tcg_gen_qemu_st_i64(tcg_ctx, s->tmp1_i64, s->tmp0, mem_index, MO_LEQ);
    tcg_gen_addi_tl(tcg_ctx, s->tmp0, s->A0, 24);
    tcg_gen_ld_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   offset + offsetof(ZMMReg, ZMM_Q(3)));
    tcg_gen_qemu_st_i64(tcg_ctx, s->tmp1_i64, s->tmp0, mem_index, MO_LEQ);
}

static inline void gen_op_movy(DisasContext *s, int d_offset, int s_offset)
{
    gen_op_movo(s, d_offset, s_offset);
    gen_op_movo(s, d_offset + 16, s_offset + 16);
}

static inline void gen_op_zero_vex_upper(DisasContext *s, int d_offset,
                                         int vex_l)
{
    TCGContext *tcg_ctx = s->uc->tcg_ctx;

    tcg_gen_movi_i64(tcg_ctx, s->tmp1_i64, 0);
    if (!vex_l) {
        tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                       d_offset + offsetof(ZMMReg, ZMM_Q(2)));
        tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                       d_offset + offsetof(ZMMReg, ZMM_Q(3)));
    }
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   d_offset + offsetof(ZMMReg, ZMM_Q(4)));
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   d_offset + offsetof(ZMMReg, ZMM_Q(5)));
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   d_offset + offsetof(ZMMReg, ZMM_Q(6)));
    tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                   d_offset + offsetof(ZMMReg, ZMM_Q(7)));
}

typedef void (*SSEFunc_i_ep)(TCGContext *s, TCGv_i32 val, TCGv_ptr env, TCGv_ptr reg);
"""

    declaration_before = """    int b1, op1_offset, op2_offset, is_xmm, val;
    int modrm, mod, rm, reg;
    SSEFunc_0_epp sse_fn_epp;
"""
    declaration_after = """    int b1, op1_offset, op2_offset, is_xmm, val;
    int modrm, mod, rm, reg;
    int vex_xor, vex_vector_move;
    SSEFunc_0_epp sse_fn_epp;
"""

    classify_before = """    /* simple MMX/SSE operation */
    if (s->flags & HF_TS_MASK) {
"""
    classify_after = """    /* The pinned translator only had partial VEX decoding. Keep the initial
     * implementation intentionally narrow: true three-operand XOR plus
     * VMOVDQA/VMOVDQU are the only vector operations allowed to use VEX.L=1. */
    vex_xor = (s->prefix & PREFIX_VEX) && is_xmm &&
              ((b == 0x57 && b1 <= 1) || (b == 0xef && b1 == 1));
    vex_vector_move = (s->prefix & PREFIX_VEX) && is_xmm &&
                      ((b == 0x6f || b == 0x7f) &&
                       (b1 == 1 || b1 == 2));

    /* simple MMX/SSE operation */
    if (s->flags & HF_TS_MASK) {
"""

    guard_before = """    /* VEX.L (256 bit) encodings are not supported */
    if (s->vex_l != 0) {
        goto illegal_op; // perhaps it should be unknown_op?
    }
"""
    guard_after = """    /* Fail closed for every VEX.256 instruction outside the audited basic
     * move/XOR closure. Do not turn this into a broad VEX.L enable. */
    if (s->vex_l != 0 && !(vex_xor || vex_vector_move)) {
        goto illegal_op;
    }
"""

    load_before = """        case 0x010: /* movups */
        case 0x110: /* movupd */
        case 0x028: /* movaps */
        case 0x128: /* movapd */
        case 0x16f: /* movdqa xmm, ea */
        case 0x26f: /* movdqu xmm, ea */
            if (mod != 3) {
                gen_lea_modrm(env, s, modrm);
                gen_ldo_env_A0(s, offsetof(CPUX86State, xmm_regs[reg]));
            } else {
                rm = (modrm & 7) | REX_B(s);
                gen_op_movo(s, offsetof(CPUX86State, xmm_regs[reg]),
                            offsetof(CPUX86State,xmm_regs[rm]));
            }
            break;
"""
    load_after = """        case 0x010: /* movups */
        case 0x110: /* movupd */
        case 0x028: /* movaps */
        case 0x128: /* movapd */
        case 0x16f: /* movdqa / vmovdqa xmm|ymm, ea */
        case 0x26f: /* movdqu / vmovdqu xmm|ymm, ea */
            if (mod != 3) {
                gen_lea_modrm(env, s, modrm);
                if (vex_vector_move && s->vex_l) {
                    /* Load through the scratch vector so a fault in the upper
                     * half cannot partially update the architectural dest. */
                    gen_ldy_env_A0(s, offsetof(CPUX86State, xmm_t0));
                    gen_op_movy(s, offsetof(CPUX86State, xmm_regs[reg]),
                                offsetof(CPUX86State, xmm_t0));
                } else {
                    gen_ldo_env_A0(s, offsetof(CPUX86State, xmm_regs[reg]));
                }
            } else {
                rm = (modrm & 7) | REX_B(s);
                if (vex_vector_move && s->vex_l) {
                    gen_op_movy(s, offsetof(CPUX86State, xmm_regs[reg]),
                                offsetof(CPUX86State,xmm_regs[rm]));
                } else {
                    gen_op_movo(s, offsetof(CPUX86State, xmm_regs[reg]),
                                offsetof(CPUX86State,xmm_regs[rm]));
                }
            }
            if (vex_vector_move) {
                gen_op_zero_vex_upper(s,
                                      offsetof(CPUX86State, xmm_regs[reg]),
                                      s->vex_l);
            }
            break;
"""

    store_before = """        case 0x011: /* movups */
        case 0x111: /* movupd */
        case 0x029: /* movaps */
        case 0x129: /* movapd */
        case 0x17f: /* movdqa ea, xmm */
        case 0x27f: /* movdqu ea, xmm */
            if (mod != 3) {
                gen_lea_modrm(env, s, modrm);
                gen_sto_env_A0(s, offsetof(CPUX86State, xmm_regs[reg]));
            } else {
                rm = (modrm & 7) | REX_B(s);
                gen_op_movo(s, offsetof(CPUX86State, xmm_regs[rm]),
                            offsetof(CPUX86State,xmm_regs[reg]));
            }
            break;
"""
    store_after = """        case 0x011: /* movups */
        case 0x111: /* movupd */
        case 0x029: /* movaps */
        case 0x129: /* movapd */
        case 0x17f: /* movdqa / vmovdqa ea, xmm|ymm */
        case 0x27f: /* movdqu / vmovdqu ea, xmm|ymm */
            if (mod != 3) {
                gen_lea_modrm(env, s, modrm);
                if (vex_vector_move && s->vex_l) {
                    gen_sty_env_A0(s, offsetof(CPUX86State, xmm_regs[reg]));
                } else {
                    gen_sto_env_A0(s, offsetof(CPUX86State, xmm_regs[reg]));
                }
            } else {
                rm = (modrm & 7) | REX_B(s);
                if (vex_vector_move && s->vex_l) {
                    gen_op_movy(s, offsetof(CPUX86State, xmm_regs[rm]),
                                offsetof(CPUX86State,xmm_regs[reg]));
                } else {
                    gen_op_movo(s, offsetof(CPUX86State, xmm_regs[rm]),
                                offsetof(CPUX86State,xmm_regs[reg]));
                }
                if (vex_vector_move) {
                    gen_op_zero_vex_upper(
                        s, offsetof(CPUX86State, xmm_regs[rm]), s->vex_l);
                }
            }
            break;
"""

    operand_before = """        if (is_xmm) {
            op1_offset = offsetof(CPUX86State,xmm_regs[reg]);
            if (mod != 3) {
                int sz = 4;

                gen_lea_modrm(env, s, modrm);
                op2_offset = offsetof(CPUX86State,xmm_t0);

                switch (b) {
                case 0x50:
                case 0x51:
                case 0x52:
                case 0x53:
                case 0x54:
                case 0x55:
                case 0x56:
                case 0x57:
                case 0x58:
                case 0x59:
                case 0x5a:

                case 0x5c:
                case 0x5d:
                case 0x5e:
                case 0x5f:

                case 0xc2:
                    /* Most sse scalar operations.  */
                    if (b1 == 2) {
                        sz = 2;
                    } else if (b1 == 3) {
                        sz = 3;
                    }
                    break;

                case 0x2e:  /* ucomis[sd] */
                case 0x2f:  /* comis[sd] */
                    if (b1 == 0) {
                        sz = 2;
                    } else {
                        sz = 3;
                    }
                    break;
                }

                switch (sz) {
                case 2:
                    /* 32 bit access */
                    gen_op_ld_v(s, MO_32, s->T0, s->A0);
                    tcg_gen_st32_tl(tcg_ctx, s->T0, tcg_ctx->cpu_env,
                                    offsetof(CPUX86State,xmm_t0.ZMM_L(0)));
                    break;
                case 3:
                    /* 64 bit access */
                    gen_ldq_env_A0(s, offsetof(CPUX86State, xmm_t0.ZMM_D(0)));
                    break;
                default:
                    /* 128 bit access */
                    gen_ldo_env_A0(s, op2_offset);
                    break;
                }
            } else {
                rm = (modrm & 7) | REX_B(s);
                op2_offset = offsetof(CPUX86State,xmm_regs[rm]);
            }
        } else {
"""
    operand_after = """        if (is_xmm) {
            op1_offset = offsetof(CPUX86State,xmm_regs[reg]);
            if (mod != 3) {
                int sz = 4;

                gen_lea_modrm(env, s, modrm);
                op2_offset = offsetof(CPUX86State,xmm_t0);

                if (vex_xor && s->vex_l) {
                    gen_ldy_env_A0(s, op2_offset);
                } else {
                    switch (b) {
                    case 0x50:
                    case 0x51:
                    case 0x52:
                    case 0x53:
                    case 0x54:
                    case 0x55:
                    case 0x56:
                    case 0x57:
                    case 0x58:
                    case 0x59:
                    case 0x5a:

                    case 0x5c:
                    case 0x5d:
                    case 0x5e:
                    case 0x5f:

                    case 0xc2:
                        /* Most sse scalar operations.  */
                        if (b1 == 2) {
                            sz = 2;
                        } else if (b1 == 3) {
                            sz = 3;
                        }
                        break;

                    case 0x2e:  /* ucomis[sd] */
                    case 0x2f:  /* comis[sd] */
                        if (b1 == 0) {
                            sz = 2;
                        } else {
                            sz = 3;
                        }
                        break;
                    }

                    switch (sz) {
                    case 2:
                        /* 32 bit access */
                        gen_op_ld_v(s, MO_32, s->T0, s->A0);
                        tcg_gen_st32_tl(tcg_ctx, s->T0, tcg_ctx->cpu_env,
                                        offsetof(CPUX86State,xmm_t0.ZMM_L(0)));
                        break;
                    case 3:
                        /* 64 bit access */
                        gen_ldq_env_A0(s, offsetof(CPUX86State, xmm_t0.ZMM_D(0)));
                        break;
                    default:
                        /* 128 bit access */
                        gen_ldo_env_A0(s, op2_offset);
                        break;
                    }
                }
            } else {
                rm = (modrm & 7) | REX_B(s);
                if (vex_xor) {
                    /* Snapshot source2 before overwriting destination; VEX permits
                     * dest == src2 while source1 comes from vvvv. */
                    op2_offset = offsetof(CPUX86State,xmm_t0);
                    if (s->vex_l) {
                        gen_op_movy(s, op2_offset,
                                    offsetof(CPUX86State,xmm_regs[rm]));
                    } else {
                        gen_op_movo(s, op2_offset,
                                    offsetof(CPUX86State,xmm_regs[rm]));
                    }
                } else {
                    op2_offset = offsetof(CPUX86State,xmm_regs[rm]);
                }
            }
        } else {
"""

    default_before = """        default:
            tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
            tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
            sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
            break;
"""
    default_after = """        default:
            if (vex_xor) {
                int src1_offset = offsetof(CPUX86State,xmm_regs[s->vex_v]);

                if (s->vex_l) {
                    gen_op_movy(s, op1_offset, src1_offset);
                } else {
                    gen_op_movo(s, op1_offset, src1_offset);
                }

                tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                 op1_offset);
                tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env,
                                 op2_offset);
                sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);

                if (s->vex_l) {
                    tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                     op1_offset + 16);
                    tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env,
                                     op2_offset + 16);
                    sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                }
                gen_op_zero_vex_upper(s, op1_offset, s->vex_l);
            } else {
                tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                 op1_offset);
                tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env,
                                 op2_offset);
                sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
            }
            break;
"""

    replacements = [
        ("vector helper insertion", helper_before, helper_after),
        ("gen_sse declarations", declaration_before, declaration_after),
        ("VEX operation classification", classify_before, classify_after),
        ("VEX.L guard", guard_before, guard_after),
        ("VEX vector load", load_before, load_after),
        ("VEX vector store", store_before, store_after),
        ("VEX XOR operand preparation", operand_before, operand_after),
        ("VEX XOR execution", default_before, default_after),
    ]
    for label, before, after in replacements:
        count = text.count(before)
        if count != 1:
            raise RuntimeError(
                f"Pinned Unicorn AVX patch anchor '{label}' expected once, found {count}"
            )
        text = text.replace(before, after, 1)

    translate_path.write_text(text)


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
    patch_avx_vector_basics(source_root)
    upstream.generateConstants()
    upstream.compileUnicorn(["x86"])

    output = source_root / "dist" / "unicorn_x86.js"
    if not output.is_file() or output.stat().st_size < 100_000:
        raise RuntimeError(f"Patched Unicorn.js x86 runtime was not produced correctly: {output}")
    print(f"Patched Unicorn.js x86 runtime built: {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
