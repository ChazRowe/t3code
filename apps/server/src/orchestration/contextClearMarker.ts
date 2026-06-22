import { CONTEXT_CLEARED_ACTIVITY_KIND } from "./unattendedRun.ts";

export { CONTEXT_CLEARED_ACTIVITY_KIND };

// A context clear ends one context window and starts a fresh one within the same
// thread. Two paths produce it today:
//  - the unattended state machine clearing between iterations
//    ([[CONTEXT_CLEARED_ACTIVITY_KIND]] from ./unattendedRun.ts), and
//  - the provider clearing its conversation in place when the user runs `/clear`
//    or `/new` (PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND, surfaced by the adapters
//    via a `thread.state.changed` event with state "cleared").
// Context-scoped views — chiefly the subagent hierarchy — rebase to the latest
// such marker so a prior context's subagents drop out of the live tree.

/** Marker kind for a provider-driven in-place context clear (e.g. Claude `/clear`). */
export const PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND = "context.cleared";

/** Every activity kind that marks a context-clear boundary. */
export const CONTEXT_CLEARED_ACTIVITY_KINDS = [
  CONTEXT_CLEARED_ACTIVITY_KIND,
  PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND,
] as const;

/** True when an activity kind marks a context-clear boundary. */
export const isContextClearedActivityKind = (kind: string): boolean =>
  kind === CONTEXT_CLEARED_ACTIVITY_KIND || kind === PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND;

/**
 * The user-typed command that resets the context window from the input side.
 *
 * `/new` is intercepted uniformly server-side (in the decider) and turned into a
 * provider-agnostic context reset — a [[PROVIDER_CONTEXT_CLEARED_ACTIVITY_KIND]]
 * marker plus a session stop with `resetContext`, which binds a fresh provider
 * conversation on the next turn. This is the path that gives Codex (and the other
 * non-Claude providers, which expose no in-session clear signal of their own) a
 * working context clear.
 *
 * `/clear` is deliberately NOT matched: Claude handles it SDK-native (the SDK
 * resets its conversation in place and the adapter observes the new session id),
 * so intercepting it here would short-circuit that nicer in-place clear. For the
 * non-Claude providers `/clear` has no session meaning, so it simply passes
 * through as ordinary text.
 */
export const CONTEXT_RESET_COMMAND = "/new";

/** True when user-typed message text is the `/new` context-reset command. */
export const isContextResetCommand = (text: string): boolean => /^\s*\/new(\s|$)/u.test(text);
