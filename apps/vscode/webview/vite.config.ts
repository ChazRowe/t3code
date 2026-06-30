import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const dir = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(dir, "../../web/src");

export default defineConfig({
  root: path.join(dir, "chat"),
  base: "./",
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
