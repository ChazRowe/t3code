// @effect-diagnostics nodeBuiltinImport:off - Extension host resolves webview asset paths with Node fs/path.
import { readdirSync } from "node:fs";
import path from "node:path";

export interface WebviewEntryAssets {
  readonly scriptName: string;
  readonly styleNames: readonly string[];
}

export const resolveWebviewEntryAssets = (
  webviewDistDir: string,
  readDir: (dir: string) => readonly string[] = (dir) => readdirSync(dir),
): WebviewEntryAssets | null => {
  const assetsDir = path.join(webviewDistDir, "assets");
  let entries: readonly string[];
  try {
    entries = readDir(assetsDir);
  } catch {
    return null;
  }

  const scriptName = entries.find((name) => /^index-.*\.js$/.test(name));
  if (!scriptName) {
    return null;
  }

  const styleNames = entries.filter((name) => /^index-.*\.css$/.test(name));
  return { scriptName, styleNames };
};
