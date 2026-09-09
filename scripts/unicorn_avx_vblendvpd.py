#!/usr/bin/env python3
"""Dedicated VEX.0F3A lowering for AVX VBLENDVPD.

The pinned translator has a legacy BLENDVPD helper, but that SSE4.1 form takes
its mask implicitly from XMM0. AVX VBLENDVPD instead has four architectural
operands: VEX.vvvv is source1, ModRM supplies source2, and imm8[7:4] selects the
mask register. Reusing the legacy helper would therefore be incorrect whenever
the mask is not XMM0.

Keep the 0F3A map fail-closed. Only opcode 4B with mandatory 66 prefix and W=0
is admitted here; every other VEX.0F3A instruction remains illegal until it has
its own audited lowering.
"""

from __future__ import annotations

from pathlib import Path


def patch_avx_vblendvpd_decoder(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    declaration_before = """    int vex_binary, vex_vector_move, vex_map38;
    SSEFunc_0_epp sse_fn_epp;
"""
    declaration_after = """    int vex_binary, vex_vector_move, vex_map38, vex_map3a_vblendvpd;
    SSEFunc_0_epp sse_fn_epp;
"""
    if text.count(declaration_before) != 1:
        raise RuntimeError("Final AVX declaration block no longer matches before VBLENDVPD extension")
    text = text.replace(declaration_before, declaration_after, 1)

    classification_before = """    vex_map38 = (s->prefix & PREFIX_VEX) && is_xmm && b == 0x38 && b1 == 1;
    vex_vector_move = (s->prefix & PREFIX_VEX) && is_xmm &&
"""
    classification_after = """    vex_map38 = (s->prefix & PREFIX_VEX) && is_xmm && b == 0x38 && b1 == 1;
    /* VEX.66.0F3A is still globally closed. This classification only lets the
     * dedicated 4B decoder below survive the VEX.L guard long enough to reject
     * every other opcode explicitly. */
    vex_map3a_vblendvpd = (s->prefix & PREFIX_VEX) && is_xmm &&
                          b == 0x3a && b1 == 1;
    vex_vector_move = (s->prefix & PREFIX_VEX) && is_xmm &&
"""
    if text.count(classification_before) != 1:
        raise RuntimeError("Final AVX map38 classification no longer matches before VBLENDVPD extension")
    text = text.replace(classification_before, classification_after, 1)

    guard_before = """    if (s->vex_l != 0 && !(vex_binary || vex_vector_move || vex_map38)) {
        goto illegal_op;
    }
"""
    guard_after = """    if (s->vex_l != 0 &&
        !(vex_binary || vex_vector_move || vex_map38 || vex_map3a_vblendvpd)) {
        goto illegal_op;
    }
"""
    if text.count(guard_before) != 1:
        raise RuntimeError("Final AVX VEX.L guard no longer matches before VBLENDVPD extension")
    text = text.replace(guard_before, guard_after, 1)

    map3a_before = """        case 0x03a:
        case 0x13a:
            b = modrm;
            modrm = x86_ldub_code(env, s);
            rm = modrm & 7;
            reg = ((modrm >> 3) & 7) | rex_r;
            mod = (modrm >> 6) & 3;

            if (b1 >= 2) {
                goto unknown_op;
            }
            sse_fn_eppi = sse_op_table7[b].op[b1];
            if (!sse_fn_eppi) {
                goto unknown_op;
            }
"""
    map3a_after = """        case 0x03a:
        case 0x13a:
            b = modrm;
            modrm = x86_ldub_code(env, s);
            rm = modrm & 7;
            reg = ((modrm >> 3) & 7) | rex_r;
            mod = (modrm >> 6) & 3;

            if (vex_map3a_vblendvpd) {
                int dest_offset;
                int src1_offset;
                int src2_offset;
                int mask_offset;
                int mask_reg;
                int lane;
                int lanes;
                TCGv_i64 src1_value;
                TCGv_i64 src2_value;
                TCGv_i64 mask_value;
                TCGv_i64 inverse_mask;
                TCGv_i64 selected;

                /* VBLENDVPD is VEX.128/256.66.0F3A.W0 4B /r /is4. Do not
                 * admit any neighbouring 0F3A instruction merely because the
                 * vector-length guard was opened for this one family. */
                if (b != 0x4b || s->dflag == MO_64) {
                    goto illegal_op;
                }

                dest_offset = offsetof(CPUX86State, xmm_regs[reg]);
                src1_offset = offsetof(CPUX86State, xmm_regs[s->vex_v]);
                s->rip_offset = 1; /* immediate mask register follows ModRM */

                if (mod == 3) {
                    rm |= REX_B(s);
                    src2_offset = offsetof(CPUX86State, xmm_regs[rm]);
                } else {
                    /* Stage the complete architectural memory source before
                     * mutating destination state. Besides preserving aliases,
                     * this guarantees exact m128/m256 access width. */
                    gen_lea_modrm(env, s, modrm);
                    src2_offset = offsetof(CPUX86State, xmm_t0);
                    if (s->vex_l) {
                        gen_ldy_env_A0(s, src2_offset);
                    } else {
                        gen_ldo_env_A0(s, src2_offset);
                    }
                }

                val = x86_ldub_code(env, s);
                mask_reg = (val >> 4) & 0xf;
                mask_offset = offsetof(CPUX86State, xmm_regs[mask_reg]);
                lanes = s->vex_l ? 4 : 2;

                src1_value = tcg_temp_new_i64(tcg_ctx);
                src2_value = tcg_temp_new_i64(tcg_ctx);
                mask_value = tcg_temp_new_i64(tcg_ctx);
                inverse_mask = tcg_temp_new_i64(tcg_ctx);
                selected = tcg_temp_new_i64(tcg_ctx);

                /* Each qword is lane-independent. Arithmetic-shifting the mask
                 * sign bit creates either all-zeroes or all-ones, which lets us
                 * select source2/source1 with ordinary TCG integer operations.
                 * This remains correct when dest aliases src1, src2, or mask:
                 * a store only changes the qword whose inputs were already read. */
                for (lane = 0; lane < lanes; ++lane) {
                    int q_offset = offsetof(ZMMReg, ZMM_Q(0)) + lane * 8;
                    tcg_gen_ld_i64(tcg_ctx, src1_value, tcg_ctx->cpu_env,
                                   src1_offset + q_offset);
                    tcg_gen_ld_i64(tcg_ctx, src2_value, tcg_ctx->cpu_env,
                                   src2_offset + q_offset);
                    tcg_gen_ld_i64(tcg_ctx, mask_value, tcg_ctx->cpu_env,
                                   mask_offset + q_offset);
                    tcg_gen_sari_i64(tcg_ctx, mask_value, mask_value, 63);
                    tcg_gen_not_i64(tcg_ctx, inverse_mask, mask_value);
                    tcg_gen_and_i64(tcg_ctx, selected, src2_value, mask_value);
                    tcg_gen_and_i64(tcg_ctx, inverse_mask, src1_value, inverse_mask);
                    tcg_gen_or_i64(tcg_ctx, selected, selected, inverse_mask);
                    tcg_gen_st_i64(tcg_ctx, selected, tcg_ctx->cpu_env,
                                   dest_offset + q_offset);
                }

                tcg_temp_free_i64(tcg_ctx, selected);
                tcg_temp_free_i64(tcg_ctx, inverse_mask);
                tcg_temp_free_i64(tcg_ctx, mask_value);
                tcg_temp_free_i64(tcg_ctx, src2_value);
                tcg_temp_free_i64(tcg_ctx, src1_value);
                gen_op_zero_vex_upper(s, dest_offset, s->vex_l);
                break;
            }

            if (b1 >= 2) {
                goto unknown_op;
            }
            sse_fn_eppi = sse_op_table7[b].op[b1];
            if (!sse_fn_eppi) {
                goto unknown_op;
            }
"""
    if text.count(map3a_before) != 1:
        raise RuntimeError("Pinned 0F3A decoder block no longer matches before VBLENDVPD extension")
    translate_path.write_text(text.replace(map3a_before, map3a_after, 1))
