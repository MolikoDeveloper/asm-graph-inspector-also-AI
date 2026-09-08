#!/usr/bin/env python3
"""Dedicated full-YMM lowering for AVX2 VPERMD.

VPERMD is the first enabled operation whose semantics genuinely cross the
128-bit lane boundary: every destination dword may select any of the eight
source dwords. Applying an XMM helper independently to low/high lanes would be
architecturally wrong.

The existing three-operand AVX2 machinery is still useful for operand staging:
VEX.vvvv supplies the index vector, ModRM supplies the data vector, and memory
sources are staged transactionally. This layer adds one helper that consumes the
full 256-bit index/data vectors at once. VEX.L=0 and VEX.W=1 stay fail-closed.
"""

from __future__ import annotations

from pathlib import Path


VPERMD_OPCODE = 0x36


def patch_avx2_vpermd_helper(source_root: Path) -> None:
    ops_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse.h"
    text = ops_path.read_text()

    anchor = """#if SHIFT == 1
/* AVX2 integer broadcasts. Each helper fills one 128-bit destination chunk
"""
    replacement = """#if SHIFT == 1
/* VPERMD must observe all eight dwords as one 256-bit domain. D initially
 * contains the index vector and S contains the data vector. Snapshot both
 * before producing output so every architectural alias combination is safe. */
void helper_vpermd_ymm(CPUX86State *env, Reg *d, Reg *s)
{
    Reg indices = *d;
    Reg data = *s;
    int i;

    for (i = 0; i < 8; ++i) {
        d->L(i) = data.L(indices.L(i) & 7);
    }
}

/* AVX2 integer broadcasts. Each helper fills one 128-bit destination chunk
"""
    if text.count(anchor) != 1:
        raise RuntimeError("Broadcast helper anchor no longer matches before VPERMD extension")
    ops_path.write_text(text.replace(anchor, replacement, 1))

    header_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse_header.h"
    text = header_path.read_text()
    header_anchor = """#if SHIFT == 1
DEF_HELPER_3(glue(vpbroadcastb, SUFFIX), void, env, Reg, Reg)
"""
    header_replacement = """#if SHIFT == 1
DEF_HELPER_3(vpermd_ymm, void, env, Reg, Reg)
DEF_HELPER_3(glue(vpbroadcastb, SUFFIX), void, env, Reg, Reg)
"""
    if text.count(header_anchor) != 1:
        raise RuntimeError("Broadcast declarations no longer match before VPERMD extension")
    header_path.write_text(text.replace(header_anchor, header_replacement, 1))


def patch_avx2_vpermd_decoder(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    allow_anchor = """                case 0x35:
                case 0x45:
"""
    allow_replacement = """                case 0x35:
                case 0x36:
                case 0x45:
"""
    if text.count(allow_anchor) != 1:
        raise RuntimeError("Post-broadcast 0F38 allow-list anchor no longer matches")
    text = text.replace(allow_anchor, allow_replacement, 1)

    lookup_anchor = """                (b == 0x45 || b == 0x46 || b == 0x47 ||
                 b == 0x58 || b == 0x59 || b == 0x78 || b == 0x79)) {
"""
    lookup_replacement = """                (b == 0x36 || b == 0x45 || b == 0x46 || b == 0x47 ||
                 b == 0x58 || b == 0x59 || b == 0x78 || b == 0x79)) {
"""
    if text.count(lookup_anchor) != 1:
        raise RuntimeError("Post-broadcast helper-routing condition no longer matches")
    text = text.replace(lookup_anchor, lookup_replacement, 1)

    switch_anchor = """                switch (b) {
                case 0x45:
"""
    switch_replacement = """                switch (b) {
                case 0x36:
                    sse_fn_epp = gen_helper_vpermd_ymm;
                    break;
                case 0x45:
"""
    if text.count(switch_anchor) != 1:
        raise RuntimeError("Post-broadcast AVX2-only helper switch no longer matches")
    text = text.replace(switch_anchor, switch_replacement, 1)

    lowering_anchor = """            if (vex_map38) {
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if (b == 0x58 || b == 0x59 || b == 0x78 || b == 0x79) {
"""
    lowering_replacement = """            if (vex_map38) {
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if (b == 0x36) {
                    int src1_offset;

                    /* AVX2 VPERMD is VEX.256.W0 only. vvvv is the index
                     * operand, so unlike unary/broadcast forms it is not
                     * reserved. */
                    if (!s->vex_l || s->dflag == MO_64) {
                        goto illegal_op;
                    }
                    src1_offset = offsetof(CPUX86State, xmm_regs[s->vex_v]);

                    if (mod == 3) {
                        rm = (modrm & 7) | REX_B(s);
                        op2_offset = offsetof(CPUX86State, xmm_regs[rm]);
                        if (rm == reg) {
                            /* Source2 would otherwise be destroyed while the
                             * index vector is installed in destination. */
                            gen_op_movy(s, offsetof(CPUX86State, xmm_t0), op2_offset);
                            op2_offset = offsetof(CPUX86State, xmm_t0);
                        }
                    } else {
                        gen_lea_modrm(env, s, modrm);
                        op2_offset = offsetof(CPUX86State, xmm_t0);
                        gen_ldy_env_A0(s, op2_offset);
                    }

                    if (s->vex_v != reg) {
                        gen_op_movy(s, op1_offset, src1_offset);
                    }

                    tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
                    tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
                    sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                    gen_op_zero_vex_upper(s, op1_offset, 1);
                    break;
                }

                if (b == 0x58 || b == 0x59 || b == 0x78 || b == 0x79) {
"""
    if text.count(lowering_anchor) != 1:
        raise RuntimeError("Post-broadcast 0F38 lowering anchor no longer matches")
    translate_path.write_text(text.replace(lowering_anchor, lowering_replacement, 1))
