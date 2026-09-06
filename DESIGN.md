# Product design system

The new shell is intentionally an application workspace, not a dashboard and not a large single-page document.

## Layout

```text
Title / menu bar
┌──────────────────────────────────────────────────────────────────┐
│ Activity │ Project sidebar │ Editor groups │ Graph │ Inspector  │
│          │                 │               │       │            │
│          │                 ├───────────────┴───────┴────────────┤
│          │                 │ Output / Problems / Debug          │
└──────────────────────────────────────────────────────────────────┘
Status bar
```

The editor is the primary surface. Graph and inspector are secondary docks and can be hidden. Editor groups can be split right so multiple files remain visible simultaneously.

## Visual rules

- Dark neutral chrome; blue is reserved for selection/primary focus.
- Dense 11–13 px UI typography, larger text only inside dialogs and onboarding.
- Square/low-radius panels; avoid dashboard-card styling.
- Canvas graph uses a spatial grid and muted edges so selected evidence remains dominant.
- Modal settings/project surfaces dim and blur the entire workbench.
- ASM, addresses, hex and technical metadata stay monospace and LTR.

## Interaction rules

- No project means no loose-file mode. The project chooser blocks the workbench.
- Imported files are copied into the current browser-local project.
- Editing marks the project dirty and autosaves to IndexedDB.
- Binary engines load lazily. Opening the application does not fetch or instantiate Capstone.
- Editor arrangement belongs to session/workspace state, not to authoritative project content.
