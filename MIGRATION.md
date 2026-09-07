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


## Process execution correction: dynamic ELF belongs to Blink

The first modular execution slice proved real-byte execution with a small Capstone-driven interpreter, but extending that interpreter into `PT_INTERP`, ELF relocation, glibc, signals and Linux process semantics would duplicate an emulator/loader and diverge from the pre-existing Process Sandbox design.

The migration now keeps that provider only for static fixed-address ELF and adds Blink/WASM for process images requiring Linux loader semantics. `executionSupport()` selects the provider from physical ELF evidence:

- static `ET_EXEC` without interpreter/dependencies → `bounded-x86-64`;
- PIE or any executable with `PT_INTERP` / `DT_NEEDED` → `blink-process`;
- shared libraries/relocatables remain non-process targets.

Global Dependencies are no longer merely a green resolution badge for execution. On Blink preparation the runtime resolver reads the actual bytes, follows each dependency's dynamic section recursively, rejects missing/permission-blocked entries and mounts the resulting closure into Blink's private MEMFS. The guest loader therefore sees real library bytes while the browser host filesystem remains outside the provider boundary.

This slice does **not** claim that a graphical program such as a raylib application can already create a host window. Dynamic loading and CPU/process emulation are different from X11/Wayland/GPU/environment virtualization. Those services remain explicit future provider surfaces.

## V11: Blink headless process Run

Dynamic ELF execution now separates two Blink modes. Process `Run` uses the fork's headless `run_fast`/preemption-resume path, avoiding the internal Blink disassembler that can abort while modern glibc/ld-linux is executing. `Step` remains debugger-backed and is entered lazily. The application never reports stale register state from a headless run.

The UI now follows paused execution instead of leaving the graph detached from the debugger state. When a step pauses on a main-image address, the binary disassembly editor auto-reveals the live PC, the analysis dock switches to Function CFG, and the canvas focuses the containing basic block. If execution enters a different discovered function, the analyzer re-roots on that function so the graph reflects the current local flow rather than a stale entry-only snapshot. Cross-library/runtime-module stepping is still limited by the pending multi-image analysis work; addresses outside the main image intentionally do not fake a disassembly reveal.

## V13: provider diagnostics are first-class observed state

The first real dynamic `ray_test` browser run exposed repeated Emscripten `__syscall_mprotect` warnings followed by `Aborted(native code called abort())`. The warning itself is not sufficient evidence for the abort: Emscripten's compatibility syscall stub reports `mprotect` and returns success. The Process Sandbox therefore no longer treats browser-console noise as an implicit cause.

Blink/Emscripten host diagnostics are now captured through the module `print`, `printErr`, and `onAbort` hooks and attached to immutable `ExecutionSnapshot` state. Repeated identical messages are coalesced, the caught WASM/JavaScript error stack is preserved, and Debug Console renders those diagnostics separately from guest stdout/stderr. This keeps host-emulator diagnostics, guest IO, and execution truth distinct while making the next native `abort()` actionable.


## Raw ASM execution checkpoint (v14)

ASM source files are now executable without creating an ELF image or depending on Blink. `asm-source-x86-64` compiles a small NASM-style source model into a deterministic source-PC address space, initializes x86-64 registers/stack/data memory, and executes a bounded instruction subset directly in the browser. Labels, direct calls/jumps, conditional branches, register/memory arithmetic and `syscall` are modeled. The provider is intentionally explicit that these are synthetic source PCs rather than assembler byte offsets.

A small `Linux Lite` boundary virtualizes only stdin/stdout/stderr and termination (`read(0)`, `write(1/2)`, `exit`, `exit_group`). Unknown syscalls trap rather than inheriting browser/host behavior. This makes raw ASM useful before the full Linux Process Sandbox is healthy without quietly growing a second dynamic linker or libc environment.

Execution rendering is now trace-driven rather than selection-only. `ExecutionEvent` instruction records can carry source line/node identity; the graph projection counts visited nodes, maps observed transitions onto static CFG edges (including short label-node paths), highlights the current node, and recenters the Canvas while stepping. Source stepping also reveals the active editor line automatically. Binary address-based follow remains intact.

### v15 — execution is no longer a UI feature

The execution core now has a headless API in `src/features/execution/headless/runner.ts`. ASM source and static ELF execution can be driven synchronously from tests, CI or a CLI without constructing React state, a canvas, a project workspace, or browser DOM nodes. The UI remains a consumer of execution snapshots; it is no longer required to produce them.

The Bun entry point `scripts/execute.ts` auto-detects ELF magic. ASM files use the source-semantic x86-64 provider and Linux Lite. Static fixed-address ELF uses the bounded x86-64 provider plus vendored Capstone WASM loaded by `scripts/headless-capstone.ts`. Dynamic ELF is still delegated conceptually to `blink-process`; headless execution rejects it explicitly until that provider has reliable non-UI lifecycle semantics.

## V16: recursive dependency preflight + binary program call graph

Binary analysis now resolves the same `PT_INTERP` + recursive `DT_NEEDED` closure that process execution materializes. The Binary Map no longer stops at the executable's direct `DT_NEEDED` list: interpreter, direct dependencies and transitive dependencies are shown with parent/depth evidence, while older IndexedDB library entries are re-inspected lazily so users do not need to re-import them. Runtime materialization remains byte-owning and sandbox-local; this analysis preflight does not touch an implicit host filesystem.

`Program flow` is now an actual interprocedural call graph instead of a history of functions the user happened to open. Prepared binary analysis decodes discovered functions under a bounded instruction/function budget, records direct CALL and proven interprocedural tail-JMP edges, and recognizes the narrow `_start` → `__libc_start_main(main)` ABI handoff from relocation + RDI evidence. Connected-call scope renders function/PLT nodes directly rather than collapsing the common `(root)` namespace into one empty-looking node. Layout is rooted at the ELF entry independently of the function-detail picker, keeps that entry call lineage in the first column, and orders siblings by address so `_start → main → application function → PLT` reads top-to-bottom.


## V17: baseline-compatible Blink source build

The dynamic Process Sandbox no longer accepts the precompiled x86-64-playground Blink payload. That artifact is configured with `--disable-all`, which disables x87/FPU in the pinned fork. Blink's CPUID implementation only advertises the FPU bit when x87 is enabled, so contemporary glibc can reject an otherwise `x86-64-baseline` `libc.so.6` with `CPU ISA level is lower than required` before `main` is reached.

`bun run vendor:blink` now checks out the pinned Blink fork and builds the Emscripten JS/WASM pair locally from source with `--disable-all --enable-x87 --enable-mmx --enable-nonposix`. JIT intentionally remains disabled. The build emits `build-profile.json`; `blink-process` validates that profile before importing the module, so stale upstream-prebuilt assets fail fast instead of exposing a CPU contract lower than baseline.

This does not bundle glibc into the repository. Dynamic guest libraries continue to come from Global Dependencies. A minimal glibc `puts()` executable normally needs the matching `ld-linux-x86-64.so.2` and `libc.so.6` bytes from one host installation; additional direct/transitive `DT_NEEDED` modules are resolved recursively.
