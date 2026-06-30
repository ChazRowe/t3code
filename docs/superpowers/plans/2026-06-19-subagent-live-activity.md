# Subagent Live Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a Task/subagent's inner activity (its text, thinking, tool calls, and tool results) live in the T3code work log, nested under the "Subagent task" row, instead of showing an opaque spinner until the subagent returns.

**Architecture:** The Claude Agent SDK gates subagent inner content behind the `forwardSubagentText` query option (default `false`); when off it writes the subagent conversation to a side-channel (`<session>/subagents/*.jsonl`) that never enters the main `query()` stream T3code consumes. We (1) enable that option behind a server-config flag, (2) add an optional `parentItemId` linkage to the runtime item contract, (3) route the forwarded `assistant`/`user` messages (which now carry a non-null `parent_tool_use_id`) through a dedicated adapter handler that emits nested work-log items **without** mutating main-thread turn/token/text state, (4) carry `parentItemId` through the projection, and (5) render nested rows in the web work log. A per-parent volume cap bounds the firehose.

**Tech Stack:** TypeScript, Effect (Schema, Layer, Effect.gen), `@anthropic-ai/claude-agent-sdk@0.3.170`, React (apps/web), node:test / vitest-style `it.effect` harness tests.

## Global Constraints

- SDK is `@anthropic-ai/claude-agent-sdk@0.3.170`; the `Options` type (imported as `ClaudeQueryOptions`) already declares `forwardSubagentText?: boolean`. Do not bump the SDK.
- The forwarded subagent content arrives as **complete `assistant` / `user` SDK messages with `parent_tool_use_id` set to the parent Task tool-use id** — NOT as `stream_event` partial deltas. Rendering is therefore step-by-step (per message), not token-by-token. Do not promise token streaming.
- `parent_tool_use_id` currently appears in three places in `apps/server/src/provider/Layers/ClaudeAdapter.ts`: the noise-key set (`SDK_MESSAGE_NOISE_KEYS`, ~line 1296), the `message_delta` token gate (~line 2102), and a hardcoded `null` (~line 938). Only the routing behavior changes; the token gate at 2102 MUST keep ignoring subagent `message_delta` (subagent token usage stays off the main-thread gauge — see commit `11739cd7`).
- Default the feature **OFF**. It is opt-in via env `T3CODE_FORWARD_SUBAGENT_ACTIVITY=1`. Unattended runs must not forward (they have no live viewer and the volume is large — fugue runs produced ~7,000 subagent lines).
- Effect Schema idiom: optional fields use `Schema.optional(...)`; emit fields conditionally with `...(x ? { key: x } : {})` to match the existing codebase style.
- Run server tests with `pnpm --filter @t3tools/server test` (or the repo's `vp run --filter t3 test` equivalent the implementer confirms); web tests with `pnpm --filter @t3tools/web test`; typecheck with the repo's `pnpm typecheck`. Confirm the exact script names from `package.json` before first run.
- Frequent commits: one per task. TDD: failing test first, minimal implementation, green, commit.

---

### Task 1: Server-config flag + enable `forwardSubagentText`

Gate the SDK option behind an env-derived `ServerConfig` boolean and pass it into `queryOptions`. Deliverable: with the flag set, `query()` receives `forwardSubagentText: true`; with it unset, the option is absent.

**Files:**

- Modify: `apps/server/src/config.ts` (add `forwardSubagentActivity: boolean` to the `ServerConfig` interface ~lines 29-74, and to wherever the config object is constructed from env)
- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts:3449-3474` (queryOptions assembly; `const serverConfig = yield* ServerConfig` already exists at ~line 1367)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

**Interfaces:**

- Consumes: `ServerConfig` service (already injected in the adapter as `serverConfig`).
- Produces: `ServerConfig.forwardSubagentActivity: boolean`, derived from `process.env.T3CODE_FORWARD_SUBAGENT_ACTIVITY === "1"`, default `false`.

- [ ] **Step 1: Find how existing boolean flags are parsed from env**

Read `apps/server/src/config.ts` and locate where a sibling boolean such as `logWebSocketEvents` or `traceTimingEnabled` is read from the environment and assigned. Mirror that exact pattern (same helper, same casing convention).

- [ ] **Step 2: Write the failing adapter test**

Add to `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`, mirroring the existing harness setup used by other `it.effect` tests in this file (which provide a test `ServerConfig` layer and capture the options passed to `query`):

```typescript
it.effect("passes forwardSubagentText to query when the flag is enabled", () =>
  Effect.gen(function* () {
    const harness = yield* makeAdapterHarness({ forwardSubagentActivity: true });
    yield* harness.startTurn({ prompt: "hi" });
    assert.equal(harness.lastQueryOptions?.forwardSubagentText, true);
  }),
);

it.effect("omits forwardSubagentText when the flag is disabled", () =>
  Effect.gen(function* () {
    const harness = yield* makeAdapterHarness({ forwardSubagentActivity: false });
    yield* harness.startTurn({ prompt: "hi" });
    assert.equal(harness.lastQueryOptions?.forwardSubagentText, undefined);
  }),
);
```

If the existing harness in this file does not already expose `lastQueryOptions` / a `forwardSubagentActivity` override, extend the harness helper in the test file to capture the object passed to the mocked `query()` and to thread the `ServerConfig` override — match the pattern already used to assert on `includePartialMessages`/`permissionMode` if present; otherwise add a minimal capture.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter`
Expected: FAIL — `forwardSubagentText` is `undefined` (flag not wired) / `forwardSubagentActivity` not a known config field.

- [ ] **Step 4: Add the config field**

In `apps/server/src/config.ts`, add to the `ServerConfig` interface (near the other boolean flags ~line 73):

```typescript
  readonly forwardSubagentActivity: boolean;
```

And where the config object is constructed from env, add (mirroring the sibling-flag pattern found in Step 1):

```typescript
  forwardSubagentActivity: process.env.T3CODE_FORWARD_SUBAGENT_ACTIVITY === "1",
```

- [ ] **Step 5: Wire it into queryOptions**

In `apps/server/src/provider/Layers/ClaudeAdapter.ts`, in the `queryOptions` object (right after `includePartialMessages: true,` at ~line 3469):

```typescript
        includePartialMessages: true,
        ...(serverConfig.forwardSubagentActivity ? { forwardSubagentText: true } : {}),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter`
Expected: PASS (both new tests).

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. (If `layerTest`/config fixtures elsewhere construct `ServerConfig` literally, add `forwardSubagentActivity: false` to them.)

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
git commit -m "feat(provider): gate forwardSubagentText behind T3CODE_FORWARD_SUBAGENT_ACTIVITY"
```

---

### Task 2: Add `parentItemId` to the runtime item contract

Give runtime item-lifecycle events an optional parent linkage so a subagent's inner items can reference the Task tool-use that spawned them.

**Files:**

- Modify: `packages/contracts/src/providerRuntime.ts:404-411` (`ItemLifecyclePayload`)
- Test: `packages/contracts/src/providerRuntime.test.ts` (create if absent; otherwise add to the existing contract test file)

**Interfaces:**

- Consumes: `RuntimeItemId` (already defined/exported in `providerRuntime.ts`; it is the branded type produced by `asRuntimeItemId`).
- Produces: `ItemLifecyclePayload.parentItemId?: RuntimeItemId` — set on every nested subagent item; absent on main-thread items.

- [ ] **Step 1: Write the failing round-trip test**

In `packages/contracts/src/providerRuntime.test.ts`:

```typescript
import * as Schema from "effect/Schema";
import { ItemLifecyclePayload } from "./providerRuntime.ts";
import assert from "node:assert/strict";
import { it } from "node:test";

it("ItemLifecyclePayload carries an optional parentItemId", () => {
  const decoded = Schema.decodeUnknownSync(ItemLifecyclePayload)({
    itemType: "command_execution",
    status: "inProgress",
    title: "Command run",
    parentItemId: "tool-parent-123",
  });
  assert.equal(decoded.parentItemId, "tool-parent-123");

  const withoutParent = Schema.decodeUnknownSync(ItemLifecyclePayload)({
    itemType: "command_execution",
  });
  assert.equal(withoutParent.parentItemId, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t3tools/contracts test providerRuntime`
Expected: FAIL — `parentItemId` stripped by schema (excess property) or assertion mismatch.

- [ ] **Step 3: Add the field**

In `packages/contracts/src/providerRuntime.ts`, extend `ItemLifecyclePayload` (lines 404-411):

```typescript
export const ItemLifecyclePayload = Schema.Struct({
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
  parentItemId: Schema.optional(RuntimeItemId),
});
export type ItemLifecyclePayload = typeof ItemLifecyclePayload.Type;
```

Confirm `RuntimeItemId` is in scope in this file (it is referenced by `ProviderRuntimeEventBase.itemId`); if it is defined lower in the file, no change is needed since these are `const` schema values evaluated at module load in declaration order — if a load-order error appears, move the `RuntimeItemId` definition above `ItemLifecyclePayload`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @t3tools/contracts test providerRuntime`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` (Expected: no errors)

```bash
git add packages/contracts/src/providerRuntime.ts packages/contracts/src/providerRuntime.test.ts
git commit -m "feat(contracts): add optional parentItemId to ItemLifecyclePayload"
```

---

### Task 3: Route forwarded subagent messages into nested work-log items

When `forwardSubagentText` is on, the SDK delivers subagent `assistant`/`user` messages with non-null `parent_tool_use_id`. Add a dedicated handler that emits nested `item.started`/`item.completed` events for the subagent's tool calls, results, and text — each tagged with `parentItemId` — while leaving main-thread turn state, token usage, and assistant text blocks untouched.

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` — the dispatch switch (~lines 2876-2889), `handleAssistantMessage` (2480-2566), `handleUserMessage` (2358-2478)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

**Interfaces:**

- Consumes: `offerRuntimeEvent`, `makeEventStamp`, `asRuntimeItemId`, `classifyToolItemType`, `titleForTool`, `summarizeToolRequest`, `nativeProviderRefs`, `context.turnState` (all already defined in this file). `ItemLifecyclePayload.parentItemId` from Task 2.
- Produces: a new local handler `handleSubagentMessage(context, message)` invoked from the dispatch switch for any `assistant`/`user` message whose `parent_tool_use_id` is non-null.

- [ ] **Step 1: Write the failing test — subagent tool_use becomes a nested item**

In `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`, following the existing emit/collect harness (see the `parent_tool_use_id: null` stream-event tests around lines 743-820 for the harness shape):

```typescript
it.effect("emits nested work-log items for forwarded subagent tool calls", () =>
  Effect.gen(function* () {
    const harness = yield* makeAdapterHarness({ forwardSubagentActivity: true });
    yield* harness.startTurn({ prompt: "go" });

    // Parent Task tool call (main loop) — registers itemId "task-parent".
    harness.query.emit({
      type: "stream_event",
      session_id: "s",
      uuid: "p0",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "task-parent",
          name: "Agent",
          input: { subagent_type: "general-purpose", description: "do work" },
        },
      },
    } as unknown as SDKMessage);

    // Forwarded subagent assistant message carrying an inner tool_use.
    harness.query.emit({
      type: "assistant",
      session_id: "s",
      uuid: "sa1",
      parent_tool_use_id: "task-parent",
      message: {
        id: "msg-sa1",
        role: "assistant",
        content: [{ type: "tool_use", id: "inner-bash-1", name: "Bash", input: { command: "ls" } }],
      },
    } as unknown as SDKMessage);

    const started = harness.events.filter(
      (e) => e.type === "item.started" && e.itemId === "inner-bash-1",
    );
    assert.equal(started.length, 1);
    assert.equal(started[0]?.payload.itemType, "command_execution");
    assert.equal(started[0]?.payload.parentItemId, "task-parent");
  }),
);
```

- [ ] **Step 2: Write the failing test — main-thread state is NOT polluted**

```typescript
it.effect("does not push subagent messages into the main turn or token gauge", () =>
  Effect.gen(function* () {
    const harness = yield* makeAdapterHarness({ forwardSubagentActivity: true });
    yield* harness.startTurn({ prompt: "go" });

    const turnItemsBefore = harness.currentTurnItemCount();
    const usageEventsBefore = harness.events.filter(
      (e) => e.type === "thread.token-usage.updated",
    ).length;

    harness.query.emit({
      type: "assistant",
      session_id: "s",
      uuid: "sa2",
      parent_tool_use_id: "task-parent",
      message: {
        id: "msg-sa2",
        role: "assistant",
        content: [{ type: "text", text: "subagent thinking out loud" }],
      },
    } as unknown as SDKMessage);

    assert.equal(harness.currentTurnItemCount(), turnItemsBefore);
    assert.equal(
      harness.events.filter((e) => e.type === "thread.token-usage.updated").length,
      usageEventsBefore,
    );
  }),
);
```

If `currentTurnItemCount()` is not on the harness, add a thin accessor returning `context.turnState?.items.length ?? 0`, matching how other tests reach into turn state.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter`
Expected: FAIL — no `item.started` for `inner-bash-1` (subagent assistant messages currently fall through to `handleAssistantMessage`, which pushes into `turnState.items` and emits nothing for tool_use blocks).

- [ ] **Step 4: Add the `handleSubagentMessage` handler**

In `apps/server/src/provider/Layers/ClaudeAdapter.ts`, add a new handler (place it just before `handleAssistantMessage` at ~line 2480). It emits nested items for tool_use / tool_result / text blocks, tagged with `parentItemId`, and never touches `turnState.items`, token usage, or `assistantTextBlocks`:

```typescript
const handleSubagentMessage = Effect.fn("handleSubagentMessage")(function* (
  context: ClaudeSessionContext,
  message: SDKMessage,
  parentToolUseId: string,
) {
  const parentItemId = asRuntimeItemId(parentToolUseId);
  const turnIdPart = context.turnState
    ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
    : {};

  // assistant: tool_use blocks (the subagent's own tool calls) + text/thinking.
  if (message.type === "assistant") {
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as {
        type?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
        text?: unknown;
        thinking?: unknown;
      };

      if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        const itemType = classifyToolItemType(b.name);
        const toolInput =
          typeof b.input === "object" && b.input !== null
            ? (b.input as Record<string, unknown>)
            : {};
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.started",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...turnIdPart,
          itemId: asRuntimeItemId(b.id),
          payload: {
            itemType,
            status: "inProgress",
            title: titleForTool(itemType),
            detail: summarizeToolRequest(b.name, toolInput),
            parentItemId,
            data: { toolName: b.name, input: toolInput },
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: b.id }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/assistant/subagent",
            payload: message,
          },
        });
        continue;
      }

      const text =
        b.type === "text" && typeof b.text === "string"
          ? b.text
          : b.type === "thinking" && typeof b.thinking === "string"
            ? b.thinking
            : undefined;
      if (text && text.trim().length > 0 && typeof message.uuid === "string") {
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...turnIdPart,
          itemId: asRuntimeItemId(`${message.uuid}:${b.type}`),
          payload: {
            itemType: b.type === "thinking" ? "reasoning" : "assistant_message",
            status: "completed",
            title: b.type === "thinking" ? "Subagent thinking" : "Subagent message",
            detail: text.trim().slice(0, 400),
            parentItemId,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/assistant/subagent",
            payload: message,
          },
        });
      }
    }
    return;
  }

  // user: tool_result blocks — complete the matching nested tool item.
  if (message.type === "user") {
    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...turnIdPart,
        itemId: asRuntimeItemId(toolResult.toolUseId),
        payload: {
          itemType: "dynamic_tool_call",
          status: toolResult.isError ? "failed" : "completed",
          title: "Subagent tool result",
          ...(toolResult.text.trim().length > 0
            ? { detail: toolResult.text.trim().slice(0, 400) }
            : {}),
          parentItemId,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: toolResult.toolUseId }),
        raw: { source: "claude.sdk.message", method: "claude/user/subagent", payload: message },
      });
    }
    return;
  }
});
```

Note: the nested tool item's `itemType` on completion (`dynamic_tool_call`) may differ from its `item.started` type; the web row keys off `itemId`, so the start's `itemType` wins for the icon. This is acceptable for v1; do not try to re-derive the tool name from the result.

- [ ] **Step 5: Route subagent messages before the main handlers**

In the dispatch switch (`apps/server/src/provider/Layers/ClaudeAdapter.ts` ~lines 2876-2889), intercept non-null `parent_tool_use_id` for `assistant`/`user` BEFORE the existing cases:

```typescript
      case "user":
        if (message.parent_tool_use_id) {
          yield* handleSubagentMessage(context, message, message.parent_tool_use_id);
          break;
        }
        yield* handleUserMessage(context, message);
        break;
      case "assistant":
        if (message.parent_tool_use_id) {
          yield* handleSubagentMessage(context, message, message.parent_tool_use_id);
          break;
        }
        yield* handleAssistantMessage(context, message);
        break;
```

Leave the `stream_event` case and the `message_delta` token gate at line 2102 unchanged — subagents do not emit stream events, and the gate must keep ignoring any that theoretically arrive.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter`
Expected: PASS (both new tests, plus the existing suite — confirm the prior 1252 still pass).

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck` (Expected: no errors)

```bash
git add apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
git commit -m "feat(provider): route forwarded subagent messages into nested work-log items"
```

---

### Task 4: Carry `parentItemId` through the projection

Persist `parentItemId` from runtime item events into the thread-activity payload so the web layer can read it.

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — the three lifecycle cases: `item.updated` (561-577), `item.started` (606-621), `item.completed` (584-599)
- Test: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` (add to the existing file)

**Interfaces:**

- Consumes: `event.payload.parentItemId` (from Task 2's contract change).
- Produces: activity `payload.parentItemId` on `tool.started` / `tool.updated` / `tool.completed` rows.

- [ ] **Step 1: Write the failing test**

In `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`, mirroring the existing tests that assert on the activities produced from an `item.started` event:

```typescript
it("propagates parentItemId from item.started into the activity payload", () => {
  const activities = activitiesForRuntimeEvent({
    type: "item.started",
    eventId: "evt-1",
    createdAt: "2026-06-19T00:00:00.000Z",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "inner-bash-1",
    payload: {
      itemType: "command_execution",
      status: "inProgress",
      title: "Command run",
      parentItemId: "task-parent",
    },
  });
  assert.equal(activities.length, 1);
  assert.equal((activities[0]?.payload as Record<string, unknown>).parentItemId, "task-parent");
});
```

Use whatever the test file already calls the pure mapping function (the report shows the mapping lives in the same module as the `case "item.started"` block; reuse the existing test's entry point rather than inventing `activitiesForRuntimeEvent` if it differs).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t3tools/server test ProviderRuntimeIngestion`
Expected: FAIL — `parentItemId` is `undefined` in the activity payload (not carried).

- [ ] **Step 3: Carry the field in all three cases**

In `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, add to each lifecycle case's `payload` object the same conditional spread. For `item.started` (inside the payload at ~615):

```typescript
          payload: {
            itemType: event.payload.itemType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
            ...(event.payload.parentItemId ? { parentItemId: event.payload.parentItemId } : {}),
          },
```

For `item.updated` (~569) and `item.completed` (~591), add the identical `...(event.payload.parentItemId ? { parentItemId: event.payload.parentItemId } : {})` line alongside the existing `itemType`/`status`/`detail`/`data` spreads.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @t3tools/server test ProviderRuntimeIngestion`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` (Expected: no errors)

```bash
git add apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts
git commit -m "feat(orchestration): carry parentItemId into thread-activity payload"
```

---

### Task 5: Render nested subagent rows in the web work log

Group work-log entries that carry a `parentItemId` under their parent "Subagent task" row, indented.

**Files:**

- Modify: `apps/web/src/session-logic.ts:678-765` (`toDerivedWorkLogEntry`) — surface `parentItemId` onto the derived entry
- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx:721-821` (`WorkGroupSection`) and `:1548-1705` (`SimpleWorkEntryRow`) — group + indent children
- Test: `apps/web/src/session-logic.test.ts` (derive) and, if a render test harness exists, `MessagesTimeline.test.tsx`

**Interfaces:**

- Consumes: activity `payload.parentItemId` (Task 4).
- Produces: `DerivedWorkLogEntry.parentItemId?: string`; grouped rendering keyed by `parentItemId`.

- [ ] **Step 1: Write the failing derive test**

In `apps/web/src/session-logic.test.ts`:

```typescript
it("surfaces parentItemId from the activity payload onto the derived entry", () => {
  const entry = toDerivedWorkLogEntry({
    id: "act-1",
    tone: "tool",
    kind: "tool.started",
    summary: "Command run started",
    turnId: "turn-1",
    createdAt: "2026-06-19T00:00:00.000Z",
    payload: { itemType: "command_execution", parentItemId: "task-parent" },
  } as OrchestrationThreadActivity);
  assert.equal(entry.parentItemId, "task-parent");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t3tools/web test session-logic`
Expected: FAIL — `parentItemId` not on the derived entry.

- [ ] **Step 3: Surface `parentItemId` on the derived entry**

In `apps/web/src/session-logic.ts`, add to the `DerivedWorkLogEntry` type a `parentItemId?: string` field, and in `toDerivedWorkLogEntry` (after computing `payload`) add:

```typescript
const parentItemId = asTrimmedString((payload as Record<string, unknown> | null)?.parentItemId);
if (parentItemId) {
  entry.parentItemId = parentItemId;
}
```

(`asTrimmedString` is the same helper already used by `extractToolTitle` in this file.)

- [ ] **Step 4: Run the derive test to verify it passes**

Run: `pnpm --filter @t3tools/web test session-logic`
Expected: PASS.

- [ ] **Step 5: Group + indent children in the work group**

In `apps/web/src/components/chat/MessagesTimeline.tsx`, in `WorkGroupSection` before rendering, partition entries into parents and children:

```typescript
const childrenByParent = new Map<string, TimelineWorkEntry[]>();
for (const e of visibleEntries) {
  if (e.parentItemId) {
    const list = childrenByParent.get(e.parentItemId) ?? [];
    list.push(e);
    childrenByParent.set(e.parentItemId, list);
  }
}
const topLevelEntries = visibleEntries.filter((e) => !e.parentItemId);
```

Render top-level entries as today, and after each parent row whose `id` (the parent's runtime item id) has children, render the children indented. Pass an `indented` prop to `SimpleWorkEntryRow`:

```tsx
{
  topLevelEntries.map((workEntry) => (
    <Fragment key={workEntry.id}>
      <SimpleWorkEntryRow workEntry={workEntry} workspaceRoot={workspaceRoot} />
      {(childrenByParent.get(workEntry.id) ?? []).map((child) => (
        <SimpleWorkEntryRow
          key={child.id}
          workEntry={child}
          workspaceRoot={workspaceRoot}
          indented
        />
      ))}
    </Fragment>
  ));
}
```

In `SimpleWorkEntryRow`, accept `indented?: boolean` and apply a left margin when set, e.g. add `indented ? "ml-4 border-l border-border/40 pl-2" : ""` to the row's outer `className`. Match the parent row's runtime item id: the parent Task tool's `item.started` carries `itemId: "task-parent"`, which becomes the activity `id` — confirm the derived parent entry's `id` equals the children's `parentItemId`. If the work-group dedupes/merges activities such that the parent's derived `id` is the activity eventId rather than the item id, key the map on whatever field the derived parent entry exposes as the tool item id; add a `toolItemId` passthrough on the derived entry if needed (read from `providerRefs.providerItemId` or the item id already threaded through the projection).

- [ ] **Step 6: Verify grouping (render test or manual)**

If a `MessagesTimeline.test.tsx` render harness exists, add a test asserting a child entry renders with the indent class after its parent. Otherwise, defer to the live-verification step in the handoff and note it.

Run: `pnpm --filter @t3tools/web test`
Expected: PASS (existing suite + new derive test).

- [ ] **Step 7: Typecheck + lint + commit**

Run: `pnpm typecheck` and the web lint command. Expected: clean.

```bash
git add apps/web/src/session-logic.ts apps/web/src/session-logic.test.ts apps/web/src/components/chat/MessagesTimeline.tsx
git commit -m "feat(web): nest subagent activity under its parent task in the work log"
```

---

### Task 6: Bound the volume (per-parent cap)

Subagent activity is high-volume (~7,000 lines observed for a single fugue run). Cap nested items emitted per parent so a runaway subagent can't flood the work log / event store, and log what was dropped.

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` — `handleSubagentMessage` and `ClaudeSessionContext` (the per-session state struct where `inFlightTools` lives)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`

**Interfaces:**

- Consumes: `context` session state.
- Produces: `context.subagentItemCounts: Map<string, number>` keyed by `parentToolUseId`; a module const `MAX_SUBAGENT_ITEMS_PER_PARENT = 200`.

- [ ] **Step 1: Write the failing test**

```typescript
it("caps nested subagent items per parent and logs the overflow", () =>
  Effect.gen(function* () {
    const harness = yield* makeAdapterHarness({ forwardSubagentActivity: true });
    yield* harness.startTurn({ prompt: "go" });
    for (let i = 0; i < 250; i++) {
      harness.query.emit({
        type: "assistant",
        session_id: "s",
        uuid: `sa-${i}`,
        parent_tool_use_id: "task-parent",
        message: {
          id: `m-${i}`,
          role: "assistant",
          content: [{ type: "tool_use", id: `inner-${i}`, name: "Bash", input: { command: "ls" } }],
        },
      } as unknown as SDKMessage);
    }
    const started = harness.events.filter(
      (e) =>
        e.type === "item.started" &&
        (e.payload as { parentItemId?: string }).parentItemId === "task-parent",
    );
    assert.equal(started.length, 200);
  }).pipe(Effect.provide(/* the test harness's layer */)));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter`
Expected: FAIL — 250 items emitted (no cap).

- [ ] **Step 3: Add the cap**

Add near the other module constants in `apps/server/src/provider/Layers/ClaudeAdapter.ts`:

```typescript
const MAX_SUBAGENT_ITEMS_PER_PARENT = 200;
```

Add `subagentItemCounts: Map<string, number>` to the `ClaudeSessionContext` type and initialize it (`new Map()`) wherever `inFlightTools` is initialized. At the top of `handleSubagentMessage`, before emitting any item:

```typescript
const emitted = context.subagentItemCounts.get(parentToolUseId) ?? 0;
if (emitted >= MAX_SUBAGENT_ITEMS_PER_PARENT) {
  if (emitted === MAX_SUBAGENT_ITEMS_PER_PARENT) {
    context.subagentItemCounts.set(parentToolUseId, emitted + 1);
    yield *
      Effect.logWarning("subagent activity cap reached; dropping further nested items", {
        parentToolUseId,
        cap: MAX_SUBAGENT_ITEMS_PER_PARENT,
      });
  }
  return;
}
context.subagentItemCounts.set(parentToolUseId, emitted + 1);
```

(Increment once per message, before the per-block loop — this caps messages, which is the right granularity for bounding the firehose. Each message yields a small bounded number of blocks.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @t3tools/server test ClaudeAdapter`
Expected: PASS — exactly 200 `item.started` events for the parent.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck` (Expected: no errors)

```bash
git add apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
git commit -m "feat(provider): cap nested subagent items per parent with overflow log"
```

---

## Verification (after all tasks)

- [ ] Full server suite green: `pnpm --filter @t3tools/server test` (was 1252 passing on this branch).
- [ ] Full web suite green: `pnpm --filter @t3tools/web test` (was 1212 passing).
- [ ] `pnpm typecheck` + lint clean.
- [ ] Live: `T3CODE_FORWARD_SUBAGENT_ACTIVITY=1 pnpm daemon:deploy` (note: env must reach the systemd unit — add it to the unit's `Environment=` or the deploy env, NOT just the shell), trigger a prompt that dispatches a subagent (e.g. ask T3code to "dispatch a general-purpose subagent to list files"), and confirm the subagent's inner tool calls appear indented under the "Subagent task" row, updating step-by-step as the subagent works.
- [ ] Toggle off (unset the env, redeploy) and confirm the old opaque-spinner behavior returns and no `parentItemId` rows appear — proving the gate.

## Notes / out of scope

- **No token-by-token streaming for subagents.** The SDK forwards complete messages, not partial stream events. If true streaming is later wanted, it requires SDK support that does not exist in 0.3.170.
- **ServerSettings UI toggle** (vs. env var) is a deliberate follow-up: promote `forwardSubagentActivity` from `ServerConfig` (env) to the persisted `ServerSettings` contract + settings UI once the behavior is proven.
- **Event-store growth:** even capped at 200 items/parent, many parallel subagents add load to `orchestration_events`. Watch the table size after enabling; the cap is the first defense, retention/pruning is a separate concern.
