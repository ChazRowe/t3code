# Design: `spawn_agent` cross-provider subagent MCP tool

- **Date:** 2026-06-22
- **Status:** Implemented
- **Topic:** An MCP tool that lets the calling agent spawn a subagent on **any**
  configured provider (Claude, Codex, Cursor, Grok, OpenCode), run a prompt to
  completion, capture the subagent's transcript as a normal session, and surface it
  under the caller in the existing subagent tree.

## Summary

Add a `spawn_agent` tool (plus a `list_agents` discovery tool) to t3code's existing
in-process MCP server. When an agent calls `spawn_agent` with a target
`providerInstanceId` and a `prompt`, the tool:

1. Starts a **real provider session** on the requested provider instance, with its
   own `threadId`, inheriting the caller's workspace and safety envelope.
2. Submits the prompt as a turn and **blocks until the turn completes**.
3. Returns the subagent's final assistant text as the tool result — exactly like
   Claude's built-in Task tool, but cross-provider.

Because the subagent is a normal provider session, its transcript is captured by the
existing ingestion pipeline with no extra work. The subagent is **linked into the
caller's subagent tree** so it appears nested under the caller in the watch UI.

## Motivation / why this is feasible

Three existing facts make this a thin layer rather than new infrastructure:

1. **Spawning any provider is already a first-class operation.**
   `ProviderService.startSession(threadId, input)` and `sendTurn(input)` start a
   session and submit a prompt on any provider instance
   (`apps/server/src/provider/Services/ProviderService.ts:38-127`). Target instances
   are resolved from `ProviderInstanceRegistry`
   (`apps/server/src/provider/Services/ProviderInstanceRegistry.ts:29-82`), populated
   from `BUILT_IN_DRIVERS` (`apps/server/src/provider/builtInDrivers.ts:47-53`).

2. **Transcripts are captured for every thread automatically.**
   `ProviderRuntimeIngestion` subscribes to `providerService.streamEvents` and writes
   every event into `projection_thread_activities`, keyed by the event's `threadId`
   (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1807-1822`,
   write at `apps/server/src/persistence/Layers/ProjectionThreadActivities.ts:39-84`).
   A spawned session with its own `threadId` is therefore captured "as normal" with
   zero additional plumbing.

3. **The MCP server already knows who is calling.** The HTTP auth middleware resolves
   the bearer token to an `McpInvocationScope` carrying `threadId`, `environmentId`,
   `providerInstanceId`, `providerSessionId`, and `capabilities`
   (`apps/server/src/mcp/McpHttpServer.ts:69-88`,
   `apps/server/src/mcp/McpInvocationContext.ts:8-21`). Every t3code-spawned session
   is issued a thread-scoped `t3-code` credential
   (`apps/server/src/mcp/McpSessionRegistry.ts:94-127`), so the tool is reachable from
   every provider with no per-provider wiring.

## The linkage problem

Today the subagent tree is **strictly intra-thread**. `OrchestrationSubagentRef`
(`packages/contracts/src/orchestration.ts:1301-1320`) describes nodes purely via
item IDs within one thread, and the tree/transcript queries only read the **same**
thread's activities:

- `readRootSubagentRefsByThread` selects `collab_agent_tool_call` activities with
  `parent_item_id IS NULL` for the thread
  (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:993-1020`).
- `getSubagentActivities` reads child activities where `parent_item_id = rootItemId`
  in the same thread (`...ProjectionSnapshotQuery.ts:965-991,2297-2309`).

A cross-provider subagent is a **separate thread** with its own activities. So we
must teach the tree how to point one node at another thread's transcript.

### Chosen approach: synthetic `collab_agent_tool_call` node carrying `childThreadId`

When `spawn_agent` runs, append a synthetic `collab_agent_tool_call` activity to the
**caller's** thread whose payload carries `childThreadId` (plus `providerInstanceId`,
label, prompt). This reuses the existing tree machinery:

- `readRootSubagentRefsByThread` already matches `collab_agent_tool_call` → the node
  appears in the tree with **no query change**. (Claude's classifier already maps any
  tool whose name contains "agent" to `collab_agent_tool_call` —
  `apps/server/src/provider/Layers/ClaudeAdapter.ts:657-699` — but because we write
  the node ourselves we do not depend on the parent provider's classifier; this also
  makes it work when the caller is Codex/Grok/etc.)
- Extend `OrchestrationSubagentRef` with `childThreadId: ThreadId | null` and
  `providerInstanceId: ProviderInstanceId | null`, populated during ref building from
  the payload.
- Extend `getSubagentActivities`: when a ref has a `childThreadId`, return **that
  thread's** activities (its full transcript) instead of running the intra-thread
  `parent_item_id = rootItemId` query.
- The handler updates this node's `status` (`inProgress → completed | failed`) and
  `resultText` as the child turn progresses and finishes.

**Why this over a new `subagent_links` table:** the projection + tree + watch UI
(`subscribeSubagentTree` / `subscribeSubagent`) already exist and already render
`collab_agent_tool_call` nodes. Reusing them means the only web change is a provider
badge. A separate link table would duplicate the tree's status/labeling/ordering
logic — the kind of parallel-path duplication AGENTS.md calls a code smell.

**Why not just spawn a standalone thread (no linkage):** rejected per product
decision — the subagent should nest under the caller in the watch UI.

## Components

### 1. Contracts — `packages/contracts/src/orchestration.ts`

Add to `OrchestrationSubagentRef` (`:1301-1320`):

```ts
childThreadId: Schema.NullOr(ThreadId),
providerInstanceId: Schema.NullOr(ProviderInstanceId),
provider: Schema.NullOr(ProviderDriverKind), // driver kind, for a readable badge
model: Schema.NullOr(TrimmedNonEmptyString), // resolved model the subagent ran on
```

All null for ordinary same-thread Claude subagents (unchanged behavior); set for
cross-provider nodes. Keep this package schema-only (no runtime logic) per AGENTS.md.

`provider`/`model` exist so the watch view can show **which provider and model the
subagent ran on at the top of its transcript** (see Web §6). `model` is the _resolved_
model: at node creation we record the requested `model` (or the instance default, if
omitted), then upgrade it to the actually-configured model once the child session
reports it (`ProviderSession.model`, or the first `session.configured`/`turn.started`
event for the child thread). If never resolved, fall back to the requested/default
value; render `unknown` only if both are absent.

### 2. Capability — `apps/server/src/mcp/{McpInvocationContext,McpSessionRegistry}.ts`

Add a `"spawn"` capability to `McpCapability` and grant it when issuing credentials
(capabilities are currently hardcoded to `["preview"]` at
`apps/server/src/mcp/McpSessionRegistry.ts:106`). The handler gates on it via the
existing `requireMcpCapability` pattern used by the preview toolkit.

### 3. Tools — `apps/server/src/mcp/toolkits/spawn/tools.ts`

Mirror the preview/context toolkit layout.

```ts
export const SpawnAgentTool = Tool.make("spawn_agent", {
  description:
    "Delegate a task to a subagent running on another configured provider " +
    "(e.g. Codex, Claude, Grok). Starts a real session, runs the prompt to " +
    "completion, and returns the subagent's final response. Use list_agents to " +
    "discover available providerInstanceId values.",
  parameters: {
    providerInstanceId: Schema.String, // validated against the live registry
    prompt: TrimmedNonEmptyString,
    model: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String), // short label for the tree node
  },
  success: Schema.String, // the subagent's final assistant text
})
  .annotate(Tool.Title, "Spawn a subagent on another provider")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const ListAgentsTool = Tool.make("list_agents", {
  description:
    "List provider instances available to spawn as subagents, with their " +
    "providerInstanceId, provider kind, and default model.",
  success: Schema.String, // human-readable list (or a small JSON array)
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
```

`list_agents` reads `ProviderInstanceRegistry.listInstances()`.

### 4. Handler — `apps/server/src/mcp/toolkits/spawn/handlers.ts`

`spawn_agent` flow:

1. Read the caller scope from `McpInvocationContext` (`threadId`, `environmentId`,
   `providerInstanceId`, depth — see safeguards). Require the `spawn` capability.
2. Validate `providerInstanceId` against `ProviderInstanceRegistry.getInstance(...)`;
   error clearly if unknown/unavailable.
3. Mint a child `threadId` (callers pass their own `threadId` to `startSession`; the
   service does not mint one).
4. Resolve the **caller's** workspace `cwd` and safety settings
   (`runtimeMode`/`approvalPolicy`/`sandboxMode`) from the parent thread/environment,
   and pass them into the child session so a delegate cannot exceed the caller's
   envelope.
5. Append the synthetic `collab_agent_tool_call` activity to the caller's thread
   (`status: inProgress`, payload `{ childThreadId, providerInstanceId, provider,
model, prompt, label }`, where `model` is the requested model or the instance
   default) via the orchestration engine's `thread.activity.append` command (same
   dispatch path ingestion uses — `ProviderRuntimeIngestion.ts:1770-1782`).
6. `startSession(childThreadId, { providerInstanceId, runtimeMode, cwd,
modelSelection })` (`ProviderSessionStartInput`,
   `packages/contracts/src/provider.ts:53-65`).
7. `sendTurn({ threadId: childThreadId, input: prompt })` → capture the returned
   `turnId` (`ProviderTurnStartResult`, `packages/contracts/src/provider.ts:80-85`).
8. Subscribe to `ProviderService.streamEvents` filtered to `childThreadId`
   (`ProviderService.ts:126`); accumulate `content.delta` payloads with
   `streamKind === "assistant_text"`
   (`packages/contracts/src/providerRuntime.ts:805-810,417-423`) and resolve when a
   `turn.completed` event arrives for `turnId`
   (`...providerRuntime.ts:740-745`, payload `:365-373`).
9. When the child session first reports its configured model (`ProviderSession.model`
   from `startSession`, or the first `session.configured`/`turn.started` event for
   `childThreadId`), upgrade the node's `model` if it differs from the requested value.
10. Update the node activity (`completed` + `resultText`, or `failed` on
    error/abort/`turn.completed` with a non-`completed` state).
11. Return the accumulated text as a single MCP text content block (manual `addTool`
    form, like `registerContextUsage` at `McpHttpServer.ts:172-215`, so the result is
    literal text, not JSON-quoted).

### 5. Registration — `apps/server/src/mcp/McpHttpServer.ts`

Add `registerSpawnToolkit` and merge it into the exported `layer`
(`McpHttpServer.ts:219-241`), providing `ProviderService`,
`ProviderInstanceRegistry`, and the orchestration engine for the activity append.

### 6. Web — `apps/web`

No new subscription needed: cross-provider nodes flow through `subscribeSubagentTree`
/ `subscribeSubagent` automatically (watch route
`apps/web/src/routes/_chat.$environmentId.$threadId.subagent.$subagentRootItemId.tsx`).

**Provider + model at the top of the transcript.** The watch header in
`apps/web/src/components/SubagentWatchView.tsx:121-129` already renders
`Subagent: {subagentType}` (+ optional `description`). Extend that header block to
show the provider and model from the new ref fields — e.g. a line/badge reading
`{provider} · {model}` (using `providerInstanceId` for the precise instance and
`provider`/`model` for the readable label), rendered only when present so same-thread
Claude subagents are visually unchanged. Falls back to `unknown` only if both
`provider` and `model` are absent. This is the only required web change; the rest is
inherited.

## Safeguards

- **Recursion depth cap.** A spawned child receives its own `t3-code` credential and
  can itself call `spawn_agent`. Carry a `subagentDepth` in the issued scope
  (incremented per spawn); reject spawns beyond a configured max to prevent runaway
  fan-out. Default the cap to **5**, matching Claude Code's native nested-subagent
  depth limit (5 levels below the main agent), so cross-provider delegation behaves
  consistently with native delegation. Configurable, but 5 is the default.
- **Inherit the caller's safety envelope.** Never let a delegate run with broader
  `runtimeMode`/approval/sandbox than the caller.
- **Cleanup on caller abort.** If the caller's turn is cancelled while a spawn is
  in-flight, mark the node `failed` and stop waiting (scoped subscription).

## Concurrency & parallelism

`spawn_agent` blocks per call — the handler holds until the child's `turn.completed`
and returns the final text — but this does **not** preclude parallel fan-out. The
semantics mirror Claude Code's native `Agent` tool: an orchestrator launches several
subagents by emitting multiple tool_use blocks in one assistant message; they run
in-flight together, and the parent's turn resumes only once **all** results return
(a launch-all → barrier → resume pattern, not serial-per-call). Each `spawn_agent`
invocation is independent and concurrency-safe by construction — its own
`childThreadId`, its own scoped event subscription, its own tree node; nothing shared.

Two ways our tool differs from the native `Agent` tool, both inherent to being an
out-of-process MCP tool rather than harness-managed:

1. **Parallelism is client-dependent, not guaranteed.** The Messages API leaves
   "execute these tool*use blocks concurrently vs. serially" entirely to the caller's
   runtime. Claude's Agent SDK dispatches independent tool calls (including MCP ones)
   in-flight, so multi-spawn fans out as expected when **Claude** orchestrates. Other
   app-server MCP clients (Codex, Cursor, Grok, OpenCode) may serialize MCP tool calls
   even when the model emits them together. The tool supports parallelism; we do not
   \_promise* it cross-provider. (The native `Agent` tool, by contrast, is
   harness-managed and its concurrency is guaranteed.)
2. **Each in-flight spawn holds one open `/mcp` HTTP request** for the duration of the
   child turn. So N concurrent spawns = N concurrent long-lived requests against the
   in-process MCP server — a real resource/timeout consideration that compounds with
   the long-running-tool-call risk below. The native tool has no equivalent cost
   because it never leaves the harness.

Implication for the implementation: the handler must tolerate many concurrent
invocations (no shared mutable state, scoped subscriptions that clean up on
completion/abort), and the long-running-tool-call mitigation (configurable max-wait →
partial result + `childThreadId`) applies _per concurrent spawn_.

## Data flow

```
agent calls spawn_agent { providerInstanceId, prompt }
  -> MCP auth middleware -> McpInvocationScope { threadId(parent), environmentId, depth }
  -> require "spawn" capability; validate providerInstanceId via ProviderInstanceRegistry
  -> append collab_agent_tool_call node to PARENT thread (inProgress, childThreadId, prompt)
  -> startSession(childThreadId, { providerInstanceId, cwd, runtimeMode, model })
  -> sendTurn({ threadId: childThreadId, input: prompt }) -> turnId
  -> subscribe streamEvents (threadId == childThreadId):
        content.delta(assistant_text) -> accumulate
        turn.completed(turnId)        -> resolve
  -> update node (completed + resultText)
  -> CallToolResult content: [{ type: "text", text: finalText }]

(child thread's events are ALSO ingested into projection_thread_activities under
 childThreadId by ProviderRuntimeIngestion — the captured transcript, for free.)
```

## Output contract

- Success: the subagent's final assistant text as a single MCP text content block.
- Failure (unknown provider, start/turn error, non-`completed` turn state, depth cap):
  an MCP error result with a clear message; the tree node is marked `failed`.

## Gating

Requires the new `spawn` capability on the credential (unlike `context_usage`, which
is ungated read-only metadata). Spawning starts real sessions and consumes provider
quota, so it is an explicit capability rather than always-on.

## Testing

- **Handler unit test** (stub `ProviderService` + `ProviderInstanceRegistry`,
  following `UnattendedRunReactor.test.ts` / `ProjectionThreadActivities.test.ts`
  Effect patterns): emits `content.delta` then `turn.completed`; asserts accumulated
  text returned, node transitions `inProgress → completed`, `resultText` set.
- **Unknown / unavailable `providerInstanceId`** → error result, no session started.
- **Turn fails / non-`completed` state** → node `failed`, error surfaced.
- **Capability gating** → call without `spawn` capability is rejected.
- **Linkage / ref building**: a `collab_agent_tool_call` activity carrying
  `childThreadId` produces an `OrchestrationSubagentRef` whose `getSubagentActivities`
  reads the **child** thread's activities (extend
  `ProjectionSnapshotQuery` tests).
- **Depth cap**: spawn at max depth is rejected.
- **Provider/model capture**: the node records `providerInstanceId`/`provider`/`model`
  (requested-or-default at creation, upgraded to resolved), surfaced on the ref; a
  `SubagentWatchView` render test asserts the provider + model line appears for a
  cross-provider node and is absent for a plain Claude subagent.
- Tests require Node 24 (project toolchain).

## Out of scope (YAGNI)

- Async handle + polling lifecycle (chosen model is block-until-complete).
- Streaming the subagent's partial output back through the tool result (only the final
  text is returned; live progress is visible in the watch UI).
- A fixed provider allowlist / settings UI (any configured instance is targetable).
- Attachments / multi-turn conversations with the subagent (single prompt → single
  turn for v1).
- A standalone/publishable MCP server.

## Open questions / risks

- **Long-running tool call.** The MCP request fiber stays open until the child turn
  completes (possibly minutes). Claude's SDK tolerates long Task-like tool calls;
  confirm Codex/Cursor/Grok/OpenCode app-server MCP clients don't impose a tighter
  per-tool timeout. Mitigation: a configurable max-wait that returns a partial result
  - the `childThreadId` (so the run is still inspectable) rather than hanging forever.
- **`thread.activity.append` shape.** Confirm the exact command/payload the
  orchestration engine accepts for a manually-authored `collab_agent_tool_call`
  activity so the synthetic node is indistinguishable from an ingested one (itemType,
  status, summary, prompt).
- **Default target when `providerInstanceId` omitted.** Proposed: required field; no
  implicit default (use `list_agents` to discover). Revisit if it proves clumsy.

## Implementation notes (as shipped)

- **Files added:** `apps/server/src/mcp/toolkits/spawn/{tools.ts,handlers.ts,handlers.test.ts}`.
- **Files changed:** `packages/contracts/src/{orchestration.ts,provider.ts}` (ref
  fields + `ProviderSessionStartInput.subagentDepth`); `apps/server/src/mcp/{McpInvocationContext,McpSessionRegistry,McpHttpServer}.ts`
  (`spawn` capability, `subagentDepth` scope, registration); `apps/server/src/provider/Layers/ProviderService.ts`
  (thread depth into credential issuance); `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
  (ref fields + cross-thread `getSubagentActivities`); `apps/web/src/components/SubagentWatchView.tsx`
  (provider · model header). Plus test updates for the widened `OrchestrationSubagentRef`.
- **Model resolution simplified.** The resolved model is read directly from
  `ProviderSession.model` returned by `startSession` (falling back to the requested
  model), so the node is appended _after_ the session starts and no event-stream
  "upgrade" step is needed.
- **Safety-envelope inheritance is runtimeMode + cwd only.** `ProviderSession` echoes
  `runtimeMode`/`cwd` but not `approvalPolicy`/`sandboxMode`, so only those two are
  inherited (read via `listSessions()`). Spawning fails cleanly if the caller's session
  can't be resolved.
- **`spawn` capability is granted to every issued credential** (the gate exists but is
  always-on, like `preview`), so any session can delegate.
- **Final text is accumulated from `content.delta` (`assistant_text`).** The stream
  subscription is established before `sendTurn`; the tiny forkScoped subscription-defer
  window is immaterial since providers emit output only well after the turn is accepted.
- **Node payload shape:** cross-provider metadata lives under
  `payload.subagentSession = { childThreadId, providerInstanceId, provider, model }`;
  prompt/result reuse the existing `payload.data.input` / `payload.data.result` shape so
  the existing `deriveSubagent*` helpers work unchanged.
- **Test-harness note:** mock `ProviderService`/`ProviderInstanceRegistry` were merged
  into an existing `Layer.merge` in `server.test.ts` rather than added as new
  `Layer.provide` args, to stay within the 20-argument `.pipe` limit on the serve chain.
- **Verification:** `apps/server` + `packages/contracts` + `apps/web` typecheck clean;
  spawn handler 4/4, ProjectionSnapshotQuery 19/19, SubagentWatchView 4/4, McpHttpServer
  - PreviewAutomationBroker 7/7, server 100/100; new files lint- and fmt-clean.

## Correction: the child must be a real (hidden) thread

The first cut spawned the subagent on a bare `threadId` with no orchestration thread
record. That **silently broke transcript capture**: `ProviderRuntimeIngestion`
skips events for unknown threads (`ProviderRuntimeIngestion.ts` `resolveThreadShell →
if (!thread) return`), and `thread.activity.append` is guarded by `requireThread`
(`commandInvariants.ts`), so none of the child's activities persisted — the tool
returned text but the watch transcript was blank.

Fix (the chosen "real thread + hide from sidebar" option):

- The handler creates a real orchestration thread for the child via `thread.create`
  under the **caller's project**, inheriting runtime mode / cwd / branch / worktree,
  then waits (bounded poll on `getThreadShellById`) for the projection to catch up
  before sending the prompt — so the turn's activities are ingested, not dropped.
- New nullable `projection_threads.parent_thread_id` (migration **036**), threaded
  through the `thread.create` command → `thread.created` payload → projector. It's
  `Schema.optional` on the persisted row so unrelated queries decode unchanged.
- The **active + archived shell snapshots** filter `parent_thread_id IS NULL`
  (`listActiveThreadRows` / `listArchivedThreadRows`), hiding subagent threads from
  the sidebar. The **command read model** (`listThreadRows`, used by `getSnapshot` /
  `getCommandReadModel`) is deliberately _not_ filtered, so the child thread exists
  for the decider and its own `thread.activity.append`s pass `requireThread`.
- Session teardown: an `Effect.addFinalizer` stops the spawned session when the tool
  call ends (success / error / interrupt), so spawns no longer leak live sessions.
- The resolved model is read from the started `ProviderSession.model`; the child's
  early session-lifecycle events (emitted before `thread.create` lands) drop
  harmlessly — only the post-prompt turn is the transcript we keep.

This resolves the "`thread.activity.append` shape" open question above (the synthetic
node + child thread both go through the normal command path).
