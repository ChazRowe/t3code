# Sidebar "+ New Session" Item Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tappable "+ New Session" control to the top of the left sidebar so users (especially on phones) can start a new session without a keyboard shortcut.

**Architecture:** A presentational `SidebarNewSessionButton` (split control: full-width primary + small secondary icon) is rendered at the top of `SidebarContent`. The parent `Sidebar` component builds a `ChatThreadActionContext` from the existing `useHandleNewThread()` hook and wires the two clicks to `startNewLocalThreadFromContext` (primary) and `startNewThreadFromContext` (secondary) — the exact functions the global keyboard shortcuts already call in `_chat.tsx`. No new session-creation logic is introduced.

**Tech Stack:** React, TypeScript, Zustand stores, TanStack Router, lucide-react icons, vite-plus (`vp`) test runner with `vitest-browser-react` for browser component tests.

## Global Constraints

- Package: `@t3tools/web` (all paths under `apps/web`).
- Reuse the existing new-session code path (`apps/web/src/lib/chatThreadActions.ts`); do NOT reimplement project resolution or env-mode logic.
- Do NOT change the existing keyboard shortcuts or their handlers in `apps/web/src/routes/_chat.tsx`.
- Primary action = clean/local new session (`startNewLocalThreadFromContext`, mirrors `chat.newLocal`). Secondary action = context-inheriting new session (`startNewThreadFromContext`, mirrors `chat.new`).
- When no project is resolvable, both controls are disabled.
- Match existing sidebar styling: primary mirrors the "Search" `SidebarMenuButton` row; secondary uses `SIDEBAR_ICON_ACTION_BUTTON_CLASS`.
- Browser tests use the `browser` test project; unit tests use `unit`.

---

### Task 1: Presentational `SidebarNewSessionButton` component

A pure, props-driven split-button component, exported from `Sidebar.tsx` (mirrors the existing exported-for-test `SidebarThreadRow` pattern) and verified with a browser component test using spy callbacks.

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx` (add exported component; add `GitBranchPlusIcon` to the existing `lucide-react` import block at lines 1-13)
- Test: `apps/web/src/components/Sidebar.newSession.browser.tsx` (create)

**Interfaces:**

- Produces: `export function SidebarNewSessionButton(props: SidebarNewSessionButtonProps)` where
  ```ts
  interface SidebarNewSessionButtonProps {
    onNewSession: () => void;
    onNewSessionWithContext: () => void;
    disabled: boolean;
    newSessionShortcutLabel: string | null;
    newSessionWithContextShortcutLabel: string | null;
  }
  ```
  Renders a primary button `data-testid="sidebar-new-session"` and a secondary icon button `data-testid="sidebar-new-session-with-context"`.
- Consumes: existing `SidebarMenuButton` (from `./ui/sidebar`), `Kbd` (from `./ui/kbd`), `Tooltip`/`TooltipTrigger`/`TooltipPopup` (from `./ui/tooltip`), `SquarePenIcon` (already imported), and the module-level `SIDEBAR_ICON_ACTION_BUTTON_CLASS` constant (defined at `Sidebar.tsx:225`). All are already in scope within `Sidebar.tsx`.

- [ ] **Step 1: Write the failing browser test**

Create `apps/web/src/components/Sidebar.newSession.browser.tsx`:

```tsx
import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { SidebarNewSessionButton } from "./Sidebar";

afterEach(() => {
  cleanup();
});

function renderButton(overrides?: {
  disabled?: boolean;
  onNewSession?: () => void;
  onNewSessionWithContext?: () => void;
}) {
  const onNewSession = overrides?.onNewSession ?? vi.fn();
  const onNewSessionWithContext = overrides?.onNewSessionWithContext ?? vi.fn();
  render(
    <SidebarNewSessionButton
      onNewSession={onNewSession}
      onNewSessionWithContext={onNewSessionWithContext}
      disabled={overrides?.disabled ?? false}
      newSessionShortcutLabel="⌘⇧N"
      newSessionWithContextShortcutLabel="⌘⇧O"
    />,
  );
  return { onNewSession, onNewSessionWithContext };
}

describe("SidebarNewSessionButton", () => {
  it("invokes the local new-session handler on primary click", async () => {
    const { onNewSession, onNewSessionWithContext } = renderButton();
    await userEvent.click(page.getByTestId("sidebar-new-session"));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onNewSessionWithContext).not.toHaveBeenCalled();
  });

  it("invokes the contextual handler on secondary click", async () => {
    const { onNewSession, onNewSessionWithContext } = renderButton();
    await userEvent.click(page.getByTestId("sidebar-new-session-with-context"));
    expect(onNewSessionWithContext).toHaveBeenCalledTimes(1);
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("renders the primary shortcut label", async () => {
    renderButton();
    await expect.element(page.getByText("⌘⇧N")).toBeInTheDocument();
  });

  it("disables both controls when disabled", async () => {
    const { onNewSession, onNewSessionWithContext } = renderButton({ disabled: true });
    await expect.element(page.getByTestId("sidebar-new-session")).toBeDisabled();
    await expect.element(page.getByTestId("sidebar-new-session-with-context")).toBeDisabled();
    expect(onNewSession).not.toHaveBeenCalled();
    expect(onNewSessionWithContext).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/web`): `pnpm exec vp test run --project browser src/components/Sidebar.newSession.browser.tsx`
Expected: FAIL — `SidebarNewSessionButton` is not exported from `./Sidebar` (import/type error or "is not a function").

- [ ] **Step 3: Add `GitBranchPlusIcon` to the lucide import**

In `apps/web/src/components/Sidebar.tsx`, edit the import block (lines 1-13) to add `GitBranchPlusIcon` in alphabetical position:

```tsx
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  CloudIcon,
  FolderPlusIcon,
  GitBranchPlusIcon,
  Globe2Icon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
```

Note: if `tsgo`/the editor reports `GitBranchPlusIcon` is not exported by the installed `lucide-react`, substitute `GitBranchIcon` (definitely present) and use it in Step 4 instead.

- [ ] **Step 4: Implement the component**

In `apps/web/src/components/Sidebar.tsx`, add the exported component immediately above the `SidebarProjectsContent` definition (it begins at `const SidebarProjectsContent = memo(...)`, ~line 2663). Place it just before that line:

```tsx
interface SidebarNewSessionButtonProps {
  onNewSession: () => void;
  onNewSessionWithContext: () => void;
  disabled: boolean;
  newSessionShortcutLabel: string | null;
  newSessionWithContextShortcutLabel: string | null;
}

export function SidebarNewSessionButton({
  onNewSession,
  onNewSessionWithContext,
  disabled,
  newSessionShortcutLabel,
  newSessionWithContextShortcutLabel,
}: SidebarNewSessionButtonProps) {
  return (
    <div className="flex items-center gap-1">
      <SidebarMenuButton
        size="sm"
        data-testid="sidebar-new-session"
        disabled={disabled}
        className="flex-1 gap-2 px-2 py-1.5 font-medium hover:bg-accent hover:text-foreground focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onNewSession}
      >
        <SquarePenIcon className="size-3.5" />
        <span className="flex-1 truncate text-left text-xs">New Session</span>
        {newSessionShortcutLabel ? (
          <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">{newSessionShortcutLabel}</Kbd>
        ) : null}
      </SidebarMenuButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="New session with current context"
              data-testid="sidebar-new-session-with-context"
              disabled={disabled}
              className={`${SIDEBAR_ICON_ACTION_BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={onNewSessionWithContext}
            />
          }
        >
          <GitBranchPlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">
          {newSessionWithContextShortcutLabel
            ? `New session with current context (${newSessionWithContextShortcutLabel})`
            : "New session with current context"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run (from `apps/web`): `pnpm exec vp test run --project browser src/components/Sidebar.newSession.browser.tsx`
Expected: PASS — all four tests green.

- [ ] **Step 6: Typecheck**

Run (from `apps/web`): `pnpm typecheck`
Expected: no new errors related to `Sidebar.tsx` / `Sidebar.newSession.browser.tsx`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.newSession.browser.tsx
git commit -m "feat(web): add SidebarNewSessionButton presentational component"
```

---

### Task 2: Wire the button into the sidebar

Build the action context in the parent `Sidebar` component, derive the two click handlers and the disabled state, thread them through `SidebarProjectsContent`, and render `SidebarNewSessionButton` at the top of `SidebarContent`.

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`
  - Imports (top of file).
  - `SidebarProjectsContentProps` interface (`~line 2625`) and its destructure (`~line 2666`).
  - `SidebarContent` render — add the button group above the search `SidebarGroup` (`~line 2730`).
  - Parent `Sidebar` component body (`~line 2895+`): hook call (`~line 2910`), new context/handlers/labels, and the `<SidebarProjectsContent .../>` render site (`~line 3529`).

**Interfaces:**

- Consumes: `SidebarNewSessionButton` (Task 1); `useHandleNewThread` from `../hooks/useHandleNewThread`; `startNewLocalThreadFromContext`, `startNewThreadFromContext`, `resolveThreadActionProjectRef`, and type `ChatThreadActionContext` from `../lib/chatThreadActions`; the in-file `resolveSidebarNewThreadEnvMode` (already imported, used at `Sidebar.tsx:1764`) and `shortcutLabelForCommand` (already imported); `defaultThreadEnvMode` (already in scope in the parent component, used at `Sidebar.tsx:1796`).
- Produces: no new exported interface; new props added to the internal `SidebarProjectsContentProps`:

  ```ts
  onNewSession: () => void;
  onNewSessionWithContext: () => void;
  canCreateNewSession: boolean;
  newSessionWithContextShortcutLabel: string | null;
  ```

  (`newSessionShortcutLabel` already exists on the props as `newThreadShortcutLabel` and is reused.)

- [ ] **Step 1: Add imports**

In `apps/web/src/components/Sidebar.tsx`:

Replace the existing new-thread hook import (line 94, currently `import { useNewThreadHandler } from "../hooks/useHandleNewThread";`) with:

```tsx
import { useHandleNewThread, useNewThreadHandler } from "../hooks/useHandleNewThread";
```

(`useNewThreadHandler` is kept because it is still referenced in type positions at `Sidebar.tsx:984` and `:2643`.)

Add a new import for the action helpers (place it near the other `../lib/...` imports):

```tsx
import {
  resolveThreadActionProjectRef,
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
  type ChatThreadActionContext,
} from "../lib/chatThreadActions";
```

- [ ] **Step 2: Switch the parent hook call to `useHandleNewThread`**

In the parent `Sidebar` component, replace line 2910:

```tsx
const { handleNewThread } = useNewThreadHandler();
```

with:

```tsx
const {
  activeThread: newSessionActiveThread,
  activeDraftThread: newSessionActiveDraftThread,
  defaultProjectRef: newSessionDefaultProjectRef,
  handleNewThread,
} = useHandleNewThread();
```

`handleNewThread` is the same `useNewThreadState()` callback as before, so all existing usages are unaffected.

- [ ] **Step 3: Build the action context, handlers, disabled state, and contextual label**

Add the following inside the parent `Sidebar` component, after the existing `newThreadShortcutLabel` computation (`~line 3054-3056`, which uses `keybindings` and `newThreadShortcutLabelOptions`):

```tsx
const newSessionWithContextShortcutLabel = shortcutLabelForCommand(
  keybindings,
  "chat.new",
  newThreadShortcutLabelOptions,
);

const newSessionContext = useMemo<ChatThreadActionContext>(
  () => ({
    activeThread: newSessionActiveThread,
    activeDraftThread: newSessionActiveDraftThread,
    defaultProjectRef: newSessionDefaultProjectRef,
    defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
      defaultEnvMode: defaultThreadEnvMode,
    }),
    handleNewThread,
  }),
  [
    newSessionActiveThread,
    newSessionActiveDraftThread,
    newSessionDefaultProjectRef,
    defaultThreadEnvMode,
    handleNewThread,
  ],
);

const canCreateNewSession = resolveThreadActionProjectRef(newSessionContext) != null;

const handleNewSessionClick = useCallback(() => {
  if (isMobile) {
    setOpenMobile(false);
  }
  void startNewLocalThreadFromContext(newSessionContext);
}, [isMobile, setOpenMobile, newSessionContext]);

const handleNewSessionWithContextClick = useCallback(() => {
  if (isMobile) {
    setOpenMobile(false);
  }
  void startNewThreadFromContext(newSessionContext);
}, [isMobile, setOpenMobile, newSessionContext]);
```

Notes:

- `defaultThreadEnvMode`, `isMobile`, `setOpenMobile`, `keybindings`, and `newThreadShortcutLabelOptions` are already in scope in this component.
- The `ChatThreadActionContext` shape (`activeThread?: ThreadContextLike | undefined`, `activeDraftThread: ... | null`, `defaultProjectRef: ScopedProjectRef | null`) matches exactly what `useHandleNewThread()` returns — this is the same wiring `_chat.tsx` uses, so no casts are needed.

- [ ] **Step 4: Extend `SidebarProjectsContentProps` and its destructure**

In the `SidebarProjectsContentProps` interface (`~line 2625`), add:

```tsx
  onNewSession: () => void;
  onNewSessionWithContext: () => void;
  canCreateNewSession: boolean;
  newSessionWithContextShortcutLabel: string | null;
```

In the `SidebarProjectsContent` destructure (`~line 2666-2702`), add the matching names:

```tsx
    onNewSession,
    onNewSessionWithContext,
    canCreateNewSession,
    newSessionWithContextShortcutLabel,
```

(`newThreadShortcutLabel` is already destructured and will be passed as the primary label.)

- [ ] **Step 5: Render the button at the top of `SidebarContent`**

In `SidebarProjectsContent`'s return, insert a new `SidebarGroup` as the FIRST child of `<SidebarContent className="gap-0">` (immediately before the search `SidebarGroup` at `~line 2731`):

```tsx
<SidebarGroup className="px-2 pt-2 pb-1">
  <SidebarMenu>
    <SidebarMenuItem>
      <SidebarNewSessionButton
        onNewSession={onNewSession}
        onNewSessionWithContext={onNewSessionWithContext}
        disabled={!canCreateNewSession}
        newSessionShortcutLabel={newThreadShortcutLabel}
        newSessionWithContextShortcutLabel={newSessionWithContextShortcutLabel}
      />
    </SidebarMenuItem>
  </SidebarMenu>
</SidebarGroup>
```

- [ ] **Step 6: Pass the new props at the `SidebarProjectsContent` render site**

At the `<SidebarProjectsContent .../>` render (`~line 3529`), add:

```tsx
onNewSession = { handleNewSessionClick };
onNewSessionWithContext = { handleNewSessionWithContextClick };
canCreateNewSession = { canCreateNewSession };
newSessionWithContextShortcutLabel = { newSessionWithContextShortcutLabel };
```

(The existing `newThreadShortcutLabel={...}` prop already supplies the primary label.)

- [ ] **Step 7: Typecheck**

Run (from `apps/web`): `pnpm typecheck`
Expected: PASS with no new errors.

- [ ] **Step 8: Run the affected tests**

Run (from `apps/web`):

- `pnpm exec vp test run --project browser src/components/Sidebar.newSession.browser.tsx`
- `pnpm exec vp test run --project unit src/components/Sidebar.logic.test.ts`

Expected: PASS — the presentational test still passes and existing sidebar logic tests are unaffected.

- [ ] **Step 9: Manual verification (use the `run` skill)**

Launch the web app, open the sidebar, and confirm:

- A full-width "New Session" button appears at the top of the sidebar with a small branch icon to its right.
- Clicking "New Session" opens a fresh draft in the active/first project (resets to default env mode).
- Clicking the branch icon opens a new draft inheriting the current thread's branch/worktree/env when a thread is active.
- With no projects, both controls are disabled.
- On a narrow/mobile viewport, the sidebar closes after a click.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): add '+ New Session' control to the sidebar"
```

---

## Self-Review

- **Spec coverage:**
  - Placement (top, full-width) → Task 2 Step 5. ✓
  - Both behaviors (primary local / secondary contextual) → Task 1 component + Task 2 Step 3 handlers. ✓
  - Reuse existing code path → Task 2 uses `startNewLocalThreadFromContext` / `startNewThreadFromContext` (no new logic). ✓
  - Disabled when no project → `canCreateNewSession` via `resolveThreadActionProjectRef` (Task 2 Step 3), consumed as `disabled` (Step 5). ✓
  - Shortcut tooltips/labels → primary reuses `newThreadShortcutLabel`; secondary adds `chat.new` label (Task 2 Step 3). ✓
  - Styling match → primary mirrors Search row; secondary uses `SIDEBAR_ICON_ACTION_BUTTON_CLASS` (Task 1 Step 4). ✓
  - Testing → browser component test (Task 1). ✓
- **Placeholder scan:** none — all steps contain concrete code/commands.
- **Type consistency:** `SidebarNewSessionButtonProps` field names match between Task 1 (definition) and Task 2 Step 5 (usage). `ChatThreadActionContext` fields match `chatThreadActions.ts:29-35`. New `SidebarProjectsContentProps` fields (Step 4) match the render-site props (Step 6) and the component usage (Step 5). `handleNewThread` type unchanged (same `useNewThreadState` callback).
- **Risk note:** `GitBranchPlusIcon` export is verified against `lucide-react` in Task 1 Step 3, with `GitBranchIcon` as a documented fallback.
