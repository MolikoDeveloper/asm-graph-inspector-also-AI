# ASM Graph Inspector

Browser-native ASM/ELF inspection workspace. This is the modular React + Vite + TypeScript successor to the previous single-file inspector.

## Goals

- 100% frontend; no server runtime is required.
- GitHub Pages deployment.
- Every file belongs to a browser-local project.
- Multiple files can be open concurrently in editor groups.
- One editor/viewer surface handles text and binary files.
- Canvas remains the graph rendering surface.
- Heavy engines such as Capstone are separate static assets and load on demand.
- Analysis, UI, project persistence and runtime integrations are separate modules.

## Local development

With Bun:

```bash
bun install
bun run dev
```

With Node/npm:

```bash
npm install
npm run dev
```

Production validation:

```bash
npm run typecheck
npm run build
npm run preview
```

Vite uses `base: './'`, so the generated `dist/` works from a GitHub Pages repository subpath without hard-coding the repository name.

## GitHub Pages

`.github/workflows/deploy-pages.yml` builds on every push to `main` with Bun and deploys `dist/` using GitHub's official Pages actions.

In the repository settings select **Settings → Pages → Source: GitHub Actions** once. After that, pushes to `main` deploy automatically.

## Project model

The app does not have a loose-file state. When there is no active project, the first UI is the project chooser. Projects and imported files are persisted in IndexedDB.

Text edits autosave after a short debounce. Imported binaries are stored as `ArrayBuffer` values through IndexedDB structured cloning.


## Execution checkpoint

The Debug Console now has three explicit browser execution providers:

- `asm-source-x86-64` executes NASM-style ASM source directly with synthetic source PCs, x86-64 register/stack/data state, bounded stepping/run and a minimal Linux Lite stdio/exit syscall surface. It does not require ELF, libc or Blink.
- `bounded-x86-64` executes fixed-address static ELF64 x86-64 directly from authoritative bytes and is kept as a small deterministic smoke/debug provider.
- `blink-process` is the Process Sandbox for PIE and dynamically linked x86-64 Linux ELF. It materializes the complete `PT_INTERP` / `DT_NEEDED` dependency closure from **Global Dependencies**, mounts those bytes in Blink's private MEMFS, then lets Blink perform the Linux ELF/dynamic-loader work.
- Binary Map preflights that closure recursively and distinguishes interpreter, direct `DT_NEEDED`, and transitive requirements. Program flow separately builds a bounded ELF-wide function call graph, so the canvas can show connected functions (`_start → main → ... → PLT`) instead of only the currently selected function CFG.

Select an ASM source file or an analyzed binary and use **Run → Run Active Program (F6)** or **Step Instruction (F10)**. No provider executes a host program or inherits the host filesystem.

Blink is vendored as a pinned same-origin JS/WASM **source build**. Build it before the first dynamic-ELF run:

```bash
bun run vendor:blink
```

The script checks out the pinned `robalb/blink` fork and builds the browser module with Emscripten. Unlike the x86-64-playground prebuilt `--disable-all` artifact, ASM Graph Inspector re-enables x87/FPU, MMX and Linux non-POSIX APIs so the virtual CPU satisfies glibc's `x86-64-baseline` startup contract while JIT remains disabled. The runtime validates `public/vendor/blink/build-profile.json` and rejects stale/incompatible assets.

For a dynamically linked glibc ELF, upload its actual loader/runtime libraries to **Global Dependencies**. For the minimal `puts()` fixture on a typical Debian/Ubuntu-style system this means the resolved bytes for:

```text
/lib64/ld-linux-x86-64.so.2
/lib/x86_64-linux-gnu/libc.so.6
```

Do **not** upload `linux-vdso.so.1`; it is a kernel-provided virtual image, not a normal filesystem dependency. If the ELF adds `libm.so.6`, `libstdc++.so.6`, or other `DT_NEEDED` entries, upload those too. The dependency resolver follows their transitive `DT_NEEDED` closure automatically.

Process execution is still sandbox work in progress: interactive stdin, VFS/syscall policy interception, runtime module/load-bias observations and graphics/window integration are not complete. A program can therefore load successfully and later fail when it asks Linux/environment services the sandbox does not yet provide.

A deterministic, interaction-free execution smoke suite is available with `bun run test:execution`. It drives raw ASM source through a loop + virtual `write` + `exit`, drives the bounded ELF provider instruction-by-instruction, verifies execution-trace projection onto CFG nodes/edges, and covers the Blink state/diagnostic adapters.

## Current migration boundary

This package establishes the new product shell and module boundaries. The old monolithic analysis implementation should be migrated feature-by-feature behind `src/features/analysis/` and `src/features/capstone/` instead of copying the old global state into React.

The initial ASM graph analyzer is intentionally small: it proves the new editor → analysis → Canvas graph path while the V14.x ELF/CFI/dataflow engine is moved into typed services.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the intended module boundaries.

## Headless execution

Execution is not coupled to React or the browser UI. The repository exposes a headless runner and a Bun CLI for deterministic tests, scripts and CI.

```bash
# Execute NASM-style x86-64 source with the source-semantic provider + Linux Lite.
bun run execute -- examples/headless/hello.asm

# Execute a static fixed-address ELF64 x86-64 binary with vendored Capstone WASM.
bun run execute -- ./path/to/static-program

# Machine-readable result and observed trace.
bun run execute -- ./path/to/static-program --json
bun run execute -- examples/headless/hello.asm --trace
```

The command auto-detects ELF by magic. ASM uses `asm-source-x86-64`; static `ET_EXEC` ELF without `PT_INTERP`/`DT_NEEDED` uses `bounded-x86-64`. Dynamic ELF still selects `blink-process`, which is intentionally rejected by the headless CLI until the Blink/WASM process provider is made reliable outside the UI/browser process sandbox. This is a provider limitation, not a CLI limitation.

`bun run test:headless` exercises both input paths without any UI. One smoke test runs ASM source directly; another runs a generated static ELF through the execution API. A second ELF test loads the vendored Capstone WASM in the headless runtime so the CLI path is covered without a browser.
