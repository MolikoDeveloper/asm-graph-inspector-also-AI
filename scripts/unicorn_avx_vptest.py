#!/usr/bin/env python3
"""Implement AVX VPTEST for XMM/YMM in pinned Unicorn/QEMU.

The legacy SSE4.1 PTEST helper computes ZF/CF over exactly 128 bits. Calling it
once per YMM lane would be wrong because the second call would overwrite flags
from the first. This layer therefore adds one full-YMM helper that aggregates
all four qwords before writing CC_SRC, while retaining the audited legacy helper
for VEX.128.
"""

from __future__ import annotations

from pathlib import Path


def patch_avx_vptest_helper(source_root: Path) -> None:
    ops_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse.h"
    text = ops_path.read_text()
    anchor = """/* VPERMD must observe all eight dwords as one 256-bit domain. D initially
 * contains the index vector and S contains the data vector. Snapshot both
"""
    replacement = """/* VPTEST must aggregate both 128-bit lanes before updating flags. */
void helper_vptest_ymm(CPUX86State *env, Reg *d, Reg *s)
{
    uint64_t zf = 0;
    uint64_t cf = 0;
    int i;

    for (i = 0; i < 4; ++i) {
        zf |= s->Q(i) & d->Q(i);
        cf |= s->Q(i) & ~d->Q(i);
    }
    CC_SRC = (zf ? 0 : CC_Z) | (cf ? 0 : CC_C);
}

/* VPERMD must observe all eight dwords as one 256-bit domain. D initially
 * contains the index vector and S contains the data vector. Snapshot both
"""
    if text.count(anchor) != 1:
        raise RuntimeError("VPERMD helper anchor no longer matches before VPTEST extension")
    ops_path.write_text(text.replace(anchor, replacement, 1))

    header_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse_header.h"
    text = header_path.read_text()
    header_anchor = """DEF_HELPER_3(vpermd_ymm, void, env, Reg, Reg)
DEF_HELPER_3(glue(vbroadcastf128, SUFFIX), void, env, Reg, Reg)
"""
    header_replacement = """DEF_HELPER_3(vptest_ymm, void, env, Reg, Reg)
DEF_HELPER_3(vpermd_ymm, void, env, Reg, Reg)
DEF_HELPER_3(glue(vbroadcastf128, SUFFIX), void, env, Reg, Reg)
"""
    if text.count(header_anchor) != 1:
        raise RuntimeError("VPERMD/FP-broadcast declarations no longer match before VPTEST extension")
    header_path.write_text(text.replace(header_anchor, header_replacement, 1))


def patch_avx_vptest_decoder(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    # Match the whole FP-broadcast insertion point. The shorter 0x18/0x19
    # sequence also appears in other switch blocks after the preceding layers,
    # which made the patch order-dependent even though the target block itself
    # was unchanged.
    allow_anchor = """                case 0x18:
                case 0x19:
                case 0x1a:
                case 0x35:
"""
    allow_replacement = """                case 0x17:
                case 0x18:
                case 0x19:
                case 0x1a:
                case 0x35:
"""
    if text.count(allow_anchor) != 1:
        raise RuntimeError("FP-broadcast 0F38 allow-list anchor no longer matches before VPTEST extension")
    text = text.replace(allow_anchor, allow_replacement, 1)

    lookup_anchor = """                (b == 0x18 || b == 0x19 || b == 0x1a ||
                 b == 0x36 || b == 0x45 || b == 0x46 || b == 0x47 ||
"""
    lookup_replacement = """                (b == 0x17 || b == 0x18 || b == 0x19 || b == 0x1a ||
                 b == 0x36 || b == 0x45 || b == 0x46 || b == 0x47 ||
"""
    if text.count(lookup_anchor) != 1:
        raise RuntimeError("FP-broadcast helper-routing condition no longer matches before VPTEST extension")
    text = text.replace(lookup_anchor, lookup_replacement, 1)

    switch_anchor = """                switch (b) {
                case 0x18:
                    sse_fn_epp = gen_helper_vpbroadcastd_xmm;
"""
    switch_replacement = """                switch (b) {
                case 0x17:
                    sse_fn_epp = s->vex_l ? gen_helper_vptest_ymm : gen_helper_ptest_xmm;
                    break;
                case 0x18:
                    sse_fn_epp = gen_helper_vpbroadcastd_xmm;
"""
    if text.count(switch_anchor) != 1:
        raise RuntimeError("FP-broadcast helper switch no longer matches before VPTEST extension")
    text = text.replace(switch_anchor, switch_replacement, 1)

    lowering_anchor = """            if (vex_map38) {
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if (b == 0x18 || b == 0x19 || b == 0x1a) {
"""
    lowering_replacement = """            if (vex_map38) {
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if (b == 0x17) {
                    /* VPTEST is two-source and reserves VEX.vvvv. It does not
                     * modify either vector operand. */
                    if (s->vex_v != 0) {
                        goto illegal_op;
                    }
                    if (mod == 3) {
                        rm = (modrm & 7) | REX_B(s);
                        op2_offset = offsetof(CPUX86State, xmm_regs[rm]);
                    } else {
                        gen_lea_modrm(env, s, modrm);
                        op2_offset = offsetof(CPUX86State, xmm_t0);
                        if (s->vex_l) {
                            gen_ldy_env_A0(s, op2_offset);
                        } else {
                            gen_ldo_env_A0(s, op2_offset);
                        }
                    }

                    tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
                    tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
                    sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                    set_cc_op(s, CC_OP_EFLAGS);
                    break;
                }

                if (b == 0x18 || b == 0x19 || b == 0x1a) {
"""
    if text.count(lowering_anchor) != 1:
        raise RuntimeError("FP-broadcast 0F38 lowering anchor no longer matches before VPTEST extension")
    translate_path.write_text(text.replace(lowering_anchor, lowering_replacement, 1))
