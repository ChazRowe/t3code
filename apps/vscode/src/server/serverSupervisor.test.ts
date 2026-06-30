// @effect-diagnostics globalTimers:off - Test harness uses setTimeout to flush microtasks; the supervisor under test injects all real timers.
import { describe, expect, it, vi } from "vite-plus/test";

import { createServerSupervisor, restartDelay } from "./serverSupervisor.ts";
import { createOutputChannelLogger } from "../logger.ts";

const tuning = {
  initialRestartDelayMs: 10, maxRestartDelayMs: 100,
  readinessTimeoutMs: 1000, readinessIntervalMs: 5, terminateGraceMs: 20,
};
const logger = createOutputChannelLogger({ appendLine: () => {} });

interface FakeChild {
  pid: number | undefined;
  written: string[];
  killed: NodeJS.Signals[];
  exit: (code: number | null) => void;
}

const makeDeps = (overrides: { probeReady?: () => Promise<boolean> } = {}) => {
  const children: FakeChild[] = [];
  const spawn = (_cmd: string, _args: readonly string[], _opts: { cwd: string; env: Record<string, string | undefined> }) => {
    let onExit: ((code: number | null) => void) | undefined;
    const child: FakeChild = {
      pid: 100 + children.length,
      written: [],
      killed: [],
      exit: (code) => onExit?.(code),
    };
    children.push(child);
    return {
      pid: child.pid,
      writeBootstrap: (line: string) => child.written.push(line),
      kill: (sig: NodeJS.Signals) => child.killed.push(sig),
      onExit: (cb: (code: number | null) => void) => { onExit = cb; },
    };
  };
  const deps = {
    logger,
    findFreePort: async () => 3801,
    resolveEntry: () => ({ command: "node", entryPath: "/bin.mjs", spawnEnv: { ELECTRON_RUN_AS_NODE: "1" } }),
    t3Home: "/home/u/.t3",
    spawn,
    probeReady: overrides.probeReady ?? (async () => true),
    sleep: async () => {},
    now: () => 0,
    tuning,
  };
  return { deps, children };
};

describe("restartDelay", () => {
  it("doubles per attempt and caps at max", () => {
    const t = { initialRestartDelayMs: 500, maxRestartDelayMs: 10000, readinessTimeoutMs: 0, readinessIntervalMs: 0, terminateGraceMs: 0 };
    expect(restartDelay(0, t)).toBe(500);
    expect(restartDelay(1, t)).toBe(1000);
    expect(restartDelay(5, t)).toBe(10000); // 500*32 capped
  });
});

describe("createServerSupervisor", () => {
  it("spawns the child with --bootstrap-fd 3 and writes the bootstrap line to fd 3", async () => {
    const { deps, children } = makeDeps();
    const spawnSpy = vi.spyOn(deps, "spawn");
    const supervisor = createServerSupervisor(deps);
    const handle = await supervisor.start();

    expect(handle.port).toBe(3801);
    expect(handle.httpBaseUrl).toBe("http://127.0.0.1:3801");
    const [, args] = spawnSpy.mock.calls[0]!;
    expect(args).toEqual(["/bin.mjs", "--bootstrap-fd", "3"]);
    const line = children[0]!.written[0]!;
    expect(JSON.parse(line) as { desktopBootstrapToken: string }).toMatchObject({
      port: 3801, host: "127.0.0.1", desktopBootstrapToken: handle.token,
    });
    expect(supervisor.snapshot()).toMatchObject({ running: true, ready: true });
    await supervisor.stop();
  });

  it("auto-restarts with backoff when the child exits unexpectedly", async () => {
    const { deps, children } = makeDeps();
    const sleepSpy = vi.spyOn(deps, "sleep");
    const supervisor = createServerSupervisor(deps);
    await supervisor.start();
    expect(children).toHaveLength(1);

    // Simulate a crash.
    children[0]!.exit(1);
    // Let the restart microtasks settle.
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(children.length).toBe(2));
    expect(sleepSpy).toHaveBeenCalledWith(tuning.initialRestartDelayMs);
    await supervisor.stop();
  });

  it("getHandle() is null before start/after stop and reflects the new port after a restart", async () => {
    const { deps, children } = makeDeps();
    const ports = [3801, 3902];
    let call = 0;
    const findFreePort = async () => ports[call++] ?? 3902;
    const supervisor = createServerSupervisor({ ...deps, findFreePort });

    expect(supervisor.getHandle()).toBeNull();

    const handle = await supervisor.start();
    expect(handle.port).toBe(3801);
    expect(supervisor.getHandle()?.port).toBe(3801);
    expect(supervisor.getHandle()?.httpBaseUrl).toBe("http://127.0.0.1:3801");

    // Post-ready crash → backoff restart whose fresh findFreePort yields a NEW port.
    children[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 0));
    await vi.waitFor(() => expect(children.length).toBe(2));
    await vi.waitFor(() => expect(supervisor.getHandle()?.port).toBe(3902));
    expect(supervisor.getHandle()?.httpBaseUrl).toBe("http://127.0.0.1:3902");

    await supervisor.stop();
    expect(supervisor.getHandle()).toBeNull();
  });

  it("stop() sends SIGTERM and suppresses restart", async () => {
    const { deps, children } = makeDeps();
    const supervisor = createServerSupervisor(deps);
    await supervisor.start();
    await supervisor.stop();
    expect(children[0]!.killed).toContain("SIGTERM");
    children[0]!.exit(0); // exit after stop must NOT spawn a replacement
    await new Promise((r) => setTimeout(r, 0));
    expect(children).toHaveLength(1);
  });

  it("rejects start() if readiness never succeeds before timeout", async () => {
    const { deps } = makeDeps({ probeReady: async () => false });
    const supervisor = createServerSupervisor({ ...deps, now: (() => { let t = 0; return () => (t += 100); })() });
    await expect(supervisor.start()).rejects.toThrow(/readiness|timed out/i);
    await supervisor.stop();
  });

  it("rejects start() promptly when the child exits before readiness (no orphan restart)", async () => {
    // probeReady never succeeds and now() is constant: without fail-fast, start()
    // would block until the readiness timeout. The pre-ready exit must win.
    // sleep yields a macrotask each readiness iteration so the test's exit() and
    // vi.waitFor can run between probes (a microtask-only sleep would starve them).
    const { deps, children } = makeDeps({ probeReady: async () => false });
    const supervisor = createServerSupervisor({ ...deps, sleep: () => new Promise((r) => setTimeout(r, 0)) });

    const startP = supervisor.start();
    // Let launch() spawn the child (findFreePort awaits before spawn).
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(1); // crash mid-startup, before readiness

    await expect(startP).rejects.toThrow(/exited during startup/i);
    // No background restart: a never-ready child is surfaced, not retried.
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot().running).toBe(false);
  });
});
