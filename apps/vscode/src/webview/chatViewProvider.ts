import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type { Logger } from "../logger.ts";
import type { ResolvedServerSession } from "../session/serverSession.ts";
import { buildConnectSrcOrigins, renderWebviewHtml } from "../ui/webviewHtml.ts";
import { resolveWebviewEntryAssets } from "./resolveWebviewAssets.ts";
import {
  isLoopbackHttpUrl,
  resolveWebviewPortMappings,
  toWebviewLoopbackUrl,
} from "./webviewPortMapping.ts";
import { isWebviewWsInboundMessage, WebviewWsProxy } from "./webviewWsProxy.ts";
import { isWebviewHttpFetchMessage, proxyWebviewHttpFetch } from "./webviewHttpProxy.ts";

export interface ChatViewProviderDeps {
  readonly logger: Logger;
  readonly extensionUri: vscode.Uri;
  readonly getSession: () => Promise<ResolvedServerSession | null>;
  readonly getWorkspaceCwd?: () => string | undefined;
  readonly randomBytes?: (size: number) => Buffer;
  readonly wsProxy?: WebviewWsProxy;
}

export class ChatWebviewViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private localHttpBaseUrl: string | null = null;
  private readonly deps: ChatViewProviderDeps;
  private readonly wsProxy: WebviewWsProxy;

  constructor(deps: ChatViewProviderDeps) {
    this.deps = deps;
    this.wsProxy = deps.wsProxy ?? new WebviewWsProxy();
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
        this.localHttpBaseUrl = null;
        this.wsProxy.dispose();
      }
    });
    webviewView.webview.onDidReceiveMessage((message) => {
      const localHttpBaseUrl = this.localHttpBaseUrl;
      if (localHttpBaseUrl === null) {
        return;
      }
      if (isWebviewHttpFetchMessage(message)) {
        void proxyWebviewHttpFetch(message, localHttpBaseUrl).then((result) => {
          // eslint-disable-next-line unicorn/require-post-message-target-origin -- VS Code Webview.postMessage is not window.postMessage.
          void webviewView.webview.postMessage(result);
        });
        return;
      }
      if (isWebviewWsInboundMessage(message)) {
        this.wsProxy.handle(message, localHttpBaseUrl, (result) => {
          // eslint-disable-next-line unicorn/require-post-message-target-origin -- VS Code Webview.postMessage is not window.postMessage.
          void webviewView.webview.postMessage(result);
        });
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

    if (this.deps.getWorkspaceCwd?.() === undefined) {
      return `<!doctype html><html><body style="font-family:var(--vscode-font-family);padding:12px">
        <p>Open a folder workspace to start a T3 Code chat session.</p>
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

    const useLoopbackPortMapping = isLoopbackHttpUrl(session.httpBaseUrl);
    if (useLoopbackPortMapping) {
      webview.options = {
        ...webview.options,
        portMapping: [...resolveWebviewPortMappings(session.httpBaseUrl)],
      };
    }

    const httpBaseUrl = useLoopbackPortMapping
      ? toWebviewLoopbackUrl(session.httpBaseUrl)
      : session.httpBaseUrl;
    const wsBaseUrl = useLoopbackPortMapping
      ? toWebviewLoopbackUrl(session.wsBaseUrl)
      : session.wsBaseUrl;

    this.localHttpBaseUrl = session.localHttpBaseUrl;

    return renderWebviewHtml({
      nonce,
      bootstrap: {
        label: session.label,
        httpBaseUrl,
        wsBaseUrl,
        bootstrapToken: session.bootstrapToken,
      },
      scriptUri,
      styleUris,
      connectSrcOrigins: buildConnectSrcOrigins(httpBaseUrl, wsBaseUrl),
      cspSource: webview.cspSource,
    });
  }
}
