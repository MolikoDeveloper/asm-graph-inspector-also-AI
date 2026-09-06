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
- [ ] Port full CFI row interpretation and LSDA/personality semantics; current modular unwind parser uses FDE boundaries only.
- [ ] Port the remaining V14.15 CFG semantics into worker-friendly pure TypeScript; canonical function candidates and instruction control-flow targets are now modular.
- [ ] Port Dataflow/SSA engine and the Flow/Registers/Memory/Calls/Raw-SSA projections.
- [ ] Port execution policy/session/provider contracts.
- [ ] Add project bundle import/export and analysis-cache persistence.
- [ ] Move heavy ELF/Capstone/dataflow work to Web Workers.
- [ ] Restore full `ray_test` regression under the modular engine.

## UX follow-up

- [ ] Add command palette and keyboard-driven file switching.
- [ ] Add resizable dock splitters.
- [ ] Persist editor-group/workbench layout per project as non-authoritative UI state.
- [ ] Add contextual graph tabs (CFG, Dataflow, Binary Map, Sections, Symbols, Relocs) without duplicating the editor surface.
- [ ] Add virtualized file/symbol lists for large binaries.
