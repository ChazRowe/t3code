# Looping (unattended-run) Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global **Looping** settings page that makes the unattended-run preamble, continue message, and wrap sentinel user-editable (empty = built-in default), plus a toggle to append the previous iteration's final assistant message to the continue message.

**Architecture:** A new nested `unattendedRun` struct on `ServerSettings` (server-authoritative, because the reactor cannot read browser `localStorage`). The `UnattendedRunReactor` injects `ServerSettingsService` and reads the config fresh at each iteration boundary, falling back to built-in defaults per field. The web Settings UI edits the struct through the existing `useSettings`/`splitPatch` pipeline, which routes any `ServerSettings` key to the server patch automatically.

**Tech Stack:** TypeScript, Effect (Schema, Layer, Service), `vite-plus/test` (`vp test`), `@effect/vitest`, React + TanStack Router (file-based routes), base-ui components.

## Global Constraints

These apply to **every** task. Exact values, copied from the approved spec (`docs/superpowers/specs/2026-06-27-looping-settings-design.md`):

- **Node 24 toolchain for all tests.** The harness default Node is too old. Before running any test/typecheck command, prepend the v24 bin to `PATH`:
  `export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"`
- **Empty string = use the built-in default.** Every text field (`preamble`, `continueMessage`, `sentinel`) falls back to its built-in default when empty. There is no "disabled" state.
- **Raw text, sent verbatim — NO token/placeholder substitution.** Prompts are stored and sent exactly as typed.
- **Storage is `ServerSettings` only** (not per-thread, not client `localStorage`). The struct is a single nested `unattendedRun` object.
- **Append rule:** when `appendLastAgentMessage` is on, walk the iteration's assistant messages backward, take the first one that is non-empty **after stripping any sentinel-only line(s)**, and plain-append it after the continue text with a `\n\n` separator (no header/label). If none qualifies, append nothing.
- **Live edits apply to the next iteration, never the one already running** (config read fresh at the iteration boundary).
- **Default constants are shared.** `WRAP_SENTINEL` (`"<<WRAP_COMPLETE>>"`) and `CONTINUE_MESSAGE` live in `packages/contracts/src/settings.ts` and are re-exported from `apps/server/src/orchestration/unattendedRun.ts` so server, web, and tests share one source of truth.

## File Structure

| File                                                                | Responsibility                                                                                                                                                 | Tasks   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `packages/contracts/src/settings.ts`                                | `UnattendedRunSettings` struct, `unattendedRun` on `ServerSettings` + `ServerSettingsPatch`, relocated `WRAP_SENTINEL` / `CONTINUE_MESSAGE` constants          | 1       |
| `packages/contracts/src/settings.test.ts`                           | Decode/defaults/patch round-trip for the new struct                                                                                                            | 1       |
| `apps/server/src/orchestration/unattendedRun.ts`                    | Re-export constants; `buildUnattendedPreamble`/`messageHasWrapSentinel` accept effective sentinel; new pure `stripSentinelLine` + `resolveAppendedLastMessage` | 1, 2, 3 |
| `apps/server/src/orchestration/unattendedRun.test.ts`               | Unit tests for the helpers above                                                                                                                               | 2, 3    |
| `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`      | Inject `ServerSettingsService`; effective sentinel for preamble + detection; custom continue message; iteration-scoped assistant-message accumulator + append  | 4, 5    |
| `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts` | Harness `ServerSettings` override; reactor behavior tests                                                                                                      | 4, 5    |
| `apps/web/src/components/ui/draft-textarea.tsx`                     | New multiline commit-on-blur input (Enter inserts a newline, does NOT commit)                                                                                  | 6       |
| `apps/web/src/components/settings/loopingSettings.ts`               | Pure `preambleMissingEffectiveSentinel` warning helper                                                                                                         | 7       |
| `apps/web/src/components/settings/loopingSettings.test.ts`          | Unit test for the warning helper                                                                                                                               | 7       |
| `apps/web/src/components/settings/LoopingSettings.tsx`              | `LoopingSettingsPanel` (4 controls + reset buttons + placeholders + warning)                                                                                   | 7       |
| `apps/web/src/routes/settings.looping.tsx`                          | Route that renders the panel                                                                                                                                   | 7       |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`           | Register the "Looping" nav item + `SettingsSectionPath` member                                                                                                 | 7       |

---

## Task 1: Contracts — `unattendedRun` struct + shared default constants

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Modify: `apps/server/src/orchestration/unattendedRun.ts` (relocate constants; re-export)
- Test: `packages/contracts/src/settings.test.ts`

**Interfaces:**

- Produces: `UnattendedRunSettings` (`{ preamble: string; continueMessage: string; sentinel: string; appendLastAgentMessage: boolean }`); `unattendedRun` field on `ServerSettings` and `ServerSettingsPatch`; `WRAP_SENTINEL: string`, `CONTINUE_MESSAGE: string` exported from `@t3tools/contracts` and re-exported from `unattendedRun.ts`.

- [ ] **Step 1: Write the failing contracts test**

Append to `packages/contracts/src/settings.test.ts`:

```ts
import { CONTINUE_MESSAGE, WRAP_SENTINEL } from "./settings.ts";

describe("ServerSettings.unattendedRun", () => {
  it("defaults every field to empty/false so legacy configs decode unchanged", () => {
    expect(DEFAULT_SERVER_SETTINGS.unattendedRun).toEqual({
      preamble: "",
      continueMessage: "",
      sentinel: "",
      appendLastAgentMessage: false,
    });
  });

  it("decodes a fully empty config without the key", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.unattendedRun.preamble).toBe("");
    expect(decoded.unattendedRun.appendLastAgentMessage).toBe(false);
  });

  it("decodes provided unattendedRun values and trims the strings", () => {
    const decoded = decodeServerSettings({
      unattendedRun: {
        preamble: "  custom preamble  ",
        continueMessage: "  resume  ",
        sentinel: "  <<DONE>>  ",
        appendLastAgentMessage: true,
      },
    });
    expect(decoded.unattendedRun).toEqual({
      preamble: "custom preamble",
      continueMessage: "resume",
      sentinel: "<<DONE>>",
      appendLastAgentMessage: true,
    });
  });

  it("accepts a partial unattendedRun patch", () => {
    const patch = decodeServerSettingsPatch({
      unattendedRun: { sentinel: "  <<DONE>>  " },
    });
    expect(patch.unattendedRun).toEqual({ sentinel: "<<DONE>>" });
  });

  it("exposes the shared default constants", () => {
    expect(WRAP_SENTINEL).toBe("<<WRAP_COMPLETE>>");
    expect(CONTINUE_MESSAGE.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/packages/contracts && npx vp test run src/settings.test.ts
```

Expected: FAIL — `unattendedRun` undefined / `WRAP_SENTINEL` not exported.

- [ ] **Step 3: Add the constants + struct to `settings.ts`**

In `packages/contracts/src/settings.ts`, add immediately **after** `ObservabilitySettings` (after line 362, before `DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL`):

```ts
// ── Unattended-run (looping) settings ──────────────────────────

/** Sentinel the agent prints on its own line after wrapping an iteration. */
export const WRAP_SENTINEL = "<<WRAP_COMPLETE>>";

/** Message sent for iterations 2..N after the context is cleared. */
export const CONTINUE_MESSAGE =
  "continue — invoke your continue skill to re-orient from the handoff, then resume the unattended run without waiting for me.";

/**
 * User-tunable unattended-run prompts. Each text field is RAW TEXT sent
 * verbatim; an EMPTY field means "use the built-in default" (model-aware
 * preamble / `CONTINUE_MESSAGE` / `WRAP_SENTINEL`).
 */
export const UnattendedRunSettings = Schema.Struct({
  preamble: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  continueMessage: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sentinel: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  appendLastAgentMessage: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type UnattendedRunSettings = typeof UnattendedRunSettings.Type;
```

Add the field to the `ServerSettings` struct, immediately after the `observability:` line (line 407):

```ts
  unattendedRun: UnattendedRunSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
```

Add the patch field to `ServerSettingsPatch`, immediately after the `providerInstances:` patch line (after line 505):

```ts
  unattendedRun: Schema.optionalKey(
    Schema.Struct({
      preamble: Schema.optionalKey(TrimmedString),
      continueMessage: Schema.optionalKey(TrimmedString),
      sentinel: Schema.optionalKey(TrimmedString),
      appendLastAgentMessage: Schema.optionalKey(Schema.Boolean),
    }),
  ),
```

(`DEFAULT_SERVER_SETTINGS` is derived via `Schema.decodeSync(ServerSettings)({})` at line 411, so the new struct is produced automatically; `applyServerSettingsPatch`/`stripDefaultServerSettings`/`redactServerSettingsForClient` all handle a new nested struct generically — no other contract/shared changes needed.)

- [ ] **Step 4: Relocate the constants out of `unattendedRun.ts` and re-export them**

In `apps/server/src/orchestration/unattendedRun.ts`:

Delete the local definition of `WRAP_SENTINEL` (line 2) and `CONTINUE_MESSAGE` (lines 71-73). Add a re-export at the top of the file (above `messageHasWrapSentinel`):

```ts
import { CONTINUE_MESSAGE, WRAP_SENTINEL } from "@t3tools/contracts";

// Re-exported so existing importers (`./unattendedRun.ts`) keep working and
// the web/contracts share one source of truth for the defaults.
export { CONTINUE_MESSAGE, WRAP_SENTINEL };
```

Leave `messageHasWrapSentinel` referencing `WRAP_SENTINEL` as today (it is now the imported constant). All other importers (`UnattendedRunReactor.ts`, both test files) import these from `./unattendedRun.ts` and continue to work unchanged.

- [ ] **Step 5: Run the contracts test + typecheck**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/packages/contracts && npx vp test run src/settings.test.ts
npx tsgo --noEmit
cd /home/chaz/projects/t3code/apps/server && npx tsgo --noEmit
```

Expected: contracts test PASS; both typechecks clean.

- [ ] **Step 6: Commit**

```bash
cd /home/chaz/projects/t3code
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts apps/server/src/orchestration/unattendedRun.ts
git commit -m "feat(contracts): add unattendedRun settings struct + share default constants"
```

---

## Task 2: Server — effective sentinel in `buildUnattendedPreamble` + `messageHasWrapSentinel`

**Files:**

- Modify: `apps/server/src/orchestration/unattendedRun.ts`
- Test: `apps/server/src/orchestration/unattendedRun.test.ts`

**Interfaces:**

- Consumes: `WRAP_SENTINEL` (Task 1).
- Produces: `buildUnattendedPreamble(totalIterations: number, model?: string | null, sentinel?: string): string` (defaults `sentinel = WRAP_SENTINEL`); `messageHasWrapSentinel(text: string, sentinel?: string): boolean` (defaults `sentinel = WRAP_SENTINEL`).

- [ ] **Step 1: Write the failing tests**

Add to the `describe("unattended run constants", ...)` block in `apps/server/src/orchestration/unattendedRun.test.ts`:

```ts
it("embeds a custom sentinel in the preamble when one is passed", () => {
  const preamble = buildUnattendedPreamble(5, "gpt-5-codex", "<<DONE>>");
  expect(preamble).toContain("<<DONE>>");
  expect(preamble).not.toContain(WRAP_SENTINEL);
});

it("defaults the preamble sentinel to WRAP_SENTINEL when none is passed", () => {
  expect(buildUnattendedPreamble(5)).toContain(WRAP_SENTINEL);
});

it("detects a custom sentinel and ignores the default when a custom one is set", () => {
  expect(messageHasWrapSentinel("all done\n<<DONE>>", "<<DONE>>")).toBe(true);
  expect(messageHasWrapSentinel(`all done\n${WRAP_SENTINEL}`, "<<DONE>>")).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/unattendedRun.test.ts
```

Expected: FAIL — `buildUnattendedPreamble` ignores the 3rd arg; `messageHasWrapSentinel` ignores the 2nd arg.

- [ ] **Step 3: Thread the sentinel parameter through both functions**

In `apps/server/src/orchestration/unattendedRun.ts`:

Change `messageHasWrapSentinel` to:

```ts
/** True when the agent's final message signals a completed wrap. */
export const messageHasWrapSentinel = (text: string, sentinel: string = WRAP_SENTINEL): boolean =>
  text.includes(sentinel);
```

Change `buildUnattendedPreamble`'s signature and the embedded sentinel line:

```ts
export const buildUnattendedPreamble = (
  totalIterations: number,
  model: string | null | undefined = null,
  sentinel: string = WRAP_SENTINEL,
): string => {
```

In the returned array, replace the bare `WRAP_SENTINEL,` entry (currently line 39) with `sentinel,`. Leave the rest of the preamble text unchanged.

- [ ] **Step 4: Run to verify the tests pass**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/unattendedRun.test.ts
npx tsgo --noEmit
```

Expected: PASS; typecheck clean. (Existing one-arg calls still pass via the default.)

- [ ] **Step 5: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/server/src/orchestration/unattendedRun.ts apps/server/src/orchestration/unattendedRun.test.ts
git commit -m "feat(unattended): accept an effective sentinel in preamble + detection"
```

---

## Task 3: Server — pure `stripSentinelLine` + `resolveAppendedLastMessage`

**Files:**

- Modify: `apps/server/src/orchestration/unattendedRun.ts`
- Test: `apps/server/src/orchestration/unattendedRun.test.ts`

**Interfaces:**

- Produces:
  - `stripSentinelLine(text: string, sentinel: string): string` — removes any line equal to the sentinel after trimming, preserving the rest; the overall result is trimmed.
  - `resolveAppendedLastMessage(messages: readonly string[], sentinel: string): string | null` — walks `messages` backward, returns the first non-empty `stripSentinelLine` result, else `null`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `apps/server/src/orchestration/unattendedRun.test.ts`. Also add `stripSentinelLine` and `resolveAppendedLastMessage` to the existing import from `./unattendedRun.ts` at the top of the file.

```ts
describe("stripSentinelLine", () => {
  it("removes a standalone sentinel line and trims the result", () => {
    expect(stripSentinelLine("did the work\n<<WRAP_COMPLETE>>", "<<WRAP_COMPLETE>>")).toBe(
      "did the work",
    );
  });

  it("removes a sentinel line surrounded by whitespace", () => {
    expect(stripSentinelLine("  <<WRAP_COMPLETE>>  ", "<<WRAP_COMPLETE>>")).toBe("");
  });

  it("preserves text on either side of the sentinel line", () => {
    expect(stripSentinelLine("line a\n<<WRAP_COMPLETE>>\nline b", "<<WRAP_COMPLETE>>")).toBe(
      "line a\nline b",
    );
  });

  it("leaves text without the sentinel unchanged", () => {
    expect(stripSentinelLine("nothing to strip", "<<WRAP_COMPLETE>>")).toBe("nothing to strip");
  });
});

describe("resolveAppendedLastMessage", () => {
  it("returns the latest message with its sentinel line stripped", () => {
    expect(
      resolveAppendedLastMessage(
        ["older", "final summary\n<<WRAP_COMPLETE>>"],
        "<<WRAP_COMPLETE>>",
      ),
    ).toBe("final summary");
  });

  it("falls back to the previous message when the latest is a standalone sentinel", () => {
    expect(
      resolveAppendedLastMessage(["substantive work", "<<WRAP_COMPLETE>>"], "<<WRAP_COMPLETE>>"),
    ).toBe("substantive work");
  });

  it("returns null when nothing substantive remains", () => {
    expect(
      resolveAppendedLastMessage(["<<WRAP_COMPLETE>>", "   "], "<<WRAP_COMPLETE>>"),
    ).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(resolveAppendedLastMessage([], "<<WRAP_COMPLETE>>")).toBeNull();
  });

  it("picks the latest qualifying message from a longer list", () => {
    expect(
      resolveAppendedLastMessage(["a", "b", "c\n<<WRAP_COMPLETE>>"], "<<WRAP_COMPLETE>>"),
    ).toBe("c");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/unattendedRun.test.ts
```

Expected: FAIL — `stripSentinelLine` / `resolveAppendedLastMessage` not exported.

- [ ] **Step 3: Implement the helpers**

In `apps/server/src/orchestration/unattendedRun.ts`, add after `messageHasWrapSentinel`:

```ts
/**
 * Remove any line consisting solely of the sentinel (after trimming),
 * preserving surrounding text. The overall result is trimmed so a message
 * that is only a sentinel collapses to "".
 */
export const stripSentinelLine = (text: string, sentinel: string): string =>
  text
    .split("\n")
    .filter((line) => line.trim() !== sentinel)
    .join("\n")
    .trim();

/**
 * Walk discrete assistant messages backward and return the first one that is
 * non-empty after `stripSentinelLine` (so a standalone-sentinel message is
 * skipped in favor of the prior substantive one). Returns null if none qualify.
 */
export const resolveAppendedLastMessage = (
  messages: readonly string[],
  sentinel: string,
): string | null => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const stripped = stripSentinelLine(messages[index] ?? "", sentinel);
    if (stripped.length > 0) {
      return stripped;
    }
  }
  return null;
};
```

- [ ] **Step 4: Run to verify the tests pass**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/unattendedRun.test.ts
npx tsgo --noEmit
```

Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/server/src/orchestration/unattendedRun.ts apps/server/src/orchestration/unattendedRun.test.ts
git commit -m "feat(unattended): add stripSentinelLine + resolveAppendedLastMessage helpers"
```

---

## Task 4: Reactor — inject `ServerSettingsService`; effective sentinel + custom preamble

**Files:**

- Modify: `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`
- Test: `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`

**Interfaces:**

- Consumes: `ServerSettingsService` (`apps/server/src/serverSettings.ts`); `UnattendedRunSettings`, `DEFAULT_SERVER_SETTINGS` (`@t3tools/contracts`); `buildUnattendedPreamble`, `messageHasWrapSentinel`, `WRAP_SENTINEL` (Task 2).
- Produces: reactor reads `unattendedRun` config fresh; the built-in preamble embeds the effective sentinel; wrap detection uses the effective sentinel; a custom non-empty `preamble` overrides the built-in. `projectionTurnHasWrapSentinel(thread, sentinel?)` gains an optional sentinel param (default `WRAP_SENTINEL`). New test harness signature: `makeTestLayer(unattendedRun?: DeepPartial<ServerSettings["unattendedRun"]>)`.

**Note on layer wiring:** `UnattendedRunReactorLive` and `ProviderCommandReactorLive` are both merged in `ReactorLayerLive` (`apps/server/src/server.ts:159-168`), and `ServerSettingsLive` is provided to that stack (`server.ts:317`). `ProviderCommandReactor` already injects `ServerSettingsService` through this exact composition, so adding the dependency to this reactor needs **no** wiring change.

- [ ] **Step 1: Write the failing reactor tests**

First, extend the test harness so a test can configure `unattendedRun`. In `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`:

Add imports near the top:

```ts
import type { DeepPartial } from "@t3tools/shared/Struct";
import type { ServerSettings } from "@t3tools/contracts";
import { ServerSettingsService } from "../../serverSettings.ts";
```

Change `makeTestLayer` to accept overrides and provide the settings layer (replace the existing `const makeTestLayer = () => {` signature and add the merge):

```ts
const makeTestLayer = (unattendedRun: DeepPartial<ServerSettings["unattendedRun"]> = {}) => {
```

…and add this line to the `UnattendedRunReactorLive.pipe(...)` chain (alongside the other `Layer.provideMerge` calls, before `NodeServices.layer`):

```ts
    Layer.provideMerge(ServerSettingsService.layerTest({ unattendedRun })),
```

Now add the new behavior tests at the end of the file:

```ts
effectIt.effect("uses a custom preamble verbatim when one is configured", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    const thread = yield* harness.readThread;
    const userMessages = thread?.messages.filter((m) => m.role === "user") ?? [];
    assert.strictEqual(userMessages.length, 1);
    assert.strictEqual(userMessages[0]?.text, "CUSTOM PREAMBLE");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ preamble: "CUSTOM PREAMBLE" })))),
);

effectIt.effect("advances on a configured custom sentinel (not the default)", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("custom", "work done\n<<DONE>>");

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.currentIteration, 2);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ sentinel: "<<DONE>>" })))),
);

effectIt.effect("does not advance on the default sentinel when a custom one is configured", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("default", `work done\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    assert.strictEqual(thread?.unattendedRun?.currentIteration, 1);
    assert.strictEqual(thread?.unattendedRun?.status, "running");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ sentinel: "<<DONE>>" })))),
);
```

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts
```

Expected: FAIL — the reactor ignores `unattendedRun` config (uses the built-in preamble and the default sentinel). Compilation of the harness change may also surface the missing `ServerSettingsService` provision; that resolves once Step 3 injects it.

- [ ] **Step 3: Inject the service and use the effective config in the reactor**

In `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`:

Add imports:

```ts
import { DEFAULT_SERVER_SETTINGS, type UnattendedRunSettings } from "@t3tools/contracts";
import { WRAP_SENTINEL } from "../unattendedRun.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
```

(Add `WRAP_SENTINEL` to the existing import from `../unattendedRun.ts`. The existing `buildUnattendedPreamble` / `messageHasWrapSentinel` imports stay.)

Change `projectionTurnHasWrapSentinel` to accept an effective sentinel (keep a default so other call sites/tests are unaffected):

```ts
const projectionTurnHasWrapSentinel = (
  thread: OrchestrationThread,
  sentinel: string = WRAP_SENTINEL,
): boolean => {
  const turnId = thread.latestTurn?.turnId;
  if (!turnId) return false;
  return thread.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.turnId === turnId &&
      messageHasWrapSentinel(message.text, sentinel),
  );
};
```

Inside `make`, after the other service acquisitions (e.g. after `const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;`), add:

```ts
const serverSettingsService = yield * ServerSettingsService;

// Read the unattended-run config fresh; fall back to built-in defaults if the
// settings read ever fails so a config error never faults a running loop.
const readUnattendedConfig: Effect.Effect<UnattendedRunSettings> =
  serverSettingsService.getSettings.pipe(
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
    Effect.map((settings) => settings.unattendedRun),
  );

const effectiveSentinel = (cfg: UnattendedRunSettings): string => cfg.sentinel || WRAP_SENTINEL;
```

In `handleSessionSet`, after the `run.status !== "running"` guard and before computing `hasSentinel`, read the config and compute the effective sentinel:

```ts
const cfg = yield * readUnattendedConfig;
const sentinel = effectiveSentinel(cfg);
```

Change the `hasSentinel` computation to pass the effective sentinel to both detectors:

```ts
const hasSentinel =
  messageHasWrapSentinel(latestAssistantText.get(threadId) ?? "", sentinel) ||
  projectionTurnHasWrapSentinel(thread, sentinel);
```

In the `thread.unattended-run-started` case (in `processEvent`), read the config and choose the preamble. Replace the `text: buildUnattendedPreamble(...)` block with:

```ts
const cfg = yield * readUnattendedConfig;
const preambleText =
  cfg.preamble ||
  buildUnattendedPreamble(
    event.payload.totalIterations,
    thread.modelSelection.model,
    effectiveSentinel(cfg),
  );
yield *
  orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: yield * serverCommandId("unattended-preamble"),
    threadId: thread.id,
    message: {
      messageId: yield * freshMessageId,
      role: "user",
      text: preambleText,
      attachments: [],
    },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: yield * nowIso,
  });
return;
```

- [ ] **Step 4: Run to verify the tests pass**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts
npx tsgo --noEmit
```

Expected: all reactor tests PASS (including the pre-existing ones, which run with default config); typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/server/src/orchestration/Layers/UnattendedRunReactor.ts apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts
git commit -m "feat(unattended): read settings for effective sentinel + custom preamble"
```

---

## Task 5: Reactor — custom continue message + append-last-agent-message

**Files:**

- Modify: `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`
- Test: `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`

**Interfaces:**

- Consumes: `readUnattendedConfig`, `effectiveSentinel` (Task 4); `resolveAppendedLastMessage`, `CONTINUE_MESSAGE` (Tasks 1/3).
- Produces: continue text = `cfg.continueMessage || CONTINUE_MESSAGE`, with the resolved last message plain-appended (`\n\n`) when `cfg.appendLastAgentMessage` is on. An iteration-scoped, `messageId`-keyed accumulator of assistant messages, reset at the iteration boundary (run start + context clear), drives `resolveAppendedLastMessage`.

**Design note (resolves the spec's open question):** `thread.message-sent` fires once **per streamed chunk**, reusing the same `messageId` across a message's chunks and assigning a **new** `messageId` per discrete message/segment (`apps/server/src/orchestration/decider.ts:660-711`; payload schema `packages/contracts/src/orchestration.ts:1045-1055`). So discrete messages are reconstructed by accumulating delta text **keyed by `messageId`**. The accumulator is reset at the **iteration** boundary (not the turn boundary), so it survives an iteration that spans multiple turns. The projection-array alternative was rejected for v1: the projection has no clean per-iteration boundary marker, whereas this in-memory map is naturally iteration-scoped and self-contained. After a reactor restart mid-iteration the map is empty, so `resolveAppendedLastMessage` returns `null` and nothing is appended — a safe degradation.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`:

```ts
effectIt.effect("uses a custom continue message verbatim when configured", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("wrap", `done\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    const userMessages = thread?.messages.filter((m) => m.role === "user") ?? [];
    assert.strictEqual(userMessages[1]?.text, "RESUME NOW");
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ continueMessage: "RESUME NOW" })))),
);

effectIt.effect(
  "appends the last assistant message (sentinel stripped) when the toggle is on",
  () =>
    Effect.gen(function* () {
      const harness = yield* setupHarness();
      yield* harness.startUnattendedRun(2);

      yield* harness.driveTurnEnd("wrap", `did real work\n${WRAP_SENTINEL}`);

      const thread = yield* harness.readThread;
      const userMessages = thread?.messages.filter((m) => m.role === "user") ?? [];
      const continueText = userMessages[1]?.text ?? "";
      assert.ok(continueText.includes(CONTINUE_MESSAGE), continueText);
      assert.ok(continueText.endsWith("\n\ndid real work"), continueText);
      assert.ok(!continueText.includes(WRAP_SENTINEL), continueText);
    }).pipe(Effect.provide(Layer.fresh(makeTestLayer({ appendLastAgentMessage: true })))),
);

effectIt.effect("does not append the last assistant message when the toggle is off", () =>
  Effect.gen(function* () {
    const harness = yield* setupHarness();
    yield* harness.startUnattendedRun(2);

    yield* harness.driveTurnEnd("wrap", `did real work\n${WRAP_SENTINEL}`);

    const thread = yield* harness.readThread;
    const userMessages = thread?.messages.filter((m) => m.role === "user") ?? [];
    assert.strictEqual(userMessages[1]?.text, CONTINUE_MESSAGE);
  }).pipe(Effect.provide(Layer.fresh(makeTestLayer()))),
);
```

- [ ] **Step 2: Run to verify they fail**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts
```

Expected: FAIL — continue text is always `CONTINUE_MESSAGE`; no append.

- [ ] **Step 3: Add the accumulator, build the continue text, and thread the appended message through**

In `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`:

Add `resolveAppendedLastMessage` to the existing import from `../unattendedRun.ts`.

Add a per-thread accumulator next to the other `Map`s (after `latestAssistantText`):

```ts
// Per-thread, per-iteration map of assistant messageId -> accumulated text.
// `thread.message-sent` fires per streamed CHUNK reusing a messageId across a
// message's chunks; keying by messageId reconstructs discrete messages. Reset
// at the ITERATION boundary (run start + context clear), NOT at turn start, so
// it captures every assistant message of an iteration that spans turns.
const iterationAssistantMessages = new Map<string, Map<string, string>>();
```

Add a helper to build the continue text (place it near `effectiveSentinel`):

```ts
const buildContinueText = (cfg: UnattendedRunSettings, appendedMessage: string | null): string => {
  const base = cfg.continueMessage || CONTINUE_MESSAGE;
  return appendedMessage ? `${base}\n\n${appendedMessage}` : base;
};
```

Change `issueContinueTurn` to build the text from config + an optional appended message (read config fresh when not supplied, so resume/rehydrate honor a custom continue message):

```ts
const issueContinueTurn = Effect.fn("issueContinueTurn")(function* (
  thread: OrchestrationThread,
  options?: { readonly cfg?: UnattendedRunSettings; readonly appendedMessage?: string | null },
) {
  const cfg = options?.cfg ?? (yield* readUnattendedConfig);
  yield* orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: yield* serverCommandId("unattended-continue"),
    threadId: thread.id,
    message: {
      messageId: yield* freshMessageId,
      role: "user",
      text: buildContinueText(cfg, options?.appendedMessage ?? null),
      attachments: [],
    },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: yield* nowIso,
  });
});
```

Change `clearAndContinue` to take the resolved config + appended message and reset the accumulator at the clear boundary. Update its signature:

```ts
  const clearAndContinue = Effect.fn("clearAndContinue")(function* (
    thread: OrchestrationThread,
    cfg: UnattendedRunSettings,
    appendedMessage: string | null,
  ) {
```

Inside `clearAndContinue`, where `awaitingFreshContextReading.set(thread.id, true);` is set (right after the cleared marker is appended), add the accumulator reset:

```ts
awaitingFreshContextReading.set(thread.id, true);
iterationAssistantMessages.set(thread.id, new Map());
```

…and change the final call from `yield* issueContinueTurn(thread);` to:

```ts
yield * issueContinueTurn(thread, { cfg, appendedMessage });
```

In `handleSessionSet`, the `clear-continue` case must resolve the appended message (before `clearAndContinue` resets the accumulator) and pass `cfg` through. Replace:

```ts
      case "clear-continue":
        return yield* clearAndContinue(thread);
```

with:

```ts
      case "clear-continue": {
        const appendedMessage = cfg.appendLastAgentMessage
          ? resolveAppendedLastMessage(
              Array.from(iterationAssistantMessages.get(threadId)?.values() ?? []),
              sentinel,
            )
          : null;
        return yield* clearAndContinue(thread, cfg, appendedMessage);
      }
```

In `processEvent`, the `thread.message-sent` case must also feed the iteration accumulator (keyed by `messageId`). Replace the existing assistant branch body with:

```ts
        case "thread.message-sent": {
          if (event.payload.role !== "assistant") {
            return;
          }
          const threadId = event.payload.threadId;
          const previous = latestAssistantText.get(threadId) ?? "";
          latestAssistantText.set(threadId, previous + event.payload.text);

          const byId = iterationAssistantMessages.get(threadId) ?? new Map<string, string>();
          byId.set(
            event.payload.messageId,
            (byId.get(event.payload.messageId) ?? "") + event.payload.text,
          );
          iterationAssistantMessages.set(threadId, byId);
          return;
        }
```

In the `thread.unattended-run-started` case (Task 4's block), reset the accumulator at run start. Add, right after reading the thread / before issuing the preamble turn:

```ts
iterationAssistantMessages.set(thread.id, new Map());
```

- [ ] **Step 4: Run to verify the tests pass**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts
npx tsgo --noEmit
```

Expected: all reactor tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/server/src/orchestration/Layers/UnattendedRunReactor.ts apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts
git commit -m "feat(unattended): custom continue message + append-last-agent-message"
```

---

## Task 6: Web — `DraftTextarea` component

**Files:**

- Create: `apps/web/src/components/ui/draft-textarea.tsx`

**Interfaces:**

- Consumes: `Textarea`, `TextareaProps` from `./textarea` (`apps/web/src/components/ui/textarea.tsx`).
- Produces: `DraftTextarea` — a multiline `<Textarea>` that buffers keystrokes and calls `onCommit(next)` on blur. **Enter inserts a newline (does NOT commit)** — this is why it cannot reuse `useCommitOnBlur` (that hook commits on Enter and is typed for `HTMLInputElement`).

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/ui/draft-textarea.tsx`:

```tsx
"use client";

import { type ChangeEvent, useEffect, useRef, useState } from "react";

import { Textarea, type TextareaProps } from "./textarea";

export type DraftTextareaProps = Omit<TextareaProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Multiline `<Textarea>` that buffers keystrokes locally and invokes `onCommit`
 * only on blur. Unlike `DraftInput`, Enter inserts a newline (the field holds
 * multi-line prompts), so there is no commit-on-Enter. The draft resynchronizes
 * from the upstream `value` only while unfocused, so an external push (e.g. a
 * reset to default) does not clobber an in-progress edit.
 */
export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setDraft(value);
    }
  }, [value]);

  return (
    <Textarea
      {...rest}
      value={draft}
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (draft !== value) {
          onCommit(draft);
        }
      }}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/web && npx tsgo --noEmit
```

Expected: clean. (The component is consumed in Task 7; an unused-export warning is not an error.)

- [ ] **Step 3: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/web/src/components/ui/draft-textarea.tsx
git commit -m "feat(web): add DraftTextarea commit-on-blur multiline input"
```

---

## Task 7: Web — Looping settings panel, route, and nav

**Files:**

- Create: `apps/web/src/components/settings/loopingSettings.ts` (pure warning helper)
- Test: `apps/web/src/components/settings/loopingSettings.test.ts`
- Create: `apps/web/src/components/settings/LoopingSettings.tsx`
- Create: `apps/web/src/routes/settings.looping.tsx`
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx`

**Interfaces:**

- Consumes: `useSettings`, `useUpdateSettings` (`apps/web/src/hooks/useSettings.ts`); `DEFAULT_UNIFIED_SETTINGS`, `WRAP_SENTINEL`, `CONTINUE_MESSAGE` (`@t3tools/contracts`); `SettingsPageContainer`, `SettingsSection`, `SettingsRow`, `SettingResetButton` (`./settingsLayout`); `DraftInput` (`../ui/draft-input`); `DraftTextarea` (Task 6); `Switch` (`../ui/switch`).
- Produces: `preambleMissingEffectiveSentinel(preamble, effectiveSentinel): boolean`; `LoopingSettingsPanel`; the `/settings/looping` route; the "Looping" nav item.

- [ ] **Step 1: Write the failing warning-helper test**

Create `apps/web/src/components/settings/loopingSettings.test.ts`:

```ts
import { describe, expect, it } from "vite-plus/test";

import { preambleMissingEffectiveSentinel } from "./loopingSettings.ts";

describe("preambleMissingEffectiveSentinel", () => {
  it("is false for an empty preamble (the built-in default is used)", () => {
    expect(preambleMissingEffectiveSentinel("", "<<WRAP_COMPLETE>>")).toBe(false);
    expect(preambleMissingEffectiveSentinel("   ", "<<WRAP_COMPLETE>>")).toBe(false);
  });

  it("is false when a custom preamble contains the effective sentinel", () => {
    expect(
      preambleMissingEffectiveSentinel("emit <<WRAP_COMPLETE>> to advance", "<<WRAP_COMPLETE>>"),
    ).toBe(false);
  });

  it("is true when a custom preamble omits the effective sentinel", () => {
    expect(preambleMissingEffectiveSentinel("just do the work", "<<WRAP_COMPLETE>>")).toBe(true);
  });

  it("respects a custom effective sentinel", () => {
    expect(preambleMissingEffectiveSentinel("emit <<DONE>>", "<<DONE>>")).toBe(false);
    expect(preambleMissingEffectiveSentinel("emit <<WRAP_COMPLETE>>", "<<DONE>>")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/web && npx vp test run src/components/settings/loopingSettings.test.ts
```

Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement the warning helper**

Create `apps/web/src/components/settings/loopingSettings.ts`:

```ts
/**
 * True when a CUSTOM (non-empty) preamble does not mention the effective
 * sentinel. The reactor watches the sentinel; if the preamble never tells the
 * agent to emit it, the loop can never advance. Empty preamble => false (the
 * built-in, model-aware preamble already embeds the sentinel). Warning only;
 * never blocks saving.
 */
export const preambleMissingEffectiveSentinel = (
  preamble: string,
  effectiveSentinel: string,
): boolean => preamble.trim().length > 0 && !preamble.includes(effectiveSentinel);
```

- [ ] **Step 4: Run to verify it passes**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/web && npx vp test run src/components/settings/loopingSettings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Create the panel component**

Create `apps/web/src/components/settings/LoopingSettings.tsx`:

```tsx
import { CONTINUE_MESSAGE, DEFAULT_UNIFIED_SETTINGS, WRAP_SENTINEL } from "@t3tools/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { DraftInput } from "../ui/draft-input";
import { DraftTextarea } from "../ui/draft-textarea";
import { Switch } from "../ui/switch";
import { preambleMissingEffectiveSentinel } from "./loopingSettings.ts";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const DEFAULTS = DEFAULT_UNIFIED_SETTINGS.unattendedRun;

export function LoopingSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const cfg = settings.unattendedRun;
  const effectiveSentinel = cfg.sentinel || WRAP_SENTINEL;
  const showPreambleWarning = preambleMissingEffectiveSentinel(cfg.preamble, effectiveSentinel);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Looping">
        <SettingsRow
          title="Preamble"
          description="Opens iteration 1 and sets the unattended contract. Leave empty to use the built-in, model-aware preamble. Sent verbatim — no substitutions."
          resetAction={
            cfg.preamble !== DEFAULTS.preamble ? (
              <SettingResetButton
                label="preamble"
                onClick={() => updateSettings({ unattendedRun: { preamble: DEFAULTS.preamble } })}
              />
            ) : null
          }
          control={
            <DraftTextarea
              className="w-full sm:w-96"
              value={cfg.preamble}
              onCommit={(next) => updateSettings({ unattendedRun: { preamble: next } })}
              placeholder="Leave empty to use the built-in, model-aware preamble."
              spellCheck={false}
              aria-label="Unattended-run preamble"
            />
          }
        >
          {showPreambleWarning ? (
            <p className="pt-2 pb-3.5 text-xs text-amber-600 dark:text-amber-500">
              Your custom preamble does not mention the sentinel{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{effectiveSentinel}</code>.
              The run can only advance when the agent emits it, so be sure to instruct the agent to
              print it on its own line.
            </p>
          ) : null}
        </SettingsRow>

        <SettingsRow
          title="Continue message"
          description="Sent for iterations 2..N after the context is cleared. Leave empty to use the built-in default. Sent verbatim — no substitutions."
          resetAction={
            cfg.continueMessage !== DEFAULTS.continueMessage ? (
              <SettingResetButton
                label="continue message"
                onClick={() =>
                  updateSettings({ unattendedRun: { continueMessage: DEFAULTS.continueMessage } })
                }
              />
            ) : null
          }
          control={
            <DraftTextarea
              className="w-full sm:w-96"
              value={cfg.continueMessage}
              onCommit={(next) => updateSettings({ unattendedRun: { continueMessage: next } })}
              placeholder={CONTINUE_MESSAGE}
              spellCheck={false}
              aria-label="Unattended-run continue message"
            />
          }
        />

        <SettingsRow
          title="Sentinel"
          description="The line the reactor watches for to advance the run. Leave empty to use the built-in default."
          resetAction={
            cfg.sentinel !== DEFAULTS.sentinel ? (
              <SettingResetButton
                label="sentinel"
                onClick={() => updateSettings({ unattendedRun: { sentinel: DEFAULTS.sentinel } })}
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={cfg.sentinel}
              onCommit={(next) => updateSettings({ unattendedRun: { sentinel: next } })}
              placeholder={WRAP_SENTINEL}
              spellCheck={false}
              aria-label="Unattended-run sentinel"
            />
          }
        />

        <SettingsRow
          title="Append last agent message"
          description="Append the previous iteration's final assistant message to the continue message so the fresh context carries it forward."
          resetAction={
            cfg.appendLastAgentMessage !== DEFAULTS.appendLastAgentMessage ? (
              <SettingResetButton
                label="append last agent message"
                onClick={() =>
                  updateSettings({
                    unattendedRun: { appendLastAgentMessage: DEFAULTS.appendLastAgentMessage },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={cfg.appendLastAgentMessage}
              onCheckedChange={(checked) =>
                updateSettings({ unattendedRun: { appendLastAgentMessage: Boolean(checked) } })
              }
              aria-label="Append last agent message to the continue message"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
```

- [ ] **Step 6: Create the route**

Create `apps/web/src/routes/settings.looping.tsx` (mirrors `settings.general.tsx`):

```tsx
import { createFileRoute } from "@tanstack/react-router";

import { LoopingSettingsPanel } from "../components/settings/LoopingSettings";

function SettingsLoopingRoute() {
  return <LoopingSettingsPanel />;
}

export const Route = createFileRoute("/settings/looping")({
  component: SettingsLoopingRoute,
});
```

- [ ] **Step 7: Register the nav item**

In `apps/web/src/components/settings/SettingsSidebarNav.tsx`:

Add `| "/settings/looping"` to the `SettingsSectionPath` union (after `"/settings/general"`):

```ts
export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/looping"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/archived";
```

Import a `lucide-react` icon (add `RepeatIcon` to the existing lucide import line) and add the nav entry right after the "General" item in `SETTINGS_NAV_ITEMS`:

```ts
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Looping", to: "/settings/looping", icon: RepeatIcon },
```

- [ ] **Step 8: Typecheck, lint, build (regenerates the TanStack route tree), and run the helper test**

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/apps/web
npx vp test run src/components/settings/loopingSettings.test.ts
npx tsgo --noEmit
```

Expected: helper test PASS; typecheck clean (the generated route tree picks up `settings.looping.tsx`; if `tsgo` reports the route is unknown, run the web dev/build once to regenerate `routeTree.gen.ts`, then re-run `tsgo`).

If `RepeatIcon` is not exported by the installed `lucide-react`, substitute another existing icon (e.g. `RotateCwIcon`) — confirm by checking the other icons already imported in that file resolve.

- [ ] **Step 9: Commit**

```bash
cd /home/chaz/projects/t3code
git add apps/web/src/components/settings/loopingSettings.ts apps/web/src/components/settings/loopingSettings.test.ts apps/web/src/components/settings/LoopingSettings.tsx apps/web/src/routes/settings.looping.tsx apps/web/src/components/settings/SettingsSidebarNav.tsx
git commit -m "feat(web): add Looping settings page (preamble, continue, sentinel, append)"
```

---

## Final verification

After Task 7, run the full set once more to confirm nothing regressed:

```bash
export PATH="/home/chaz/.nvm/versions/node/v24.17.0/bin:$PATH"
cd /home/chaz/projects/t3code/packages/contracts && npx vp test run src/settings.test.ts && npx tsgo --noEmit
cd /home/chaz/projects/t3code/apps/server && npx vp test run src/orchestration/unattendedRun.test.ts && npx vp test run src/orchestration/Layers/UnattendedRunReactor.test.ts && npx tsgo --noEmit
cd /home/chaz/projects/t3code/apps/web && npx vp test run src/components/settings/loopingSettings.test.ts && npx tsgo --noEmit
```

Manual smoke (optional, via the `run` skill or `pnpm` dev): open Settings → Looping, set a custom sentinel, start a short unattended run, and confirm the loop advances on the custom sentinel and the appended message appears in the continue turn when the toggle is on.

---

## Self-review notes

- **Spec coverage:** data model (Task 1); effective sentinel in preamble + detection (Tasks 2, 4); `stripSentinelLine` + `resolveAppendedLastMessage` (Task 3); custom preamble/continue + append, fresh-per-iteration read, iteration-scoped capture (Tasks 4, 5); shared default constants relocation (Task 1); web route/panel/nav, `DraftTextarea`, placeholders, per-field reset, non-blocking sentinel warning, `splitPatch` routing (schema-driven — automatic for the new `ServerSettings` key) (Tasks 6, 7). Open question (message granularity) resolved in Task 5's design note.
- **Out of scope (per spec §7):** no token substitution; no per-thread/project config; no UI for wrap-ceiling/poll internals; no truncation of the appended message; no labeled append separator.
- **Edge cases covered by tests:** empty sentinel falls back to default (Task 4); append finds nothing → continue sent alone, and standalone-sentinel fallback (Task 3 unit tests); toggle off → no append (Task 5).
