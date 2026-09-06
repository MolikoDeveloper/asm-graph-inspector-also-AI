# Architecture

## Application shell

`src/app/App.tsx` is composition only. It wires together project state, workspace layout, menus, settings, analysis selection and runtime status.

UI regions are independent components:

- `MenuBar` — typed top-level dropdown menus.
- `ActivityBar` — VS Code-style primary navigation.
- `ProjectExplorer` — current project tree/search/analysis summary.
- `EditorWorkspace` — one to three editor groups with independent tabs.
- `SourceEditor` — common viewer/editor surface: highlighted editable ASM/text plus lazy virtualized complete ELF executable disassembly and Hex fallback.
- `GraphPanel` — Canvas-only graph renderer with pan/zoom/select.
- `InspectorPanel` — selected graph entity/evidence details.
- `BottomPanel` — output/problems/debug surface; syntax problems are clickable navigation targets.
- `SettingsDialog` — full overlay settings surface.

## Project layer

`features/project/` owns browser-local persistence and file import. React components do not talk to IndexedDB directly.

The current schema is `InspectorProject.schemaVersion = 1`.

## Workspace layer

`features/workspace/` owns editor groups, open tabs, visibility state, resizable workbench dimensions and editor reveal targets. Multiple files can be visible at the same time by splitting the editor right.

This state is intentionally separate from the project. Editor arrangement is session UI state; files and content belong to the project.

## Analysis layer

`features/analysis/` owns semantic analysis and graph models. Canvas components consume committed `AnalysisGraph` snapshots; they do not parse source code themselves. Source analysis is transactional: candidate parse problems never replace the last valid committed graph.

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

`features/analysis/binaryDisassembly.ts` separately provides a lazy full executable-section disassembly document for the editor, with fixed-row virtualization in React. `features/analysis/binaryAnalysis.ts` selects a discovered function, decodes canonical instructions and delegates local control-flow partitioning to `features/analysis/cfg.ts`. Basic blocks, local branch/fallthrough edges and relocation-proven external call references are projected into the same `AnalysisGraph` consumed by `GraphPanel`. This is deliberately one shared graph model rather than a second binary-only renderer.

`AnalysisDock` provides contextual CFG / Binary Map / Sections / Symbols / Relocs / Unwind views. The table/map views consume `BinaryAnalysisSummary`; React never reparses ELF bytes. Function selection is shared between the Analysis activity sidebar and the dock picker.

`features/analysis/dataflow.ts` is the shared static-dataflow service. It accepts the already-normalized source/binary instruction models and returns SSA-like values plus instruction use/definition metadata. `AnalysisDock` projects that model into Flow / Registers / Memory / Calls / Raw-SSA graphs; `GraphPanel` remains a renderer and does not own transfer semantics.

## Capstone

Capstone is no longer embedded in `index.html`.

```text
public/vendor/capstone/capstone_x86.js
public/vendor/capstone/capstone_x86.wasm
```

`capstoneLoader.ts` loads both only when requested. This keeps initial page and application bundles small and allows future architecture-specific WASM packages to be lazy-loaded independently.

## Recommended next migration slices

1. Complete DWARF expression evaluation, LSDA/personality/action tables and exception CFG edges on top of the migrated CFI rows.
2. Complete V14.15 advanced CFG semantics: dominators, loops, irreducible regions, critical edges, jump tables and noreturn proof.
3. Complete V14.15 dataflow parity: normalized memory ranges/alias sets, stack/flags/barriers and provenance focus.
4. Add cross-artifact build-id reconciliation for textual dumps + raw ELF evidence.
5. Move project bundle import/export into `features/project/`.
6. Add execution policy/session/provider + VFS/IO contracts.
7. Add Web Workers for ELF/Capstone/dataflow operations before moving large fixtures.
8. Persist analysis cache separately from authoritative project files.

The React tree should never become the analysis engine.

## Global dependency registry

`features/dependencies/` owns a browser-local dependency registry that is deliberately outside any individual `InspectorProject`. Imported ELF libraries are persisted as bytes in a dedicated IndexedDB database; authorized host library directories are persisted as File System Access API directory handles when the browser supports structured-cloning those handles. Every project resolves `DT_NEEDED` through the same registry.

Resolution is evidence-first and deterministic: exact imported `DT_SONAME`, exact imported filename, then exact filename in an authorized global library root. A missing browser permission is represented separately from an unresolved dependency. The resolver never substitutes a different SONAME heuristically.
