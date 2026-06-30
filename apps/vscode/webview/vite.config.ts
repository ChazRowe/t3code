import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const dir = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(dir, "../../web/src");

// The shared web client reads its version from import.meta.env.APP_VERSION
// (apps/web/vite.config.ts defines it). The webview build uses this separate
// config, so define it here too — otherwise the client reports "0.0.0" and the
// version-skew banner fires against the embedded server. Mirror the extension's
// package version so client and server agree.
const require = createRequire(import.meta.url);
const extensionPkg = require("../package.json") as { version: string };
const appVersion = process.env.APP_VERSION?.trim() || extensionPkg.version;

export default defineConfig({
  root: path.join(dir, "chat"),
  base: "./",
  define: {
    "import.meta.env.APP_VERSION": JSON.stringify(appVersion),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "~": webSrc,
    },
  },
  build: {
    outDir: path.join(dir, "../dist/webview/chat"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
