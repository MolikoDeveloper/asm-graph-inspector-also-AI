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

`.github/workflows/deploy-pages.yml` builds on every push to `main` with Bun and deploys `dist/` using GitHub's official Pages actions.

In the repository settings select **Settings → Pages → Source: GitHub Actions** once. After that, pushes to `main` deploy automatically.

## Project model

The app does not have a loose-file state. When there is no active project, the first UI is the project chooser. Projects and imported files are persisted in IndexedDB.

Text edits autosave after a short debounce. Imported binaries are stored as `ArrayBuffer` values through IndexedDB structured cloning.

## Current migration boundary

This package establishes the new product shell and module boundaries. The old monolithic analysis implementation should be migrated feature-by-feature behind `src/features/analysis/` and `src/features/capstone/` instead of copying the old global state into React.

The initial ASM graph analyzer is intentionally small: it proves the new editor → analysis → Canvas graph path while the V14.x ELF/CFI/dataflow engine is moved into typed services.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the intended module boundaries.
