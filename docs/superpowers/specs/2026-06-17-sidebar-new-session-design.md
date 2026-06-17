# Sidebar "+ New Session" item — Design

**Date:** 2026-06-17
**Status:** Approved (design)

## Problem

Creating a new session currently requires a keyboard shortcut (`chat.newLocal` =
`Ctrl/Cmd+Shift+N`, `chat.new` = `Ctrl/Cmd+Shift+O`). Key combinations are
awkward on a phone / touch device, so there is no easy touch affordance to start
a new session. We want a visible, tappable "+ New Session" control in the left
sidebar.

## Goals

- A prominent, always-visible "+ New Session" control in the left sidebar.
- Touch-friendly (large primary tap target).
- Reuse the existing new-session code path so behavior matches the keyboard
  shortcuts exactly — no new session-creation logic.

## Non-goals

- No change to how sessions are actually created, to project resolution, or to
  env-mode defaults.
- No change to the existing keyboard shortcuts.
- No new settings or configuration.

## Design

### Placement

A full-width button row at the very top of `SidebarContent` in
`apps/web/src/components/Sidebar.tsx`, just above the existing search /
command-palette `SidebarGroup` (around line 2730). Always visible at the top of
the sidebar.

### Control: split button (both shortcuts)

A single row containing:

- **Primary** — full-width button labeled `+ New Session`. On click/tap, runs
  the clean fresh-start path, mirroring `chat.newLocal`.
- **Secondary** — a small icon button on the right edge of the row (a
  branch/context glyph). On click/tap, runs the context-inheriting path,
  mirroring `chat.new` (inherits `branch` / `worktreePath` / `envMode` from the
  active thread when present).

Both controls expose a tooltip showing their resolved keyboard-shortcut label
(via `shortcutLabelForCommand(keybindings, "chat.newLocal" | "chat.new", ...)`),
consistent with how the sidebar already surfaces shortcut hints.

### Wiring (reuse, not reimplement)

The global keyboard handler `ChatRouteGlobalShortcuts` in
`apps/web/src/routes/_chat.tsx` builds a `ChatThreadActionContext` and calls
`startNewLocalThreadFromContext` / `startNewThreadFromContext` from
`apps/web/src/lib/chatThreadActions.ts`. The sidebar control does the same:

1. Get `{ activeDraftThread, activeThread, defaultProjectRef, handleNewThread }`
   from the existing `useHandleNewThread()` hook.
2. Build `defaultThreadEnvMode` via
   `resolveSidebarNewThreadEnvMode({ defaultEnvMode: appSettings.defaultThreadEnvMode })`
   (`appSettings` from `useSettings()`).
3. Primary → `startNewLocalThreadFromContext(context)`.
4. Secondary → `startNewThreadFromContext(context)`.

Project resolution is therefore identical to the shortcuts: active thread →
active draft thread → first project (`defaultProjectRef`).

### Edge cases

- **No projects / no resolvable project** (`defaultProjectRef === null` and no
  active thread/draft): both action functions no-op and return `false`. In this
  state the control is **disabled** (both primary and secondary), so the user
  is never shown a button that silently does nothing.

### Styling

- Primary button: match existing prominent sidebar button styling, full-width.
- Secondary icon button: `SIDEBAR_ICON_ACTION_BUTTON_CLASS`, matching other
  sidebar icon actions.
- Tooltips via the existing `Tooltip` / `TooltipTrigger` / `TooltipPopup`
  components already used in the sidebar.

## Testing

- Unit/component test for the sidebar control:
  - Primary click invokes the local/default new-session path.
  - Secondary icon click invokes the contextual new-session path.
  - Control is disabled when no project is resolvable.
- Lean on existing `chatThreadActions` coverage for the underlying behavior;
  the new tests verify the sidebar correctly triggers those functions.

## Files touched

- `apps/web/src/components/Sidebar.tsx` — add the control + wiring.
- (Possibly a small extracted component, e.g. `SidebarNewSessionButton`, to keep
  `Sidebar.tsx` focused — decided during planning.)
- New test file for the control.
