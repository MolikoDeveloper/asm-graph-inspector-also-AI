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

This is intentionally not parity with V14.15 yet. Full CFI row interpretation/LSDA, old CFG edge semantics, Dataflow/SSA projections, Binary Map views, advanced execution/VFS semantics and multi-range hot/cold functions remain pending. The important rule remains: migrate the engine as pure typed services rather than rebuilding the monolith inside React.


## Migration checkpoint: function CFG + visible CFI + binary navigation

The binary analysis surface is now function-scoped rather than a single instruction chain. `features/analysis/cfg.ts` turns one canonical Capstone function decode into basic blocks, branch/fallthrough edges, reachability and conservative back-edge metadata. Selecting another discovered/symbol-backed function from the Analysis sidebar or function picker reruns the function projection without inventing a second instruction model.

`features/binary/unwind.ts` now retains CIE/FDE instruction programs and interprets the common DW_CFA state machine used by GCC/Clang x86-64. Preferred FDEs expose decoded CFI rows (CFA, saved-register rules and return-address rule), and CFG block entries display the exact row covering that PC. Raw DWARF expression bytes are retained as rules but expression evaluation, LSDA/personality semantics and exception CFG edges remain a later slice.

The right analysis dock now owns contextual tabs for CFG, Binary Map, Sections, Symbols, Relocs and Unwind. These views consume the same `LoadedImage`/analysis summary and do not reparse bytes in React. This keeps the editor surface singular while moving V14.x inspection capabilities into modular feature views.


## Migration checkpoint: modular Dataflow/SSA projections

`features/analysis/dataflow.ts` now owns the first DOM-free dataflow slice. It consumes either canonical Capstone instructions for the selected ELF function or normalized ASM-source instructions, models x86-64 register definitions/uses, constants, copies, conservative arithmetic expressions, memory keys, System V call clobbers/results and Linux syscall inputs/results. Binary CFG predecessor states are merged with stable phi identities and a bounded fixed-point pass; source ASM currently uses a conservative linear block until source CFG normalization is migrated.

The workbench exposes the same analysis through five projections rather than leaking raw SSA as the default UI: **Flow**, **Registers**, **Memory**, **Calls / syscalls** and **Raw SSA**. Known Linux x86-64 syscall numbers reduce visible arguments to the ABI-defined arity, so `exit(60)` does not inherit stale RSI/RDX/R8/R9 edges from an earlier syscall. Raw SSA remains available for auditing definitions, entry values, phi values and clobbers.

This is a migration checkpoint, not full V14.15 parity. The next dataflow slices are normalized memory ranges/alias sets, stack-frame normalization, flag/predicate flow, richer barrier provenance, focus/provenance navigation and large-function worker execution. The other pending V14.15 areas—advanced CFG, LSDA/exceptions, BuildArtifact/provenance, project bundles, advanced execution/VFS/IO and `ray_test`—remain explicitly tracked in `PENDING.md`.

### Global dependency registry

The React port now has an application-global dependency registry exposed in Settings → Global dependencies. It is not stored inside project metadata, so all projects in the browser share imported `.so` files and authorized library roots. Binary analysis records per-`DT_NEEDED` resolution status and invalidates prepared binary caches when the registry changes.


## Migration checkpoint: interactive editor/workbench loop

The modular app now treats analysis as a live, transactional projection of project files instead of a manual F5-only command. ASM edits are debounced and parsed into a candidate snapshot. Only syntactically valid candidates replace the committed `AnalysisGraph`; invalid candidates populate the Problems panel and leave the previous valid graph/inspector untouched. This prevents transient half-written instructions from destroying useful analysis state.

The editor remains one surface but now has NASM-oriented syntax highlighting, graph/inspector navigation back to source lines, and binary navigation by static address. Imported ELF files default to a lazy **complete executable disassembly** view: executable ELF sections are decoded from raw bytes through the pinned Capstone provider and rendered with a fixed-row virtualized list, while the Hex view remains available as a secondary byte-oriented view.

The workbench also gained resizable Explorer, editor/analysis, analysis/inspector and bottom-panel splits, plus mouse-anchored Canvas zoom. Project files support right-click operations and drag-to-folder/root movement; folder operations are path-prefix transformations over authoritative project files rather than hidden filesystem mutation.


## Migration checkpoint: bounded real-binary execution

The modular frontend now has a first `features/execution/` slice. It is not a visualization pretending to be a runtime: the provider maps authoritative ELF `PT_LOAD` bytes into sparse virtual memory, initializes x86-64 process registers/stack, decodes the instruction at the live RIP through the pinned Capstone provider, applies bounded instruction semantics, and exposes observed state to the Debug Console.

The supported execution envelope is intentionally narrow: fixed-address static ELF64 x86-64. PIE, `PT_INTERP`, `DT_NEEDED`, unsupported opcodes and unsupported Linux syscalls are rejected. The virtual syscall surface currently covers stdin/stdout/stderr `read`/`write` plus `exit`/`exit_group`; no browser host filesystem or kernel syscall is invoked. This gives the next migration slices a truthful base for dynamic-loader, dependency address-space, VFS and richer CPU semantics work.
