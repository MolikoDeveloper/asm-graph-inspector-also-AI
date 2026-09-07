# Blink Process Sandbox assets

`blinkenlib.js`, `blinkenlib.wasm`, `build-profile.json`, and the Blink license are generated locally by:

```bash
bun run vendor:blink
```

The assets are intentionally not hand-maintained and are not downloaded from the precompiled x86-64-playground payload anymore.

## Why the source build is required

The original x86-64-playground browser artifact is configured with `--disable-all`. In the pinned Blink fork that disables x87/FPU support, so its virtual CPUID does not satisfy glibc's `x86-64-baseline` CPU check even when the uploaded `libc.so.6` itself only requires baseline.

ASM Graph Inspector therefore builds the same pinned Blink fork with this browser-safe profile:

- `--disable-all`
- `--enable-x87`
- `--enable-mmx`
- `--enable-nonposix`

JIT remains disabled. The resulting `build-profile.json` is checked by the runtime before dynamic ELF execution; stale upstream-prebuilt assets are rejected instead of silently presenting the wrong CPU profile.

Pinned source:

- `robalb/blink` commit `71487ee40869b3ccac6cac9bb7a45d71484978d6`
- Blink is ISC licensed; its license is copied next to the generated assets.

## Build dependency

Install and activate Emscripten before running the vendoring command. The upstream browser fork documents Emscripten/emsdk 3.1.64 as its tested toolchain. The script requires `git`, `make`, `emconfigure`, `emmake`, `emcc`, and `sha256sum`.

The generated runtime is served from this same-origin Vite public directory. The inspector never executes a host binary and never inherits the host filesystem.
