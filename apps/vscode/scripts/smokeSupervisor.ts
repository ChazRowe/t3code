// @effect-diagnostics nodeBuiltinImport:off - Smoke harness runs as plain Node outside Effect.
// @effect-diagnostics globalFetch:off - Smoke harness probes readiness with native fetch.
// @effect-diagnostics globalTimers:off - Smoke harness uses setTimeout for polling helpers.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOutputChannelLogger } from "../src/logger.ts";
import { findFreeLoopbackPort } from "../src/server/freePort.ts";
import { resolveServerEntry } from "../src/server/serverEntry.ts";
import { createServerSupervisor, type SpawnedChild } from "../src/server/serverSupervisor.ts";

const vscodeRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = vscodeRoot;
const t3Home = mkdtempSync(join(tmpdir(), "t3code-vscode-smoke-"));
const lines: string[] = [];
const logger = createOutputChannelLogger({ appendLine: (line) => lines.push(line) });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 120_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const probeReady = async (httpBaseUrl: string, signal: AbortSignal): Promise<boolean> => {
  try {
    const res = await fetch(`${httpBaseUrl}/.well-known/t3/environment`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const spawnedPids: number[] = [];

const spawnChild = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
): SpawnedChild => {
  const child = nodeSpawn(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  if (child.pid !== undefined) {
    spawnedPids.push(child.pid);
  }
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

const supervisor = createServerSupervisor({
  logger,
  findFreePort: findFreeLoopbackPort,
  resolveEntry: () =>
    resolveServerEntry({
      extensionPath,
      execPath: process.execPath,
      fileExists: existsSync,
    }),
  t3Home,
  spawn: spawnChild,
  probeReady,
  sleep,
  now: () => performance.now(),
});

const fail = (message: string): never => {
  console.error(`\nVSCode supervisor smoke failed: ${message}`);
  if (lines.length > 0) {
    console.error("\nSupervisor log:\n" + lines.join("\n"));
  }
  process.exit(1);
};

try {
  console.log("\nRunning VSCode embedded-server supervisor smoke...");

  const handle = await supervisor.start();
  const pid1 = spawnedPids.at(-1);
  if (pid1 === undefined || !isAlive(pid1)) {
    fail("initial server pid missing or not alive");
  }
  await waitFor("initial readiness", async () => {
    const current = supervisor.getHandle();
    return (
      current !== null && (await probeReady(current.httpBaseUrl, new AbortController().signal))
    );
  });
  console.log(`  initial server ready pid=${String(pid1)} port=${String(handle.port)}`);

  process.kill(pid1, "SIGKILL");
  await waitFor("supervisor restart after kill", async () => {
    const current = supervisor.getHandle();
    const pid = spawnedPids.at(-1);
    if (current === null || pid === undefined || pid === pid1) {
      return false;
    }
    return isAlive(pid) && (await probeReady(current.httpBaseUrl, new AbortController().signal));
  });
  const pid2 = spawnedPids.at(-1)!;
  console.log(
    `  restart after kill ok pid=${String(pid2)} port=${String(supervisor.getHandle()?.port)}`,
  );

  await supervisor.stop();
  await sleep(3_000);

  for (const pid of spawnedPids) {
    if (isAlive(pid)) {
      fail(`orphan server process still alive after stop(): pid=${String(pid)}`);
    }
  }
  console.log("  no orphan processes after stop()");

  console.log("\nVSCode supervisor smoke passed.");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(t3Home, { recursive: true, force: true });
}
