import type { Logger } from "../logger.ts";
import { buildBootstrap, mintBootstrapToken, serializeBootstrapLine } from "./bootstrap.ts";
import { resolveEmbeddedServerSpawnArgs } from "./embeddedServerArgs.ts";

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

// Sanctioned default start port for the embedded server's free-port search.
const DEFAULT_START_PORT = 3773;

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
  readonly getWorkspaceCwd?: () => string | undefined;
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
  let currentHandle: ServerHandle | null = null;

  const waitForReady = async (httpBaseUrl: string, signal: AbortSignal): Promise<void> => {
    const deadline = deps.now() + tuning.readinessTimeoutMs;
    while (deps.now() < deadline) {
      if (signal.aborted) return;
      const ok = await deps.probeReady(httpBaseUrl, signal).catch(() => false);
      if (ok) return;
      await deps.sleep(tuning.readinessIntervalMs);
    }
    if (signal.aborted) return;
    throw new Error(
      `Server readiness timed out after ${tuning.readinessTimeoutMs}ms at ${httpBaseUrl}`,
    );
  };

  const launch = async (): Promise<ServerHandle> => {
    const entry = deps.resolveEntry();
    currentPort = await deps.findFreePort({ startPort: DEFAULT_START_PORT });
    const httpBaseUrl = `http://${host}:${currentPort}`;
    const bootstrap = buildBootstrap({ port: currentPort, host, t3Home: deps.t3Home, token });
    const embeddedServerEnv = {
      T3CODE_MODE: bootstrap.mode,
      T3CODE_PORT: String(bootstrap.port),
      T3CODE_HOST: bootstrap.host,
      T3CODE_HOME: bootstrap.t3Home,
      T3CODE_NO_BROWSER: String(bootstrap.noBrowser),
      T3CODE_TAILSCALE_SERVE: String(bootstrap.tailscaleServeEnabled),
      T3CODE_TAILSCALE_SERVE_PORT: String(bootstrap.tailscaleServePort),
      // Force the bundled `ws` library to use its pure-JS mask/unmask and UTF-8
      // validation instead of the optional native `bufferutil`/`utf-8-validate`
      // addons. The embedded server runs under VS Code's Electron Node, whose ABI
      // does not match the prebuilt addons: `require()` resolves to a broken module
      // whose `unmask` is not a function, so `ws` installs it and then throws
      // `TypeError: bufferUtil.unmask is not a function` on the first inbound frame,
      // crashing the server on every WebSocket connection (the chat webview never
      // receives its welcome event and hangs on "Waiting for session…"). The pure-JS
      // path has no native dependency and works under any Node/Electron runtime.
      WS_NO_BUFFER_UTIL: "1",
      WS_NO_UTF_8_VALIDATE: "1",
    };

    const child = deps.spawn(
      entry.command,
      resolveEmbeddedServerSpawnArgs({
        entryPath: entry.entryPath,
        workspaceCwd: deps.getWorkspaceCwd?.(),
      }),
      {
        cwd: deps.t3Home,
        env: { ...process.env, ...entry.spawnEnv, ...embeddedServerEnv },
      },
    );
    current = child;
    deps.logger.info(`Spawned server pid=${String(child.pid)} port=${currentPort}`);
    child.writeBootstrap(serializeBootstrapLine(bootstrap));

    // Whether THIS specific child reached readiness. Only a post-ready exit
    // earns a background restart; a never-ready exit is surfaced via start()'s
    // rejection (Policy A: start() owns the initial bring-up).
    let childReady = false;
    // Per-launch exit signal: rejects when THIS child exits during startup, so the
    // readiness wait loses to the child crashing instead of polling a dead server.
    let rejectOnExit: ((code: number | null) => void) | undefined;
    const exitDuringStartup = new Promise<never>((_, reject) => {
      rejectOnExit = (code) =>
        reject(new Error(`Server exited during startup (code=${String(code)})`));
    });

    child.onExit((code) => {
      if (child === current) {
        current = null;
        ready = false;
        currentHandle = null;
      }
      // Fail the in-flight readiness race for this child (no-op once ready/settled).
      rejectOnExit?.(code);
      if (!desiredRunning) return;
      if (!childReady) return; // initial bring-up failure → surfaced via start() rejection, not a restart
      void scheduleRestart(code);
    });

    const controller = new AbortController();
    try {
      await Promise.race([waitForReady(httpBaseUrl, controller.signal), exitDuringStartup]);
    } finally {
      // Stop any in-flight probe and the readiness loop, and stop treating further
      // exits as a startup failure (a post-ready exit is handled by scheduleRestart).
      controller.abort();
      rejectOnExit = undefined;
    }
    childReady = true;
    ready = true;
    restartAttempt = 0;
    const handle: ServerHandle = { port: currentPort, httpBaseUrl, token };
    currentHandle = handle;
    deps.logger.info(`Server ready at ${httpBaseUrl}`);
    return handle;
  };

  const scheduleRestart = async (code: number | null): Promise<void> => {
    const delay = restartDelay(restartAttempt, tuning);
    deps.logger.warn(
      `Server exited (code=${String(code)}); restarting in ${delay}ms (attempt ${restartAttempt + 1})`,
    );
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
    try {
      return await launch();
    } catch (error) {
      // Failed initial bring-up: keep snapshot().running honest and schedule no restart.
      desiredRunning = false;
      throw error;
    }
  };

  const stop = async (): Promise<void> => {
    desiredRunning = false;
    currentHandle = null;
    const child = current;
    if (child === null) return;
    child.kill("SIGTERM");
    await deps.sleep(tuning.terminateGraceMs);
  };

  const snapshot = () => ({ running: desiredRunning, ready, restartAttempt });

  const getHandle = (): ServerHandle | null => currentHandle;

  return { start, stop, snapshot, getHandle };
};
