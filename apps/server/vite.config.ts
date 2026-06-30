import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

import { shouldBundleCliDependency } from "./scripts/bundleDeps.ts";

export { shouldBundleCliDependency };

const repoEnv = loadRepoEnv();

export default mergeConfig(
  baseConfig,
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      shims: true,
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        onlyBundle: false,
      },
      banner: {
        // The shebang MUST stay on line 1. The lines after it force the bundled
        // `ws` onto its pure-JS mask/unmask path: the native `bufferutil` /
        // `utf-8-validate` addons can resolve to broken stubs inside this
        // single-file bundle and crash the server on the first inbound WS frame
        // (`TypeError: bufferUtil.unmask is not a function`). `ws` reads these env
        // vars at module-init time, and the banner is emitted above all bundled
        // module code, so it is the only place guaranteed to run first.
        js: [
          "#!/usr/bin/env node",
          'process.env.WS_NO_BUFFER_UTIL ??= "1";',
          'process.env.WS_NO_UTF_8_VALIDATE ??= "1";',
          "",
        ].join("\n"),
      },
      define: {
        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
        __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
        ),
        __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
        ),
      },
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
