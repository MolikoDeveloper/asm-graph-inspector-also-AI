#!/usr/bin/env python3
"""Implement VZEROUPPER/VZEROALL without falling through to legacy EMMS."""

from __future__ import annotations

from pathlib import Path


def _zero_stores(first_q: int) -> str:
    lines: list[str] = []
    for reg in range(16):
        for qword in range(first_q, 8):
            lines.extend([
                "            tcg_gen_st_i64(tcg_ctx, s->tmp1_i64, tcg_ctx->cpu_env,",
                f"                           offsetof(CPUX86State, xmm_regs[{reg}]) +",
                f"                           offsetof(ZMMReg, ZMM_Q({qword})));",
            ])
    return "\n".join(lines)


def patch_avx_zero_state(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    anchor = """    else
        b1 = 0;
    sse_fn_epp = sse_op_table1[b][b1];
"""
    all_stores = _zero_stores(0)
    upper_stores = _zero_stores(2)
    replacement = f"""    else
        b1 = 0;

    /* VEX.0F.77 is VZEROUPPER/VZEROALL, not the legacy EMMS opcode stored in
     * sse_op_table1[0x77]. Reserved vvvv must decode to zero and no mandatory
     * prefix is permitted. Constant offsets are emitted deliberately: the
     * pinned TCG store API takes host-side offsets, not guest runtime indices. */
    if ((s->prefix & PREFIX_VEX) && b == 0x77) {{
        if (b1 != 0 || s->vex_v != 0 || s->dflag == MO_64) {{
            goto illegal_op;
        }}
        tcg_gen_movi_i64(tcg_ctx, s->tmp1_i64, 0);
        if (s->vex_l) {{
{all_stores}
        }} else {{
{upper_stores}
        }}
        return;
    }}

    sse_fn_epp = sse_op_table1[b][b1];
"""
    if text.count(anchor) != 1:
        raise RuntimeError("Pinned gen_sse prefix decode anchor no longer matches for VZERO patch")
    translate_path.write_text(text.replace(anchor, replacement, 1))
