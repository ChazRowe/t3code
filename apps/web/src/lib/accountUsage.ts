import type { OrchestrationThreadActivity } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** A single plan rate-limit window ready for display. */
export type AccountUsageWindowRow = {
  /** Stable identifier for the window (used as a React key). */
  readonly key: string;
  /** Primary label, e.g. "Session" or "Sonnet". */
  readonly label: string;
  /** Window duration hint, e.g. "5h" or "7d". */
  readonly sublabel: string | null;
  /** Percentage of the window consumed, 0-100, or null if unknown. */
  readonly utilization: number | null;
  /** ISO-8601 instant when the window resets, or null. */
  readonly resetsAt: string | null;
};

export type AccountUsageSnapshot = {
  /** claude.ai plan ("pro" | "max" | …) or null for API-key sessions. */
  readonly subscriptionType: string | null;
  /** Logged-in account email, or null when unavailable. */
  readonly accountEmail: string | null;
  /** False when plan limits do not apply (rows will be empty). */
  readonly rateLimitsAvailable: boolean;
  /** Ordered, present-only windows to render. */
  readonly windows: ReadonlyArray<AccountUsageWindowRow>;
  readonly updatedAt: string;
};

// Window keys in the contract payload, paired with how we present them. Ordered
// to mirror the `/usage` dialog: the 5-hour session first, then weekly windows.
const WINDOW_DISPLAY: ReadonlyArray<{
  readonly payloadKey: string;
  readonly key: string;
  readonly label: string;
  readonly sublabel: string | null;
}> = [
  { payloadKey: "fiveHour", key: "five-hour", label: "Session", sublabel: "5h" },
  { payloadKey: "sevenDay", key: "seven-day", label: "Week", sublabel: "7d" },
  { payloadKey: "sevenDayOpus", key: "seven-day-opus", label: "Opus", sublabel: "7d" },
  { payloadKey: "sevenDaySonnet", key: "seven-day-sonnet", label: "Sonnet", sublabel: "7d" },
  { payloadKey: "sevenDayOauthApps", key: "seven-day-apps", label: "Apps", sublabel: "7d" },
];

function parseWindowRow(
  raw: unknown,
  display: { readonly key: string; readonly label: string; readonly sublabel: string | null },
): AccountUsageWindowRow | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const utilization = asFiniteNumber(record.utilization);
  const resetsAt = asNonEmptyString(record.resetsAt);
  if (utilization === null && resetsAt === null) {
    return null;
  }
  return {
    key: display.key,
    label: display.label,
    sublabel: display.sublabel,
    utilization,
    resetsAt,
  };
}

/**
 * Find the most recent account.usage.updated activity and shape it for the
 * gauge tooltip. Returns null when no usage data is present (e.g. Codex
 * sessions, or a Claude session that has not completed a turn yet).
 */
export function deriveLatestAccountUsageSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AccountUsageSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account.usage.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }

    const windowsRecord = asRecord(payload.windows) ?? {};
    const rows: AccountUsageWindowRow[] = [];
    for (const display of WINDOW_DISPLAY) {
      const row = parseWindowRow(windowsRecord[display.payloadKey], display);
      if (row) {
        rows.push(row);
      }
    }

    // Pay-as-you-go extra usage, when present and enabled.
    const extra = asRecord(windowsRecord.extraUsage);
    if (extra && extra.isEnabled === true) {
      const utilization = asFiniteNumber(extra.utilization);
      if (utilization !== null) {
        rows.push({
          key: "extra-usage",
          label: "Extra usage",
          sublabel: null,
          utilization,
          resetsAt: null,
        });
      }
    }

    if (rows.length === 0) {
      continue;
    }

    return {
      subscriptionType: asNonEmptyString(payload.subscriptionType),
      accountEmail: asNonEmptyString(payload.accountEmail),
      rateLimitsAvailable: payload.rateLimitsAvailable === true,
      windows: rows,
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

/** Format a 0-100 utilization as a compact percentage label. */
export function formatUsagePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped > 0 && clamped < 1) {
    return "<1%";
  }
  return `${Math.round(clamped)}%`;
}

/** Title-case a plan name for display, e.g. "max" → "Max". */
export function formatSubscriptionType(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Render an ISO reset instant as a short countdown ("resets in 3h", "resets in
 * 2d"). `now` is injectable for tests. Returns null when unparseable.
 */
export function formatResetCountdown(
  resetsAt: string | null,
  now: number = Date.now(),
): string | null {
  if (!resetsAt) {
    return null;
  }
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) {
    return null;
  }
  const deltaMs = target - now;
  if (deltaMs <= 0) {
    return "resets soon";
  }
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) {
    return `resets in ${Math.max(1, minutes)}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `resets in ${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `resets in ${days}d`;
}
