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

`.github/workflows/deploy-pages.yml` builds on every push to `master` with Bun and deploys `dist/` using GitHub's official Pages actions.

In the repository settings select **Settings → Pages → Source: GitHub Actions** once. After that, pushes to `master` deploy automatically.

## Project model

The app does not have a loose-file state. When there is no active project, the first UI is the project chooser. Projects and imported files are persisted in IndexedDB.

Text edits autosave after a short debounce. Imported binaries are stored as `ArrayBuffer` values through IndexedDB structured cloning.

## Execution checkpoint

The execution layer now separates fast CPU/machine execution from bounded Linux userspace compatibility:

- `asm-source-x86-64` executes NASM-style ASM source directly with synthetic source PCs, x86-64 register/stack/data state, bounded stepping/run and a minimal Linux Lite stdio/exit syscall surface. It does not require ELF, libc or a guest kernel.
- `unicorn-machine` executes fixed-address/static ELF64 x86-64 through the pinned Unicorn/WASM + Capstone runtime. It is the direct machine-level path for authoritative bytes and keeps deterministic instruction-level stepping.
- `unicorn-linux` is the bounded **Linux User** provider for dynamic/PIE x86-64 Linux ELF. It maps the real program, `PT_INTERP` loader and recursive `DT_NEEDED` closure into Unicorn and supplies a deliberately narrow TypeScript userspace syscall contract instead of pretending to be a complete Linux kernel.
- Legacy Blink/WASM code remains in the repository as regression/reference infrastructure, but it is no longer the normal dynamic ELF execution route.
- Binary Map preflights the recursive runtime closure and distinguishes interpreter, direct `DT_NEEDED`, and transitive requirements. Program flow separately builds a bounded ELF-wide function call graph so the canvas can show connected functions (`_start → main → ... → PLT`) instead of only the currently selected function CFG.

Select an ASM source file or an analyzed binary and use **Run → Run Active Program (F6)** or **Step Instruction (F10)**. No execution provider launches a host process or inherits the host filesystem.

### Linux User runtime dependencies

For a dynamically linked glibc ELF, upload its actual loader/runtime libraries to **Global Dependencies**. For a minimal `puts()` fixture on a typical Debian/Ubuntu-style system this means the resolved bytes for:

```text
/lib64/ld-linux-x86-64.so.2
/lib/x86_64-linux-gnu/libc.so.6
```

Do **not** upload `linux-vdso.so.1`; it is a kernel-provided virtual image, not a normal filesystem dependency. If the ELF adds `libm.so.6`, `libstdc++.so.6`, or other `DT_NEEDED` entries, upload those too. The dependency resolver follows their transitive `DT_NEEDED` closure automatically.

The prepared loader/runtime files are exposed to Linux User as a read-only virtual runtime filesystem. The current contract includes the bounded loader/glibc services required by the regression baseline, including memory mapping/protection, loader file reads, process identity/time/random basics, stdio `read`/`write`, x86-64 `writev(2)`, and process exit. Scalar I/O is limited to 1 MiB per syscall; `writev` is limited to 1024 iovecs and the same 1 MiB aggregate budget. Writes to non-stdio runtime descriptors fail rather than mutating program/dependency bytes.

Linux User is intentionally single-process/single-thread and fail-closed. Unsupported syscalls remain explicit. A futex WAIT whose value matches and would really block traps instead of returning fake success. Devices, a writable root filesystem, kernel scheduling/networking and X11 are outside this provider's scope; they belong to the separate full-system Linux experiment tracked on `feature/linux-system`.

A real dynamic glibc smoke runs the host-built test ELF through the actual host loader + libc bytes materialized as explicit guest dependencies. It covers `puts()`, `writev(2)` and clean `exit(0)` through Unicorn Linux User. The deterministic execution suite is available with:

```bash
bun run test:execution
```

It also covers raw ASM, static ELF execution, execution-trace projection, runtime dependency/symbol-version checks, Unicorn runtime/capabilities/memory behavior and retained Blink regression adapters.

## Current migration boundary

This package establishes the new product shell and module boundaries. The old monolithic analysis implementation should be migrated feature-by-feature behind `src/features/analysis/` and `src/features/capstone/` instead of copying the old global state into React.

The initial ASM graph analyzer is intentionally small: it proves the new editor → analysis → Canvas graph path while the V14.x ELF/CFI/dataflow engine is moved into typed services.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the intended module boundaries and [`PENDING.md`](./PENDING.md) for the current execution/migration roadmap.

## Headless execution

Execution is not coupled to React or the browser UI. The repository exposes a headless runner and a Bun CLI for deterministic tests, scripts and CI.

```bash
# Execute NASM-style x86-64 source with the source-semantic provider + Linux Lite.
bun run execute -- examples/headless/hello.asm

# Execute a static fixed-address ELF64 x86-64 binary with vendored Capstone/Unicorn support.
bun run execute -- ./path/to/static-program

# Machine-readable result and observed trace.
bun run execute -- ./path/to/static-program --json
bun run execute -- examples/headless/hello.asm --trace
```

The command auto-detects ELF by magic. ASM uses `asm-source-x86-64`; static `ET_EXEC` ELF without `PT_INTERP`/`DT_NEEDED` uses the direct machine execution path. Prepared dynamic Linux ELF is supported in the browser UI through `unicorn-linux`, but the CLI does not yet accept/materialize the explicit runtime dependency closure required to start that provider headlessly. That wiring remains pending; it is not a limitation of the Linux User session itself.

`bun run test:headless` exercises both current zero-UI input paths. One smoke test runs ASM source directly; another runs a generated static ELF through the execution API. A second ELF test loads the vendored Capstone WASM in the headless runtime so the CLI path is covered without a browser.
