import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveLatestAccountUsageSnapshot,
  formatResetCountdown,
  formatSubscriptionType,
  formatUsagePercent,
} from "./accountUsage";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("accountUsage", () => {
  it("derives the latest usage snapshot with ordered, present-only windows", () => {
    const snapshot = deriveLatestAccountUsageSnapshot([
      makeActivity("activity-1", "account.usage.updated", {
        subscriptionType: "max",
        rateLimitsAvailable: true,
        windows: { fiveHour: { utilization: 10, resetsAt: null } },
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "account.usage.updated", {
        subscriptionType: "max",
        accountEmail: "person@example.com",
        rateLimitsAvailable: true,
        windows: {
          fiveHour: { utilization: 42, resetsAt: "2026-03-23T05:00:00.000Z" },
          sevenDay: { utilization: 71, resetsAt: "2026-03-30T00:00:00.000Z" },
          sevenDaySonnet: { utilization: 88, resetsAt: null },
        },
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.subscriptionType).toBe("max");
    expect(snapshot?.accountEmail).toBe("person@example.com");
    expect(snapshot?.rateLimitsAvailable).toBe(true);
    // Latest activity wins; windows follow the session → weekly → per-model order.
    expect(snapshot?.windows.map((w) => w.label)).toEqual(["Session", "Week", "Sonnet"]);
    expect(snapshot?.windows[0]).toMatchObject({ utilization: 42, sublabel: "5h" });
  });

  it("returns null when no usage activity is present", () => {
    const snapshot = deriveLatestAccountUsageSnapshot([
      makeActivity("activity-1", "context-window.updated", { usedTokens: 100 }),
    ]);
    expect(snapshot).toBeNull();
  });

  it("skips windows that carry neither utilization nor reset", () => {
    const snapshot = deriveLatestAccountUsageSnapshot([
      makeActivity("activity-1", "account.usage.updated", {
        subscriptionType: null,
        rateLimitsAvailable: true,
        windows: {
          fiveHour: { utilization: null, resetsAt: null },
          sevenDay: { utilization: 5, resetsAt: null },
        },
      }),
    ]);

    expect(snapshot?.windows.map((w) => w.label)).toEqual(["Week"]);
    // Email absent from the payload derives to null rather than undefined.
    expect(snapshot?.accountEmail).toBeNull();
  });

  it("includes enabled extra usage and ignores disabled extra usage", () => {
    const enabled = deriveLatestAccountUsageSnapshot([
      makeActivity("activity-1", "account.usage.updated", {
        subscriptionType: "max",
        rateLimitsAvailable: true,
        windows: {
          sevenDay: { utilization: 30, resetsAt: null },
          extraUsage: { isEnabled: true, utilization: 12, monthlyLimit: 100, usedCredits: 12 },
        },
      }),
    ]);
    expect(enabled?.windows.map((w) => w.label)).toEqual(["Week", "Extra usage"]);

    const disabled = deriveLatestAccountUsageSnapshot([
      makeActivity("activity-1", "account.usage.updated", {
        subscriptionType: "max",
        rateLimitsAvailable: true,
        windows: {
          sevenDay: { utilization: 30, resetsAt: null },
          extraUsage: { isEnabled: false, utilization: 12, monthlyLimit: 100, usedCredits: 12 },
        },
      }),
    ]);
    expect(disabled?.windows.map((w) => w.label)).toEqual(["Week"]);
  });

  it("returns null when the payload has no renderable windows", () => {
    const snapshot = deriveLatestAccountUsageSnapshot([
      makeActivity("activity-1", "account.usage.updated", {
        subscriptionType: "pro",
        rateLimitsAvailable: false,
        windows: {},
      }),
    ]);
    expect(snapshot).toBeNull();
  });

  it("formats utilization percentages", () => {
    expect(formatUsagePercent(0)).toBe("0%");
    expect(formatUsagePercent(0.4)).toBe("<1%");
    expect(formatUsagePercent(42.6)).toBe("43%");
    expect(formatUsagePercent(150)).toBe("100%");
    expect(formatUsagePercent(null)).toBeNull();
  });

  it("title-cases subscription types", () => {
    expect(formatSubscriptionType("max")).toBe("Max");
    expect(formatSubscriptionType(null)).toBeNull();
  });

  it("formats reset countdowns relative to now", () => {
    const now = Date.parse("2026-03-23T00:00:00.000Z");
    expect(formatResetCountdown("2026-03-23T00:30:00.000Z", now)).toBe("resets in 30m");
    expect(formatResetCountdown("2026-03-23T03:00:00.000Z", now)).toBe("resets in 3h");
    expect(formatResetCountdown("2026-03-25T00:00:00.000Z", now)).toBe("resets in 2d");
    expect(formatResetCountdown("2026-03-22T23:00:00.000Z", now)).toBe("resets soon");
    expect(formatResetCountdown(null, now)).toBeNull();
  });
});
