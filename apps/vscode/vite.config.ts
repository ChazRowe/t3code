import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // The extension spawns apps/server/dist/bin.mjs, so the server must be built first.
      build: {
        command: "vp pack && pnpm run build:webview",
        dependsOn: ["t3#build"],
        cache: false,
      },
      dev: { command: "vp pack --watch", cache: false },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/extension.ts"],
      clean: true,
      deps: {
        // `vscode` is injected by the extension host at runtime — never bundle it.
        neverBundle: ["vscode"],
        // Bundle our workspace packages into the extension (they ship no built dist).
        alwaysBundle: (id: string) => id.startsWith("@t3tools/"),
      },
    },
  ],
});
