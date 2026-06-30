import { describe, expect, it } from "vite-plus/test";
import { buildUnattendedRunBannerItem } from "./unattendedRunBanner.tsx";

const noop = () => {};
const handlers = { onPause: noop, onResume: noop, onStop: noop };

describe("buildUnattendedRunBannerItem", () => {
  it("returns an info banner while running", () => {
    const item = buildUnattendedRunBannerItem({
      run: {
        status: "running",
        totalIterations: 3,
        currentIteration: 2,
        pauseReason: null,
        startedAt: "x",
        updatedAt: "x",
      },
      ...handlers,
    });
    expect(item?.variant).toBe("info");
  });
  it("returns a warning banner when paused", () => {
    const item = buildUnattendedRunBannerItem({
      run: {
        status: "paused",
        totalIterations: 3,
        currentIteration: 2,
        pauseReason: "no-sentinel",
        startedAt: "x",
        updatedAt: "x",
      },
      ...handlers,
    });
    expect(item?.variant).toBe("warning");
  });
  it("describes an awaiting-input pause as a question to answer", () => {
    const item = buildUnattendedRunBannerItem({
      run: {
        status: "paused",
        totalIterations: 3,
        currentIteration: 2,
        pauseReason: "awaiting-input",
        startedAt: "x",
        updatedAt: "x",
      },
      ...handlers,
    });
    expect(item?.variant).toBe("warning");
    expect(item?.description).toContain("asked a question");
  });
  it("returns null for terminal runs", () => {
    expect(
      buildUnattendedRunBannerItem({
        run: {
          status: "completed",
          totalIterations: 3,
          currentIteration: 3,
          pauseReason: null,
          startedAt: "x",
          updatedAt: "x",
        },
        ...handlers,
      }),
    ).toBeNull();
  });
});
