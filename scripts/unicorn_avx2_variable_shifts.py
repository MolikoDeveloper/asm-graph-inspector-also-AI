#!/usr/bin/env python3
"""Dedicated AVX2 variable-count shift lowering for pinned Unicorn/QEMU.

This layer runs after unicorn_avx2_extension.py. The pinned QEMU 5 translator
has no guest helpers for VEX 0F38 opcodes 45-47, while ordinary scalar host
shifts do not have the architectural AVX2 out-of-range semantics. Add narrow
XMM helpers that implement the element rules explicitly, then reuse the audited
VEX three-operand/lane machinery for both 128- and 256-bit forms.

Only VPSRLVD/Q, VPSRAVD and VPSLLVD/Q are enabled here. Opcode 46 with W=1
remains illegal because AVX2 has no VPSRAVQ form. Other 0F38 instructions stay
fail-closed.
"""

from __future__ import annotations

from pathlib import Path


VARIABLE_SHIFT_OPCODES = (0x45, 0x46, 0x47)


def patch_avx2_variable_shift_helpers(source_root: Path) -> None:
    ops_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse.h"
    text = ops_path.read_text()

    anchor = """void glue(helper_psllq, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    int shift;

    if (s->Q(0) > 63) {
        d->Q(0) = 0;
#if SHIFT == 1
        d->Q(1) = 0;
#endif
    } else {
        shift = s->B(0);
        d->Q(0) <<= shift;
#if SHIFT == 1
        d->Q(1) <<= shift;
#endif
    }
}

#if SHIFT == 1
"""
    replacement = """void glue(helper_psllq, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    int shift;

    if (s->Q(0) > 63) {
        d->Q(0) = 0;
#if SHIFT == 1
        d->Q(1) = 0;
#endif
    } else {
        shift = s->B(0);
        d->Q(0) <<= shift;
#if SHIFT == 1
        d->Q(1) <<= shift;
#endif
    }
}

#if SHIFT == 1
/* AVX2 variable-count shifts. These helpers intentionally operate on one
 * 128-bit chunk; the translator invokes them once per architectural lane for
 * VEX.L=1. Counts at or above the element width do not use scalar x86 masking. */
void glue(helper_vpsrlvd, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    int i;
    for (i = 0; i < 4; ++i) {
        uint32_t count = s->L(i);
        d->L(i) = count >= 32 ? 0 : d->L(i) >> count;
    }
}

void glue(helper_vpsravd, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    int i;
    for (i = 0; i < 4; ++i) {
        uint32_t count = s->L(i);
        if (count >= 32) {
            count = 31;
        }
        d->L(i) = (int32_t)d->L(i) >> count;
    }
}

void glue(helper_vpsllvd, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    int i;
    for (i = 0; i < 4; ++i) {
        uint32_t count = s->L(i);
        d->L(i) = count >= 32 ? 0 : d->L(i) << count;
    }
}

void glue(helper_vpsrlvq, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    int i;
    for (i = 0; i < 2; ++i) {
        uint64_t count = s->Q(i);
        d->Q(i) = count >= 64 ? 0 : d->Q(i) >> count;
    }
}

void glue(helper_vpsllvq, SUFFIX)(CPUX86State *env, Reg *d, Reg *s)
{
    int i;
    for (i = 0; i < 2; ++i) {
        uint64_t count = s->Q(i);
        d->Q(i) = count >= 64 ? 0 : d->Q(i) << count;
    }
}

"""
    if text.count(anchor) != 1:
        raise RuntimeError("Pinned ops_sse.h shift anchor no longer matches the audited source")
    ops_path.write_text(text.replace(anchor, replacement, 1))

    header_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "ops_sse_header.h"
    text = header_path.read_text()
    header_anchor = """DEF_HELPER_3(glue(psrlq, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(psllq, SUFFIX), void, env, Reg, Reg)

#if SHIFT == 1
DEF_HELPER_3(glue(psrldq, SUFFIX), void, env, Reg, Reg)
"""
    header_replacement = """DEF_HELPER_3(glue(psrlq, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(psllq, SUFFIX), void, env, Reg, Reg)

#if SHIFT == 1
DEF_HELPER_3(glue(vpsrlvd, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpsravd, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpsllvd, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpsrlvq, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(vpsllvq, SUFFIX), void, env, Reg, Reg)
DEF_HELPER_3(glue(psrldq, SUFFIX), void, env, Reg, Reg)
"""
    if text.count(header_anchor) != 1:
        raise RuntimeError("Pinned ops_sse_header.h shift declarations no longer match")
    header_path.write_text(text.replace(header_anchor, header_replacement, 1))


def patch_avx2_variable_shift_decoder(source_root: Path) -> None:
    translate_path = source_root / "unicorn" / "qemu" / "target" / "i386" / "translate.c"
    text = translate_path.read_text()

    allow_anchor = """                case 0x35:
                    break;
                default:
                    goto illegal_op;
"""
    allow_replacement = """                case 0x35:
                case 0x45:
                case 0x46:
                case 0x47:
                    break;
                default:
                    goto illegal_op;
"""
    if text.count(allow_anchor) != 1:
        raise RuntimeError("Post-extension 0F38 allow-list anchor no longer matches")
    text = text.replace(allow_anchor, allow_replacement, 1)

    lookup_anchor = """            sse_fn_epp = sse_op_table6[b].op[b1];
            if (!sse_fn_epp) {
                goto unknown_op;
            }
            if (!(s->cpuid_ext_features & sse_op_table6[b].ext_mask))
                goto illegal_op;

            if (vex_map38) {
"""
    lookup_replacement = """            if (vex_map38 && (b == 0x45 || b == 0x46 || b == 0x47)) {
                /* VEX.W is reflected in dflag after prefix post-processing.
                 * 0x45/0x47 select dword vs qword; 0x46 W=1 is reserved. */
                switch (b) {
                case 0x45:
                    sse_fn_epp = s->dflag == MO_64
                        ? gen_helper_vpsrlvq_xmm : gen_helper_vpsrlvd_xmm;
                    break;
                case 0x46:
                    if (s->dflag == MO_64) {
                        goto illegal_op;
                    }
                    sse_fn_epp = gen_helper_vpsravd_xmm;
                    break;
                case 0x47:
                    sse_fn_epp = s->dflag == MO_64
                        ? gen_helper_vpsllvq_xmm : gen_helper_vpsllvd_xmm;
                    break;
                default:
                    goto illegal_op;
                }
            } else {
                sse_fn_epp = sse_op_table6[b].op[b1];
                if (!sse_fn_epp) {
                    goto unknown_op;
                }
                if (!(s->cpuid_ext_features & sse_op_table6[b].ext_mask))
                    goto illegal_op;
            }

            if (vex_map38) {
"""
    if text.count(lookup_anchor) != 1:
        raise RuntimeError("Post-extension 0F38 helper lookup no longer matches")
    translate_path.write_text(text.replace(lookup_anchor, lookup_replacement, 1))
