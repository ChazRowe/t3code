import { EnvironmentId, MessageId } from "@t3tools/contracts";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

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

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
}));

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

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    backgroundWork: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    onIsAtEndChange: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      createdAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

describe("MessagesTimeline", () => {
  it("renders collapse controls for long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s</p>");
    expect(markup).toContain('<span aria-hidden="true"> </span>');
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("keeps the copy button for collapsed long user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("work log");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("contextWindow.test.ts");
    expect(markup).toContain("Wadduo");
    expect(markup).toContain('data-testid="file-diff"');
    expect(markup).not.toContain(">Review comment<");
    expect(markup).not.toContain("&lt;review_comment");
    expect(markup).not.toContain("&lt;/review_comment&gt;");
  });

  it("renders file review comments as source code instead of diffs", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-source-comment"),
              role: "user",
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                "Clarify this.",
                "```md",
                "# Plan",
                "- Step one",
                "```",
                "</review_comment>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("plan.md");
    expect(markup).toContain("Clarify this.");
    expect(markup).toContain("# Plan");
    expect(markup).not.toContain('data-testid="file-diff"');
  });

  it("renders a failure marker for failed tool lifecycle entries", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-x");
    expect(markup).toContain('aria-label="Tool call failed"');
  });

  it("renders a collab_agent_tool_call parent as a chip; child entries are not shown inline", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-parent",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-parent",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolItemId: "tool-use-abc123",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "entry-child",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-child",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Subagent command",
              tone: "tool",
              itemType: "command_execution",
              parentItemId: "tool-use-abc123",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    // Parent renders as a chip with its label
    expect(markup).toContain("Subagent task");
    // Chip uses a bordered container
    expect(markup).toContain("border-border");
    // Children are NOT shown inline — they live in the watch route
    expect(markup).not.toContain("Subagent command");
  });

  it("renders in-progress subagent parent as a chip with a running indicator", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-parent",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-parent",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Subagent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolItemId: "tool-use-live123",
              // inProgress — parent is still running while children arrive
              toolLifecycleStatus: "inProgress",
            },
          },
          {
            id: "entry-child",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-child",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Live subagent command",
              tone: "tool",
              itemType: "command_execution",
              parentItemId: "tool-use-live123",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    // In-progress parent renders as a chip (not filtered out)
    expect(markup).toContain("Subagent task");
    // Chip shows running indicator (without "..." suffix — that was the old card)
    expect(markup).toContain("running");
    // Chip uses a bordered container
    expect(markup).toContain("border-border");
    // Children are NOT shown inline
    expect(markup).not.toContain("Live subagent command");
  });

  it("renders a subagent parent as a SubagentRefChip with a Subagent: header and open affordance", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-parent",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-parent",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "general-purpose: Execute floor-rekey cut #3",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolItemId: "tool-use-card123",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "entry-child",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-child",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Bash",
              tone: "tool",
              itemType: "command_execution",
              parentItemId: "tool-use-card123",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    // Chip shows "Subagent:" prefix and the subagent type
    expect(markup).toContain("Subagent:");
    expect(markup).toContain("general-purpose");
    // Chip has a bordered container
    expect(markup).toContain("border-border");
    // Chip renders with a testid on the root element
    expect(markup).toContain("subagent-ref-chip-tool-use-card123");
    // Children are NOT shown inline — they live in the watch route
    expect(markup).not.toContain(">Bash<");
  });

  it("renders a chip for the subagent parent; children with parentItemId are not shown inline", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const childEntries = Array.from({ length: 12 }, (_, i) => ({
      id: `entry-child-${i}`,
      kind: "work" as const,
      createdAt: "2026-03-17T19:12:29.000Z",
      entry: {
        id: `work-child-${i}`,
        createdAt: "2026-03-17T19:12:29.000Z",
        label: `Bash`,
        detail: `child-command-${i}`,
        tone: "tool" as const,
        itemType: "command_execution" as const,
        parentItemId: "tool-use-scroll123",
        toolLifecycleStatus: "completed" as const,
      },
    }));

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-parent",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-parent",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "general-purpose: Long-running task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolItemId: "tool-use-scroll123",
              toolLifecycleStatus: "completed",
            },
          },
          ...childEntries,
        ]}
      />,
    );

    // Chip renders for the parent with the testid
    expect(markup).toContain("subagent-ref-chip-tool-use-scroll123");
    // Chip shows the subagent label parts
    expect(markup).toContain("general-purpose");
    expect(markup).toContain("Long-running task");
    // Children are NOT rendered inline — the chip links to the watch route instead
    expect(markup).not.toContain("child-command-0");
    expect(markup).not.toContain("child-command-11");
  });

  it("renders a chip for a subagent parent; text child entries (assistant_message) are not shown inline", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-parent",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-parent",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "code-reviewer: Review the change",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolItemId: "tool-use-text123",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "entry-text-child",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            // Shape produced by deriveWorkLogEntries for a subagent assistant_message
            // child: no itemType (non-tool-lifecycle), tone "info", text in detail.
            entry: {
              id: "work-text-child",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Subagent message",
              tone: "info",
              detail: "I'll review this change rigorously.",
              parentItemId: "tool-use-text123",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    // Chip renders the Subagent: prefix and subagent type
    expect(markup).toContain("Subagent:");
    expect(markup).toContain("code-reviewer");
    // Text child is NOT shown inline — it's accessible via the watch route
    expect(markup).not.toContain("I&#x27;ll review this change rigorously.");
  });

  it("shows running indicator in card header when subagent parent is in-progress", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-parent",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-parent",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "general-purpose: Do something",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolItemId: "tool-use-running123",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    // Running indicator text should be present
    expect(markup).toContain("running");
    // Animated dots (animate-pulse) should be present for the spinner
    expect(markup).toContain("animate-pulse");
  });

  it("renders a collab_agent_tool_call entry as a SubagentRefChip (not an inline transcript card)", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-chip",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-chip",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "code-reviewer: review the diff",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolItemId: "tool-use-chip123",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    // Chip renders the Subagent: label and subagent type
    expect(markup).toContain("Subagent:");
    expect(markup).toContain("code-reviewer");
    // Chip is NOT the old inline transcript card with "running..." (three dots)
    expect(markup).not.toContain("running...");
  });

  it("does not truncate entries when an in-progress subagent parent is present", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    // Build more than MAX_VISIBLE entries (default is 8) with an in-progress subagent
    const manyEntries = Array.from({ length: 10 }, (_, i) => ({
      id: `entry-${i}`,
      kind: "work" as const,
      createdAt: "2026-03-17T19:12:28.000Z",
      entry: {
        id: `work-${i}`,
        createdAt: "2026-03-17T19:12:28.000Z",
        label: `Tool call ${i}`,
        tone: "tool" as const,
        itemType: "command_execution" as const,
        toolLifecycleStatus: "completed" as const,
      },
    }));

    // Replace the first entry with an in-progress subagent parent
    const entriesWithActiveSubagent = [
      {
        id: "entry-subagent",
        kind: "work" as const,
        createdAt: "2026-03-17T19:12:27.000Z",
        entry: {
          id: "work-subagent",
          createdAt: "2026-03-17T19:12:27.000Z",
          label: "general-purpose: Active task",
          tone: "tool" as const,
          itemType: "collab_agent_tool_call" as const,
          toolItemId: "tool-use-active",
          toolLifecycleStatus: "inProgress" as const,
        },
      },
      ...manyEntries,
    ];

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={entriesWithActiveSubagent} />,
    );

    // All tool calls should be visible (no "Show more" truncation)
    expect(markup).not.toContain("previous tool call");
    // Last entry should be visible
    expect(markup).toContain("Tool call 9");
  });
});
