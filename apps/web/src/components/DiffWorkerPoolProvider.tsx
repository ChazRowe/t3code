import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { useEffect, useMemo, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { isVSCode } from "../env";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    const current = workerPool.getDiffRenderOptions();
    if (current.theme === themeName) {
      return;
    }

    void workerPool
      .setRenderOptions({
        ...current,
        theme: themeName,
      })
      .catch(() => undefined);
  }, [themeName, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const workerPoolSize = useMemo(() => {
    const cores =
      typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  // VS Code webviews can't run the @pierre/diffs worker: the bundle is served
  // through VS Code's resource service worker, which does not control Worker /
  // blob contexts, so the worker can neither be constructed from the
  // vscode-cdn.net URL (cross-origin SecurityError) nor importScripts/fetch its
  // own script + shiki wasm from there (NetworkError). Chat code highlighting
  // runs on the MAIN THREAD (getSharedHighlighter) and doesn't need the pool —
  // only the diff panel does, and it degrades gracefully (useWorkerPool returns
  // undefined). Skip the pool entirely in the webview to avoid the error flood.
  // TODO: proper webview diff highlighting — inline the worker source into a
  // same-origin blob and force the shiki-js (wasm-free) engine.
  if (isVSCode) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new DiffsWorker(),
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        theme: diffThemeName,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      }}
    >
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {children}
    </WorkerPoolContextProvider>
  );
}
