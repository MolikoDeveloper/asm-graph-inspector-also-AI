# Browser ASM toolchain assets

The binary files in this directory are generated/fetched by:

```bash
bun run vendor:toolchain
```

They are intentionally not committed. The vendoring script fetches exact static x86-64 Linux tool binaries from the pinned `robalb/x86-64-playground` source commit and verifies both byte size and Git blob identity before they are used:

- NASM 3.00 — `nasm.3.00.elf`
- GNU ld 2.43.50 — `gnu-ld.2.43.50.elf`
- upstream commit: `d617f6a19879157c1debbe0454b6c4cff2ebe094`

The upstream project describes these payloads as static MUSL binaries intended to run inside Blink. The browser runtime mounts them only in the isolated `/toolchain` namespace; guest runtime libraries continue to come exclusively from ASM Graph Inspector Global Dependencies.

The deployed copies remain the upstream binaries. Their respective upstream licenses/source terms continue to apply; this project does not relink or modify them during vendoring.
