# Persist Resume Cursor on Teardown (+ fail-fast recovery guard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the silent context reset where a looping Claude session, torn down by the idle reaper, loses its real resume cursor and binds a fresh empty conversation on the next user message.

**Architecture:** Two complementary changes in the provider layer. **Part B (primary):** `ProviderService.stopSession` flushes the adapter's _live_ in-memory resume cursor into the durable binding before teardown — mirroring the flush `runStopAll` already performs — so the reaper's single-thread teardown path stops dropping the advanced cursor. **Part C (defense-in-depth):** an optional, adapter-delegated `isResumableCursor` check lets `recoverSessionForThread` fail _visibly_ (validation error) when a persisted cursor exists but cannot actually be resumed, instead of silently minting a fresh session.

**Tech Stack:** TypeScript, Effect (effect-ts), `@effect/vitest`, SQLite-backed provider session directory. Tests run with `vp test run`.

## Global Constraints

- **Node version:** the harness shell defaults to Node v23.9.0, which is too old. Prepend the v24 toolchain to `PATH` for every `vp`/`tsgo` command: `export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"`.
- **All commands run from `apps/server/`** (`cd /home/chaz/projects/t3code/apps/server`).
- **Test runner:** `npx vp test run <relative-test-path>` (the package's `test` script is `vp test run`).
- **Typecheck:** `npx tsgo --noEmit` (the package's `typecheck` script).
- **Do not change the public `ProviderService` interface** for Part C. The only consumer (`recoverSessionForThread`) already holds the resolved `adapter`, so the new capability lives only on the per-adapter `ProviderAdapterShape` and is consumed inline. (See "Deviations from the settled design" below — flag to the operator at review if disagreement.)
- **Reset-safety must hold:** `ProviderCommandReactor` calls `stopSession` then conditionally `clearResumeCursor` (only when `resetContext === true`). Part B's flush must not change that ordering's outcome — a `resetContext` stop must still end with a null cursor.

### Deviations from the settled design (flag at plan review)

The design note settled on two points this plan refines for correctness/cleanliness; call them out to the operator:

1. **Part B uses the existing `upsertSessionBinding` helper** (the exact mechanism `runStopAll` already uses at `Layers/ProviderService.ts:1049-1056`) rather than an ad-hoc `freshCursor` local. Consistent with the established flush pattern; the trailing `directory.upsert({ status: "stopped", ... })` (no `resumeCursor`) then merges over it to mark the binding stopped while keeping the just-flushed cursor.
2. **Part C is wired internally, not through the public `ProviderService` interface.** The note suggested a `hasPendingBackgroundWork`-style passthrough on `ProviderService`. That passthrough iterates adapters _by threadId_, which does not fit a _cursor_-shaped check, and `recoverSessionForThread` already has the specific `adapter` in scope — so we consume `adapter.isResumableCursor` directly with a local fallback. No public-interface surface added (YAGNI).
3. **Part B's flush is tested in `ProviderService.test.ts`, not `ProviderSessionReaper.test.ts`.** The reaper test fully _mocks_ `providerService.stopSession`, so it cannot observe the flush; the real directory + fake adapter live in `ProviderService.test.ts`.

---

## File Structure

| File                                                      | Responsibility                | Change                                                                                                                                           |
| --------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/provider/Layers/ProviderService.ts`      | Provider orchestration layer  | **Modify** `stopSession` (~837-883) to flush the live cursor; **modify** `recoverSessionForThread` (~376-403) to gate recovery on `isResumable`. |
| `apps/server/src/provider/Services/ProviderAdapter.ts`    | Per-adapter contract          | **Modify** `ProviderAdapterShape<TError>` (~95-114) to add optional `isResumableCursor?`.                                                        |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`        | Claude adapter implementation | **Modify** to implement `isResumableCursor` (next to `hasPendingBackgroundWork`, ~4606) and add it to the returned object (~4640-4660).          |
| `apps/server/src/provider/Layers/ProviderService.test.ts` | ProviderService layer tests   | **Modify**: extend the fake-adapter factory with an optional `isResumableCursor`; add Part B flush test + Part C guard tests.                    |
| `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`   | Claude adapter tests          | **Modify**: add `isResumableCursor` unit tests.                                                                                                  |

No new files. `Services/ClaudeAdapter.ts` needs **no change** — `ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError>`, so the optional method is inherited automatically.

---

## Task 1: Part B — flush the live resume cursor on `stopSession` teardown

**Why:** The idle reaper tears down one session at a time via `ProviderService.stopSession` (`Layers/ProviderSessionReaper.ts:90`). Unlike `runStopAll`, `stopSession` does **not** flush the adapter's live cursor before calling `adapter.stopSession` (which discards the in-memory session). Loop iterations after the first are synthetic turns internal to the adapter, so the durable binding's cursor lags the live one; on teardown the stale (often resume-id-less) cursor persists and the next user message resumes from it → silent context reset.

**Files:**

- Modify: `apps/server/src/provider/Layers/ProviderService.ts:857-859` (inside `stopSession`)
- Test: `apps/server/src/provider/Layers/ProviderService.test.ts` (inside the `routing.layer("ProviderServiceLive routing", (it) => { ... })` block, near the existing "preserves the persisted binding when stopping a session" test ~959)

**Interfaces:**

- Consumes: `routed.adapter.listSessions(): Effect<ReadonlyArray<ProviderSession>>`, `routed.adapter.stopSession(threadId)`, the existing layer-local helper `upsertSessionBinding(session, threadId, extra?)` (defined ~266-290, which writes `session.resumeCursor` when defined), and `routed.instanceId`.
- Produces: no signature change to `stopSession`. Behavioral guarantee — after `stopSession` returns, the durable binding's `resumeCursor` equals the live session's cursor at teardown time (when a live session existed).

- [ ] **Step 1: Write the failing test**

Add this `it.effect` inside the `routing.layer("ProviderServiceLive routing", (it) => { ... })` block (e.g. immediately after the existing "preserves the persisted binding when stopping a session" test, ~line 959):

```typescript
it.effect("flushes the live resume cursor into the binding when stopping a session", () =>
  Effect.gen(function* () {
    const provider = yield* ProviderService;
    const runtimeRepository = yield* ProviderSessionRuntimeRepository;
    const threadId = asThreadId("thread-flush-on-stop");

    const initial = yield* provider.startSession(threadId, {
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: codexInstanceId,
      threadId,
      cwd: "/tmp/project-flush-on-stop",
      runtimeMode: "full-access",
    });

    // Synthetic loop turns advance the adapter's in-memory cursor past
    // whatever the durable binding last recorded at startSession time.
    const advancedCursor = {
      threadId: String(threadId),
      resume: "550e8400-e29b-41d4-a716-446655440000",
      resumeSessionAt: "assistant-message-7",
      turnCount: 7,
    };
    routing.codex.updateSession(threadId, (existing) => ({
      ...existing,
      resumeCursor: advancedCursor,
      updatedAt: "2026-01-01T00:00:05.000Z",
    }));

    yield* provider.stopSession({ threadId });

    const persisted = yield* runtimeRepository.getByThreadId({ threadId });
    assert.equal(Option.isSome(persisted), true);
    if (Option.isSome(persisted)) {
      assert.equal(persisted.value.status, "stopped");
      // Without the flush this would still be the start-time cursor.
      assert.deepEqual(persisted.value.resumeCursor, advancedCursor);
      assert.notDeepEqual(persisted.value.resumeCursor, initial.resumeCursor);
    }
  }),
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server
npx vp test run src/provider/Layers/ProviderService.test.ts -t "flushes the live resume cursor"
```

Expected: FAIL — the assertion `persisted.value.resumeCursor` deep-equals `{ opaque: "resume-thread-flush-on-stop" }` (the start-time cursor the fake set), not `advancedCursor`.

- [ ] **Step 3: Implement the flush in `stopSession`**

In `apps/server/src/provider/Layers/ProviderService.ts`, replace the existing active-session teardown block (currently lines 857-859):

```typescript
if (routed.isActive) {
  yield * routed.adapter.stopSession(routed.threadId);
}
```

with:

```typescript
if (routed.isActive) {
  // Flush the adapter's live resume cursor into the durable binding
  // BEFORE teardown discards the in-memory session. Loop iterations are
  // synthetic turns internal to the adapter, so the durable cursor lags
  // the live one; without this flush a reaped session resumes from a
  // stale (often resume-id-less) cursor and silently resets context.
  // Mirrors `runStopAll`, which does the same listSessions -> upsert
  // flush before `adapter.stopAll()`.
  const activeSessions = yield * routed.adapter.listSessions();
  const liveSession = activeSessions.find((session) => session.threadId === routed.threadId);
  if (liveSession !== undefined) {
    yield *
      upsertSessionBinding(
        { ...liveSession, providerInstanceId: routed.instanceId },
        input.threadId,
      );
  }
  yield * routed.adapter.stopSession(routed.threadId);
}
```

Leave the trailing `directory.upsert({ ..., status: "stopped", runtimePayload: { activeTurnId: null } })` (lines 861-869) **unchanged** — it omits `resumeCursor`, so the directory's merge keeps the cursor just flushed by `upsertSessionBinding` while marking the binding stopped.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
npx vp test run src/provider/Layers/ProviderService.test.ts -t "flushes the live resume cursor"
```

Expected: PASS.

- [ ] **Step 5: Run the full ProviderService suite to confirm no regression**

Run:

```bash
npx vp test run src/provider/Layers/ProviderService.test.ts
```

Expected: PASS. In particular the existing "preserves the persisted binding when stopping a session" (cursor unchanged → flushes the same value) and "clearResumeCursor drops the persisted cursor so the next start is fresh" (stop flushes, then `clearResumeCursor` nulls — clear still wins) must remain green.

- [ ] **Step 6: Typecheck**

Run:

```bash
npx tsgo --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/server/src/provider/Layers/ProviderService.ts apps/server/src/provider/Layers/ProviderService.test.ts
git commit -m "$(cat <<'EOF'
fix(provider): flush live resume cursor into the binding on stopSession

The idle reaper tears sessions down one at a time via stopSession, which
(unlike runStopAll) did not flush the adapter's live cursor before discarding
the in-memory session. Looping sessions advance their cursor on synthetic turns
the durable binding never sees, so a reaped session resumed from a stale,
resume-id-less cursor and silently reset context. Mirror runStopAll's
listSessions -> upsertSessionBinding flush before adapter.stopSession.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Part C — adapter-delegated `isResumableCursor` fail-fast recovery guard

**Why:** Even with Part B, a binding can legitimately end up holding a non-resumable cursor (e.g. a Claude `{ turnCount: 0 }` cursor with no `resume` uuid — exactly what gets flushed when a loop is torn down before its first real session id lands). `recoverSessionForThread` currently treats _any_ non-null cursor as resumable (`resumeCursor != null`) and proceeds to `startSession` with it, silently producing a fresh empty conversation. A non-resumable cursor should instead fail _visibly_. The check must be adapter-delegated because cursor shapes are provider-specific (Claude needs a `resume` uuid; Codex's valid cursor is just `{ threadId }`; OpenCode has none), so a generic field check would wrongly reject valid Codex/other recoveries.

### Task 2a: Add the optional `isResumableCursor` to the adapter contract

**Files:**

- Modify: `apps/server/src/provider/Services/ProviderAdapter.ts` (in `ProviderAdapterShape<TError>`, next to `hasPendingBackgroundWork?` ~104-114)

**Interfaces:**

- Produces: `readonly isResumableCursor?: (resumeCursor: unknown) => Effect.Effect<boolean>` on `ProviderAdapterShape<TError>`. Optional — adapters that omit it are treated by callers as "use the historical non-null check".

- [ ] **Step 1: Add the optional method to the shape**

In `apps/server/src/provider/Services/ProviderAdapter.ts`, immediately after the `hasPendingBackgroundWork?` declaration (which ends at line 114), insert:

```typescript

  /**
   * Whether a persisted resume cursor can actually be resumed by this adapter.
   * A non-null cursor is not necessarily resumable — e.g. a Claude binding can
   * carry a resume-id-less `{ turnCount: 0 }` cursor that cannot resurrect the
   * prior conversation. Cursor shapes are provider-specific (Claude needs a
   * `resume` uuid; Codex's valid cursor is just `{ threadId }`), so only the
   * owning adapter can judge resumability.
   *
   * Optional: adapters that omit it are treated by callers as "any non-null
   * cursor is resumable" (the historical behavior), so omitting it changes
   * nothing for them.
   */
  readonly isResumableCursor?: (resumeCursor: unknown) => Effect.Effect<boolean>;
```

- [ ] **Step 2: Typecheck (no behavior change yet)**

Run:

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server
npx tsgo --noEmit
```

Expected: no errors (purely additive optional member).

### Task 2b: Implement `isResumableCursor` on the Claude adapter (TDD)

**Files:**

- Modify: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (add the impl next to `hasPendingBackgroundWork` ~4606-4612; add it to the returned object ~4640-4660)
- Test: `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` (inside `describe("ClaudeAdapterLive", ...)`)

**Interfaces:**

- Consumes: the existing pure helper `readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined` (`ClaudeAdapter.ts:723`), which keeps `resume` only when it is a valid uuid.
- Produces: `isResumableCursor: (cursor) => Effect.Effect<boolean>` on the Claude adapter, returning `true` iff `readClaudeResumeState(cursor)?.resume !== undefined`.

- [ ] **Step 1: Write the failing unit tests**

In `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`, inside `describe("ClaudeAdapterLive", ...)`, add:

```typescript
it.effect("isResumableCursor is true for a cursor carrying a resume uuid", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const resumable = yield* adapter.isResumableCursor!({
      threadId: "thread-resumable",
      resume: "550e8400-e29b-41d4-a716-446655440000",
      resumeSessionAt: "assistant-message-3",
      turnCount: 3,
    });
    assert.equal(resumable, true);
  }).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
});

it.effect("isResumableCursor is false for a resume-id-less or empty cursor", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    // No `resume` field at all (the loop-teardown cursor shape).
    assert.equal(yield* adapter.isResumableCursor!({ turnCount: 0 }), false);
    // `resume` present but not a uuid -> readClaudeResumeState drops it.
    assert.equal(yield* adapter.isResumableCursor!({ resume: "not-a-uuid" }), false);
    // Null / non-object cursors.
    assert.equal(yield* adapter.isResumableCursor!(null), false);
    assert.equal(yield* adapter.isResumableCursor!(undefined), false);
  }).pipe(
    Effect.provideService(Random.Random, makeDeterministicRandomService()),
    Effect.provide(harness.layer),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npx vp test run src/provider/Layers/ClaudeAdapter.test.ts -t "isResumableCursor"
```

Expected: FAIL — `adapter.isResumableCursor` is `undefined` (TypeError: `adapter.isResumableCursor is not a function`).

- [ ] **Step 3: Implement `isResumableCursor` on the Claude adapter**

In `apps/server/src/provider/Layers/ClaudeAdapter.ts`, immediately after the `hasPendingBackgroundWork` const (which ends at line 4612), add:

```typescript
// A persisted Claude cursor is resumable only when it carries a real session
// `resume` uuid; `readClaudeResumeState` validates that. A resume-id-less
// cursor (e.g. `{ turnCount: 0 }`, which is what a loop torn down before its
// first durable session id flushes) is NOT resumable, so recovery must fail
// visibly rather than silently start a fresh conversation.
const isResumableCursor: NonNullable<ClaudeAdapterShape["isResumableCursor"]> = (resumeCursor) =>
  Effect.sync(() => readClaudeResumeState(resumeCursor)?.resume !== undefined);
```

Then add `isResumableCursor` to the returned object literal (the `return { ... } satisfies ClaudeAdapterShape` block, ~4640-4660) — place it next to `hasPendingBackgroundWork`:

```typescript
    hasPendingBackgroundWork,
    isResumableCursor,
    stopAll,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npx vp test run src/provider/Layers/ClaudeAdapter.test.ts -t "isResumableCursor"
```

Expected: PASS (both tests).

- [ ] **Step 5: Typecheck**

Run:

```bash
npx tsgo --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/server/src/provider/Services/ProviderAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.ts apps/server/src/provider/Layers/ClaudeAdapter.test.ts
git commit -m "$(cat <<'EOF'
feat(provider): add adapter-delegated isResumableCursor (Claude impl)

Cursor shapes are provider-specific, so only the owning adapter can tell a
resumable cursor from a non-resumable one. Add an optional isResumableCursor to
the adapter contract and implement it for Claude: resumable iff the cursor
carries a real session resume uuid. Wiring into recovery follows in the next
commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2c: Gate `recoverSessionForThread` on `isResumable` (TDD)

**Files:**

- Modify: `apps/server/src/provider/Layers/ProviderService.ts:376-398` (inside `recoverSessionForThread`)
- Test: `apps/server/src/provider/Layers/ProviderService.test.ts` — extend the fake-adapter factory (`makeFakeCodexAdapter`, ~91-258) with an optional `isResumableCursor`, then add guard tests.

**Interfaces:**

- Consumes: `adapter.isResumableCursor?` (Task 2a), the in-scope `adapter` (resolved at `ProviderService.ts:375`), and `input.binding.resumeCursor`.
- Produces: `recoverSessionForThread` now returns the existing `toValidationError(..., "no provider resume state is persisted")` when the persisted cursor is non-resumable; behavior is unchanged for adapters that do not implement `isResumableCursor`.

- [ ] **Step 1: Extend the fake-adapter factory to support `isResumableCursor`**

In `apps/server/src/provider/Layers/ProviderService.test.ts`, change the `makeFakeCodexAdapter` signature (line 91) and the adapter object literal (~206-225). First the signature:

```typescript
function makeFakeCodexAdapter(
  provider: ProviderDriverKind = CODEX_DRIVER,
  options?: {
    readonly isResumableCursor?: (resumeCursor: unknown) => boolean;
  },
) {
```

Then, in the `const adapter: ProviderAdapterShape<ProviderAdapterError> = { ... }` literal, add the optional member (only present when the test supplies it, so other tests keep an adapter that does not implement the method):

```typescript
const adapter: ProviderAdapterShape<ProviderAdapterError> = {
  provider,
  capabilities: {
    sessionModelSwitch: "in-session",
  },
  startSession,
  sendTurn,
  interruptTurn,
  respondToRequest,
  respondToUserInput,
  stopSession,
  listSessions,
  hasSession,
  readThread,
  rollbackThread,
  stopAll,
  ...(options?.isResumableCursor !== undefined
    ? {
        isResumableCursor: (resumeCursor: unknown) =>
          Effect.succeed(options.isResumableCursor!(resumeCursor)),
      }
    : {}),
  get streamEvents() {
    return Stream.fromPubSub(runtimeEventPubSub);
  },
};
```

(No change to the factory's return object is required — the tests below build their own standalone layers and reference the returned `adapter`/`updateSession` handles.)

- [ ] **Step 2: Write the failing guard test**

Add this standalone `it.effect` (NOT inside the `routing.layer` block — it builds its own layer, mirroring the existing self-contained tests near line 552/700). Place it after the `routing.layer(...)` block. It exercises Part B + Part C together: a loop flushes a non-resumable cursor on stop, then recovery refuses it.

```typescript
it.effect("recovery fails visibly when the persisted cursor is non-resumable", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter(CODEX_DRIVER, {
      // Mirror Claude semantics: resumable iff the cursor carries a `resume`.
      isResumableCursor: (cursor) =>
        typeof cursor === "object" &&
        cursor !== null &&
        typeof (cursor as { resume?: unknown }).resume === "string",
    });
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const services = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    const result = yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-nonresumable");

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-nonresumable",
        runtimeMode: "full-access",
      });

      // Loop torn down before a durable session id landed: live cursor has no
      // `resume`. Part B flushes this non-resumable cursor on stop.
      codex.updateSession(threadId, (existing) => ({
        ...existing,
        resumeCursor: { threadId: String(threadId), turnCount: 0 },
        updatedAt: "2026-01-01T00:00:05.000Z",
      }));
      yield* provider.stopSession({ threadId });

      // Next user turn triggers recovery; the guard must refuse the cursor.
      return yield* provider
        .sendTurn({ threadId, input: "next message", attachments: [] })
        .pipe(Effect.result);
    }).pipe(Effect.provide(services));

    yield* Scope.close(scope, Exit.void);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(Cause.pretty(result.cause), /no provider resume state is persisted/);
    }
  }),
);
```

Also add a companion test proving the default path (adapter WITHOUT `isResumableCursor`) is unchanged — a non-null opaque cursor still recovers:

```typescript
it.effect("recovery still succeeds for adapters that do not implement isResumableCursor", () =>
  Effect.gen(function* () {
    // No `isResumableCursor` option -> adapter omits the method entirely.
    const codex = makeFakeCodexAdapter(CODEX_DRIVER);
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const services = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    const turn = yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-default-recover");

      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-default-recover",
        runtimeMode: "full-access",
      });
      // Stop with the fake's default opaque (non-null) cursor intact.
      yield* provider.stopSession({ threadId });

      codex.startSession.mockClear();
      return yield* provider.sendTurn({
        threadId,
        input: "resume please",
        attachments: [],
      });
    }).pipe(Effect.provide(services));

    yield* Scope.close(scope, Exit.void);

    // Recovery re-started the session (no validation failure).
    assert.equal(codex.startSession.mock.calls.length, 1);
    assert.equal(String(turn.threadId), "thread-default-recover");
  }),
);
```

> Confirm `Cause` and `Exit` are imported at the top of the test file; if not, add `import * as Cause from "effect/Cause";` / `import * as Exit from "effect/Exit";` (match the existing `effect/*` import style in the file).

- [ ] **Step 3: Run the tests to verify the guard test fails (and the default test passes)**

Run:

```bash
npx vp test run src/provider/Layers/ProviderService.test.ts -t "non-resumable"
npx vp test run src/provider/Layers/ProviderService.test.ts -t "do not implement isResumableCursor"
```

Expected: the **non-resumable** test FAILS — without the guard, recovery proceeds (`result._tag === "Success"`), so the `assert.equal(result._tag, "Failure")` fails. The **default** test should already PASS (behavior unchanged).

- [ ] **Step 4: Implement the guard in `recoverSessionForThread`**

In `apps/server/src/provider/Layers/ProviderService.ts`, replace the `hasResumeCursor` computation (lines 376-377):

```typescript
const hasResumeCursor =
  input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
```

with:

```typescript
const hasResumeCursor =
  input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
// A non-null cursor is not necessarily *resumable*: a Claude binding can
// carry a resume-id-less cursor (e.g. `{ turnCount: 0 }`) flushed when a
// loop is torn down before its first durable session id lands. Adapters
// that can tell the difference implement `isResumableCursor`; those that
// don't keep the historical non-null behavior.
const isResumable =
  adapter.isResumableCursor === undefined
    ? hasResumeCursor
    : hasResumeCursor && yield * adapter.isResumableCursor(input.binding.resumeCursor);
```

Then change the guard at line 398 from `if (!hasResumeCursor) {` to:

```typescript
      if (!isResumable) {
```

Leave line 416 (`...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {})`) unchanged — it is only reached after the guard, where `isResumable === true` implies `hasResumeCursor === true`.

- [ ] **Step 5: Run the guard tests to verify they pass**

Run:

```bash
npx vp test run src/provider/Layers/ProviderService.test.ts -t "non-resumable"
npx vp test run src/provider/Layers/ProviderService.test.ts -t "do not implement isResumableCursor"
```

Expected: both PASS.

- [ ] **Step 6: Run the full ProviderService suite**

Run:

```bash
npx vp test run src/provider/Layers/ProviderService.test.ts
```

Expected: PASS — the new factory parameter is optional, so existing tests (whose adapters omit `isResumableCursor`) keep the historical non-null recovery behavior.

- [ ] **Step 7: Typecheck**

Run:

```bash
npx tsgo --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/server/src/provider/Layers/ProviderService.ts apps/server/src/provider/Layers/ProviderService.test.ts
git commit -m "$(cat <<'EOF'
fix(provider): fail recovery visibly on a non-resumable persisted cursor

recoverSessionForThread treated any non-null cursor as resumable and silently
started a fresh conversation when it wasn't. Gate recovery on the adapter's
isResumableCursor (when implemented) so a resume-id-less cursor returns the
existing "no provider resume state is persisted" validation error instead of a
silent context reset. Adapters without the method keep the prior behavior.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Full-suite verification & wrap-up

**Files:** none (verification only).

- [ ] **Step 1: Run the three touched suites together**

Run:

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server
npx vp test run src/provider/Layers/ProviderService.test.ts src/provider/Layers/ClaudeAdapter.test.ts src/provider/Layers/ProviderSessionReaper.test.ts
```

Expected: all PASS. (The reaper suite is unchanged but is run to confirm the `stopSession` flush didn't perturb anything it depends on.)

- [ ] **Step 2: Typecheck the whole server package**

Run:

```bash
npx tsgo --noEmit
```

Expected: no errors.

- [ ] **Step 3: Decide on daemon redeploy (operator call — do not run unprompted)**

Open question carried from the design: after this lands on `main`, redeploy the daemon (`pnpm daemon:deploy` from main) so it carries B+C, or wait? Bug A is already live via an identical old-branch commit. Surface this to the operator rather than deciding unilaterally.

---

## Self-Review

**1. Spec coverage** (against the settled design in `CONTINUE.md` / `looping-ultracode-reaper-context-reset.md`):

- Part B (flush-on-teardown, generic, no adapter-interface change) → Task 1. ✔
- Part C (fail-fast guard, adapter-delegated, optional method) → Tasks 2a/2b/2c. ✔
- Reset-safety (stop→clear ordering preserved) → asserted by the existing "clearResumeCursor drops the persisted cursor" test re-run in Task 1 Step 5. ✔
- Method named `isResumableCursor` (operator's choice) → Task 2a. ✔
- Codex/other adapters unaffected (their valid `{ threadId }`-only cursor must not be rejected) → they omit `isResumableCursor`; default branch keeps `hasResumeCursor`; covered by Task 2c Step 2's "do not implement isResumableCursor" test. ✔

**2. Placeholder scan:** no TBD/TODO/"add error handling"/"similar to Task N"; every code step shows complete code. ✔

**3. Type consistency:**

- `isResumableCursor` signature is identical everywhere: `(resumeCursor: unknown) => Effect.Effect<boolean>` (contract in 2a; Claude impl in 2b via `NonNullable<ClaudeAdapterShape["isResumableCursor"]>`; fake wraps a `(cursor: unknown) => boolean` in `Effect.succeed`). ✔
- `upsertSessionBinding(session, threadId, extra?)` used in Task 1 matches its definition (`ProviderService.ts:266-290`) and `runStopAll`'s call site. ✔
- Guard variable `isResumable` defined once and used at the guard; `hasResumeCursor` retained for line 416. ✔

**Open risk to watch during implementation:** `makeProviderServiceLive` is invoked with no args in Task 2c's standalone layers — confirm the existing zero-arg call sites (e.g. line 292/335) match; if the signature requires an options object, pass `{}` as the sibling tests do.
