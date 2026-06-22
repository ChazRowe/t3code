import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestrationSubagentRef,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";
import type { ReactNode, Ref } from "react";

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    ref?: Ref<LegendListRef>;
  }) => (
    <div data-testid={legendListTestId}>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  );

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

vi.mock("../environments/runtime/service", () => ({
  retainSubagentActivitiesSubscription: vi.fn(() => () => undefined),
  retainSubagentTreeSubscription: vi.fn(() => () => undefined),
}));

// ---------------------------------------------------------------------------
// Store mock — Zustand's SSR snapshot uses getInitialState() which is the empty
// initial state, not the mutated current state. We mock useStore so that in SSR
// (renderToStaticMarkup) the selector is called against the live getState().
// ---------------------------------------------------------------------------
const storeModule = await import("../store");
vi.mock("../store", async () => {
  const real = await import("../store");
  // Return a useStore proxy that always calls getState(), not getInitialState(),
  // so renderToStaticMarkup tests see the seeded state.
  const mockUseStore = (selector: (state: ReturnType<typeof real.useStore.getState>) => unknown) =>
    selector(real.useStore.getState());
  Object.assign(mockUseStore, real.useStore);
  return { ...real, useStore: mockUseStore };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ENV_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-1");
const ROOT_ITEM_ID_STR = "root-1";

function makeRef(status: OrchestrationSubagentRef["status"]): OrchestrationSubagentRef {
  return {
    threadId: THREAD_ID,
    rootItemId: RuntimeItemId.make(ROOT_ITEM_ID_STR),
    parentItemId: null,
    label: "code-reviewer: review",
    subagentType: "code-reviewer",
    description: "review",
    status,
    iteration: null,
    turnId: null,
    depth: 0,
    childSubagentCount: 0,
    prompt: null,
    resultText: null,
    childThreadId: null,
    providerInstanceId: null,
    provider: null,
    model: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function makeActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.make("act-1"),
    tone: "info",
    kind: "tool.completed",
    summary: "Subagent message",
    payload: { itemType: "assistant_message", status: "completed", detail: "Reviewed." },
    turnId: null,
    createdAt: "2026-06-20T00:00:00.000Z",
  };
}

describe("SubagentWatchView", () => {
  it("renders the subagent transcript without a composer", async () => {
    const { SubagentWatchView } = await import("./SubagentWatchView");

    storeModule.useStore
      .getState()
      .syncSubagentActivitiesSnapshot(ENV_ID, THREAD_ID, ROOT_ITEM_ID_STR, [makeActivity()]);
    storeModule.useStore
      .getState()
      .syncSubagentTreeSnapshot(ENV_ID, THREAD_ID, [makeRef("inProgress")]);

    const markup = renderToStaticMarkup(
      <SubagentWatchView
        environmentId={ENV_ID}
        threadId={THREAD_ID}
        subagentRootItemId={ROOT_ITEM_ID_STR}
      />,
    );

    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain('data-testid="subagent-finished-banner"');
  });

  it("shows the finished banner when the ref status leaves inProgress", async () => {
    const { SubagentWatchView } = await import("./SubagentWatchView");

    storeModule.useStore
      .getState()
      .syncSubagentActivitiesSnapshot(ENV_ID, THREAD_ID, ROOT_ITEM_ID_STR, [makeActivity()]);
    storeModule.useStore
      .getState()
      .syncSubagentTreeSnapshot(ENV_ID, THREAD_ID, [makeRef("completed")]);

    const markup = renderToStaticMarkup(
      <SubagentWatchView
        environmentId={ENV_ID}
        threadId={THREAD_ID}
        subagentRootItemId={ROOT_ITEM_ID_STR}
      />,
    );

    expect(markup).toContain('data-testid="subagent-finished-banner"');
    expect(markup).toContain("Subagent finished");
  });

  it("shows the provider and model for a cross-provider subagent", async () => {
    const { SubagentWatchView } = await import("./SubagentWatchView");

    const crossRef: OrchestrationSubagentRef = {
      ...makeRef("inProgress"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      provider: ProviderDriverKind.make("codex"),
      model: TrimmedNonEmptyString.make("gpt-5-codex"),
    };
    storeModule.useStore
      .getState()
      .syncSubagentActivitiesSnapshot(ENV_ID, THREAD_ID, ROOT_ITEM_ID_STR, [makeActivity()]);
    storeModule.useStore.getState().syncSubagentTreeSnapshot(ENV_ID, THREAD_ID, [crossRef]);

    const markup = renderToStaticMarkup(
      <SubagentWatchView
        environmentId={ENV_ID}
        threadId={THREAD_ID}
        subagentRootItemId={ROOT_ITEM_ID_STR}
      />,
    );

    expect(markup).toContain('data-testid="subagent-provider-model"');
    expect(markup).toContain("codex · gpt-5-codex");
  });

  it("omits the provider/model line for a same-thread subagent", async () => {
    const { SubagentWatchView } = await import("./SubagentWatchView");

    storeModule.useStore
      .getState()
      .syncSubagentActivitiesSnapshot(ENV_ID, THREAD_ID, ROOT_ITEM_ID_STR, [makeActivity()]);
    storeModule.useStore
      .getState()
      .syncSubagentTreeSnapshot(ENV_ID, THREAD_ID, [makeRef("inProgress")]);

    const markup = renderToStaticMarkup(
      <SubagentWatchView
        environmentId={ENV_ID}
        threadId={THREAD_ID}
        subagentRootItemId={ROOT_ITEM_ID_STR}
      />,
    );

    expect(markup).not.toContain('data-testid="subagent-provider-model"');
  });
});
