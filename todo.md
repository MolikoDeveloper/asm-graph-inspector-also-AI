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

- [ ] Add a typed `toolchain` feature boundary independent from React and execution providers.
- [ ] Define `AssemblerBackend`, assembly request/result, diagnostics and generated-artifact contracts.
- [ ] Define a generic isolated tool-process runner contract so assembler backends do not depend directly on Blink internals.
- [ ] Add a deterministic NASM + GNU ld backend orchestration layer using the generic runner contract.
- [ ] Add zero-UI smoke coverage for command construction, multi-source object naming and final artifact retrieval.
- [ ] Add the toolchain smoke suite to CI.

## Checkpoint 2 — Blink tool runner

- [ ] Implement `BlinkToolProcessRunner` using a dedicated ephemeral Blink/MEMFS session.
- [ ] Mount only explicit toolchain binaries and `/work` inputs; never inherit host/browser filesystem state.
- [ ] Capture tool stdout/stderr/exit code and retrieve declared output files.
- [ ] Enforce bounded execution/time/output policy for tool processes.
- [ ] Add deterministic tests with a minimal executable tool fixture before wiring NASM.

## Checkpoint 3 — real NASM + GNU ld toolchain

- [ ] Vendor or otherwise reproducibly provide x86-64 Linux NASM for the tool session.
- [ ] Vendor or reproducibly provide the minimum GNU binutils/`ld` tool payload required for ELF64 linking.
- [ ] Assemble `hello_world.asm` to `ET_REL` with `nasm -f elf64`.
- [ ] Link the object to an `ET_EXEC` ELF with `_start` as entry.
- [ ] Verify the resulting ELF using the existing ELF parser and Capstone path.
- [ ] Run the generated ELF through the binary execution API with stdout + exit(0).
- [ ] Support multiple ASM source files by assembling independently and linking the resulting objects together.

## Checkpoint 4 — project integration

- [ ] Add a build model for ASM projects without coupling it to the editor UI.
- [ ] Produce generated binary `ProjectFile` artifacts under a build namespace/path.
- [ ] Expose Build / Assemble & Run actions for ASM source.
- [ ] Keep generated binaries analyzable/openable exactly like imported binaries.
- [ ] Persist only explicit project artifacts; do not silently copy host dependencies into the project.

## Checkpoint 5 — execution unification

- [ ] Route normal ASM Run/Step through `source -> assembler -> ELF -> execution`.
- [ ] Use real ELF addresses for RIP, instruction counts and execution traces.
- [ ] Keep the legacy source-semantic provider available only as a deliberate fallback/test mode during migration.
- [ ] Remove legacy-provider default routing only after binary-path parity tests pass.

## Checkpoint 6 — CFG and runtime-follow unification

- [ ] Make ELF bytes + Capstone the authoritative source for binary CFG construction.
- [ ] Keep Function CFG and Program Flow/Call Graph as distinct graph products.
- [ ] Resolve each stepped RIP to the owning loaded image, including `ld-linux`, libc and other Global Dependencies.
- [ ] Auto-scroll and highlight the current instruction in binary disassembly after Step.
- [ ] Project execution counts/edges onto CFG using executed instructions only; never count skipped instructions.
- [ ] Render execution count as `×N`, not `+N`.

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
