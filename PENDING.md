# Pending migration work

## Linux System experimental branch

This branch starts from the completed bounded `linux-user` checkpoint on `master`. Its purpose is to prove a separate **full-system x86-64** execution backend with a real Linux kernel. It must not grow `UnicornLinuxProcessSession` into a kernel substitute and must not regress the fast `unicorn-machine` / `linux-user` paths.

### LS0 — backend and provenance gate

- [ ] Select and pin the exact QEMU/WASM source revision and any required browser-host patches; record upstream commit IDs, licenses and patch provenance.
- [ ] Reproduce the full-system runtime build from repository scripts/CI instead of checking in an unexplained prebuilt engine.
- [ ] Keep the first bring-up single-vCPU and single-threaded where possible; measure a threaded/cross-origin-isolated build separately rather than making SharedArrayBuffer a hidden requirement.
- [ ] Define a typed backend boundary independent from Unicorn so machine lifecycle, console, framebuffer, storage and input do not leak QEMU-specific objects into React.
- [ ] Add an explicit capability report for full-system x86-64 rather than inferring support from configure flags.

### LS1 — CPU and machine bring-up

- [ ] Boot a minimal x86-64 Linux kernel plus deterministic initramfs/BusyBox entirely in browser/WASM.
- [ ] Establish RAM, reset/boot path, timers/interrupts and the minimum virtual devices required by the chosen machine profile.
- [ ] Get a guest serial or VirtIO console from kernel boot through an interactive shell.
- [ ] Add bounded boot/run budgets for wall time, guest RAM, browser memory and generated translation state; failures must remain explicit.
- [ ] Execute an SSE2 baseline smoke in the guest.
- [ ] Execute an AVX smoke in the guest.
- [ ] Execute an AVX2 smoke beginning with `vpxor ymm0, ymm0, ymm0`, then memory/integer/shuffle cases required by real programs.
- [ ] Validate guest `CPUID`, `XGETBV`, XCR0/XSAVE state and actual instruction execution together before claiming AVX2 support.
- [ ] Keep AVX2 unavailable in UI/capability metadata until the guest execution tests pass.

### LS2 — real guest TTY and input

- [ ] Bridge the guest console to the existing browser terminal surface without host syscall passthrough.
- [ ] Verify `/dev/tty`, `isatty`, `termios` and relevant `ioctl` behavior is supplied by the guest kernel rather than TypeScript syscall emulation.
- [ ] Route keyboard input into the virtual console/device.
- [ ] Verify canonical/raw terminal modes and control characters including Ctrl-C.
- [ ] Preserve terminal output as observable execution events without changing guest semantics.

### LS3 — browser-backed storage

- [ ] Keep project/machine metadata in IndexedDB; move large mutable machine/workspace data to OPFS.
- [ ] Use an immutable/cacheable base rootfs for the initial implementation.
- [ ] Persist only the project-owned workspace (`/workspace`) initially; do not rewrite a complete root image for ordinary project edits.
- [ ] Design a block/file bridge that preserves ordering and flush semantics required by the guest filesystem.
- [ ] Add reload persistence tests: create/modify/delete guest workspace files, reload the page, boot again and verify exact contents.
- [ ] Handle browser quota exhaustion and partial-write failures explicitly.
- [ ] Add an optional writable system overlay only after workspace persistence is proven.

### LS4 — project machine model

- [ ] Design `InspectorProject` schema v2 with a versioned `machineProfile` rather than embedding runtime objects in project state.
- [ ] Represent architecture (`x86_64`) independently from environment (`bare-metal`, `linux-user`, `linux-system`).
- [ ] Record backend/kernel/rootfs identifiers needed to reproduce a machine without persisting opaque execution state as authoritative project data.
- [ ] Provide deterministic migration from schemaVersion 1 projects with no machine profile.
- [ ] Keep old projects defaulting to the current fast behavior unless the user explicitly selects Linux System.
- [ ] Define project export/import rules for machine metadata and workspace content without automatically bundling large shared base images.

### LS5 — framebuffer and virtual display

- [ ] Add the simplest auditable guest framebuffer/display device supported by the selected backend.
- [ ] Present framebuffer output in a dedicated Canvas-based `Linux Display` surface/window, separate from the debugger graph.
- [ ] Bridge keyboard and pointer input through guest virtual input devices.
- [ ] Measure framebuffer copy/repaint cost and avoid rendering unchanged regions where the backend exposes dirty rectangles/pages.
- [ ] Keep OpenGL, VirGL, 3D acceleration and host GPU passthrough out of the first display milestone.

### LS6 — X11 guest stack

- [ ] Boot a Linux image containing a minimal X11 stack only after framebuffer/input are stable.
- [ ] Run the X server inside the guest; do not reimplement the X11 protocol in TypeScript.
- [ ] Add a minimal window-manager/application smoke that opens a real guest window, receives keyboard/mouse input and repaints correctly.
- [ ] Verify an assembled/linked project program can interact with guest X11 through the normal Linux ABI/libraries.
- [ ] Keep the graphical test surface isolated so closing/resetting it cannot corrupt project storage.

### LS7 — performance, isolation and deployment

- [ ] Measure cold boot latency, time to shell, steady-state translated x86 throughput, guest RAM footprint and browser/WASM memory growth.
- [ ] Benchmark AVX2-heavy loops separately from kernel/TTY workloads so CPU translation cost is visible.
- [ ] Measure OPFS throughput and sync/flush overhead with realistic project workloads.
- [ ] Compare single-thread and threaded WASM builds before choosing the default.
- [ ] Validate the cross-origin-isolation strategy required for any SharedArrayBuffer build under the actual GitHub Pages deployment model.
- [ ] Keep strict memory/CPU/storage ceilings and explicit errors; never increase limits solely to mask a backend bug.
- [ ] Prohibit host filesystem/process/syscall passthrough. Any network support must be an explicit virtual-device/browser policy layer.
- [ ] Add deterministic reset/dispose tests to prove a VM cannot retain stale device/memory state across project runs.

### Linux System acceptance gates

- [ ] A real x86-64 Linux kernel reaches userspace in the browser.
- [ ] A real guest TTY reaches an interactive shell and handles input/signals through kernel device semantics.
- [ ] AVX2 is observed executing correctly inside the guest, with coherent CPUID/XCR0 exposure.
- [ ] `/workspace` survives browser reload through OPFS with byte-exact persistence.
- [ ] The VM cannot access the host filesystem or host process/syscall surface.
- [ ] `unicorn-machine` and `linux-user` regression suites remain green and keep their fast startup path.
- [ ] Framebuffer performance is measured and acceptable before X11 is introduced.
- [ ] X11 is accepted only after a real guest application can open, repaint and interact with a window.

### Explicit non-goals for initial Linux System bring-up

- [ ] Do **not** convert the TypeScript Linux User syscall shim into full-system emulation.
- [ ] Do **not** claim AVX2 from a configure option or CPUID bit alone.
- [ ] Do **not** add OpenGL/VirGL/3D before the basic framebuffer/X11 path is proven.
- [ ] Do **not** make the base rootfs globally writable before an overlay/persistence design is validated.
- [ ] Do **not** pass guest syscalls, paths or file descriptors directly to the browser host OS.
- [ ] Do **not** merge this branch to `master` until the CPU/kernel/TTY/AVX2/storage acceptance gates are demonstrated by automated tests.

## Current execution architecture

- [x] `asm-source-x86-64`: fast source-semantic NASM-style execution for editor/debugger workflows.
- [x] `unicorn-machine`: direct x86-64 machine execution for static/fixed-address ELF without a guest OS.
- [x] `linux-user`: bounded, kernel-less x86-64 Linux userspace on Unicorn/WASM with explicit `PT_INTERP` / `DT_NEEDED` runtime materialization and a narrow TypeScript syscall contract.
- [x] Close the observed Linux User stdio gap with x86-64 `SYS_writev(20)`, bounded iovec handling, stdout/stderr byte-preserving aggregation and fail-closed writes to the read-only runtime VFS.
- [x] Keep Linux User single-process/single-thread and fail closed when a futex wait would really block; never fake synchronization success.
- [ ] `linux-system`: full-system x86-64 machine + real Linux kernel, real guest TTY/devices/filesystem and optional graphical display. This branch owns that experiment and must not expand the Linux User syscall shim into a second kernel.

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

- [x] Create the dedicated `feature/linux-system` branch from the completed Linux User checkpoint.
- [ ] Prototype the full-system x86-64 backend without changing the stable Linux User contract on `master`.
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
