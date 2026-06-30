import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { VsCodeChatShell } from "./chatShell";

export function mountVsCodeChatShell(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <VsCodeChatShell />
    </StrictMode>,
  );
}

const root = document.getElementById("root");
if (root) {
  mountVsCodeChatShell(root);
}
