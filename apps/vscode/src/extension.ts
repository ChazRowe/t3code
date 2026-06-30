import * as vscode from "vscode";

import { createOutputChannelLogger } from "./logger.ts";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("T3 Code");
  context.subscriptions.push(channel);
  const logger = createOutputChannelLogger(channel);
  logger.info("T3 Code extension activated.");

  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.showStatus", () => {
      void vscode.window.showInformationMessage("T3 Code: status webview not wired yet (Phase 1, Task 7).");
    }),
  );
}

export function deactivate(): void {
  // Supervisor teardown is added in Task 7.
}
