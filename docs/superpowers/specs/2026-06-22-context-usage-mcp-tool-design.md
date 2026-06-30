# Design: `context_usage` MCP tool

- **Date:** 2026-06-22
- **Status:** Implemented
- **Topic:** A tiny MCP tool that reports the calling thread's context-window consumption as a percentage string.

## Summary

Add a single no-argument tool, `context_usage`, to t3code's existing in-process MCP
server. When an agent calls it, the tool returns the percentage of that agent's
context window that has been consumed, as a plain string such as `"20%"`. When the
value is not yet known, it returns `"unknown"`.

## Motivation / why this is feasible

A generic MCP server cannot see the calling client's context window — the MCP
protocol does not pass that state to the server. t3code's MCP server is the
exception, because:

1. It **tracks context usage itself.** Every completed turn emits a
   `thread.token-usage.updated` provider event, which `ProviderRuntimeIngestion`
   projects into a `context-window.updated` activity whose payload is a
   `ThreadTokenUsageSnapshot` (`usedTokens`, optional `maxTokens`, …). See
   `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:206-213,564-582`.
2. It **knows which thread is calling.** The MCP HTTP auth middleware resolves the
   bearer token to an `McpInvocationScope` carrying the `threadId`
   (`apps/server/src/mcp/McpHttpServer.ts:66-89`,
   `apps/server/src/mcp/McpInvocationContext.ts:8-16`).
3. The tool is **automatically reachable from every agent** t3code spawns
   (Claude, Codex, Cursor, OpenCode, Grok), since each session is issued a
   thread-scoped `t3-code` MCP credential
   (`apps/server/src/provider/Layers/ProviderService.ts` issue sites; capabilities
   currently `["preview"]`).

## Data source

On each call, read the latest persisted snapshot via
`ProjectionThreadActivityRepository.listByThreadId({ threadId })`
(`apps/server/src/persistence/Services/ProjectionThreadActivities.ts:71-73`):

- Activities return in ascending sequence order; take the **last** activity whose
  `kind === "context-window.updated"`.
- Its `payload` (typed `Schema.Unknown`) decodes to `ThreadTokenUsageSnapshot`.
- The snapshot exists only after a turn reports `usedTokens > 0`
  (`ProviderRuntimeIngestion.ts:206-213`).

**Alternative considered and rejected:** a new in-memory service subscribing to
`thread.token-usage.updated` and caching latest-per-thread (mirroring
`UnattendedRunReactor`'s `latestContextUsage` map). Rejected as unnecessary state —
the SQLite projection already serves this read cheaply and covers all threads
(interactive and unattended), whereas the reactor map only exists during unattended
runs. YAGNI.

## Components

Three small pieces, mirroring the existing preview toolkit layout under
`apps/server/src/mcp/toolkits/`.

### 1. Tool definition — `apps/server/src/mcp/toolkits/context/tools.ts`

```ts
export const ContextUsageTool = Tool.make("context_usage", {
  description:
    "Report what percentage of the current context window the calling session has " +
    'consumed, e.g. "20%". Returns "unknown" if no usage has been measured yet.',
  success: Schema.String,
  dependencies: [McpInvocationContext.McpInvocationContext, ProjectionThreadActivityRepository],
})
  .annotate(Tool.Title, "Get context window usage")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);
```

- No `parameters` → no-argument tool (same shape as `PreviewStatusTool`).
- `success: Schema.String` — the result is a single percentage string.

### 2. Shared percentage helper — extract `formatPercent`

`formatPercent` is currently a private const in
`apps/server/src/orchestration/unattendedRun.ts:54-58`. Extract it (whole-number
percent, one decimal under 1%) into a small shared module — e.g.
`apps/server/src/orchestration/contextUsageFormat.ts` — and have `unattendedRun.ts`
import it from there. This avoids the MCP layer importing from an orchestration
runtime module and keeps one source of truth for the format. (`formatTokens` can stay
private in `unattendedRun.ts`; only `formatPercent` is shared.)

The handler never relies on `formatPercent`'s internal `maxTokens <= 0 → "—"`
branch — it returns `"unknown"` before calling it in that case (see edge cases).

### 3. Handler + registration

Handler logic (in `apps/server/src/mcp/toolkits/context/handlers.ts`):

1. Read `threadId` from `McpInvocationContext`.
2. `const activities = yield* repo.listByThreadId({ threadId })`.
3. Find the last activity with `kind === "context-window.updated"`.
4. Decode its `payload` to `ThreadTokenUsageSnapshot`.
5. If no such activity, decode fails, `usedTokens`/`maxTokens` missing, or
   `maxTokens <= 0` → return `"unknown"`.
6. Otherwise return `formatPercent(usedTokens, maxTokens)`.

Registration (in `apps/server/src/mcp/McpHttpServer.ts`): add a
`registerContextUsage` effect that mirrors `registerPreviewSnapshot`
(`McpHttpServer.ts:91-167`) using `server.addTool(...)` and returning
`content: [{ type: "text", text: percent }]` directly. The manual `addTool` form is
chosen specifically so the result is the literal text `20%` rather than a
JSON-quoted `"20%"`. Merge the new registration layer into the exported `layer`
(`McpHttpServer.ts:188-191`), providing `ProjectionThreadActivityRepository`.

## Data flow

```
agent calls context_usage (no args)
  -> MCP HTTP auth middleware resolves bearer token -> McpInvocationScope { threadId }
  -> handler: ProjectionThreadActivityRepository.listByThreadId({ threadId })
  -> last "context-window.updated" payload -> ThreadTokenUsageSnapshot
  -> used/max -> formatPercent -> "20%"   (or "unknown")
  -> CallToolResult content: [{ type: "text", text: "20%" }]
```

**Freshness note:** the snapshot is written when a turn completes, so the value
reflects usage _as of the last completed turn_ — the freshest measured value,
inherently slightly behind the in-progress turn. This is acceptable and inherent;
no attempt is made to estimate mid-turn usage.

## Output contract

- A measured value: whole-number percent, e.g. `"20%"`; sub-1% as one decimal,
  e.g. `"0.5%"` (matches t3code's existing display via `formatPercent`).
- Not yet measurable: `"unknown"`.
- Always returned as a single MCP text content block.

## Gating

No capability check. The tool exposes harmless read-only thread metadata, the
credential is already thread-scoped, and every issued credential is identical today.
`McpCapability` and `requireMcpCapability` are unchanged (still used for `preview`).

## Testing

- Unit-test the handler against a stub `ProjectionThreadActivityRepository` layer
  (following existing Effect/`@effect/vitest` patterns, e.g.
  `apps/server/src/persistence/Layers/ProjectionThreadActivities.test.ts` and
  `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`):
  - no activities → `"unknown"`;
  - a `context-window.updated` snapshot with `usedTokens`/`maxTokens` → correct
    percent (e.g. 40000/200000 → `"20%"`);
  - snapshot missing `maxTokens` → `"unknown"`;
  - multiple `context-window.updated` activities → uses the last (latest);
  - sub-1% → one-decimal form.
- Optionally a small test for the extracted `formatPercent` (whole vs sub-1%).
- Tests require Node 24 (project toolchain); the harness default Node is too old.

## Out of scope (YAGNI)

- Structured output (raw `usedTokens`/`maxTokens` fields) — the contract is a single
  percentage string only.
- Input parameters (e.g. choosing a denominator other than the model window).
- A standalone/publishable MCP server.
- Any new capability in `McpCapability`.
- Mid-turn / real-time usage estimation.

## Open questions

None — design approved; no-data fallback is `"unknown"`; tool name is
`context_usage`.

## Implementation notes (as shipped)

- **Self-contained formatter (deviation from "Components §2").** Rather than extract
  `formatPercent` out of `orchestration/unattendedRun.ts`, the new tool ships its own
  `formatContextPercent` in `apps/server/src/mcp/toolkits/context/usage.ts`. The
  spec's suggested location (`orchestration/contextUsageFormat.ts`) would not actually
  have removed the "MCP imports from orchestration" coupling it cited, and touching
  the orchestration module (with its own test suite) is a larger blast radius than a
  trivial 3-line pure-formatter duplication. Behavior and the `"20%"`/`"unknown"`
  contract are unchanged. `unattendedRun.ts` is left as-is.
- **Files added:** `apps/server/src/mcp/toolkits/context/{tools.ts,usage.ts,usage.test.ts}`.
- **Files changed:** `apps/server/src/mcp/McpHttpServer.ts` (register + merge into `layer`;
  exports `ContextUsageRegistrationLive`), `apps/server/src/mcp/McpHttpServer.test.ts`
  (end-to-end test), `apps/server/src/server.test.ts` (mock `ProjectionThreadActivityRepository`).
- **Test-harness note:** the `makeRoutesLayer` serve chain in `server.test.ts` was already
  at the 20-argument `pipe` limit, so the new repo mock is merged into the adjacent
  `ProjectionSnapshotQuery` provide via `Layer.merge` rather than added as a 21st
  `Layer.provide`.
- **Verification:** `usage.test.ts` 8/8, `McpHttpServer.test.ts` 4/4, `server.test.ts`
  99/99; `apps/server` typecheck clean; new files lint- and fmt-clean.
