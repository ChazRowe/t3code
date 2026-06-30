// @effect-diagnostics nodeBuiltinImport:off - Smoke harness runs as plain Node outside Effect.
// @effect-diagnostics globalFetch:off - Smoke harness probes readiness with native fetch.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveServerSession } from "../src/session/serverSession.ts";
import { renderWebviewHtml, buildConnectSrcOrigins } from "../src/ui/webviewHtml.ts";
import { resolveWebviewEntryAssets } from "../src/webview/resolveWebviewAssets.ts";

const vscodeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const webviewDist = join(vscodeRoot, "dist", "webview", "chat");
const indexHtml = join(webviewDist, "index.html");

if (!existsSync(indexHtml)) {
  throw new Error(
    `Missing ${indexHtml}. Run pnpm --filter t3-code build:webview before smokeChatWebview.`,
  );
}

const assets = resolveWebviewEntryAssets(webviewDist);
if (assets === null) {
  throw new Error(`Chat webview assets missing under ${join(webviewDist, "assets")}.`);
}

const entryPath = join(webviewDist, "assets", assets.scriptName);
const entrySource = readFileSync(entryPath, "utf8");
if (!entrySource.includes("VsCodeChatShell") && !entrySource.includes("Connecting to T3 Code")) {
  throw new Error(`Chat bundle ${assets.scriptName} does not appear to contain the chat shell.`);
}

const session = await resolveServerSession({
  localHttpBaseUrl: "http://127.0.0.1:3801",
  bootstrapToken: "smoke-token",
  asExternalUri: async (url) => url,
});

const html = renderWebviewHtml({
  nonce: "smoke-nonce",
  bootstrap: {
    label: session.label,
    httpBaseUrl: session.httpBaseUrl,
    wsBaseUrl: session.wsBaseUrl,
    bootstrapToken: session.bootstrapToken,
  },
  scriptUri: "https://example.test/assets/index.js",
  styleUris: [],
  connectSrcOrigins: buildConnectSrcOrigins(session.httpBaseUrl, session.wsBaseUrl),
});

if (!html.includes("vscodeBridge") || !html.includes("smoke-token")) {
  throw new Error("renderWebviewHtml smoke output missing bootstrap injection.");
}

process.stdout.write(
  `smokeChatWebview: ok (bundle=${assets.scriptName}, session=${session.httpBaseUrl})\n`,
);
