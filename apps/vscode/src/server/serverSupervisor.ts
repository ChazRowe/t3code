import type { Logger } from "../logger.ts";
import { buildBootstrap, mintBootstrapToken, serializeBootstrapLine } from "./bootstrap.ts";

export interface SpawnedChild {
  readonly pid: number | undefined;
  writeBootstrap(line: string): void;
  kill(signal: NodeJS.Signals): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface SupervisorTuning {
  initialRestartDelayMs: number;
  maxRestartDelayMs: number;
  readinessTimeoutMs: number;
  readinessIntervalMs: number;
  terminateGraceMs: number;
}

const DEFAULT_TUNING: SupervisorTuning = {
  initialRestartDelayMs: 500,
  maxRestartDelayMs: 10_000,
  readinessTimeoutMs: 60_000,
  readinessIntervalMs: 100,
  terminateGraceMs: 2_000,
};

export interface ResolvedEntryLite {
  readonly command: string;
  readonly entryPath: string;
  readonly spawnEnv: Record<string, string>;
}

export interface SupervisorDeps {
  readonly logger: Logger;
  readonly findFreePort: (opts?: { startPort?: number }) => Promise<number>;
  readonly resolveEntry: () => ResolvedEntryLite;
  readonly t3Home: string;
  readonly host?: string;
  readonly spawn: (
    cmd: string,
    args: readonly string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
  ) => SpawnedChild;
  readonly probeReady: (httpBaseUrl: string, signal: AbortSignal) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly tuning?: Partial<SupervisorTuning>;
}

export interface ServerHandle {
  readonly port: number;
  readonly httpBaseUrl: string;
  readonly token: string;
}

export const restartDelay = (attempt: number, tuning: SupervisorTuning): number =>
  Math.min(tuning.initialRestartDelayMs * 2 ** attempt, tuning.maxRestartDelayMs);

export const createServerSupervisor = (deps: SupervisorDeps) => {
  const tuning: SupervisorTuning = { ...DEFAULT_TUNING, ...deps.tuning };
  const host = deps.host ?? "127.0.0.1";
  const token = mintBootstrapToken();

  let desiredRunning = false;
  let ready = false;
  let restartAttempt = 0;
  let current: SpawnedChild | null = null;
  let currentPort = 0;

  const waitForReady = async (httpBaseUrl: string): Promise<void> => {
    const deadline = deps.now() + tuning.readinessTimeoutMs;
    while (deps.now() < deadline) {
      const controller = new AbortController();
      const ok = await deps.probeReady(httpBaseUrl, controller.signal).catch(() => false);
      if (ok) return;
      await deps.sleep(tuning.readinessIntervalMs);
    }
    throw new Error(`Server readiness timed out after ${tuning.readinessTimeoutMs}ms at ${httpBaseUrl}`);
  };

  const launch = async (): Promise<ServerHandle> => {
    const entry = deps.resolveEntry();
    currentPort = await deps.findFreePort({ startPort: 3773 });
    const httpBaseUrl = `http://${host}:${currentPort}`;
    const bootstrap = buildBootstrap({ port: currentPort, host, t3Home: deps.t3Home, token });

    const child = deps.spawn(entry.command, [entry.entryPath, "--bootstrap-fd", "3"], {
      cwd: deps.t3Home,
      env: { ...process.env, ...entry.spawnEnv },
    });
    current = child;
    deps.logger.info(`Spawned server pid=${String(child.pid)} port=${currentPort}`);
    child.writeBootstrap(serializeBootstrapLine(bootstrap));
    child.onExit((code) => {
      ready = false;
      if (child === current) current = null;
      if (!desiredRunning) return;
      void scheduleRestart(code);
    });

    await waitForReady(httpBaseUrl);
    ready = true;
    restartAttempt = 0;
    deps.logger.info(`Server ready at ${httpBaseUrl}`);
    return { port: currentPort, httpBaseUrl, token };
  };

  const scheduleRestart = async (code: number | null): Promise<void> => {
    const delay = restartDelay(restartAttempt, tuning);
    deps.logger.warn(`Server exited (code=${String(code)}); restarting in ${delay}ms (attempt ${restartAttempt + 1})`);
    restartAttempt += 1;
    await deps.sleep(delay);
    if (!desiredRunning) return;
    try {
      await launch();
    } catch (error) {
      deps.logger.error("Server restart failed", error);
      if (desiredRunning) void scheduleRestart(null);
    }
  };

  const start = async (): Promise<ServerHandle> => {
    desiredRunning = true;
    return launch();
  };

  const stop = async (): Promise<void> => {
    desiredRunning = false;
    const child = current;
    if (child === null) return;
    child.kill("SIGTERM");
    await deps.sleep(tuning.terminateGraceMs);
  };

  const snapshot = () => ({ running: desiredRunning, ready, restartAttempt });

  return { start, stop, snapshot };
};
