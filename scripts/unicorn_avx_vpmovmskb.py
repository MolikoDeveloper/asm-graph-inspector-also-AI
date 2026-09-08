#!/usr/bin/env python3
"""Implement AVX VPMOVMSKB for XMM/YMM in pinned Unicorn/QEMU.

The existing SSE2 PMOVMSKB helper produces the 16 sign bits of one XMM lane.
VEX.256 therefore needs two helper invocations with an explicit 16-bit shift of
the high-lane mask before one zero-extending GPR32 write. VEX.vvvv is reserved
and memory source forms remain illegal.
"""

from __future__ import annotations

from pathlib import Path


def patch_avx_vpmovmskb_decoder(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    declaration_anchor = """    int vex_binary, vex_vector_move, vex_map38;
    SSEFunc_0_epp sse_fn_epp;
"""
    declaration_replacement = """    int vex_binary, vex_vector_move, vex_map38, vex_movmask;
    SSEFunc_0_epp sse_fn_epp;
"""
    if text.count(declaration_anchor) != 1:
        raise RuntimeError("Post-map1 AVX declaration block no longer matches before VPMOVMSKB extension")
    text = text.replace(declaration_anchor, declaration_replacement, 1)

    classification_anchor = """    vex_vector_move = (s->prefix & PREFIX_VEX) && is_xmm &&
                      (((b == 0x6f || b == 0x7f) &&
                        (b1 == 1 || b1 == 2)) ||
                       ((b == 0x10 || b == 0x11 ||
                         b == 0x28 || b == 0x29) && b1 <= 1));
"""
    classification_replacement = classification_anchor + """    vex_movmask = (s->prefix & PREFIX_VEX) && is_xmm &&
                  b == 0xd7 && b1 == 1;
"""
    if text.count(classification_anchor) != 1:
        raise RuntimeError("Post-map1 vector-move classification no longer matches before VPMOVMSKB extension")
    text = text.replace(classification_anchor, classification_replacement, 1)

    guard_anchor = """    if (s->vex_l != 0 && !(vex_binary || vex_vector_move || vex_map38)) {
        goto illegal_op;
    }
"""
    guard_replacement = """    if (s->vex_l != 0 && !(vex_binary || vex_vector_move || vex_map38 || vex_movmask)) {
        goto illegal_op;
    }
"""
    if text.count(guard_anchor) != 1:
        raise RuntimeError("Post-map1 VEX.L guard no longer matches before VPMOVMSKB extension")
    text = text.replace(guard_anchor, guard_replacement, 1)

    special_anchor = """        case 0xd7: /* pmovmskb */
        case 0x1d7:
            if (mod != 3)
                goto illegal_op;
            if (b1) {
                rm = (modrm & 7) | REX_B(s);
                tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                 offsetof(CPUX86State, xmm_regs[rm]));
                gen_helper_pmovmskb_xmm(tcg_ctx, s->tmp2_i32, tcg_ctx->cpu_env, s->ptr0);
            } else {
                rm = (modrm & 7);
                tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                 offsetof(CPUX86State, fpregs[rm].mmx));
                gen_helper_pmovmskb_mmx(tcg_ctx, s->tmp2_i32, tcg_ctx->cpu_env, s->ptr0);
            }
            reg = ((modrm >> 3) & 7) | rex_r;
            tcg_gen_extu_i32_tl(tcg_ctx, tcg_ctx->cpu_regs[reg], s->tmp2_i32);
            break;
"""
    special_replacement = """        case 0xd7: /* pmovmskb */
        case 0x1d7: /* pmovmskb / vpmovmskb */
            if (mod != 3)
                goto illegal_op;
            if (b1) {
                rm = (modrm & 7) | REX_B(s);
                if ((s->prefix & PREFIX_VEX) && s->vex_v != 0) {
                    goto illegal_op;
                }
                tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                 offsetof(CPUX86State, xmm_regs[rm]));
                gen_helper_pmovmskb_xmm(tcg_ctx, s->tmp2_i32, tcg_ctx->cpu_env, s->ptr0);
                if ((s->prefix & PREFIX_VEX) && s->vex_l) {
                    tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                     offsetof(CPUX86State, xmm_regs[rm]) + 16);
                    gen_helper_pmovmskb_xmm(tcg_ctx, s->tmp3_i32, tcg_ctx->cpu_env, s->ptr0);
                    tcg_gen_shli_i32(tcg_ctx, s->tmp3_i32, s->tmp3_i32, 16);
                    tcg_gen_or_i32(tcg_ctx, s->tmp2_i32, s->tmp2_i32, s->tmp3_i32);
                }
            } else {
                rm = (modrm & 7);
                tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                 offsetof(CPUX86State, fpregs[rm].mmx));
                gen_helper_pmovmskb_mmx(tcg_ctx, s->tmp2_i32, tcg_ctx->cpu_env, s->ptr0);
            }
            reg = ((modrm >> 3) & 7) | rex_r;
            tcg_gen_extu_i32_tl(tcg_ctx, tcg_ctx->cpu_regs[reg], s->tmp2_i32);
            break;
"""
    if text.count(special_anchor) != 1:
        raise RuntimeError("Pinned PMOVMSKB special lowering no longer matches before VPMOVMSKB extension")
    text = text.replace(special_anchor, special_replacement, 1)

    translate_path.write_text(text)
