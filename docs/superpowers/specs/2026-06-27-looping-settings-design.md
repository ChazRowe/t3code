# Design: Looping (unattended-run) settings page

- **Date:** 2026-06-27
- **Status:** Approved (not yet implemented)
- **Topic:** A new global "Looping" settings page that lets the user customize the
  unattended-run preamble, continue message, and wrap sentinel, plus a toggle to
  append the previous iteration's final assistant message to the continue message.

## Summary

Add a **Looping** section to the app Settings UI backed by a new `unattendedRun`
struct on `ServerSettings`. It exposes four controls:

1. **Preamble** — the message that opens iteration 1 and sets the unattended contract.
2. **Continue message** — the message sent for iterations 2..N after the context clear.
3. **Sentinel** — the line the reactor watches for to advance the run.
4. **Append last agent message** (toggle) — when on, the previous iteration's final
   assistant message is appended to the continue message so the fresh context carries
   it forward.

All three text fields are **raw text, sent verbatim — no token substitution.** The
guiding convention is uniform: an **empty field means "use the built-in default,"** so
the user overrides only what they want and keeps today's smart behavior (including the
model-aware wrap ceiling) everywhere else.

### Motivation

The looping prompts and sentinel are currently hardcoded in
`apps/server/src/orchestration/unattendedRun.ts`. Making them user-editable lets the
operator tune the loop for non-Claude models and — combined with the append toggle —
write self-contained prompts that carry state forward inline, potentially removing the
dependence on the `wrap`/`continue` skills for models that don't have them.

## Why this is feasible

- **Sentinel / preamble / continue are referenced only in server code and tests** —
  nothing in the web UI or skill markdown hardcodes the sentinel string, so making it
  configurable breaks no external references.
- **The reactor can read settings.** `UnattendedRunReactor` runs server-side and can
  inject `ServerSettingsService` (no circular dependency; same pattern as
  `ProviderCommandReactor`, which reads `serverSettingsService.getSettings`). Browser
  `localStorage` (client settings) is _not_ reachable from the reactor, which is why
  the config must live in `ServerSettings`.
- **The last assistant message is capturable.** The reactor already accumulates
  assistant text per turn (`latestAssistantText`) and detects the wrap in
  `handleSessionSet` _before_ `clearAndContinue` runs `thread.session.stop` with
  `resetContext: true` (which forgets the whole conversation). The append feature
  captures the message before that clear and threads it into `issueContinueTurn`.

## Approach decision

**Per-field override with empty-means-default (chosen).** Four independent fields;
each text field falls back to its built-in default when empty. Lowest friction:
override just the sentinel, or just the continue message, and leave the rest smart.

**Rejected — "custom mode" master toggle (all-or-nothing).** Off = today; on = all
fields authored by the user and required. Rejected because it forces rewriting the
whole preamble to change one line and loses the model-aware ceiling entirely in custom
mode.

## 1. Data model (contracts)

In `packages/contracts/src/settings.ts`, add a nested struct to `ServerSettings`
(lines ~366-408) and mirror it into `ServerSettingsPatch` (lines ~479-506):

```
unattendedRun: {
  preamble:               string   // default ""    — empty ⇒ built-in model-aware preamble
  continueMessage:        string   // default ""    — empty ⇒ built-in CONTINUE_MESSAGE
  sentinel:               string   // default ""    — empty ⇒ built-in "<<WRAP_COMPLETE>>"
  appendLastAgentMessage: boolean  // default false
}
```

- Follow the existing schema-default pattern so `DEFAULT_SERVER_SETTINGS` (line ~411)
  produces the struct, and `stripDefaultServerSettings` omits an untouched config from
  `settings.json`.
- Patch fields are `optionalKey` like the rest of `ServerSettingsPatch`.
- These are not secrets; `redactServerSettingsForClient` passes them through unchanged.

## 2. Server behavior

### `apps/server/src/orchestration/unattendedRun.ts`

- `buildUnattendedPreamble(totalIterations, model, sentinel = WRAP_SENTINEL)` — the
  built-in preamble embeds the **effective** sentinel (currently it interpolates the
  `WRAP_SENTINEL` constant). This keeps the default preamble correct when the user
  customizes _only_ the sentinel.
- `messageHasWrapSentinel(text, sentinel = WRAP_SENTINEL)` — detection uses the
  effective sentinel.
- New pure, unit-testable helpers:
  - `stripSentinelLine(text, sentinel): string` — remove the line(s) consisting solely
    of the sentinel (trimmed), preserving the rest.
  - `resolveAppendedLastMessage(messages: readonly string[], sentinel): string | null`
    — walk the iteration's assistant messages backward; return the first one that is
    **non-empty after `stripSentinelLine`**; return `null` if none qualifies.

### `apps/server/src/orchestration/Layers/UnattendedRunReactor.ts`

- Inject `ServerSettingsService`; read `getSettings` **fresh at each iteration
  boundary** (on `thread.unattended-run-started` and inside `clearAndContinue`), so a
  mid-run edit applies to the **next** iteration, never mid-iteration.
- Compute `sentinel = cfg.unattendedRun.sentinel || WRAP_SENTINEL` and use it for:
  - the built-in preamble's embedded sentinel,
  - `messageHasWrapSentinel(latestAssistantText, sentinel)`, and
  - the projection-based turn check (`projectionTurnHasWrapSentinel`, which must accept
    the effective sentinel).
- Preamble text = `cfg.unattendedRun.preamble || buildUnattendedPreamble(totalIterations, model, sentinel)`.
- Continue text = `cfg.unattendedRun.continueMessage || CONTINUE_MESSAGE`; if
  `cfg.unattendedRun.appendLastAgentMessage` and a resolved message exists, plain-append
  it: `` `${continueText}\n\n${resolvedMessage}` ``.
- **Capturing the iteration's assistant messages.** Add a per-thread ordered list
  (`iterationAssistantMessages: Map<string, string[]>`) appended on each
  `thread.message-sent` assistant event and **reset on context-clear and run-start**
  (i.e. at the _iteration_ boundary, not the turn boundary — so it survives an
  iteration that spans multiple turns, e.g. when a turn ends without the sentinel to let
  background work finish). At wrap detection (in `handleSessionSet`, before
  `clearAndContinue`), resolve the appended message from this list with
  `resolveAppendedLastMessage` and stash it for `issueContinueTurn`.

  **Implementation detail to confirm in planning:** whether `thread.message-sent` fires
  once per complete assistant message or per streamed chunk. The walk-backward rule
  operates on **discrete messages**; if events are chunked, message boundaries must be
  reconstructed (or the resolution must read the current iteration's assistant messages
  from the thread projection instead of the in-memory list). The existing
  `latestAssistantText` uses `previous + text` accumulation, which does not by itself
  disambiguate this.

## 3. Web UI (`apps/web`)

- **Route:** `src/routes/settings.looping.tsx` (mirrors `settings.general.tsx`).
- **Panel:** `src/components/settings/LoopingSettings.tsx`.
- **Nav:** add a "Looping" item to `SETTINGS_NAV_ITEMS` and extend the
  `SettingsSectionPath` union in `src/components/settings/SettingsSidebarNav.tsx`.
- **Layout:** reuse `SettingsPageContainer` › `SettingsSection` › `SettingsRow`.
  - Sentinel → `DraftInput` (single-line, commit-on-blur).
  - Preamble + Continue message → a multi-line **`DraftTextarea`** with the same
    draft/commit semantics as `DraftInput`. Add this component under
    `src/components/ui/` if one does not already exist.
  - Append toggle → `Switch`.
  - Per-field `SettingResetButton` that clears the field to `""` (shown when the field
    differs from its default).
- **Placeholders:** empty fields show what the default is, but the strategy differs by
  field because of where the default lives:
  - **Sentinel** and **Continue message** are _static_ defaults — show the literal
    default text as the placeholder.
  - **Preamble** is _server-generated and model-aware_ (built by `buildUnattendedPreamble`
    from the iteration count + model), so the web cannot reproduce the exact text. Show a
    descriptive placeholder instead, e.g. "Leave empty to use the built-in, model-aware
    preamble." The warning below does not need the default preamble text (it only
    inspects a _custom_ preamble), so this gap is cosmetic only.
- **Shared default constants:** so the web and server agree on the static defaults,
  relocate the existing `WRAP_SENTINEL` (`"<<WRAP_COMPLETE>>"`) and `CONTINUE_MESSAGE`
  constants from `apps/server/.../unattendedRun.ts` to a place importable by both — e.g.
  `packages/contracts/src/settings.ts` (next to the schema) — and have `unattendedRun.ts`
  re-export/import them so there is one source of truth. The web imports them for the
  placeholders and the warning.
- **Non-blocking warning:** under the Preamble field, if a _custom_ (non-empty) preamble
  does not contain the **effective sentinel** (the sentinel field's value, or
  `WRAP_SENTINEL` when that field is empty), show inline warning text. This is the one
  mismatch raw-text makes easy (the reactor watches the sentinel; the preamble tells the
  agent to emit it). Client-side only; never blocks saving.
- **Persistence:** read via `useSettings()`, write via
  `updateSettings({ unattendedRun: { ... } })`. Confirm `splitPatch`
  (`src/hooks/useSettings.ts`) routes the new `unattendedRun` key to the **server**
  patch (it is a `ServerSettings` field), not client localStorage.

## 4. Data flow

```
UI edits Looping fields
  -> updateSettings({ unattendedRun }) -> splitPatch -> WsServerUpdateSettingsRpc
  -> ServerSettingsService.updateSettings(patch) -> settings.json (defaults stripped)
  -> PubSub change broadcast (UI + any server subscriber)

Run start / iteration boundary (UnattendedRunReactor)
  -> ServerSettingsService.getSettings (fresh)
  -> sentinel = cfg.sentinel || WRAP_SENTINEL
  -> preamble = cfg.preamble || buildUnattendedPreamble(iters, model, sentinel)
  -> (next iters) continue = cfg.continueMessage || CONTINUE_MESSAGE
       + (if appendLastAgentMessage) "\n\n" + resolveAppendedLastMessage(msgs, sentinel)
  -> detection: messageHasWrapSentinel(latestAssistantText, sentinel)
```

## 5. Edge cases / defaults

- **Empty sentinel never disables detection** — it falls back to the default
  `<<WRAP_COMPLETE>>`. There is no "no sentinel" state.
- **Append finds nothing substantive** (`resolveAppendedLastMessage` → `null`) ⇒ the
  continue message is sent alone.
- **Standalone-sentinel message** ⇒ the walk-backward rule skips it (empty after strip)
  and uses the prior substantive message; this is the explicit content rule.
- **Live edits** apply to the next iteration, never the one already running.
- **Custom preamble + default model-aware ceiling:** once a custom preamble is set, the
  server no longer injects the model-aware wrap-ceiling percentage — the user owns that
  text. The ceiling logic continues to apply only to the built-in (empty) preamble.

## 6. Testing

- **Unit (`apps/server/src/orchestration/unattendedRun.test.ts`):**
  - `buildUnattendedPreamble` embeds a custom sentinel when passed one; defaults to
    `<<WRAP_COMPLETE>>` otherwise.
  - `messageHasWrapSentinel` matches a custom sentinel.
  - `stripSentinelLine`: removes a standalone sentinel line, preserves surrounding text,
    leaves text without the sentinel unchanged.
  - `resolveAppendedLastMessage`: latest message stripped; standalone-sentinel falls
    back to previous; nothing substantive → `null`; multi-message list picks the latest
    qualifying.
- **Reactor (`apps/server/src/orchestration/Layers/UnattendedRunReactor.test.ts`):**
  - custom preamble used when set; built-in when empty;
  - custom continue message used when set;
  - append toggle on → continue includes the stripped last message; off → it does not;
  - custom-sentinel-driven clear-continue (run advances on the configured sentinel, not
    on `<<WRAP_COMPLETE>>`).
  - Extend the harness (`makeTestLayer`/`setupHarness`) with a `ServerSettingsService`
    override so tests can set `unattendedRun` config.
- **Contracts:** decode/defaults for the new struct + `ServerSettingsPatch` round-trip.
- Tests require Node 24 (project toolchain); the harness default Node is too old.

## 7. Out of scope (YAGNI)

- Token/placeholder substitution in prompts (explicitly chosen against — raw text only).
- Per-thread or per-project loop config (global `ServerSettings` only).
- Configuring the wrap-ceiling percentages, stop-poll timing, or other reactor
  internals from the UI.
- Truncating/capping the appended message (append the resolved message whole).
- A labeled/separated append format (plain append only).

## Open questions

None blocking. One implementation detail to resolve during planning: the
`thread.message-sent` granularity (per-message vs per-chunk) that
`resolveAppendedLastMessage` depends on — see §2.
