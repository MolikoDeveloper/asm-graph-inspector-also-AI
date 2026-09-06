# Pending migration work

## Completed in this redesign

- [x] React + Vite + TypeScript project layout.
- [x] GitHub Pages build/deploy workflow using Bun.
- [x] Project-first UX with IndexedDB persistence.
- [x] VS Code-style app shell: menu bar, activity rail, explorer, editor groups, graph dock, inspector, bottom panel and status bar.
- [x] Multiple open files through tabs and split editor groups.
- [x] Full-screen settings overlay with dimmed workbench.
- [x] Canvas graph renderer isolated from source analysis.
- [x] Capstone x86 JS/WASM removed from HTML and lazy-loaded from static vendor assets.
- [x] Minimal ASM analysis path proving editor → typed analysis → Canvas.

## Next migration slices from V14.15

- [x] Port the first raw ELF64 x86-64 parser slice as DOM-free TypeScript (`features/binary/`): PT_LOAD, sections, symbols, REL/RELA, dynamic NEEDED/SONAME, GNU build-id and PIE/shared classification.
- [x] Port `asm-graph.loaded-image/v1` for the current raw-ELF slice.
- [x] Connect vendored Capstone x86 5.0.9 to `asm-graph.decoded-instruction/v1` and the shared Canvas `AnalysisGraph`.
- [ ] Port BuildArtifact and the remaining LoadedImage identity/provenance fields.
- [x] Port the pinned Capstone x86 operand-detail layout validation/workaround: full register/immediate/memory operands, width/access, explicit + implicit register evidence and control-flow groups.
- [x] Port raw-byte GOT/PLT/IFUNC reconstruction for `.plt`, `.plt.sec`, `.plt.got`, JUMP_SLOT/GLOB_DAT and IRELATIVE using Capstone + relocation proof.
- [ ] Add cross-artifact build-id reconciliation between textual dumps and imported raw ELF evidence.
- [x] Port FDE range parsing and FDE-priority stripped-function discovery with recursive direct calls, conservative tail calls, CET/prologue/alignment fallbacks and symbol-backed suppression.
- [x] Port the first CFI row interpreter for common DW_CFA state transitions and expose CFA/return-address state per selected CFG block.
- [ ] Complete DWARF expression evaluation, LSDA/personality/action tables and exception edges; expression rules are retained but not evaluated yet.
- [x] Port function-scoped basic-block CFG construction with local branch/fallthrough reachability, back-edge detection and relocation-proven external call references.
- [ ] Port the remaining advanced V14.15 CFG semantics: dominators/frontiers, natural loops, irreducible SCCs, critical edges, jump tables, exception edges, noreturn proof and unresolved-transfer diagnostics.
- [x] Port the first modular Dataflow/SSA slice: register SSA values, join phi nodes, constants/copies/arithmetic, ABI call/syscall effects and Flow/Registers/Memory/Calls/Raw-SSA projections for source ASM and canonical binary instructions.
- [ ] Complete V14.15 Dataflow parity: range-normalized memory cells, alias sets, stack-frame normalization, flags/predicates, SIMD/x87 barriers, richer unknown provenance and large-function fixed-point budgets.
- [x] Port the first execution policy/session/provider slice: fixed-address static ELF64 x86-64, PT_LOAD virtual memory, process stack/register state, Capstone-driven stepping, bounded run loop and virtual stdin/stdout/stderr + `read`/`write`/`exit` syscalls.
- [ ] Add project bundle import/export and analysis-cache persistence.
- [ ] Move heavy ELF/Capstone/dataflow work to Web Workers.
- [ ] Extend execution beyond the bounded first provider: PIE load bias/relocations, dynamic loader + recursive shared-library address spaces, broader x86-64 instruction semantics, signals/threads and a real VFS/syscall surface.
- [ ] Restore full `ray_test` regression under the modular engine.

## UX follow-up

- [ ] Add command palette and keyboard-driven file switching.
- [x] Add resizable Explorer / editor-analysis / inspector / bottom-panel splitters.
- [x] Add project file context menus, drag-to-folder/root moves, rename/move/duplicate/delete actions, and folder rename/delete actions.
- [x] Add complete lazy binary disassembly view over executable ELF sections with virtualized rendering; keep Hex as a secondary view.
- [x] Add mouse-anchored Canvas zoom and graph/inspector → editor/disassembly navigation.
- [x] Add NASM-oriented syntax highlighting without replacing the textarea editing surface.
- [x] Add debounced automatic source analysis with transactional commit: invalid ASM reports Problems while the last valid graph/inspector remain visible.
- [ ] Persist editor-group/workbench layout per project as non-authoritative UI state.
- [x] Add contextual analysis tabs for CFG, Binary Map, Sections, Symbols, Relocs and Unwind without duplicating the editor surface.
- [x] Add Dataflow with Flow/Registers/Memory/Calls/Raw-SSA projections to the contextual analysis dock.
- [ ] Add dataflow focus/search, one-hop provenance expansion and projection-specific inspector actions from V14.15.
- [ ] Add virtualized file/symbol/function lists for large binaries.

## Global dependency follow-up

- [x] Add browser-global dependency settings shared by every project.
- [x] Persist imported global ELF files independently of project storage.
- [x] Persist authorized library directory handles where the browser supports File System Access API handles in IndexedDB.
- [x] Resolve `DT_NEEDED` by exact SONAME / filename and report permission-required separately from unresolved.
- [ ] Recursively load resolved dependency images into separate address spaces and expose cross-library symbol/call edges.
- [ ] Add project-local dependency overrides with precedence above global dependencies.
- [ ] Add dependency indexing/virtualization for very large library roots instead of exact-name lookup only.
