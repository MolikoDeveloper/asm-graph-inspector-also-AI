# Blink Process Sandbox assets

`blinkenlib.js` and `blinkenlib.wasm` are intentionally not hand-maintained.
Run `bun run vendor:blink` to fetch the pinned browser build used by the Process Sandbox.

Pins:

- `robalb/x86-64-playground` commit `d617f6a19879157c1debbe0454b6c4cff2ebe094`
- its `robalb/blink` submodule/fork commit `71487ee40869b3ccac6cac9bb7a45d71484978d6`
- both upstream projects are ISC licensed; the vendoring script copies both license files next to the assets.

The runtime is served from this same-origin Vite public directory. The inspector never executes a host binary or inherits the host filesystem.
