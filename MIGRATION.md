# V14.x → modular frontend migration

The redesign intentionally does **not** paste the old 2+ MB HTML into a React component. The old implementation should be moved behind typed services in slices.

## Feature mapping

| V14.x responsibility | New destination |
| --- | --- |
| project schema / IndexedDB / OPFS | `src/features/project/` |
| editor tabs / active files | `src/features/workspace/` |
| raw ELF parsing | `src/features/binary/elfParser.ts` |
| Capstone loader / adapter | `src/features/capstone/` |
| canonical instruction model | `src/features/binary/model.ts` + `src/features/capstone/capstoneDecoder.ts` |
| function discovery / linkage | `src/features/binary/functionDiscovery.ts` + `linkage.ts` |
| dataflow / SSA | `src/features/analysis/dataflow/` |
| Canvas rendering | `src/components/GraphPanel.tsx` plus future graph render modules |
| execution provider/session | `src/features/execution/` |
| project bundle import/export | `src/features/project/` |

## Migration rule

Old code may enter the new project only after DOM/UI dependencies have been removed from it. Analysis services should accept typed inputs and return typed models; React should only render those models.

## Worker boundary

ELF parsing, Capstone decoding and SSA/dataflow are candidates for Web Workers. The UI should not subscribe to instruction-by-instruction transient state. Prefer coarse immutable analysis snapshots and on-demand detail queries.

## Asset rule

Architecture-specific WASM stays outside the initial JS bundle and is loaded only when the active analysis requires it. Future ARM64/RISC-V decoders should follow the same `public/vendor/<engine>/<arch>` or generated asset manifest pattern.

## React migration checkpoint: raw ELF + Capstone + stripped discovery/linkage

The React/Vite application now owns a substantial binary-analysis slice instead of only loading the Capstone runtime. Imported ELF64 x86-64 files are parsed from their raw bytes into the `asm-graph.loaded-image/v1` vocabulary (PT_LOAD mappings, sections, symbol tables, relocations, GNU build-id, DT_NEEDED/SONAME and unwind FDE ranges).

The vendored Capstone x86 5.0.9 provider now exposes the pinned operand-detail layout used by V14.15: register/immediate/memory operands, access width, base/index/scale/displacement, explicit register access, complete `regs_access`, and control-flow groups. The vendor JS/WASM stays unchanged; the adapter validates the pinned layout against native `cs_op_count` on every decoded instruction.

For stripped binaries, `functionDiscovery.ts` prefers FDE coverage, then e_entry/section evidence, then recursive direct-call discovery and conservative tail-call/CET/prologue/alignment evidence. If authoritative `STT_FUNC`/`STT_GNU_IFUNC` symbols exist, stripped heuristics are suppressed. `linkage.ts` reconstructs `.plt`, `.plt.sec` and `.plt.got` only when a Capstone RIP-relative memory reference resolves to a raw-ELF relocation-backed GOT slot; `R_X86_64_IRELATIVE` is retained as IFUNC/loader evidence rather than fabricated as a normal call edge.

This is intentionally not parity with V14.15 yet. Full CFI row interpretation/LSDA, old CFG edge semantics, Dataflow/SSA projections, Binary Map views, execution/VFS contracts and multi-range hot/cold functions remain pending. The important rule remains: migrate the engine as pure typed services rather than rebuilding the monolith inside React.
