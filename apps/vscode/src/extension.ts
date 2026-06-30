// @effect-diagnostics nodeBuiltinImport:off - Extension host runs as plain Node outside any Effect runtime.
// @effect-diagnostics globalFetch:off - Extension host uses native fetch; no Effect HTTP runtime available.
// @effect-diagnostics globalTimers:off - Extension host uses setTimeout for sleep helper; no Effect runtime available.
import * as fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";

import * as vscode from "vscode";

import { createOutputChannelLogger } from "./logger.ts";
import { findFreeLoopbackPort } from "./server/freePort.ts";
import { resolveServerEntry } from "./server/serverEntry.ts";
import {
  createServerSupervisor,
  type SpawnedChild,
} from "./server/serverSupervisor.ts";
import { resolveExternalBaseUrls } from "./transport/urlResolver.ts";
import { renderStatusHtml, type StatusViewModel } from "./ui/statusPanel.ts";

let supervisor: ReturnType<typeof createServerSupervisor> | null = null;

const spawnChild = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
): SpawnedChild => {
  // Ensure the spawn cwd exists (idempotent; covers a clean install where ~/.t3
  // is absent, and restarts). Without it, spawn emits an async 'error', not 'exit'.
  fs.mkdirSync(opts.cwd, { recursive: true });
  const child = nodeSpawn(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe", "pipe"], // fd 3 = bootstrap pipe
  });
  return {
    pid: child.pid,
    writeBootstrap: (line) => {
      const fd3 = child.stdio[3];
      if (fd3 !== null && fd3 !== undefined && "write" in fd3) {
        (fd3 as unknown as NodeJS.EventEmitter).on("error", () => {});
        (fd3 as NodeJS.WritableStream).write(line);
        (fd3 as NodeJS.WritableStream).end();
      }
    },
    kill: (signal) => child.kill(signal),
    onExit: (cb) => {
      // Route both 'exit' and a spawn-time 'error' (e.g. ENOENT) through a single
      // fire so the supervisor's exitDuringStartup race rejects promptly, and so an
      // unhandled 'error' never throws in the extension host. Fire at most once.
      let settled = false;
      const fire = (code: number | null): void => {
        if (settled) return;
        settled = true;
        cb(code);
      };
      child.on("exit", (code) => fire(code));
      child.on("error", () => fire(null));
    },
  };
};

const probeReady = async (httpBaseUrl: string, signal: AbortSignal): Promise<boolean> => {
  try {
    const res = await fetch(`${httpBaseUrl}/.well-known/t3/environment`, { signal });
    return res.ok;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel("T3 Code");
  context.subscriptions.push(channel);
  const logger = createOutputChannelLogger(channel);
  logger.info("T3 Code extension activating.");

  const t3Home = `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.t3`;

  supervisor = createServerSupervisor({
    logger,
    findFreePort: findFreeLoopbackPort,
    resolveEntry: () =>
      resolveServerEntry({
        extensionPath: context.extensionPath,
        execPath: process.execPath,
        fileExists: (p) => fs.existsSync(p),
      }),
    t3Home,
    spawn: spawnChild,
    probeReady,
    sleep,
    now: () => performance.now(),
  });

  try {
    const handle = await supervisor.start();
    logger.info(`Server up at ${handle.httpBaseUrl}`);
  } catch (error) {
    logger.error("Failed to start the T3 Code server", error);
    void vscode.window.showErrorMessage("T3 Code: failed to start the embedded server. See the T3 Code output channel.");
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("t3code.showStatus", async () => {
      const panel = vscode.window.createWebviewPanel("t3codeStatus", "T3 Code: Status", vscode.ViewColumn.Active, {});
      const model = await buildStatusModel();
      panel.webview.html = renderStatusHtml(model);
    }),
  );
}

const buildStatusModel = async (): Promise<StatusViewModel> => {
  const currentHandle = supervisor?.getHandle() ?? null;
  if (currentHandle === null) {
    return { ready: false, httpBaseUrl: "", wsBaseUrl: "", descriptorJson: null, error: "Server is not running." };
  }
  try {
    const resolved = await resolveExternalBaseUrls({
      localHttpBaseUrl: currentHandle.httpBaseUrl,
      asExternalUri: async (u) => (await vscode.env.asExternalUri(vscode.Uri.parse(u))).toString(),
    });
    const res = await fetch(resolved.readinessUrl, { signal: AbortSignal.timeout(10_000) });
    const descriptorJson = res.ok ? JSON.stringify(JSON.parse(await res.text()), null, 2) : null;
    return {
      ready: res.ok,
      httpBaseUrl: resolved.httpBaseUrl,
      wsBaseUrl: resolved.wsBaseUrl,
      descriptorJson,
      error: res.ok ? null : `Descriptor fetch failed: HTTP ${String(res.status)}`,
    };
  } catch (error) {
    return {
      ready: false, httpBaseUrl: currentHandle.httpBaseUrl, wsBaseUrl: "", descriptorJson: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export async function deactivate(): Promise<void> {
  await supervisor?.stop();
  supervisor = null;
}
