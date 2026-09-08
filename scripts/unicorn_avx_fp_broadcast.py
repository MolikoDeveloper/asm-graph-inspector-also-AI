#!/usr/bin/env python3
"""AVX floating-point broadcast lowering for pinned Unicorn/QEMU.

VBROADCASTSS/SD/F128 are bitwise broadcasts: no floating-point arithmetic or
rounding occurs. Reuse the audited integer broadcast helpers for 32/64-bit
scalars and add one narrow 128-bit copy helper for VBROADCASTF128. The AVX forms
covered here are memory-source forms only, matching the architectural AVX
encodings used by the requested matrix and real ray_test workload.
"""

from __future__ import annotations

from pathlib import Path


def patch_avx_fp_broadcast_helper(source_root: Path) -> None:
    ops_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse.h"
    text = ops_path.read_text()

    anchor = """/* AVX2 integer broadcasts. Each helper fills one 128-bit destination chunk
 * from the low scalar element of S. The translator deliberately invokes the
"""
    replacement = """/* AVX VBROADCASTF128 copies one 128-bit memory object into each YMM lane.
 * Keep this helper deliberately narrow so no bytes beyond the architectural
 * source width participate in the operation. */
void glue(helper_vbroadcastf128, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    d->Q(0) = s->Q(0);
    d->Q(1) = s->Q(1);
}

/* AVX2 integer broadcasts. Each helper fills one 128-bit destination chunk
 * from the low scalar element of S. The translator deliberately invokes the
"""
    if text.count(anchor) != 1:
        raise RuntimeError("Integer-broadcast helper anchor no longer matches before FP broadcast extension")
    ops_path.write_text(text.replace(anchor, replacement, 1))

    header_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse_header.h"
    text = header_path.read_text()
    header_anchor = """DEF_HELPER_3(vpermd_ymm, void, env, Reg, Reg)
DEF_HELPER_3(glue(vpbroadcastb, SUFFIX), void, env, Reg, Reg)
"""
    header_replacement = """DEF_HELPER_3(vpermd_ymm, void, env, Reg, Reg)
DEF_HELPER_3(glue(vbroadcastf128, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpbroadcastb, SUFFIX), void, env, Reg, Reg)
"""
    if text.count(header_anchor) != 1:
        raise RuntimeError("VPERMD/broadcast helper declarations no longer match before FP broadcast extension")
    header_path.write_text(text.replace(header_anchor, header_replacement, 1))


def patch_avx_fp_broadcast_decoder(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    allow_anchor = """                case 0x35:
                case 0x36:
                case 0x45:
"""
    allow_replacement = """                case 0x18:
                case 0x19:
                case 0x1a:
                case 0x35:
                case 0x36:
                case 0x45:
"""
    if text.count(allow_anchor) != 1:
        raise RuntimeError("Post-VPERMD 0F38 allow-list anchor no longer matches")
    text = text.replace(allow_anchor, allow_replacement, 1)

    lookup_anchor = """                (b == 0x36 || b == 0x45 || b == 0x46 || b == 0x47 ||
                 b == 0x58 || b == 0x59 || b == 0x78 || b == 0x79)) {
"""
    lookup_replacement = """                (b == 0x18 || b == 0x19 || b == 0x1a ||
                 b == 0x36 || b == 0x45 || b == 0x46 || b == 0x47 ||
                 b == 0x58 || b == 0x59 || b == 0x78 || b == 0x79)) {
"""
    if text.count(lookup_anchor) != 1:
        raise RuntimeError("Post-VPERMD AVX2 helper-routing condition no longer matches")
    text = text.replace(lookup_anchor, lookup_replacement, 1)

    switch_anchor = """                switch (b) {
                case 0x36:
                    sse_fn_epp = gen_helper_vpermd_ymm;
"""
    switch_replacement = """                switch (b) {
                case 0x18:
                    sse_fn_epp = gen_helper_vpbroadcastd_xmm;
                    break;
                case 0x19:
                    sse_fn_epp = gen_helper_vpbroadcastq_xmm;
                    break;
                case 0x1a:
                    sse_fn_epp = gen_helper_vbroadcastf128_xmm;
                    break;
                case 0x36:
                    sse_fn_epp = gen_helper_vpermd_ymm;
"""
    if text.count(switch_anchor) != 1:
        raise RuntimeError("Post-VPERMD helper switch no longer matches before FP broadcast extension")
    text = text.replace(switch_anchor, switch_replacement, 1)

    lowering_anchor = """            if (vex_map38) {
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if (b == 0x36) {
"""
    lowering_replacement = """            if (vex_map38) {
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if (b == 0x18 || b == 0x19 || b == 0x1a) {
                    /* AVX floating-point broadcasts reserve vvvv. The AVX
                     * encodings implemented here are memory-source forms;
                     * VBROADCASTSD/F128 are VEX.256-only. */
                    if (s->vex_v != 0 || mod == 3) {
                        goto illegal_op;
                    }
                    if ((b == 0x19 || b == 0x1a) && !s->vex_l) {
                        goto illegal_op;
                    }

                    gen_lea_modrm(env, s, modrm);
                    op2_offset = offsetof(CPUX86State, xmm_t0);
                    switch (b) {
                    case 0x18: /* vbroadcastss: m32 */
                        gen_op_ld_v(s, MO_32, s->T0, s->A0);
                        tcg_gen_st32_tl(tcg_ctx, s->T0, tcg_ctx->cpu_env,
                                        op2_offset + offsetof(ZMMReg, ZMM_L(0)));
                        sse_fn_epp = gen_helper_vpbroadcastd_xmm;
                        break;
                    case 0x19: /* vbroadcastsd: m64 */
                        gen_ldq_env_A0(s, op2_offset + offsetof(ZMMReg, ZMM_Q(0)));
                        sse_fn_epp = gen_helper_vpbroadcastq_xmm;
                        break;
                    case 0x1a: /* vbroadcastf128: m128 */
                        gen_ldo_env_A0(s, op2_offset);
                        sse_fn_epp = gen_helper_vbroadcastf128_xmm;
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
                        tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
                        sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                    }
                    gen_op_zero_vex_upper(s, op1_offset, s->vex_l);
                    break;
                }

                if (b == 0x36) {
"""
    if text.count(lowering_anchor) != 1:
        raise RuntimeError("Post-VPERMD 0F38 lowering anchor no longer matches before FP broadcast extension")
    translate_path.write_text(text.replace(lowering_anchor, lowering_replacement, 1))
