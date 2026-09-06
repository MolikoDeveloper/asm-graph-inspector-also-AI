# QA / handoff notes

## Repository baseline reviewed

The current `main` branch was inspected before redesign. It contains `LICENSE` and a single `index.html` of roughly 2.25 MB. The new project deliberately replaces that single-file delivery model.

## Structural checks completed in this environment

- TypeScript source syntax/internal-model check: PASS using the system TypeScript compiler with temporary React module shims because package installation is unavailable in this isolated runtime.
- Execution-core strict TypeScript check: PASS with the system TypeScript compiler over the execution/binary/dependency modules, including the Blink adapter and recursive runtime-dependency materializer.
- Runtime-linkage parser smoke test: PASS against the host `libc.so.6`, `libm.so.6` and `ld-linux-x86-64.so.2`; SONAME and transitive `DT_NEEDED` values were recovered without full symbol/unwind analysis.
- Execution controller + Debug Console targeted TypeScript checks: PASS using temporary React/JSX/Vite shims; the shims are not part of the source tree.
- Real ELF execution smoke test: PASS. A locally assembled/linked static ELF64 x86-64 `_start` program executed 8 machine instructions through the vendored Capstone provider, produced `hello\n` on virtual stdout and terminated with `exit(0)`.
- Pure ASM analysis smoke test: PASS on the `Hello, world!` NASM sample.
  - 9 graph nodes (including `_start`).
  - 8 sequential/control edges.
  - data declarations are not misclassified as instructions.
- Capstone vendor payload hashes match the previously validated V14.x payloads:
  - `capstone_x86.js`: `3baa4fa8d8c7bd7152b35bd4c7b8f00f07d5aa0997b869b7f968cd687d393150`
  - `capstone_x86.wasm`: `438d9dde5420e47ef4c8fee66688b4662b4d8932c2e9022292d75bcc532a03b7`
- Visual shell review: rendered at a 1536×1024 desktop viewport using the production CSS and representative static workbench markup.
- GitHub Pages workflow is included and targets `dist/`.

## Blink validation boundary

The pinned Blink JS/WASM payload cannot be downloaded from this isolated container, so the new Process Sandbox adapter was not executed against `ray_test` here. The patch includes an integrity-checked `bun run vendor:blink` script rather than silently substituting another build.

Authoritative local validation after applying this slice must therefore include:

```bash
bun run vendor:blink
bun run typecheck
bun run build
```

Then prepare the uploaded dynamic `ray_test` with all Global Dependencies present and verify that execution reaches Blink instead of the former `PT_INTERP`/`DT_NEEDED` refusal. Subsequent failure at a raylib display/window syscall is a separate sandbox-environment limitation, not a dynamic-loader refusal.

## Environment limitation

`npm install` could not reach `registry.npmjs.org` from this container (`EAI_AGAIN`). Therefore a real Vite dependency install / production bundle could not be executed here.

The included GitHub Actions workflow performs the authoritative install, typecheck and Vite build with Bun on GitHub-hosted runners. Locally, the same validation is:

```bash
bun install
bun run typecheck
bun run build
```

or with Node:

```bash
npm install
npm run typecheck
npm run build
```

## Visual review ledger

Compared against the redesign concept:

1. App skeleton: title/menu bar, activity rail, explorer, editor, graph, inspector, bottom panel and status bar are all present.
2. Density: low-height VS Code-like chrome and monospace technical surfaces match the intended desktop-tool density.
3. Hierarchy: editor is primary; graph/inspector are secondary docks and may be toggled off.
4. Project model: no loose-file entry state; the project chooser is the blocking first surface.
5. Modularity: project persistence, workspace state, analysis, Capstone loader and UI components are separate TypeScript modules.
6. Asset strategy: Capstone JS/WASM are separate lazy static assets instead of being embedded into the HTML/application bundle.

The visual QA screenshot is delivered separately from the project ZIP; it is not included in the production source tree.

## Blink dynamic-process compatibility run (v11)

- Dynamic Process Sandbox preparation no longer enters Blink debugger mode eagerly.
- `Run` starts through `blinkenlib_run_fast()` and resumes preemption quanta through `blinkenlib_preempt_resume()`.
- This intentionally bypasses the pinned fork's internal debugger/disassembler during process Run; ASM Graph Inspector's own ELF/Capstone analysis remains authoritative.
- `Step` lazily initializes `blinkenlib_starti()` debugger mode. Switching from Step to Run requires Reset so stale/debugger state cannot be presented as a process continuation.
- Headless Run exposes stdout/stderr/exit/signal state but intentionally suppresses register snapshots because `clstruct` pointers are not refreshed when Blink debugger mode is disabled.
- The wrapper's host-side `\n$ /program\n` setup prompt is filtered and never reported as guest stdout.

## Execution-follow UI validation (v12)

- With a binary file active, `Prepare` then `Step` should auto-reveal the paused instruction address inside the binary disassembly editor whenever RIP remains inside the main executable image.
- The analysis dock should automatically switch to `CFG` → `Function CFG`, focus the current basic block on the canvas, and keep selection synchronized as stepping moves across blocks/functions discovered in the main image.
- When stepping pauses in a runtime dependency or interpreter address outside the main image, the editor must not jump to an arbitrary line in the main disassembly; the current limitation is explicit until multi-image runtime analysis lands.

## Headless execution simulation tests (v12)

The execution work now has deterministic tests that require no user interaction:

```bash
bun run test:execution
```

The bounded-provider smoke test injects a minimal fake Capstone detail surface and executes a real three-instruction x86-64 sequence through `X86ExecutionSession`: `xor edi,edi` → `mov eax,60` → `syscall`, asserting paused snapshots, RIP/register evolution and final `exit(0)`. The execution-follow smoke test feeds a paused execution snapshot into the same address/function/CFG selection helpers used by the UI and asserts the disassembly/function/basic-block target. A third Blink state-machine smoke test injects a fake WASM module/runtime into `BlinkProcessSession`, exercises `Prepare → Step`, verifies the intentional Step→Run Reset boundary, then creates a fresh session and verifies headless Run stdout plus `exit(0)`.

In this isolated environment Bun is unavailable, so the test sources were TypeScript-checked with the system compiler. The bounded/follow tests were emitted as CommonJS and executed with Node; the Blink test was emitted as ESM with its relative imports normalized to `.js` for the Node harness. Result: PASS for all three smoke tests.

## Blink provider diagnostics (v13)

- Added a no-user-interaction failure simulation reproducing the observed shape: thirteen `warning: unsupported syscall: __syscall_mprotect` messages followed by `Aborted(native code called abort())`.
- The provider must aggregate the thirteen identical warnings into one diagnostic with count 13, classify the known Emscripten `mprotect` compatibility stub as informational, capture `onAbort`, preserve the thrown WASM stack, and report the execution state as `trapped`.
- Targeted strict TypeScript compilation of the Blink execution/provider diagnostic slice passes with the system TypeScript compiler.
- The compiled diagnostic smoke test and existing Blink state-machine smoke test both execute successfully under Node after ESM extension normalization in this isolated QA environment.
