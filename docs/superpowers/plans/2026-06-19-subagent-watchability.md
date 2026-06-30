# Subagent Watchability + Unattended-Run Indicator Fix

> **For agentic workers:** execute task-by-task with the subagent-driven-development sub-skill. TDD: failing test first, minimal impl, green, commit. One commit per task.

**Goal:** Make a running subagent's activity genuinely _watchable_ in the T3code web work log — render its inner activity as a **contained card/box** with a clear "running" indicator, show the subagent's actual tool _calls_ (not just results), and stop the work log from auto-collapsing/hiding an active subagent's stream. Separately, fix a bug where the unattended-run indicator (Pause/Stop banner) disappears after the first live activity event.

**Context:** The base feature (env `T3CODE_FORWARD_SUBAGENT_ACTIVITY=1` → adapter forwards subagent messages as nested `item.*` runtime events tagged `parentItemId` → projection carries `parentItemId`/`itemId` → web groups children under the parent "Subagent task" row, indented) is merged on branch `chaz/subagent-live-activity` and verified working end-to-end (125 children nest, 0 orphaned on real data). It is just not watchable. This plan builds on that branch (base commit `1d4c28c1`).

## Global Constraints

- Stack: TypeScript, React (apps/web), Effect; web tests via `pnpm --filter @t3tools/web test <pattern>` (full unit suite was 1217). Server tests via `pnpm --filter t3 test <pattern>`. `vp` is NOT on PATH — use pnpm scripts. Typecheck `pnpm typecheck` can be STALE — verify with `npx tsgo --noEmit` inside the package. Lint `pnpm lint`.
- The subagent-parent discriminator is `itemType === "collab_agent_tool_call"`; children carry `payload.parentItemId` (= parent tool_use_id) which equals the parent entry's `toolItemId` (= `payload.itemId`). The existing helper `isInProgressSubagentParent` (MessagesTimeline.tsx) already encodes the in-progress parent check — reuse it.
- Forwarding STAYS ON during unattended runs (user wants to watch them). Do not add unattended suppression.
- Commit ONLY each task's own files (name them in `git add`; never `git add -A`).
- Visual target chosen by the user: a **contained card/box** with header `Subagent: <subagent_type>  running…` and the steps inside the box.

---

### Task 1: Fix the unattended-run indicator vanishing on live activity

**Root cause (verified):** `OrchestrationThreadShell` (the wire format for the live shell stream) does not carry `unattendedRun`. `mapThreadShell` (`apps/web/src/store.ts:286`) therefore hardcodes `unattendedRun: null`. Every `thread-upserted` shell event — which fires on any thread activity — overwrites the stored shell's real `unattendedRun` with `null` via `writeThreadShellState`, so the banner (`unattendedRunBanner.tsx`, condition `run.status` not completed/stopped) disappears. The authoritative `unattendedRun` updates already arrive through the unattended-run event folding path (`applyUnattendedRunEvent`) and the full thread-detail sync — the shell upsert simply must not clobber the field.

**Files:**

- Modify: `apps/web/src/store.ts` (the shell-upsert path: `mapThreadShell` ~286, `writeThreadShellState` ~700-768, and/or `applyEnvironmentShellEvent` ~1772 where `mapThreadShell(event.thread, …)` is written)
- Test: `apps/web/src/store.test.ts` (or the existing store test file)

**Approach:** On a shell upsert, preserve the existing stored shell's `unattendedRun` instead of overwriting with `null`. The minimal surgical fix: where `applyEnvironmentShellEvent` writes the upserted shell, carry `previousShell?.unattendedRun` onto the new shell before `writeThreadShellState`. (Confirm `applyUnattendedRunEvent` updates `threadShellById[id].unattendedRun` so preservation stays current — if it updates a different structure, adjust so the banner's source is the one the unattended events keep fresh.)

- [ ] **Step 1:** Write a failing test: seed a thread shell with an active `unattendedRun` (status `running`), apply a `thread-upserted` shell event (as the live stream would), and assert the stored shell's `unattendedRun` is still the running state (not `null`). Mirror existing store-test setup.
- [ ] **Step 2:** Run it — expect RED (unattendedRun becomes null).
- [ ] **Step 3:** Implement the preservation on shell-upsert.
- [ ] **Step 4:** GREEN. Add/confirm a test that a genuine unattended-run event (e.g. finished/stopped) still updates the state (preservation must not freeze a stale value).
- [ ] **Step 5:** Full web suite + typecheck + lint. Commit: `fix(web): preserve unattendedRun across live shell upserts`

---

### Task 2: Show the subagent's tool calls (one clean row per child call)

**Root cause:** `deriveWorkLogEntries` (`apps/web/src/session-logic.ts:644`) skips ALL `tool.started` activities, so subagent children only surface as `tool.completed` "Subagent tool result" rows — the user never sees the invocation (`Bash: …`, `Read: …`). Exempting subagent children from the skip is safe (main-thread entries have no `parentItemId`, so they're unchanged). But the one-liner alone yields TWO rows per child because `shouldCollapseToolLifecycleEntries` (`session-logic.ts:800`) and `deriveToolLifecycleCollapseKey` (`session-logic.ts:868`) only handle `tool.updated`/`tool.completed`. To get ONE clean row (invocation label + result detail, in-progress shows live), also pair a child's `tool.started`→`tool.completed` in the collapse.

**Files:**

- Modify: `apps/web/src/session-logic.ts` (`deriveWorkLogEntries` ~644; `shouldCollapseToolLifecycleEntries` ~800; `deriveToolLifecycleCollapseKey` ~868; `mergeDerivedWorkLogEntries` ~825 if needed)
- Test: `apps/web/src/session-logic.test.ts`

**Approach:**

- Change line ~644 to `if (activity.kind === "tool.started" && !activity.payload?.parentItemId) continue;` (keep subagent-child starts).
- Extend `deriveToolLifecycleCollapseKey` to also return a key for `tool.started` entries that carry a `parentItemId` (key on the same `toolCallId`/`itemId` used for updated/completed).
- Extend `shouldCollapseToolLifecycleEntries` to allow `previous.activityKind === "tool.started"` collapsing into a following `tool.completed`/`tool.updated` with the SAME collapse key. Ensure the merge keeps the invocation label (from the started entry) and the result detail/status (from the completed entry) — verify `mergeDerivedWorkLogEntries` field precedence yields that; adjust if the started label is lost.
- Net result must be: completed child → ONE row (e.g. `Bash: mix test` with the result as expandable detail); in-progress child (started, no completed) → one live row showing the invocation.

- [ ] **Step 1:** Failing test(s): given activities for a subagent child with a `tool.started` (invocation `Bash: ls`, parentItemId) + a matching `tool.completed` (result), `deriveWorkLogEntries` yields exactly ONE entry whose label reflects the invocation and whose detail reflects the result, carrying `parentItemId`. Add a second test: an in-progress child (started only) yields one row showing the invocation. Add a regression assertion: a normal main-thread tool call (no parentItemId) is unchanged (still one row, no duplicate started row).
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement the skip-exemption + collapse pairing.
- [ ] **Step 4:** GREEN. Full web suite + typecheck + lint.
- [ ] **Step 5:** Commit: `feat(web): show subagent tool invocations as one collapsed row per call`

---

### Task 3: Render subagent activity as a contained card, with a running indicator, and never auto-collapse an active subagent

Render each subagent group as a **contained card/box**: a header row `Subagent: <subagent_type>` plus a `running…` indicator while the parent is in progress, with the child rows inside the box. And exempt an active subagent's group from the work-log auto-collapse so its stream stays fully visible live.

**Files:**

- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx` (`WorkGroupSection` ~734-835 rendering + overflow ~768-776; `SimpleWorkEntryRow` ~1592 for the card/indent treatment; reuse `isInProgressSubagentParent` ~726)
- Test: `apps/web/src/components/chat/MessagesTimeline.test.tsx`

**Approach:**

- **Card/box:** when a top-level entry is a subagent parent (`itemType === "collab_agent_tool_call"`), render it and its nested children inside a bordered container (e.g. `rounded-md border border-border/60` with a header). Header shows `Subagent: <subagent_type or description>`. Derive the subagent type/description from the parent entry's existing label/detail (it already reads e.g. "general-purpose: Execute floor-rekey cut #3"). Children render inside the box (replace the thin `ml-4 border-l` indent with the box containment; keep rows compact).
- **Running indicator:** when `isInProgressSubagentParent(parent)`, show a clear running affordance in the header (spinner + `running…`). Reuse whatever in-progress/spinner pattern the work log already uses (e.g. the `showNeutralIndicator` path) — do not invent a new animation system; a small spinner + label is enough.
- **No auto-collapse for active subagents:** in `WorkGroupSection` overflow logic (~768-776), add `const hasActiveSubagent = allTopLevelEntries.some(isInProgressSubagentParent);` and gate truncation with `&& !hasActiveSubagent` so an active subagent's full stream stays visible (the overflow "Show more" resumes once it completes).

- [ ] **Step 1:** Failing render test(s) in `MessagesTimeline.test.tsx`: (a) a subagent parent (with children) renders inside a bordered card whose header shows `Subagent:` and the subagent type; (b) an in-progress subagent parent shows the running indicator; (c) a group with an in-progress subagent parent and >1 top-level entry is NOT truncated (all entries render, no "Show more"). Mirror the existing render-test harness.
- [ ] **Step 2:** RED.
- [ ] **Step 3:** Implement the card container + header + running indicator + the `!hasActiveSubagent` overflow gate.
- [ ] **Step 4:** GREEN. Full web suite + typecheck + lint.
- [ ] **Step 5:** Commit: `feat(web): render subagent activity as a contained card with a running indicator`

---

## Verification (after all tasks)

- [ ] Full web suite green (`pnpm --filter @t3tools/web test`); typecheck + lint clean.
- [ ] Live (flag already on via the systemd drop-in, daemon deployed): dispatch a fresh subagent in a new thread; confirm a contained "Subagent: …" card appears with a running indicator, its tool _calls_ show as rows live (not just results), the stream is not hidden behind "Show more", and it remains visible/expandable after the turn completes.
- [ ] Refresh mid-unattended-run and trigger activity; confirm the Pause/Stop indicator now persists (no longer vanishes on the first activity event).

## Notes / out of scope

- The 200/parent forwarding cap stays (tunable later). Forwarding stays ON for unattended runs.
- Turn-folding still collapses _completed_ turns — the card lives inside the turn it ran in; expanding the turn shows it. (Making subagent cards survive turn-folds is a possible later enhancement, not in scope.)
- Option A for the indicator (add `unattendedRun` to the `OrchestrationThreadShell` contract + server projection) is the correct-by-design long-term fix; this plan takes the surgical web-only preservation. Note it as a follow-up.
