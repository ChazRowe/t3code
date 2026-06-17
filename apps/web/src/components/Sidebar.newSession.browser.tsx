import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { SidebarProvider } from "./ui/sidebar";
import { SidebarNewSessionButton } from "./Sidebar";

afterEach(() => {
  cleanup();
});

function renderButton(overrides?: {
  disabled?: boolean;
  onNewSession?: () => void;
  onNewSessionWithContext?: () => void;
}) {
  const onNewSession = overrides?.onNewSession ?? vi.fn();
  const onNewSessionWithContext = overrides?.onNewSessionWithContext ?? vi.fn();
  render(
    <SidebarProvider>
      <SidebarNewSessionButton
        onNewSession={onNewSession}
        onNewSessionWithContext={onNewSessionWithContext}
        disabled={overrides?.disabled ?? false}
        newSessionShortcutLabel="⌘⇧N"
        newSessionWithContextShortcutLabel="⌘⇧O"
      />
    </SidebarProvider>,
  );
  return { onNewSession, onNewSessionWithContext };
}

describe("SidebarNewSessionButton", () => {
  it("invokes the local new-session handler on primary click", async () => {
    const { onNewSession, onNewSessionWithContext } = renderButton();
    await userEvent.click(page.getByTestId("sidebar-new-session"));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onNewSessionWithContext).not.toHaveBeenCalled();
  });

  it("invokes the contextual handler on secondary click", async () => {
    const { onNewSession, onNewSessionWithContext } = renderButton();
    await userEvent.click(page.getByTestId("sidebar-new-session-with-context"));
    expect(onNewSessionWithContext).toHaveBeenCalledTimes(1);
    expect(onNewSession).not.toHaveBeenCalled();
  });

  it("renders the primary shortcut label", async () => {
    renderButton();
    await expect.element(page.getByText("⌘⇧N")).toBeInTheDocument();
  });

  it("disables both controls when disabled", async () => {
    const { onNewSession, onNewSessionWithContext } = renderButton({ disabled: true });
    await expect.element(page.getByTestId("sidebar-new-session")).toBeDisabled();
    await expect.element(page.getByTestId("sidebar-new-session-with-context")).toBeDisabled();
    expect(onNewSession).not.toHaveBeenCalled();
    expect(onNewSessionWithContext).not.toHaveBeenCalled();
  });
});
