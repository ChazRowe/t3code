# Subagent Session Tree — Design

**Date:** 2026-06-20
**Status:** Approved (brainstorming) — pending implementation plan
**Related:** [Unattended Runs](./2026-06-18-unattended-runs-design.md), [Unattended Run Context-Clear Visibility](./2026-06-19-unattended-run-context-clear-visibility-design.md)

## Summary

Make subagents first-class, watchable **sessions** in the left sidebar: each subagent appears as a node nested under its parent session, using the same collapsible-chevron convention used between projects and sessions, nesting arbitrarily deep. Selecting a subagent node opens a **read-only**, real-time view of that subagent's transcript — no composer, because the Claude Code provider cannot interrupt or message a running subagent.

The feature is built on top of a **performance fix** that is the real motivation: today subagent transcripts are stored inline in the parent thread's activity log and re-shipped in full on every `subscribeThread` snapshot, which makes long (especially unattended) sessions slow to refresh. We decouple subagent transcripts from the parent thread's snapshot so the parent stays small, and the subagent refs that remain become the tree nodes.

## Goals

1. **Shrink the parent thread snapshot** by excluding subagent transcripts from it; load them on demand. (Primary — fixes slow refresh on long/unattended sessions.)
2. **Sidebar subagent tree** — subagents nested under their parent session with chevron expand/collapse, arbitrarily deep. For unattended runs, subagents are grouped under an **iteration** node (`Session → Iteration N → Subagent(s)`). For manual sessions, subagents nest directly under the session.
3. **Read-only real-time watch view** — select a subagent node to watch its transcript live (while running) or review it (after completion). No composer.
4. **Persistent + iteration-grouped** — subagent transcripts persist (cheap now that they are off the parent's hot path) so unattended runs can be audited after the fact.

## Non-goals

- Interrupting or sending messages to a subagent (no provider support; the view is read-only).
- Promoting subagents to independently-controllable orchestration threads (durable child `ThreadId`s). Explicitly rejected — heavy, and unnecessary for a read-only view.
- A retention/pruning policy implementation. The schema and code are designed to allow pruning later (ephemeral-per-iteration), but persistence is the default and pruning is out of scope for this work.
- Provider work beyond Claude. The design is provider-neutral (keys off `collab_agent_tool_call` + `parentItemId`); Claude is the only current producer.

## Background — current architecture

- **Subagent detection/flow:** `apps/server/src/provider/Layers/ClaudeAdapter.ts` detects subagent SDK messages via `parent_tool_use_id` and emits nested item-lifecycle events tagged with `parentItemId`. `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (`runtimeEventToActivities`, ~lines 265–664; dispatch ~1698–1711) converts these into `thread.activity.append` commands on the **parent** thread. The root `Task` tool call is itself a top-level activity (`itemType: "collab_agent_tool_call"`, `parentItemId` absent); its children carry `parentItemId = <root itemId>`.
- **Storage:** `projection_thread_activities` (SQL) stores every activity for a thread, full payload in `payload_json`. No column distinguishes subagent children. The in-memory projector caps activities at 500 (`apps/server/src/orchestration/projector.ts:681–686`); SQL is uncapped.
- **Snapshot:** `orchestration.subscribeThread` (`apps/server/src/ws.ts:957–1015`) sends a full `OrchestrationThreadDetailSnapshot` assembled by `ProjectionSnapshotQuery.getThreadDetailById` (`...:1905–2043`), which fetches **all** activity rows (`listThreadActivityRowsByThread`, no limit) on every subscribe/reconnect. Subagent text dominates this payload on subagent-heavy threads → slow refresh.
- **Unattended runs:** `UnattendedRunState` lives on the thread (`packages/contracts/src/orchestration.ts:129–156`) with `currentIteration` / `totalIterations` / `status`. Iterations are delimited by `unattended.context-cleared` / `unattended.context-fresh` activity markers; `currentIteration` is the source of truth for the running iteration. Reactor: `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`. Iterations are **not** currently stamped onto turns/activities — they're inferred chronologically between markers.
- **Sidebar:** `apps/web/src/components/Sidebar.tsx` renders Projects → flat Threads. Project expand/collapse uses `ChevronRightIcon` (`rotate-90`) with state in `useUiStateStore.projectExpandedById`. Thread rows navigate via TanStack Router to `_chat.$environmentId.$threadId`.
- **Inline subagent card:** `apps/web/src/components/chat/MessagesTimeline.tsx` (`SubagentCard`, ~750–821) currently renders the live subagent transcript inline from the parent thread's activities (children matched by `parentItemId`).

## Core design

### The unifying rule

> **A subagent's transcript = activities with `parentItemId` set. Exclude them from the parent thread's snapshot and projector. Keep the root `collab_agent_tool_call` ref. Load/stream a subagent's direct children on demand when watched.**

The root `collab_agent_tool_call` activity already _is_ a compact reference (label = subagent type + description, status, `turnId`). It stays in the parent. Its children (the transcript) move off the parent's hot path. Deep nesting is recursive: a subagent's children may themselves include further `collab_agent_tool_call` refs; watching a subagent loads one level of its children, and drilling into a nested ref loads the next. **Each level loads exactly one level of children, so payloads stay bounded at every depth.**

### Three-tier lazy loading (keeps every layer small)

1. **Summary hint (all sessions):** the sidebar thread summary carries only a minimal hint — `hasSubagents: boolean` and `liveSubagentCount: number` (currently-running first-level subagents) — enough to render the chevron and a "● N running" badge without loading anything. This avoids re-bloating the summary feed with the full historical tree.
2. **Tree structure (on expand):** expanding a session in the sidebar lazily subscribes to that thread's **subagent ref tree** — compact refs only (ids, labels, status, `parentItemId`, `iteration`, `depth`, child counts), **no transcripts** — and receives live status updates while expanded.
3. **Transcript (on watch):** selecting a subagent node loads/streams **that subagent's direct child activities** (the transcript), live while running and on demand after completion.

### Lifecycle & retention

- Subagent transcripts **persist** in storage (off the parent's hot path, so persistence no longer costs refresh speed). The full `Session → Iteration → Subagent` history remains auditable after an unattended run.
- The tree node for a subagent shows status derived from its root ref (`inProgress` / `completed` / `error`).
- **Watching across completion:** if a subagent completes while you're watching it, the watch view keeps the final transcript visible (frozen, read-only) with a small "Subagent finished" banner and a link back to the parent. The route stays valid because the data is persisted.
- **Iteration grouping** applies only to threads with an unattended run. Each subagent ref is stamped with the `iteration` active at creation time (read from the thread's `UnattendedRunState.currentIteration` at ingestion; `null` for manual threads). Manual-thread subagents nest directly under the session.
- Retention/pruning (ephemeral-per-iteration) is intentionally _enabled by the schema_ but not implemented here.

### Read-only watch view

- No composer. The subagent view renders the subagent's transcript using the **existing** timeline derivation (`deriveWorkLogEntries` / `deriveTimelineEntries` in `apps/web/src/session-logic.ts`) reused against the subagent's child activities.
- The composer area is simply absent (per product decision), not a disabled placeholder.

### Inline card change

- Because the parent snapshot no longer holds subagent transcripts, the inline `SubagentCard` becomes a **compact ref chip** (label + status + child counts + "open ↗"). It can lazily stream the live subagent (same subscribe path as the watch view) when expanded, and the "open ↗" affordance navigates to the full watch route. Same information; no duplication in the parent's persisted snapshot.

## Architecture & components

### 1. Contracts (`packages/contracts/src/orchestration.ts`)

- **`OrchestrationSubagentRef`** (new) — a compact tree node:
  `{ threadId, rootItemId, parentItemId: nullable, label, subagentType, description: nullable, status: RuntimeItemStatus, iteration: nullable PositiveInt, turnId: nullable, depth: NonNegativeInt, childSubagentCount: NonNegativeInt, createdAt, updatedAt }`.
- **`OrchestrationSubagentTreeStreamItem`** (new) — union of `{ kind: "snapshot", refs: OrchestrationSubagentRef[] }` and `{ kind: "ref-changed", ref }` / `{ kind: "ref-removed", rootItemId }` for live status while a session is expanded.
- **`OrchestrationSubagentActivitiesStreamItem`** (new) — union of `{ kind: "snapshot", activities: OrchestrationThreadActivity[] }` and `{ kind: "event", event }` (reusing `thread.activity-appended` shape filtered to the subtree) for the watch view.
- **Summary hint:** add `hasSubagents: boolean` and `liveSubagentCount: NonNegativeInt` to the sidebar thread summary type.
- **New WS methods** in `ORCHESTRATION_WS_METHODS`:
  - `subscribeSubagentTree: "orchestration.subscribeSubagentTree"` — input `{ threadId }`, streams `OrchestrationSubagentTreeStreamItem`.
  - `subscribeSubagent: "orchestration.subscribeSubagent"` — input `{ threadId, rootItemId }`, streams `OrchestrationSubagentActivitiesStreamItem`. The snapshot is the subagent's **direct child** activities (`parent_item_id = rootItemId`, one level — symmetric with how a top-level session shows its messages plus one level of subagent refs). Nested sub-subagents appear as further refs to drill into, not as expanded transcript.

### 2. Persistence (schema-additive, no data table split)

- Add columns to `projection_thread_activities`: `parent_item_id TEXT NULL`, `subagent_root_item_id TEXT NULL`, `iteration INTEGER NULL`. `parent_item_id` is the immediate parent (drives the one-level watch query). `subagent_root_item_id` is the **first-level** subagent that ultimately roots this activity's subtree (for whole-subtree operations: counts, future pruning); for direct children of a first-level subagent it equals `parent_item_id`.
- Indexes: `(thread_id, parent_item_id, created_at)` for the watch view's direct-children fetch; `(thread_id, subagent_root_item_id)` for whole-subtree operations; keep the existing `(thread_id, created_at)`.
- **Migration/backfill:** new migration adds columns + indexes and backfills `parent_item_id` / `subagent_root_item_id` / `iteration` from existing `payload_json` for historical rows so old threads also slim down. Files: `apps/server/src/persistence` migrations + `ProjectionThreadActivities` service/layer.

### 3. Server

- **Ingestion** (`ProviderRuntimeIngestion.ts`): stamp `parentItemId`, `subagentRootItemId`, and `iteration` (from `UnattendedRunState.currentIteration`) onto subagent-child activities as they're appended. Maintain/expose first-level subagent refs.
- **Projector** (`projector.ts`): keep subagent-child activities **out** of the parent thread's in-memory `activities` list (so the 500-cap holds real messages, not subagent noise). Maintain a compact subagent-ref index + `liveSubagentCount` per thread.
- **Snapshot** (`ProjectionSnapshotQuery.getThreadDetailById`): filter the parent activity query to `parent_item_id IS NULL` so subagent transcripts are excluded from `subscribeThread`. Root `collab_agent_tool_call` refs remain.
- **New endpoints** (`ws.ts`): implement `subscribeSubagentTree` (compact refs + live status, from the ref index) and `subscribeSubagent` (direct-children snapshot via the `parent_item_id = rootItemId` query + live `thread.activity-appended` filtered to those direct children). Both follow the existing `observeRpcStreamEffect` / `streamDomainEvents` pattern used by `subscribeThread`.
- **Summary feed:** include `hasSubagents` / `liveSubagentCount` on the thread summary projection.

### 4. Web

- **Routing:** add file-based route `_chat.$environmentId.$threadId.subagent.$subagentRootItemId.tsx`. A single leaf `rootItemId` uniquely identifies a subagent at any depth (item ids are unique; the ancestor chain is reconstructable from refs).
- **Sidebar** (`Sidebar.tsx`):
  - Session rows with `hasSubagents` get a chevron (reuse the project chevron pattern). Expand/collapse state keyed by `threadId` (and `rootItemId` for deeper nodes) in `useUiStateStore`, mirroring `projectExpandedById`.
  - Expanding a session subscribes to `subscribeSubagentTree`; render iteration group nodes (unattended) → subagent rows, or subagent rows directly (manual). Each subagent row is itself expandable (chevron) when it has child subagents — recursion handles arbitrary depth uniformly.
  - Row shows label (subagent type) + status dot; selecting navigates to the subagent route.
- **Watch view:** a read-only variant of the chat view (extract the timeline-rendering portion of `ChatView` / `MessagesTimeline` into a shared read-only component) that subscribes to `subscribeSubagent`, renders the subtree via the existing timeline derivation, omits the composer, and shows the "finished" banner on completion.
- **Store/selectors:** add subagent-tree and subagent-activity slices/selectors mirroring the thread-detail subscription lifecycle (ref-counted retain, like `retainThreadDetailSubscription` in `apps/web/src/environments/runtime/service.ts`).
- **Inline card** (`MessagesTimeline.tsx`): replace the transcript-bearing `SubagentCard` with the compact ref chip that lazily subscribes to `subscribeSubagent` when expanded and links to the watch route.

## Data flow

1. **Parent subscribe** → snapshot now excludes subagent transcripts; includes root refs + `hasSubagents`/`liveSubagentCount` hints via summary.
2. **Expand session in sidebar** → `subscribeSubagentTree({ threadId })` → compact ref tree + live status. Rendered as iteration/subagent nodes.
3. **Select subagent** → navigate to subagent route → `subscribeSubagent({ threadId, rootItemId })` → direct-children snapshot + live events → read-only timeline (nested sub-subagents appear as further refs to drill into).
4. **Subagent completes** → ref status flips to `completed` (tree updates live); if currently watched, banner + frozen transcript; node remains (persistent).

## Edge cases & error handling

- **Watch then completes:** keep frozen transcript + banner; route stays valid (persisted).
- **Reconnect / server restart mid-run:** snapshots rebuild from SQL; a subagent whose run was aborted by restart shows `error`/terminal status; tree reflects it. Parent snapshot is now cheap to rebuild.
- **Legacy threads (pre-migration):** backfill populates the new columns; if a row can't be classified, it defaults to `parent_item_id IS NULL` (included in parent snapshot) — i.e., current behavior, never data loss.
- **Deep nesting:** uniform chevron recursion; no special-casing per depth. (Claude produces depth 1 today; design supports more.)
- **Manual vs unattended:** `iteration` null → no iteration group node; subagents nest directly under the session.
- **Many subagents in one iteration:** tree rows are compact refs; transcripts load only on watch. Sidebar may collapse iteration groups by default if a session has many.

## Performance considerations

- Parent `subscribeThread` snapshot drops the dominant subagent-text payload → large refresh speedup on long/unattended sessions (the primary goal).
- In-memory projector 500-cap no longer consumed by subagent noise → real messages retained.
- Tree loads refs-only on expand; transcripts load one level at a time on watch — bounded payloads at every layer.
- Summary feed gains only two scalar fields — negligible.

## Testing strategy

- **Contracts:** schema round-trip for new types; `ORCHESTRATION_WS_METHODS` additions.
- **Server unit:** ingestion stamps `parentItemId`/`subagentRootItemId`/`iteration` correctly (incl. nested); projector excludes subagent children from parent activities and maintains ref index + `liveSubagentCount`; snapshot query excludes `parent_item_id IS NOT NULL`.
- **Server integration:** `subscribeSubagentTree` and `subscribeSubagent` return correct snapshots + live deltas; multi-client; reconnect rebuilds correctly.
- **Migration:** backfill classifies historical rows; old threads slim down; no row lost.
- **Web unit:** sidebar tree derivation (iteration grouping, direct nesting, recursion, chevron state); read-only timeline derivation reuse; ref-chip lazy subscribe.
- **Web integration/e2e:** expand session → see running subagents; select subagent → live transcript, no composer; completion → frozen + banner; arbitrary-depth nesting renders.
- **Regression:** existing `session-logic.test.ts` subagent-nesting expectations updated to the new ref/transcript split.

## File-change map (indicative)

- `packages/contracts/src/orchestration.ts` — new schemas, WS methods, summary hint fields.
- `apps/server/src/persistence/**` — migration (columns + indexes + backfill), `ProjectionThreadActivities` service/layer.
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — stamping + ref maintenance.
- `apps/server/src/orchestration/projector.ts` — exclude subagent children; ref index; `liveSubagentCount`.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — snapshot filter.
- `apps/server/src/ws.ts` — `subscribeSubagentTree`, `subscribeSubagent`; summary hint wiring.
- `apps/web/src/routes/_chat.$environmentId.$threadId.subagent.$subagentRootItemId.tsx` — watch route.
- `apps/web/src/components/Sidebar.tsx` (+ `Sidebar.logic.ts`) — tree, chevrons, iteration grouping.
- `apps/web/src/components/chat/MessagesTimeline.tsx` — ref chip; extract shared read-only timeline.
- `apps/web/src/environments/runtime/service.ts` + store — subagent subscription lifecycles/selectors.
- `apps/web/src/session-logic.ts` (+ tests) — reuse derivation for subagent subtree.

## Open questions / future

- Retention/pruning knob (ephemeral-per-iteration) — schema-ready, deferred.
- Surfacing subagent refs for _non-open_ running sessions beyond the `liveSubagentCount` badge (full tree currently loads on expand only) — acceptable for v1.
- Codex / other providers emitting `collab_agent_tool_call` would light up automatically; untested until such a producer exists.
