# Architecture

## Application shell

`src/app/App.tsx` is composition only. It wires together project state, workspace layout, menus, settings, analysis selection and runtime status.

UI regions are independent components:

- `MenuBar` — typed top-level dropdown menus.
- `ActivityBar` — VS Code-style primary navigation.
- `ProjectExplorer` — current project tree/search/analysis summary.
- `EditorWorkspace` — one to three editor groups with independent tabs.
- `SourceEditor` — common viewer/editor surface for text and binary data.
- `GraphPanel` — Canvas-only graph renderer with pan/zoom/select.
- `InspectorPanel` — selected graph entity/evidence details.
- `BottomPanel` — output/problems/debug surface.
- `SettingsDialog` — full overlay settings surface.

## Project layer

`features/project/` owns browser-local persistence and file import. React components do not talk to IndexedDB directly.

The current schema is `InspectorProject.schemaVersion = 1`.

## Workspace layer

`features/workspace/` owns editor groups, open tabs and visibility state. Multiple files can be visible at the same time by splitting the editor right.

This state is intentionally separate from the project. Editor arrangement is session UI state; files and content belong to the project.

## Analysis layer

`features/analysis/` owns semantic analysis and graph models. Canvas components consume `AnalysisGraph`; they do not parse source code themselves.

Migration target for the old V14.x engine:

```text
Imported ProjectFile
        ↓
AnalysisProvider
        ↓
raw ELF / textual source evidence
        ↓
canonical instructions / functions / CFG / dataflow
        ↓
AnalysisGraph + inspector models
        ↓
React shell / Canvas
```

Do not move old DOM manipulation into this layer. It should be pure TypeScript services where possible.

## Binary analysis

`features/binary/` owns the modular raw-ELF engine. `elfParser.ts` accepts authoritative imported bytes and produces `asm-graph.loaded-image/v1` data without touching React or the DOM: executable mappings, section tables, symbol tables, REL/RELA relocations, dynamic dependencies, GNU build-id, process/shared classification and FDE range metadata.

`unwind.ts` parses `.eh_frame` / `.debug_frame` FDE boundaries. `functionDiscovery.ts` consumes those boundaries plus canonical Capstone instructions to discover stripped functions conservatively. `linkage.ts` reconstructs relocation-proven PLT/GOT/IFUNC entities. These modules are deliberately UI-free so they can move behind a Worker without changing React.

`features/analysis/binaryAnalysis.ts` selects an executable root and projects canonical instructions, calls/branches and external function/PLT references into the same `AnalysisGraph` consumed by `GraphPanel`. This is deliberately one shared graph model rather than a second binary-only renderer.

## Capstone

Capstone is no longer embedded in `index.html`.

```text
public/vendor/capstone/capstone_x86.js
public/vendor/capstone/capstone_x86.wasm
```

`capstoneLoader.ts` loads both only when requested. This keeps initial page and application bundles small and allows future architecture-specific WASM packages to be lazy-loaded independently.

## Recommended next migration slices

1. Port full CFI row interpretation / LSDA and reconcile unwind claims with multi-range functions.
2. Complete V14.15 CFG semantics on top of the canonical instruction/function models.
3. Port dataflow/SSA and the Flow/Registers/Memory/Calls/Raw-SSA projections.
4. Add Binary Map / Sections / Symbols / Relocs views that consume the existing raw model instead of reparsing bytes.
5. Add cross-artifact build-id reconciliation for textual dumps + raw ELF evidence.
6. Move project bundle import/export into `features/project/`.
7. Add Web Workers for ELF/Capstone/dataflow operations before moving large fixtures.
8. Persist analysis cache separately from authoritative project files.

The React tree should never become the analysis engine.
