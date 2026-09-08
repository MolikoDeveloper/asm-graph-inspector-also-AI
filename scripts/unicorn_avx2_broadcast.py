#!/usr/bin/env python3
"""Dedicated AVX2 integer-broadcast lowering for pinned Unicorn/QEMU.

VPBROADCASTB/W/D/Q use one scalar source element and duplicate it across the
entire destination. In particular, a VEX.256 broadcast must reuse the same low
source element for both 128-bit destination lanes; treating it as an ordinary
lane-local binary/unary operation would incorrectly read source+16 for the high
lane.

This layer therefore adds narrow XMM helpers plus explicit source loading. Memory
forms read exactly 1/2/4/8 bytes. Register aliasing is snapshotted before the
first destination lane is written. VEX.vvvv is reserved and VEX.W=1 remains
illegal for these AVX2 encodings.
"""

from __future__ import annotations

from pathlib import Path


BROADCAST_OPCODES = (0x58, 0x59, 0x78, 0x79)


def patch_avx2_broadcast_helpers(source_root: Path) -> None:
    ops_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse.h"
    text = ops_path.read_text()

    anchor = """#if SHIFT == 1
/* AVX2 variable-count shifts. These helpers intentionally operate on one
"""
    helpers = """#if SHIFT == 1
/* AVX2 integer broadcasts. Each helper fills one 128-bit destination chunk
 * from the low scalar element of S. The translator deliberately invokes the
 * same source pointer for both chunks of a VEX.256 destination. */
void glue(helper_vpbroadcastb, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    uint8_t value = s->B(0);
    int i;
    for (i = 0; i < 16; ++i) {
        d->B(i) = value;
    }
}

void glue(helper_vpbroadcastw, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    uint16_t value = s->W(0);
    int i;
    for (i = 0; i < 8; ++i) {
        d->W(i) = value;
    }
}

void glue(helper_vpbroadcastd, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    uint32_t value = s->L(0);
    int i;
    for (i = 0; i < 4; ++i) {
        d->L(i) = value;
    }
}

void glue(helper_vpbroadcastq, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    uint64_t value = s->Q(0);
    d->Q(0) = value;
    d->Q(1) = value;
}

/* AVX2 variable-count shifts. These helpers intentionally operate on one
"""
    if text.count(anchor) != 1:
        raise RuntimeError("Variable-shift helper anchor no longer matches before broadcast extension")
    ops_path.write_text(text.replace(anchor, helpers, 1))

    header_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse_header.h"
    text = header_path.read_text()
    header_anchor = """#if SHIFT == 1
DEF_HELPER_3(glue(vpsrlvd, SUFFIX), void, env, Reg, Reg)
"""
    header_replacement = """#if SHIFT == 1
DEF_HELPER_3(glue(vpbroadcastb, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpbroadcastw, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpbroadcastd, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpbroadcastq, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpsrlvd, SUFFIX), void, env, Reg, Reg)
"""
    if text.count(header_anchor) != 1:
        raise RuntimeError("Variable-shift helper declarations no longer match before broadcast extension")
    header_path.write_text(text.replace(header_anchor, header_replacement, 1))


def patch_avx2_broadcast_decoder(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    allow_anchor = """                case 0x45:
                case 0x46:
                case 0x47:
                    break;
                default:
                    goto illegal_op;
"""
    allow_replacement = """                case 0x45:
                case 0x46:
                case 0x47:
                case 0x58:
                case 0x59:
                case 0x78:
                case 0x79:
                    break;
                default:
                    goto illegal_op;
"""
    if text.count(allow_anchor) != 1:
        raise RuntimeError("Post-variable-shift 0F38 allow-list anchor no longer matches")
    text = text.replace(allow_anchor, allow_replacement, 1)

    lookup_anchor = """            if (vex_map38 && (b == 0x45 || b == 0x46 || b == 0x47)) {
                /* VEX.W is reflected in dflag after prefix post-processing.
                 * 0x45/0x47 select dword vs qword; 0x46 W=1 is reserved. */
                switch (b) {
                case 0x45:
                    sse_fn_epp = s->dflag == MO_64
                        ? gen_helper_vpsrlvq_xmm : gen_helper_vpsrlvd_xmm;
                    break;
                case 0x46:
                    if (s->dflag == MO_64) {
                        goto illegal_op;
                    }
                    sse_fn_epp = gen_helper_vpsravd_xmm;
                    break;
                case 0x47:
                    sse_fn_epp = s->dflag == MO_64
                        ? gen_helper_vpsllvq_xmm : gen_helper_vpsllvd_xmm;
                    break;
                default:
                    goto illegal_op;
                }
            } else {
                sse_fn_epp = sse_op_table6[b].op[b1];
                if (!sse_fn_epp) {
                    goto unknown_op;
                }
                if (!(s->cpuid_ext_features & sse_op_table6[b].ext_mask))
                    goto illegal_op;
            }

            if (vex_map38) {
"""
    lookup_replacement = """            if (vex_map38 &&
                (b == 0x45 || b == 0x46 || b == 0x47 ||
                 b == 0x58 || b == 0x59 || b == 0x78 || b == 0x79)) {
                /* Route all AVX2-only helpers before the legacy SSE4 table,
                 * which has no entries for these opcodes in pinned QEMU 5. */
                switch (b) {
                case 0x45:
                    sse_fn_epp = s->dflag == MO_64
                        ? gen_helper_vpsrlvq_xmm : gen_helper_vpsrlvd_xmm;
                    break;
                case 0x46:
                    if (s->dflag == MO_64) {
                        goto illegal_op;
                    }
                    sse_fn_epp = gen_helper_vpsravd_xmm;
                    break;
                case 0x47:
                    sse_fn_epp = s->dflag == MO_64
                        ? gen_helper_vpsllvq_xmm : gen_helper_vpsllvd_xmm;
                    break;
                case 0x58:
                    sse_fn_epp = gen_helper_vpbroadcastd_xmm;
                    break;
                case 0x59:
                    sse_fn_epp = gen_helper_vpbroadcastq_xmm;
                    break;
                case 0x78:
                    sse_fn_epp = gen_helper_vpbroadcastb_xmm;
                    break;
                case 0x79:
                    sse_fn_epp = gen_helper_vpbroadcastw_xmm;
                    break;
                default:
                    goto illegal_op;
                }
            } else {
                sse_fn_epp = sse_op_table6[b].op[b1];
                if (!sse_fn_epp) {
                    goto unknown_op;
                }
                if (!(s->cpuid_ext_features & sse_op_table6[b].ext_mask))
                    goto illegal_op;
            }

            if (vex_map38) {
"""
    if text.count(lookup_anchor) != 1:
        raise RuntimeError("Post-variable-shift helper routing no longer matches before broadcast extension")
    text = text.replace(lookup_anchor, lookup_replacement, 1)

    lowering_anchor = """            if (vex_map38) {
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if (b == 0x1c || b == 0x1d || b == 0x1e) {
"""
    lowering_replacement = """            if (vex_map38) {
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if (b == 0x58 || b == 0x59 || b == 0x78 || b == 0x79) {
                    /* Integer broadcasts reserve vvvv and require VEX.W=0. */
                    if (s->vex_v != 0 || s->dflag == MO_64) {
                        goto illegal_op;
                    }

                    if (mod == 3) {
                        rm = (modrm & 7) | REX_B(s);
                        op2_offset = offsetof(CPUX86State, xmm_regs[rm]);
                        if (rm == reg) {
                            /* Both destination lanes must observe the original
                             * scalar even when destination aliases the source. */
                            gen_op_movo(s, offsetof(CPUX86State, xmm_t0), op2_offset);
                            op2_offset = offsetof(CPUX86State, xmm_t0);
                        }
                    } else {
                        gen_lea_modrm(env, s, modrm);
                        op2_offset = offsetof(CPUX86State, xmm_t0);
                        switch (b) {
                        case 0x78: /* byte */
                            gen_op_ld_v(s, MO_8, s->T0, s->A0);
                            tcg_gen_st8_tl(tcg_ctx, s->T0, tcg_ctx->cpu_env,
                                           op2_offset + offsetof(ZMMReg, ZMM_B(0)));
                            break;
                        case 0x79: /* word */
                            gen_op_ld_v(s, MO_16, s->T0, s->A0);
                            tcg_gen_st16_tl(tcg_ctx, s->T0, tcg_ctx->cpu_env,
                                            op2_offset + offsetof(ZMMReg, ZMM_W(0)));
                            break;
                        case 0x58: /* dword */
                            gen_op_ld_v(s, MO_32, s->T0, s->A0);
                            tcg_gen_st32_tl(tcg_ctx, s->T0, tcg_ctx->cpu_env,
                                            op2_offset + offsetof(ZMMReg, ZMM_L(0)));
                            break;
                        case 0x59: /* qword */
                            gen_ldq_env_A0(s, op2_offset + offsetof(ZMMReg, ZMM_Q(0)));
                            break;
                        default:
                            goto illegal_op;
                        }
                    }

                    switch (b) {
                    case 0x78:
                        sse_fn_epp = gen_helper_vpbroadcastb_xmm;
                        break;
                    case 0x79:
                        sse_fn_epp = gen_helper_vpbroadcastw_xmm;
                        break;
                    case 0x58:
                        sse_fn_epp = gen_helper_vpbroadcastd_xmm;
                        break;
                    case 0x59:
                        sse_fn_epp = gen_helper_vpbroadcastq_xmm;
                        break;
                    default:
                        goto illegal_op;
                    }

                    tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
                    tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
                    sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                    if (s->vex_l) {
                        tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                        op1_offset + 16);
                        /* Deliberately reuse OP2: the scalar is global to the
                         * full vector, not lane-local. */
                        tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
                        sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                    }
                    gen_op_zero_vex_upper(s, op1_offset, s->vex_l);
                    break;
                }

                if (b == 0x1c || b == 0x1d || b == 0x1e) {
"""
    if text.count(lowering_anchor) != 1:
        raise RuntimeError("Post-extension 0F38 lowering anchor no longer matches before broadcast extension")
    translate_path.write_text(text.replace(lowering_anchor, lowering_replacement, 1))
