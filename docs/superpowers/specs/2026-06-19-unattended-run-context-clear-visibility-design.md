# Unattended-run context-clear visibility + earlier wrap — design

**Date:** 2026-06-19
**Status:** Approved for planning

## Problem

When an unattended run clears context between iterations, there is no visible,
persistent signal in the conversation that the clear happened. The live context
gauge is transient and reflects only the current provider session, so a user who
looks at the thread after an iteration has run sees a high number (e.g. 52% /
519k of 1M) and cannot tell whether:

- the context was actually cleared between iterations, and
- how much context an iteration consumed before it stopped.

Investigation confirmed the clear **does** work at the provider level (each
iteration starts a fresh Claude session — `turnCount` resets to 1, and the gauge
reads the live session's `activeTokens`, not thread-cumulative). The gap is
purely **observability**: the run gives no inline assurance, and the
single-continuous-scrollback UI makes a cleared run look un-cleared.

A second, related irritation: an iteration ran to ~52% context before the agent
chose to wrap — "way past where I would have chosen." The wrap trigger is too
soft.

## Goals

1. Emit a **persistent, inline marker** at each mid-run context clear so the user
   can scroll back and see, per iteration, that a clear occurred and how big the
   context was before vs. after.
2. Make the agent **wrap earlier** so iterations don't balloon toward ~50%
   context.

## Non-goals

- Investigating or changing the live context gauge / token-usage snapshot
  behavior. The gauge is per-session and correct; the inline marker gives an
  independent signal without touching it. (Any gauge stickiness is out of scope
  and would risk the uncommitted WIP `ClaudeAdapter`.)
- Hard, reactor-enforced wrap ceilings. The earlier-wrap mechanism is a soft
  preamble budget; we will tune the number empirically.
- Any change to `ClaudeAdapter.*`, `package.json`, `pnpm-lock.yaml`, `ops/`
  (uncommitted user WIP — must not be touched).

## Part A — Inline context-clear markers

### Where it lives

Entirely within `UnattendedRunReactor.ts` (already owns the unattended-run
orchestration) plus a small web-rendering addition in `session-logic.ts`. No
provider/adapter changes.

### Data source

The reactor already consumes `thread.activity-appended` from the domain event
stream. Token usage is surfaced as a `context-window.updated` **activity** whose
payload includes `usedTokens` and `maxTokens` (confirmed in the event log:
`{ usedTokens: 517188, maxTokens: 1000000, ... }`). The reactor will keep a tiny
per-thread record of the latest such payload — the same pattern as the existing
`latestAssistantText` / `sawRunningSinceTurnStart` maps.

`thread.token-usage.updated` is a **provider runtime** event, not an orchestration
domain event, so the reactor cannot read it directly — the `context-window.updated`
activity is the correct, already-available hook.

### Flow (per mid-run clear, inside `clearAndContinue`)

The clear path today is: `session.stop` → poll until stopped →
`unattended-run.advance` → `issueContinueTurn`. The markers slot in around it:

1. **Before-marker** — at the clear, dispatch `thread.activity.append` with kind
   `unattended.context-cleared` and payload
   `{ fromIteration, toIteration, usedTokens, maxTokens }`. Renders inline as:
   _"⏳ Context cleared · iter 4 → 5 · before 517k / 1M (52%)."_
2. Set a per-thread "awaiting fresh reading" flag.
3. **After-marker** — when the fresh session emits its **first**
   `context-window.updated` after the clear, dispatch `unattended.context-fresh`
   with the new `{ iteration, usedTokens, maxTokens }`, then clear the flag
   (strictly one-shot). Renders inline as:
   _"✓ Fresh context · iter 5 · now 4k / 1M (0.4%)."_

The reactor emitting `thread.activity.append` produces more
`thread.activity-appended` events, but their kinds (`unattended.context-cleared`
/ `unattended.context-fresh`) are ignored by the reactor's own handlers — no loop.

### Rendering

`context-window.updated` is currently filtered out of the timeline
(`session-logic.ts:636`). The two new kinds get the **opposite** treatment: an
explicit, visible inline row, styled compactly and distinctly so a clear is
scannable in scrollback. Contained change in `session-logic.ts` plus a small row
renderer.

### Edge cases

- Markers emit only while `unattendedRun.status === "running"`.
- If no `context-window.updated` was ever seen for the thread (no usage reported
  yet), the before-marker shows "—"/unknown rather than a fabricated number.
- The after-marker is one-shot per iteration: subsequent usage updates within the
  iteration do not append more markers.
- These markers are additive activities; they do not alter the clear logic, the
  `awaiting-input` pause path, or completion behavior.

## Part B — Earlier wrap (preamble budget)

A pure text change to `buildUnattendedPreamble` in `unattendedRun.ts`. Add a
concrete, model-agnostic budget expressed as a percentage of the context window
(holds across models/context sizes):

> "Treat about 35% of your context window as your wrap ceiling. When you cross
> it, finish your current step, invoke your wrap skill, and emit the sentinel —
> don't keep going to a 'natural' stopping point. Wrapping early and often is
> correct here."

No new machinery, no reactor enforcement. This is a soft signal (the same channel
that previously allowed ~52%); the number is a starting point to tune.

## Testing

- **Reactor** (`UnattendedRunReactor.test.ts`):
  - After a `context-window.updated` activity is seen, a mid-run clear emits an
    `unattended.context-cleared` marker carrying the last tracked usage.
  - The first `context-window.updated` after a clear emits exactly one
    `unattended.context-fresh` marker; a second usage update emits no further
    marker.
  - No markers are emitted when there is no running unattended run.
- **Preamble** (`unattendedRun` test): `buildUnattendedPreamble` output contains
  the wrap-budget guidance.
- **Web** (`session-logic` test): the two new kinds produce visible timeline rows
  (and `context-window.updated` remains filtered).

## Files

- `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts` — track latest
  context-window payload; emit before/after markers in `clearAndContinue` and on
  the first post-clear usage update.
- `apps/server/src/orchestration/unattendedRun.ts` — preamble wrap-budget text;
  marker activity-kind constants and/or small payload builders.
- `apps/web/src/session-logic.ts` (+ small row renderer) — render the two new
  kinds inline.
- Tests alongside each.

No contracts schema change is required: activity `kind` is a free-form
`TrimmedNonEmptyString` and the activity `payload` is `Schema.Unknown`.

## Open item (resolve in the implementation plan, not here)

Exact visual treatment of the inline marker row — icon/color, one-line vs.
two-line, how the percentage is formatted. Functionally the markers carry
`usedTokens` + `maxTokens`; presentation is a planning detail.
