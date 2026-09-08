#!/usr/bin/env python3
"""Incremental AVX2 extensions for the pinned Unicorn/QEMU translator.

This module intentionally runs *after* patch_avx_vector_basics(). It only widens
an audited set of lane-local packed integer operations whose existing XMM helpers
have identical per-128-bit semantics when applied independently to the low/high
halves of a YMM register.

Do not turn this into a blanket VEX.L enable. Cross-lane shuffles, vector-count
shifts, broadcasts, gathers and other AVX2-specific semantics require dedicated
lowering and stay fail-closed until implemented and tested.
"""

from __future__ import annotations

from pathlib import Path


# 66 0F opcodes with ordinary three-operand packed integer semantics. The base
# AVX patch already snapshots source2, copies VEX.vvvv source1 into destination,
# invokes the XMM helper once per 128-bit lane, and applies VEX zero-upper rules.
# These opcodes can therefore safely reuse that exact lowering.
PACKED_BINARY_OPCODES = (
    # Compare.
    0x64,  # vpcmpgtb
    0x65,  # vpcmpgtw
    0x66,  # vpcmpgtd
    0x74,  # vpcmpeqb
    0x75,  # vpcmpeqw
    0x76,  # vpcmpeqd

    # Add/subtract and logical core.
    0xD4,  # vpaddq
    0xDB,  # vpand
    0xDF,  # vpandn
    0xEB,  # vpor
    0xEF,  # vpxor
    0xF8,  # vpsubb
    0xF9,  # vpsubw
    0xFA,  # vpsubd
    0xFB,  # vpsubq
    0xFC,  # vpaddb
    0xFD,  # vpaddw
    0xFE,  # vpaddd

    # Multiply / horizontal-within-element-pairs / absolute-difference sum.
    0xD5,  # vpmullw
    0xE4,  # vpmulhuw
    0xE5,  # vpmulhw
    0xF4,  # vpmuludq
    0xF5,  # vpmaddwd
    0xF6,  # vpsadbw

    # Unsigned saturating arithmetic and min/max.
    0xD8,  # vpsubusb
    0xD9,  # vpsubusw
    0xDA,  # vpminub
    0xDC,  # vpaddusb
    0xDD,  # vpaddusw
    0xDE,  # vpmaxub

    # Rounded averages.
    0xE0,  # vpavgb
    0xE3,  # vpavgw

    # Signed saturating arithmetic and min/max.
    0xE8,  # vpsubsb
    0xE9,  # vpsubsw
    0xEA,  # vpminsw
    0xEC,  # vpaddsb
    0xED,  # vpaddsw
    0xEE,  # vpmaxsw
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
        raise RuntimeError(
            "Base AVX binary classification no longer matches the audited patch"
        )

    # vex_xor is a private identifier introduced only by the base patch. Once
    # the classification is broadened, the existing operand preparation and
    # two-lane execution path is exactly the reusable packed-binary lowering.
    occurrences = text.count("vex_xor")
    if occurrences < 5:
        raise RuntimeError(
            f"Base AVX vex_xor lowering expected at least 5 references, found {occurrences}"
        )

    text = text.replace(old_classification, new_classification, 1)
    text = text.replace("vex_xor", "vex_binary")

    # Tighten comments so future changes do not mistake this subset for general
    # AVX2 support.
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
