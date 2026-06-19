import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerFooterModeControls } from "./ChatComposer";

const baseProps = {
  showInteractionModeToggle: false,
  interactionMode: "default" as const,
  runtimeMode: "approval-required" as const,
  showPlanToggle: false,
  planSidebarLabel: "Plan",
  planSidebarOpen: false,
  onToggleInteractionMode: () => {},
  onRuntimeModeChange: () => {},
  onTogglePlanSidebar: () => {},
};

describe("ComposerFooterModeControls — unattended run control", () => {
  it("renders an enabled start-unattended-run control in the wide footer", () => {
    const markup = renderToStaticMarkup(
      <ComposerFooterModeControls
        {...baseProps}
        onStartUnattendedRun={() => {}}
        canStartUnattendedRun={true}
      />,
    );

    expect(markup).toContain("Start unattended run");
    expect(markup).not.toContain('disabled=""');
  });

  it("disables the control when a run cannot be started", () => {
    const markup = renderToStaticMarkup(
      <ComposerFooterModeControls
        {...baseProps}
        onStartUnattendedRun={() => {}}
        canStartUnattendedRun={false}
      />,
    );

    expect(markup).toContain("Start unattended run");
    expect(markup).toContain('disabled=""');
  });

  it("omits the control when no start handler is provided", () => {
    const markup = renderToStaticMarkup(<ComposerFooterModeControls {...baseProps} />);

    expect(markup).not.toContain("Start unattended run");
  });
});
