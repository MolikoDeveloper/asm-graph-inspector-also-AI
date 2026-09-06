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


## Binary execution checkpoint

The Debug Console now has two explicit browser execution providers:

- `bounded-x86-64` executes fixed-address static ELF64 x86-64 directly from authoritative bytes and is kept as a small deterministic smoke/debug provider.
- `blink-process` is the Process Sandbox for PIE and dynamically linked x86-64 Linux ELF. It materializes the complete `PT_INTERP` / `DT_NEEDED` dependency closure from **Global Dependencies**, mounts those bytes in Blink's private MEMFS, then lets Blink perform the Linux ELF/dynamic-loader work.

Select an analyzed binary and use **Run → Run Active Binary (F6)** or **Step Instruction (F10)**. Neither provider executes a host program or inherits the host filesystem.

Blink is vendored as pinned same-origin JS/WASM assets. Fetch the exact audited payload before the first Blink build:

```bash
bun run vendor:blink
```

The vendoring script pins both the browser wrapper and its Blink fork commit, verifies Git blob identities/sizes and copies the ISC license texts beside the assets.

Process execution is still sandbox work in progress: interactive stdin, VFS/syscall policy interception, runtime module/load-bias observations and graphics/window integration are not complete. A program can therefore load successfully and later fail when it asks Linux/environment services the sandbox does not yet provide.

A deterministic, interaction-free execution smoke suite is available with `bun run test:execution`. It drives the bounded x86-64 session instruction-by-instruction and separately verifies paused-PC → disassembly/function/CFG follow behavior.

## Current migration boundary

This package establishes the new product shell and module boundaries. The old monolithic analysis implementation should be migrated feature-by-feature behind `src/features/analysis/` and `src/features/capstone/` instead of copying the old global state into React.

The initial ASM graph analyzer is intentionally small: it proves the new editor → analysis → Canvas graph path while the V14.x ELF/CFI/dataflow engine is moved into typed services.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the intended module boundaries.
