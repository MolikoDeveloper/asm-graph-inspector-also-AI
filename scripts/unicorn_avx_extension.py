#!/usr/bin/env python3
"""Audited AVX (VEX.0F) extensions layered on the existing AVX2 patch.

The pinned QEMU already has mature SSE/SSE2/SSE3 helpers for the arithmetic
semantics below. This layer adapts VEX operand topology and vector width:
NDS three-operand instructions stage VEX.vvvv as source1, 256-bit packed forms
run the existing helper independently for each architectural 128-bit lane, and
VEX.128 destinations keep the existing zero-upper invariant.

Do not add opcodes here merely because an SSE helper exists. Every condition in
this file corresponds to an explicit VEX form in the requested AVX matrix.
"""

from __future__ import annotations

from pathlib import Path

from unicorn_avx2_extension import PACKED_BINARY_OPCODES


def _base_binary_classification() -> str:
    packed_conditions = " ||\n               ".join(
        f"b == 0x{opcode:02x}" for opcode in PACKED_BINARY_OPCODES
    )
    return f"""    vex_binary = (s->prefix & PREFIX_VEX) && is_xmm &&
                 ((b == 0x57 && b1 <= 1) ||
                  (b1 == 1 && ({packed_conditions})));
"""


def patch_avx_map1_binary_and_moves(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    old_classification = _base_binary_classification()
    new_classification = """    vex_binary = (s->prefix & PREFIX_VEX) && is_xmm &&
                 (
                  /* Existing audited packed-integer closure. */
                  (b1 == 1 && (
                   b == 0x60 || b == 0x61 || b == 0x62 || b == 0x63 ||
                   b == 0x67 || b == 0x68 || b == 0x69 || b == 0x6a ||
                   b == 0x6b || b == 0x6c || b == 0x6d || b == 0x64 ||
                   b == 0x65 || b == 0x66 || b == 0x74 || b == 0x75 ||
                   b == 0x76 || b == 0xd4 || b == 0xdb || b == 0xdf ||
                   b == 0xeb || b == 0xef || b == 0xf8 || b == 0xf9 ||
                   b == 0xfa || b == 0xfb || b == 0xfc || b == 0xfd ||
                   b == 0xfe || b == 0xd5 || b == 0xe4 || b == 0xe5 ||
                   b == 0xf4 || b == 0xf5 || b == 0xf6 || b == 0xd8 ||
                   b == 0xd9 || b == 0xda || b == 0xdc || b == 0xdd ||
                   b == 0xde || b == 0xe0 || b == 0xe3 || b == 0xe8 ||
                   b == 0xe9 || b == 0xea || b == 0xec || b == 0xed ||
                   b == 0xee)) ||
                  /* Packed FP/logical and unpack operations: VEX.128/256. */
                  (b1 <= 1 && (
                   b == 0x14 || b == 0x15 ||
                   b == 0x54 || b == 0x55 || b == 0x56 || b == 0x57 ||
                   b == 0x58 || b == 0x59 || b == 0x5c || b == 0x5d ||
                   b == 0x5e || b == 0x5f)) ||
                  /* Scalar NDS arithmetic: VEX.L must be zero. */
                  (!s->vex_l && (b1 == 2 || b1 == 3) &&
                   (b == 0x58 || b == 0x59 || b == 0x5c ||
                    b == 0x5d || b == 0x5e || b == 0x5f)) ||
                  /* Scalar sqrt/rcp/rsqrt are NDS. */
                  (!s->vex_l && b1 == 2 &&
                   (b == 0x51 || b == 0x52 || b == 0x53)) ||
                  (!s->vex_l && b1 == 3 && b == 0x51) ||
                  /* Packed unary sqrt/rcp/rsqrt reserve VEX.vvvv. The generic
                   * helper path snapshots source2 before destination writes. */
                  (s->vex_v == 0 &&
                   ((b == 0x51 && b1 <= 1) ||
                    ((b == 0x52 || b == 0x53) && b1 == 0))) ||
                  /* VCMP is NDS for packed/scalar forms. Packed permits L=1;
                   * scalar must remain VEX.128. Predicate extension is checked
                   * by the immediate dispatch below. */
                  (b == 0xc2 && (b1 <= 1 || !s->vex_l)) ||
                  /* VSHUFPS/PD are packed NDS; VPSHUF* is unary with reserved
                   * vvvv and uses the same immediate helper path. */
                  (b == 0xc6 && b1 <= 1) ||
                  (b == 0x70 && s->vex_v == 0 &&
                   (b1 == 1 || b1 == 2 || b1 == 3)) ||
                  /* SSE3 horizontal/addsub helpers are lane-local for YMM. */
                  ((b1 == 1 || b1 == 3) &&
                   (b == 0x7c || b == 0x7d || b == 0xd0))
                 );
"""
    if text.count(old_classification) != 1:
        raise RuntimeError("Post-AVX2 VEX binary classification no longer matches")
    text = text.replace(old_classification, new_classification, 1)

    old_moves = """    vex_vector_move = (s->prefix & PREFIX_VEX) && is_xmm &&
                      ((b == 0x6f || b == 0x7f) &&
                       (b1 == 1 || b1 == 2));
"""
    new_moves = """    vex_vector_move = (s->prefix & PREFIX_VEX) && is_xmm &&
                      (((b == 0x6f || b == 0x7f) &&
                        (b1 == 1 || b1 == 2)) ||
                       ((b == 0x10 || b == 0x11 ||
                         b == 0x28 || b == 0x29) && b1 <= 1));
"""
    if text.count(old_moves) != 1:
        raise RuntimeError("Post-AVX2 vector-move classification no longer matches")
    text = text.replace(old_moves, new_moves, 1)

    immediate_before = """        case 0x70: /* pshufx insn */
        case 0xc6: /* pshufx insn */
            val = x86_ldub_code(env, s);
            tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
            tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
            /* XXX: introduce a new table? */
            sse_fn_ppi = (SSEFunc_0_ppi)sse_fn_epp;
            sse_fn_ppi(tcg_ctx, s->ptr0, s->ptr1, tcg_const_i32(tcg_ctx, val));
            break;
        case 0xc2:
            /* compare insns */
            val = x86_ldub_code(env, s);
            if (val >= 8)
                goto unknown_op;
            sse_fn_epp = sse_op_table4[val][b1];

            tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
            tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
            sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
            break;
"""
    immediate_after = """        case 0x70: /* pshufx / vpshufx */
        case 0xc6: /* shufps/pd / vshufps/pd */
            val = x86_ldub_code(env, s);
            tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
            tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
            sse_fn_ppi = (SSEFunc_0_ppi)sse_fn_epp;
            sse_fn_ppi(tcg_ctx, s->ptr0, s->ptr1, tcg_const_i32(tcg_ctx, val));
            if (vex_binary && s->vex_l) {
                tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset + 16);
                tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset + 16);
                sse_fn_ppi(tcg_ctx, s->ptr0, s->ptr1, tcg_const_i32(tcg_ctx, val));
            }
            if (vex_binary) {
                gen_op_zero_vex_upper(s, op1_offset, s->vex_l);
            }
            break;
        case 0xc2:
            /* AVX retains the legacy eight SSE predicates and adds more. Keep
             * unported predicates fail-closed rather than aliasing their
             * exception/signaling semantics. */
            val = x86_ldub_code(env, s);
            if (val >= 8)
                goto unknown_op;
            sse_fn_epp = sse_op_table4[val][b1];

            tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
            tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
            sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
            if (vex_binary && s->vex_l) {
                tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset + 16);
                tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset + 16);
                sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
            }
            if (vex_binary) {
                gen_op_zero_vex_upper(s, op1_offset, s->vex_l);
            }
            break;
"""
    if text.count(immediate_before) != 1:
        raise RuntimeError("Pinned immediate compare/shuffle block no longer matches")
    text = text.replace(immediate_before, immediate_after, 1)

    translate_path.write_text(text)
