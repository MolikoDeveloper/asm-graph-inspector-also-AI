#!/usr/bin/env python3
"""Implement VZEROUPPER/VZEROALL without falling through to legacy EMMS."""

from __future__ import annotations

from pathlib import Path


def patch_avx_zero_state(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    anchor = """    else
        b1 = 0;
    sse_fn_epp = sse_op_table1[b][b1];
"""
    replacement = """    else
        b1 = 0;

    /* VEX.0F.77 is VZEROUPPER/VZEROALL, not the legacy EMMS opcode stored in
     * sse_op_table1[0x77]. Reserved vvvv must decode to zero and no mandatory
     * prefix is permitted. Generate explicit stores so counted execution has a
     * real TCG operation and cannot run through padding after a no-op helper. */
    if ((s->prefix & PREFIX_VEX) && b == 0x77) {
        int vr, vq;
        int first_q;

        if (b1 != 0 || s->vex_v != 0 || s->dflag == MO_64) {
            goto illegal_op;
        }
        first_q = s->vex_l ? 0 : 2;
        tcg_gen_movi_i64(tcg_ctx, s->tmp1_i64, 0);
        for (vr = 0; vr < 16; ++vr) {
            for (vq = first_q; vq < 8; ++vq) {
                tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,
                               offsetof(CPUX86State, xmm_regs[vr]) +
                               offsetof(ZMMReg, ZMM_Q(vq)));
            }
        }
        return;
    }

    sse_fn_epp = sse_op_table1[b][b1];
"""
    if text.count(anchor) != 1:
        raise RuntimeError("Pinned gen_sse prefix decode anchor no longer matches for VZERO patch")
    translate_path.write_text(text.replace(anchor, replacement, 1))
