import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

import { SidebarProvider } from "./ui/sidebar";
import { SidebarNewSessionButton } from "./Sidebar";

afterEach(() => {
  cleanup();
});

function renderButton(overrides?: { disabled?: boolean; onNewSessionWithContext?: () => void }) {
  const onNewSessionWithContext = overrides?.onNewSessionWithContext ?? vi.fn();
  render(
    <SidebarProvider>
      <SidebarNewSessionButton
        onNewSessionWithContext={onNewSessionWithContext}
        disabled={overrides?.disabled ?? false}
        newSessionWithContextShortcutLabel="⌘⇧O"
      />
    </SidebarProvider>,
  );
  return { onNewSessionWithContext };
}

describe("SidebarNewSessionButton", () => {
  it("invokes the new-session handler on click", async () => {
    const { onNewSessionWithContext } = renderButton();
    await userEvent.click(page.getByTestId("sidebar-new-session"));
    expect(onNewSessionWithContext).toHaveBeenCalledTimes(1);
  });

  it("disables the control when disabled", async () => {
    const { onNewSessionWithContext } = renderButton({ disabled: true });
    await expect.element(page.getByTestId("sidebar-new-session")).toBeDisabled();
    expect(onNewSessionWithContext).not.toHaveBeenCalled();
  });
});
