#!/usr/bin/env python3
"""Audited AVX (VEX.0F) extensions layered on the existing AVX2 patch.

The pinned QEMU already has mature SSE/SSE2/SSE3 helpers for the arithmetic
semantics below.  This layer only adapts VEX operand topology and vector width:
NDS three-operand instructions stage VEX.vvvv as source1, 256-bit packed forms
run the existing helper independently for each architectural 128-bit lane, and
VEX.128 destinations keep the existing zero-upper invariant.

Do not add opcodes here merely because an SSE helper exists.  Every condition in
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
                  /* Scalar sqrt/rcp/rsqrt are NDS; packed forms are unary and
                   * get a dedicated reserved-vvvv path later. */
                  (!s->vex_l && b1 == 2 &&
                   (b == 0x51 || b == 0x52 || b == 0x53)) ||
                  (!s->vex_l && b1 == 3 && b == 0x51) ||
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

    translate_path.write_text(text)
