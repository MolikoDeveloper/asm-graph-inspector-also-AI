# Capstone x86 WebAssembly vendor

Pinned from `capstone_x86_5.0.9.zip`.

The runtime is deliberately kept outside the application JavaScript bundle. `src/features/capstone/capstoneLoader.ts` injects the Emscripten glue and loads the WASM only when binary analysis needs it.

Expected upstream archive SHA-256:

`ded6c12714a48fcd2706c8b3912f248a52c0758c80f608e30eee5c101d6b2d63`

Vendored payloads are not edited by the application.
