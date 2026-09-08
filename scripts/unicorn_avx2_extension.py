#!/usr/bin/env python3
"""Incremental AVX2 extensions for the pinned Unicorn/QEMU translator.

The base patch establishes truthful VEX three-operand state handling plus YMM
load/store. This module widens only explicitly audited instruction families.
Every enabled 256-bit operation is either defined independently per 128-bit lane
or receives dedicated lowering here.

Do not turn this into a blanket VEX.L enable. Cross-lane permutations,
variable-count shifts, broadcasts, gathers and other AVX2-specific semantics
stay fail-closed until implemented and tested.
"""

from __future__ import annotations

from pathlib import Path


PACKED_BINARY_OPCODES = (
    0x60, 0x61, 0x62, 0x63, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D,
    0x64, 0x65, 0x66, 0x74, 0x75, 0x76,
    0xD4, 0xDB, 0xDF, 0xEB, 0xEF, 0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD, 0xFE,
    0xD5, 0xE4, 0xE5, 0xF4, 0xF5, 0xF6,
    0xD8, 0xD9, 0xDA, 0xDC, 0xDD, 0xDE,
    0xE0, 0xE3,
    0xE8, 0xE9, 0xEA, 0xEC, 0xED, 0xEE,
)

MAP38_BINARY_OPCODES = (
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    0x08, 0x09, 0x0A, 0x0B,
    0x28, 0x29, 0x2B, 0x37,
    0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40,
)

# Unary full-width source operations. VEX.vvvv is reserved and must remain 1111b.
MAP38_UNARY_OPCODES = (
    0x1C,  # vpabsb
    0x1D,  # vpabsw
    0x1E,  # vpabsd
)

# VPMOVSX*/VPMOVZX*. One XMM helper produces one 128-bit destination. For
# VEX.256 the second call consumes the immediately following narrow source
# chunk and writes the high 128-bit destination lane.
MAP38_EXTEND_OPCODES = (
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25,
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35,
)


def patch_avx2_packed_integer_ops(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    old_classification = """    vex_xor = (s->prefix & PREFIX_VEX) && is_xmm &&
              ((b == 0x57 && b1 <= 1) || (b == 0xef && b1 == 1));
"""
    packed_conditions = " ||\n               ".join(
        f"b == 0x{opcode:02x}" for opcode in PACKED_BINARY_OPCODES
    )
    new_classification = f"""    vex_binary = (s->prefix & PREFIX_VEX) && is_xmm &&
                 ((b == 0x57 && b1 <= 1) ||
                  (b1 == 1 && ({packed_conditions})));
"""

    if text.count(old_classification) != 1:
        raise RuntimeError("Base AVX binary classification no longer matches the audited patch")
    occurrences = text.count("vex_xor")
    if occurrences < 5:
        raise RuntimeError(
            f"Base AVX vex_xor lowering expected at least 5 references, found {occurrences}"
        )

    text = text.replace(old_classification, new_classification, 1)
    text = text.replace("vex_xor", "vex_binary")
    text = text.replace(
        "true three-operand XOR plus\n     * VMOVDQA/VMOVDQU are the only vector operations allowed to use VEX.L=1.",
        "audited three-operand lane-local binary ops plus\n     * VMOVDQA/VMOVDQU are the only vector operations allowed to use VEX.L=1.",
        1,
    )
    text = text.replace(
        "move/XOR closure. Do not turn this into a broad VEX.L enable.",
        "move/packed-binary closure. Do not turn this into a broad VEX.L enable.",
        1,
    )
    translate_path.write_text(text)


def patch_avx2_map38_lane_local_ops(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    declaration_before = """    int vex_binary, vex_vector_move;
    SSEFunc_0_epp sse_fn_epp;
"""
    declaration_after = """    int vex_binary, vex_vector_move, vex_map38;
    SSEFunc_0_epp sse_fn_epp;
"""
    if text.count(declaration_before) != 1:
        raise RuntimeError("AVX declaration block no longer matches before 0F38 extension")
    text = text.replace(declaration_before, declaration_after, 1)

    classify_before = """    vex_vector_move = (s->prefix & PREFIX_VEX) && is_xmm &&
                      ((b == 0x6f || b == 0x7f) &&
                       (b1 == 1 || b1 == 2));
"""
    classify_after = """    /* 0F38's real opcode byte is read later into modrm. Permit only the
     * 66/VEX map to reach that decoder; an explicit opcode allow-list there
     * rejects every unaudited VEX form before it can execute. */
    vex_map38 = (s->prefix & PREFIX_VEX) && is_xmm && b == 0x38 && b1 == 1;
    vex_vector_move = (s->prefix & PREFIX_VEX) && is_xmm &&
                      ((b == 0x6f || b == 0x7f) &&
                       (b1 == 1 || b1 == 2));
"""
    if text.count(classify_before) != 1:
        raise RuntimeError("AVX vector-move classification no longer matches before 0F38 extension")
    text = text.replace(classify_before, classify_after, 1)

    guard_before = """    if (s->vex_l != 0 && !(vex_binary || vex_vector_move)) {
        goto illegal_op;
    }
"""
    guard_after = """    if (s->vex_l != 0 && !(vex_binary || vex_vector_move || vex_map38)) {
        goto illegal_op;
    }
"""
    if text.count(guard_before) != 1:
        raise RuntimeError("AVX VEX.L guard no longer matches before 0F38 extension")
    text = text.replace(guard_before, guard_after, 1)

    allowed = MAP38_BINARY_OPCODES + MAP38_UNARY_OPCODES + MAP38_EXTEND_OPCODES
    allow_cases = "\n".join(f"                case 0x{opcode:02x}:" for opcode in allowed)
    map_entry_before = """        case 0x138:
        case 0x038:
            b = modrm;
            if ((b & 0xf0) == 0xf0) {
"""
    map_entry_after = f"""        case 0x138:
        case 0x038:
            b = modrm;
            /* SHLX is scalar BMI2 but uses the same 66/VEX.0F38 map as the
             * AVX2 subset below. Let the upstream BMI2 decoder handle F7. */
            if (vex_map38 && b == 0xf7) {{
                vex_map38 = 0;
            }}
            if (vex_map38) {{
                /* Fail closed before helper lookup or BMI/CRC side paths. */
                switch (b) {{
{allow_cases}
                    break;
                default:
                    goto illegal_op;
                }}
            }}
            if ((b & 0xf0) == 0xf0) {{
"""
    if text.count(map_entry_before) != 1:
        raise RuntimeError("Pinned 0F38 entry block no longer matches the audited source")
    text = text.replace(map_entry_before, map_entry_after, 1)

    unary_condition = " || ".join(f"b == 0x{opcode:02x}" for opcode in MAP38_UNARY_OPCODES)
    extend_cases = "\n".join(f"                case 0x{opcode:02x}:" for opcode in MAP38_EXTEND_OPCODES)
    helper_anchor_before = """            if (!(s->cpuid_ext_features & sse_op_table6[b].ext_mask))
                goto illegal_op;

            if (b1) {
"""
    helper_anchor_after = f"""            if (!(s->cpuid_ext_features & sse_op_table6[b].ext_mask))
                goto illegal_op;

            if (vex_map38) {{
                op1_offset = offsetof(CPUX86State, xmm_regs[reg]);

                if ({unary_condition}) {{
                    /* Unary VEX forms reserve vvvv. Snapshot register aliases so
                     * helper implementation details cannot make in-place writes
                     * observable, then apply the existing XMM helper per lane. */
                    if (s->vex_v != 0) {{
                        goto illegal_op;
                    }}
                    if (mod == 3) {{
                        rm = (modrm & 7) | REX_B(s);
                        op2_offset = offsetof(CPUX86State, xmm_regs[rm]);
                        if (rm == reg) {{
                            if (s->vex_l) {{
                                gen_op_movy(s, offsetof(CPUX86State, xmm_t0), op2_offset);
                            }} else {{
                                gen_op_movo(s, offsetof(CPUX86State, xmm_t0), op2_offset);
                            }}
                            op2_offset = offsetof(CPUX86State, xmm_t0);
                        }}
                    }} else {{
                        gen_lea_modrm(env, s, modrm);
                        op2_offset = offsetof(CPUX86State, xmm_t0);
                        if (s->vex_l) {{
                            gen_ldy_env_A0(s, op2_offset);
                        }} else {{
                            gen_ldo_env_A0(s, op2_offset);
                        }}
                    }}

                    tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
                    tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
                    sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                    if (s->vex_l) {{
                        tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset + 16);
                        tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset + 16);
                        sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                    }}
                    gen_op_zero_vex_upper(s, op1_offset, s->vex_l);
                    break;
                }}

                switch (b) {{
{extend_cases}
                    {{
                        int source_chunk;
                        int source_bytes;

                        /* Reserved VEX.vvvv=1111b is decoded by QEMU as zero. */
                        if (s->vex_v != 0) {{
                            goto illegal_op;
                        }}
                        switch (b) {{
                        case 0x20: case 0x23: case 0x25:
                        case 0x30: case 0x33: case 0x35:
                            source_chunk = 8;
                            break;
                        case 0x21: case 0x24: case 0x31: case 0x34:
                            source_chunk = 4;
                            break;
                        case 0x22: case 0x32:
                            source_chunk = 2;
                            break;
                        default:
                            goto illegal_op;
                        }}
                        source_bytes = source_chunk * (s->vex_l ? 2 : 1);

                        if (mod == 3) {{
                            rm = (modrm & 7) | REX_B(s);
                            op2_offset = offsetof(CPUX86State, xmm_regs[rm]);
                            if (rm == reg) {{
                                gen_op_movo(s, offsetof(CPUX86State, xmm_t0), op2_offset);
                                op2_offset = offsetof(CPUX86State, xmm_t0);
                            }}
                        }} else {{
                            gen_lea_modrm(env, s, modrm);
                            op2_offset = offsetof(CPUX86State, xmm_t0);
                            switch (source_bytes) {{
                            case 16:
                                gen_ldo_env_A0(s, op2_offset);
                                break;
                            case 8:
                                gen_ldq_env_A0(s, op2_offset);
                                break;
                            case 4:
                                tcg_gen_qemu_ld_i32(tcg_ctx, s->tmp2_i32, s->A0,
                                                    s->mem_index, MO_LEUL);
                                tcg_gen_st_i32(tcg_ctx, s->tmp2_i32, tcg_ctx->cpu_env,
                                               op2_offset + offsetof(ZMMReg, ZMM_L(0)));
                                break;
                            case 2:
                                tcg_gen_qemu_ld_tl(tcg_ctx, s->tmp0, s->A0,
                                                   s->mem_index, MO_LEUW);
                                tcg_gen_st16_tl(tcg_ctx, s->tmp0, tcg_ctx->cpu_env,
                                                op2_offset + offsetof(ZMMReg, ZMM_W(0)));
                                break;
                            default:
                                goto illegal_op;
                            }}
                        }}

                        tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
                        tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
                        sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                        if (s->vex_l) {{
                            tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env,
                                            op1_offset + 16);
                            tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env,
                                            op2_offset + source_chunk);
                            sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                        }}
                        gen_op_zero_vex_upper(s, op1_offset, s->vex_l);
                        break;
                    }}
                default:
                    {{
                        int src1_offset = offsetof(CPUX86State, xmm_regs[s->vex_v]);

                        if (mod == 3) {{
                            rm = (modrm & 7) | REX_B(s);
                            op2_offset = offsetof(CPUX86State, xmm_regs[rm]);
                            if (rm == reg) {{
                                if (s->vex_l) {{
                                    gen_op_movy(s, offsetof(CPUX86State, xmm_t0), op2_offset);
                                }} else {{
                                    gen_op_movo(s, offsetof(CPUX86State, xmm_t0), op2_offset);
                                }}
                                op2_offset = offsetof(CPUX86State, xmm_t0);
                            }}
                        }} else {{
                            gen_lea_modrm(env, s, modrm);
                            op2_offset = offsetof(CPUX86State, xmm_t0);
                            if (s->vex_l) {{
                                gen_ldy_env_A0(s, op2_offset);
                            }} else {{
                                gen_ldo_env_A0(s, op2_offset);
                            }}
                        }}

                        if (s->vex_v != reg) {{
                            if (s->vex_l) {{
                                gen_op_movy(s, op1_offset, src1_offset);
                            }} else {{
                                gen_op_movo(s, op1_offset, src1_offset);
                            }}
                        }}

                        tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset);
                        tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset);
                        sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                        if (s->vex_l) {{
                            tcg_gen_addi_ptr(tcg_ctx, s->ptr0, tcg_ctx->cpu_env, op1_offset + 16);
                            tcg_gen_addi_ptr(tcg_ctx, s->ptr1, tcg_ctx->cpu_env, op2_offset + 16);
                            sse_fn_epp(tcg_ctx, tcg_ctx->cpu_env, s->ptr0, s->ptr1);
                        }}
                        gen_op_zero_vex_upper(s, op1_offset, s->vex_l);
                        break;
                    }}
                }}
                break;
            }}

            if (b1) {{
"""
    if text.count(helper_anchor_before) != 1:
        raise RuntimeError("Pinned 0F38 helper dispatch no longer matches the audited source")
    text = text.replace(helper_anchor_before, helper_anchor_after, 1)

    translate_path.write_text(text)
