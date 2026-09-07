# Unicorn.js x86 runtime

This directory is populated by `bun run vendor:unicorn`.

- Package: `@alexaltea/unicorn-js`
- Version: `2.1.4`
- Variant: `x86`
- Upstream: `https://github.com/AlexAltea/unicorn.js`
- Runtime license: GPL-2.0 (see generated `LICENSE.unicorn-js.txt`)

`unicorn_x86.js` is the upstream x86-only Emscripten `SINGLE_FILE=1` build, so its WebAssembly payload is embedded in the JavaScript asset. The generated runtime is intentionally not committed; CI vendors the exact package version before tests/build/deployment.

Unicorn owns CPU/memory execution only. ELF parsing, disassembly, CFG/dataflow and canonical instruction evidence remain inspector-owned and Capstone-backed. Dynamic Linux process execution remains on the Blink process backend until a separate Unicorn Linux-userspace layer exists.
