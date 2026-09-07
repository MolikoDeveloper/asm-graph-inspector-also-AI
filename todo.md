# ASM Graph Inspector — toolchain / execution roadmap

This file is the implementation contract for the ASM → binary → analysis/execution migration.

## Working rules

- [x] Before every implementation pass, inspect the current `master` state and recent repository changes before modifying code.
- [x] Keep assembly and execution as separate libraries/modules.
- [x] The assembler ends at bytes/artifacts; it must not own program execution.
- [x] The execution engine consumes real binaries; it must not parse/assemble ASM source.
- [x] Binary instruction truth comes from real bytes + Capstone, not from source-semantic pseudo-PCs or objdump text.
- [x] Keep Global Dependencies as the authoritative user-provided runtime library store (`PT_INTERP` + recursive `DT_NEEDED`).
- [x] Keep toolchain files separate from guest runtime dependencies.
- [x] Do not add or boot a Linux kernel. Linux execution remains userspace ABI emulation through Blink.
- [x] Keep toolchain Blink sessions separate from guest-program Blink sessions.
- [x] Freeze `asmSourceSession.ts` as the legacy/source-semantic path while the binary pipeline reaches feature parity; do not expand it into a full x86 implementation.
- [x] Preserve current working ELF execution, Global Dependencies, runtime disassembly and execution-follow behavior while migrating ASM.

## Target architecture

```text
ASM source
   |
   v
AssemblerBackend
   |
   v
real ELF/object/flat bytes
   |
   +---------------------> Capstone -> disassembly / CFG / call graph / dataflow
   |
   +---------------------> Execution engine -> Blink -> Linux userspace ABI
                                                |
                                                +-> Global Dependencies
```

## Checkpoint 1 — toolchain abstraction

- [x] Add a typed `toolchain` feature boundary independent from React and execution providers.
- [x] Define `AssemblerBackend`, assembly request/result, diagnostics and generated-artifact contracts.
- [x] Define a generic isolated tool-process runner contract so assembler backends do not depend directly on Blink internals.
- [x] Add a deterministic NASM + GNU ld backend orchestration layer using the generic runner contract.
- [x] Add zero-UI smoke coverage for command construction, multi-source object naming and final artifact retrieval.
- [x] Add the toolchain smoke suite to CI.

## Checkpoint 2 — Blink tool runner

- [x] Implement `BlinkToolProcessRunner` using a dedicated ephemeral Blink/MEMFS session.
- [x] Mount only explicit toolchain binaries and `/work` inputs; never inherit host/browser filesystem state.
- [x] Capture tool stdout/stderr/exit code and retrieve declared output files.
- [x] Enforce bounded execution/time/output policy for tool processes.
- [x] Add deterministic tests with a minimal executable tool fixture before wiring NASM.

The pinned Blink browser bridge tokenizes its argument string on spaces and currently leaves guest environment variables unimplemented. The tool runner therefore rejects whitespace-bearing individual argv tokens and non-empty `env` explicitly rather than silently misrepresenting them. Generated NASM work paths are normalized to bridge-safe ASCII names.

## Checkpoint 3 — real NASM + GNU ld toolchain

- [x] Reproducibly provide x86-64 Linux NASM 3.00 from an exact upstream commit/blob identity.
- [x] Reproducibly provide GNU ld 2.43.50 from the same pinned upstream toolchain source.
- [x] Assemble `hello-world.asm` to `ET_REL` with real `nasm -f elf64` in CI.
- [x] Link the object to an `ET_EXEC` ELF with `_start` as entry using real GNU ld.
- [x] Verify the resulting ELF using the existing ELF parser and Capstone-backed binary execution path.
- [x] Run the generated ELF through the binary execution API and assert exact stdout + exit(0).
- [x] Support multiple ASM source files by assembling independently and linking the resulting objects together.
- [x] Expose `createPinnedNasmLdAssemblerBackend()` to bind verified real tool assets to `BlinkToolProcessRunner` in the browser.
- [ ] Add a real browser E2E that executes the pinned NASM + GNU ld binaries through Blink itself (the runner has deterministic fake-Blink coverage and the actual tool binaries are independently executed/verified in CI today).

Generated NASM/GNU ld binaries are not committed. `bun run vendor:toolchain` fetches exact files from `robalb/x86-64-playground@d617f6a19879157c1debbe0454b6c4cff2ebe094`, verifies byte length + Git blob identity, and places them under `public/vendor/toolchain` for same-origin browser loading and Pages deployment.

## Checkpoint 4 — project integration

- [x] Add a build model for ASM projects without coupling it to the editor UI.
- [x] Produce generated binary `ProjectFile` artifacts under a build namespace/path.
- [x] Expose Build / Assemble & Run actions for ASM source.
- [x] Keep generated binaries analyzable/openable exactly like imported binaries.
- [x] Persist only explicit project artifacts; do not silently copy host dependencies into the project.

Generated build files carry explicit `assembly-build` provenance (backend, source file ids, artifact kind and build timestamp) and use a stable project id/path so rebuilding replaces the same artifact rather than accumulating copies. The generated ELF is immediately routed through normal binary analysis/Capstone and may be opened, disassembled, graphed and executed like an imported binary. Global Dependencies remain external to project exports.

## Checkpoint 5 — execution unification

- [x] Route normal ASM Run/Step through `source -> assembler -> ELF -> execution`.
- [x] Use real ELF addresses for RIP, instruction counts and execution traces.
- [x] Keep the legacy source-semantic provider available only as a deliberate fallback/test mode during migration.
- [x] Remove legacy-provider default routing only after binary-path parity tests pass.

Normal UI execution no longer constructs an `asm-source` execution target. F6/F10/Prepare on an ASM source resolves a generated ELF using the pinned NASM + GNU ld backend, analyzes it through the normal binary/Capstone path, and executes that binary. Generated execution artifacts carry SHA-256 source fingerprints so unchanged source reuses the existing ELF while any source-content change forces a rebuild. The legacy `AsmSourceExecutionSession` remains available to explicit headless/tests/fallback callers only. A parity smoke fixture restricted to the shared legacy/NASM subset asserts identical stdout/exit behavior while the compiled path is additionally required to use the binary provider and real linked ELF addresses.

## Checkpoint 6 — CFG and runtime-follow unification

- [x] Make ELF bytes + Capstone the authoritative source for binary CFG construction.
- [x] Keep Function CFG and Program Flow/Call Graph as distinct graph products.
- [x] Resolve each stepped RIP to the owning loaded image, including `ld-linux`, libc and other Global Dependencies.
- [x] Auto-scroll and highlight the current instruction in binary disassembly after Step.
- [x] Project execution counts/edges onto CFG using executed instructions only; never count skipped instructions.
- [x] Render execution count as `×N`, not `+N`.

Blink Step now indexes the main executable plus the materialized `PT_INTERP`/recursive `DT_NEEDED` closure as executable runtime images. Fixed-address `ET_EXEC` mappings use their canonical image addresses directly; relocated images infer and cache load bias only from a unique multi-instruction byte signature in Blink's live debugger window, and ambiguous signatures fail closed. The live view exposes the owning image, role, runtime address, image-relative address and load bias without replacing static ELF + Capstone evidence. Only actually stepped instructions that resolve to the program image become CFG trace events. Leaving the program for the loader or a shared library emits a trace discontinuity, so returning to the program cannot fabricate a CFG edge across library execution. Static editor/CFG follow likewise refuses to project dependency RIPs into the main executable.

## Checkpoint 7 — text dump classification/import

- [ ] Detect objdump/disassembly text by content instead of trusting the `.asm` extension.
- [ ] Route objdump text to a dedicated importer/parser, never to the NASM source parser.
- [ ] Treat dump text as analysis evidence/annotation when authoritative binary bytes are also available.
- [ ] Never use objdump text in place of ELF bytes for binary execution.

## Checkpoint 8 — FASM backend

- [ ] Add FASM behind the same `AssemblerBackend` contract.
- [ ] Run FASM in the isolated toolchain environment rather than reimplementing the FASM macro/preprocessor language.
- [ ] Accept FASM-produced ELF/raw artifacts through the same binary analysis/execution pipeline.

## Checkpoint 9 — richer Linux userspace sandbox

- [ ] Keep the model kernel-less: guest Linux syscalls terminate at the Blink userspace ABI layer.
- [ ] Formalize VFS namespaces for toolchain, work files, guest runtime libraries and temporary files.
- [ ] Extend syscall/VFS policy only from concrete program requirements; do not emulate unrelated kernel subsystems pre-emptively.
- [ ] Preserve explicit diagnostics for unsupported syscalls and environment services.

## Checkpoint 10 — Blink ISA compatibility and portable guest contract

The large VZed `ray_test` regression proved that ELF ISA notes are not sufficient execution evidence: the file advertises x86-64-baseline while executable bytes contain AVX/VEX, AVX2-style vector forms and GFNI. The browser Blink profile intentionally implements a baseline CPU contract, not arbitrary host-native extensions.

- [x] Add a Blink ISA preflight based on authoritative executable `PT_LOAD` bytes decoded by pinned Capstone.
- [x] Reject positively decoded AVX/VEX vector, EVEX/AVX-512, GFNI and VMX instructions before creating the Blink guest session.
- [x] Report the first unsupported instruction with virtual address, mnemonic, operands, bytes and executable segment evidence.
- [x] Treat GNU/ELF ISA notes as advisory; never allow metadata claiming `x86-64-baseline` to override contradictory executable bytes.
- [x] Add deterministic smoke coverage for baseline acceptance, AVX, GFNI, EVEX and VMX classification.
- [ ] Surface ISA preflight progress/result explicitly in Debug Console instead of only surfacing a terminal rejection.
- [ ] Audit executable bytes of the materialized interpreter and recursive Global Dependencies as well as the main guest image.
- [ ] Parse GNU symbol-version requirements and validate the selected Global Dependencies before launch (the large `ray_test` requires symbols up through `GLIBC_2.36`).
- [ ] Add a compact real ELF regression fixture whose bytes contain unsupported VEX/EVEX instructions and assert browser execution is rejected before Blink starts.
- [ ] VZed producer contract: build browser-inspector-compatible Linux artifacts with an explicit portable x86-64 baseline CPU target rather than host-native CPU features.
- [ ] VZed producer contract: apply the same CPU target to generated module code, runtime/support objects and compiler-rt inputs so link-time code cannot reintroduce AVX/AVX2/GFNI.
- [ ] VZed producer contract: add a post-link ISA audit that fails when an inspector-compatible artifact contains instructions outside the agreed Blink profile.
- [ ] Add a VZed baseline `ray_test` regression and prove `VZed -> ELF -> Global Dependencies -> Blink -> stdout/exit(0)` end to end.

The inspector-side compatibility gate is deliberately fail-closed only on positively decoded unsupported instructions. Bytes Capstone cannot decode are reported as skipped evidence rather than guessed to be AVX. Producer-side portability remains necessary: the inspector must diagnose incompatible binaries, not rewrite them or pretend Blink implements instructions it does not.
