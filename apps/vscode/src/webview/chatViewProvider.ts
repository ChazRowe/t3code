import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type { Logger } from "../logger.ts";
import type { ResolvedServerSession } from "../session/serverSession.ts";
import { buildConnectSrcOrigins, renderWebviewHtml } from "../ui/webviewHtml.ts";
import { resolveWebviewEntryAssets } from "./resolveWebviewAssets.ts";

export interface ChatViewProviderDeps {
  readonly logger: Logger;
  readonly extensionUri: vscode.Uri;
  readonly getSession: () => Promise<ResolvedServerSession | null>;
  readonly randomBytes?: (size: number) => Buffer;
}

export class ChatWebviewViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly deps: ChatViewProviderDeps;

  constructor(deps: ChatViewProviderDeps) {
    this.deps = deps;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview", "chat")],
    };
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
    void this.refresh(webviewView.webview);
  }

  async refresh(webview?: vscode.Webview): Promise<void> {
    const target = webview ?? this.view?.webview;
    if (!target) {
      return;
    }
    target.html = await this.buildHtml(target);
  }

  private async buildHtml(webview: vscode.Webview): Promise<string> {
    const session = await this.deps.getSession();
    if (session === null) {
      return `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:12px">
        <p>Embedded server is starting…</p>
      </body></html>`;
    }

    const webviewRoot = vscode.Uri.joinPath(this.deps.extensionUri, "dist", "webview", "chat");
    const assets = resolveWebviewEntryAssets(webviewRoot.fsPath);
    if (assets === null) {
      this.deps.logger.error(
        "Chat webview bundle assets not found. Run pnpm --filter t3-code build:webview.",
      );
      return `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-errorForeground)">
        <p>Chat webview bundle is missing. Rebuild the extension.</p>
      </body></html>`;
    }

    const random = this.deps.randomBytes ?? randomBytes;
    const nonce = random(16).toString("hex");
    const scriptUri = webview
      .asWebviewUri(vscode.Uri.joinPath(webviewRoot, "assets", assets.scriptName))
      .toString();
    const styleUris = assets.styleNames.map((name) =>
      webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, "assets", name)).toString(),
    );

    return renderWebviewHtml({
      nonce,
      bootstrap: {
        label: session.label,
        httpBaseUrl: session.httpBaseUrl,
        wsBaseUrl: session.wsBaseUrl,
        bootstrapToken: session.bootstrapToken,
      },
      scriptUri,
      styleUris,
      connectSrcOrigins: buildConnectSrcOrigins(session.httpBaseUrl, session.wsBaseUrl),
      cspSource: webview.cspSource,
    });
  }
}
