# QA / handoff notes

## Repository baseline reviewed

The current `main` branch was inspected before redesign. It contains `LICENSE` and a single `index.html` of roughly 2.25 MB. The new project deliberately replaces that single-file delivery model.

## Structural checks completed in this environment

- TypeScript source syntax/internal-model check: PASS using the system TypeScript compiler with temporary React module shims because package installation is unavailable in this isolated runtime.
- Pure ASM analysis smoke test: PASS on the `Hello, world!` NASM sample.
  - 9 graph nodes (including `_start`).
  - 8 sequential/control edges.
  - data declarations are not misclassified as instructions.
- Capstone vendor payload hashes match the previously validated V14.x payloads:
  - `capstone_x86.js`: `3baa4fa8d8c7bd7152b35bd4c7b8f00f07d5aa0997b869b7f968cd687d393150`
  - `capstone_x86.wasm`: `438d9dde5420e47ef4c8fee66688b4662b4d8932c2e9022292d75bcc532a03b7`
- Visual shell review: rendered at a 1536×1024 desktop viewport using the production CSS and representative static workbench markup.
- GitHub Pages workflow is included and targets `dist/`.

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
