# Pending migration work

## Current execution architecture

- [x] `asm-source-x86-64`: fast source-semantic NASM-style execution for editor/debugger workflows.
- [x] `unicorn-machine`: direct x86-64 machine execution for static/fixed-address ELF without a guest OS.
- [x] `linux-user`: bounded, kernel-less x86-64 Linux userspace on Unicorn/WASM with explicit `PT_INTERP` / `DT_NEEDED` runtime materialization and a narrow TypeScript syscall contract.
- [x] Close the observed Linux User stdio gap with x86-64 `SYS_writev(20)`, bounded iovec handling, stdout/stderr byte-preserving aggregation and fail-closed writes to the read-only runtime VFS.
- [x] Keep Linux User single-process/single-thread and fail closed when a futex wait would really block; never fake synchronization success.
- [ ] `linux-system`: full-system x86-64 machine + real Linux kernel, real guest TTY/devices/filesystem and optional graphical display. This work belongs on a dedicated branch and must not expand the Linux User syscall shim into a second kernel.

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
- [x] Add raw ASM source execution independent of ELF/Linux: source-PC machine state, labels/branches/calls/stack/registers, source-line stepping and a Linux Lite `read`/`write`/`exit` syscall surface.
- [x] Project observed execution traces onto the Canvas: current-node focus, visited-node counters and traversed-edge highlighting for source ASM and address-backed binary CFGs.
- [x] Route dynamic/PIE Linux ELF to the pinned Unicorn/WASM Linux User provider; materialize the real loader/runtime closure and let the guest loader/glibc execute on the emulated CPU without a guest kernel.
- [x] Materialize direct + transitive `DT_NEEDED` closure from Global Dependencies without touching the host filesystem; expose those bytes to Linux User as read-only virtual runtime files.
- [x] Run a real host-built dynamic glibc smoke through explicit `ld-linux-x86-64.so.2` + `libc.so.6`, including `puts()`, `writev(2)` output and clean `exit(0)`.
- [ ] Add project bundle import/export and analysis-cache persistence.
- [ ] Move heavy ELF/Capstone/dataflow work to Web Workers.
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
- [x] Materialize recursive dynamic dependency bytes for Linux User execution through exact filename/DT_SONAME resolution.
- [x] Show recursive dependency preflight in Binary Map (PT_INTERP, direct DT_NEEDED and transitive DT_NEEDED with parent/depth evidence), including lazy migration of older imported-library records.
- [x] Build an ELF-wide interprocedural call graph from discovered functions without requiring the user to open each function; keep direct CALL/tail-call evidence and the proven libc startup handoff.
- [ ] Load dependency images into separate **analysis** address spaces and expose cross-library symbol/call edges; runtime loading remains observed state and must not mutate static IR.
- [ ] Add project-local dependency overrides with precedence above global dependencies.
- [ ] Add dependency indexing/virtualization for very large library roots instead of exact-name lookup only.

## Linux User boundary

- [x] Preserve the bounded syscall provider as a deliberate compatibility layer, not a general-purpose Linux kernel implementation.
- [x] Support the syscall subset required by the current loader/glibc baseline, including memory management, loader file reads, process identity/time/random basics, `read`, `write`, `writev`, and exit.
- [x] Keep runtime ELF files read-only; `write`/`writev` to non-stdio descriptors fail instead of mutating dependency/program bytes.
- [x] Bound scalar IO to 1 MiB per syscall and `writev` to at most 1024 iovecs with the same aggregate 1 MiB budget.
- [x] Keep unsupported syscalls explicit; do not silently return success.
- [x] Keep true blocking/thread semantics out of Linux User; a matching futex WAIT traps as would-block rather than pretending progress.
- [ ] Add further Linux User syscalls only when a concrete supported workload demonstrates that they are small, deterministic and compatible with this boundary.
- [ ] Do not add devices, a writable root filesystem, real process scheduling, X11, kernel networking or general thread support here; those belong to Linux System.

## Linux System handoff

- [ ] Prototype a full-system x86-64 backend in a dedicated branch without changing the stable Linux User contract on `master`.
- [ ] Pin and audit the full-system emulator/toolchain before vendoring any new runtime assets.
- [ ] Gate the architecture on a real Linux kernel boot, guest TTY, AVX2 execution and browser-persistent workspace storage before adding graphical work.
- [ ] Keep the root system image immutable/cached where practical; persist project-owned changes separately through browser storage.
- [ ] Add framebuffer/X11 only after the CPU/kernel/TTY/storage path is stable and measured.

## Legacy Blink cleanup / reference work

Blink remains useful as historical implementation evidence and for regression/reference tests, but it is no longer the normal dynamic ELF route.

- [ ] Decide which Blink-specific tests/build assets still provide unique regression value after Linux User stabilization.
- [ ] Remove or archive Blink-only UI/docs paths that claim it is the active Process Sandbox when they no longer match routing.
- [ ] Preserve any useful ISA/preflight or diagnostic lessons when retiring redundant Blink code.

## Headless execution follow-up

- [x] Expose ASM source execution without React/UI state.
- [x] Expose static ELF execution without React/UI state.
- [x] Add a Bun CLI that auto-detects ASM vs ELF and supports JSON/trace output.
- [x] Add zero-UI smoke tests for ASM and static ELF.
- [x] Load vendored Capstone WASM from the headless runtime rather than through `window`/`document`.
- [ ] Route prepared dynamic Linux ELF through the same Linux User contract in headless mode when explicit runtime dependencies are supplied.
- [ ] Replace source-semantic ASM execution with an assembler-backed machine-byte path while preserving source mapping and execution events.
