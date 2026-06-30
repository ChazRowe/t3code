// @effect-diagnostics nodeBuiltinImport:off - build packaging tests read dist artifacts from disk.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { assert, it } from "@effect/vitest";

import {
  collectBareProductionImports,
  collectUnresolvedProductionImports,
  productionDependencyNames,
  resolvePackageNameFromSpecifier,
  shouldBundleCliDependency,
  stageNativeRuntimePackages,
} from "./bundleDeps.ts";

const serverDistDir = join(import.meta.dirname, "..", "dist");

it("resolvePackageNameFromSpecifier", () => {
  assert.equal(resolvePackageNameFromSpecifier("node-pty"), "node-pty");
  assert.equal(resolvePackageNameFromSpecifier("node-pty/package.json"), "node-pty");
  assert.equal(resolvePackageNameFromSpecifier("@effect/platform-node"), "@effect/platform-node");
  assert.equal(
    resolvePackageNameFromSpecifier("@effect/platform-node/NodeHttpServer"),
    "@effect/platform-node",
  );
  assert.equal(resolvePackageNameFromSpecifier("./NodePTY.mjs"), null);
  assert.equal(resolvePackageNameFromSpecifier("node:fs"), null);
});

it("shouldBundleCliDependency includes production dependencies and workspace runtime packages", () => {
  assert.isTrue(shouldBundleCliDependency("node-pty"));
  assert.isTrue(shouldBundleCliDependency("effect/Effect"));
  assert.isTrue(shouldBundleCliDependency("@effect/platform-node/NodeHttpServer"));
  assert.isTrue(shouldBundleCliDependency("@t3tools/shared/hostProcess"));
  assert.isTrue(shouldBundleCliDependency("effect-acp/errors"));
  assert.isTrue(shouldBundleCliDependency("effect-codex-app-server/schema"));
});

it("shouldBundleCliDependency leaves node builtins external", () => {
  assert.isFalse(shouldBundleCliDependency("node:fs"));
  assert.isFalse(shouldBundleCliDependency("fs"));
  assert.isFalse(shouldBundleCliDependency("path"));
});

it("collectBareProductionImports finds bare runtime dependency specifiers", () => {
  const sample = `
    const nodePty = yield* promise(() => import("node-pty"));
    const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
    import * as Effect from "effect/Effect";
  `;
  assert.deepStrictEqual(collectBareProductionImports(sample), [
    "effect/Effect",
    "node-pty",
    "node-pty/package.json",
  ]);
});

it("collectUnresolvedProductionImports ignores generated schema importDeclaration strings", () => {
  const sample = `
    importDeclaration: \`import * as Option from "effect/Option"\`
    const nodePty = yield* promise(() => import("node-pty"));
  `;
  assert.deepStrictEqual(collectUnresolvedProductionImports(sample), ["node-pty"]);
});

it("built server dist must not contain unresolved production dependency imports", () => {
  if (!existsSync(join(serverDistDir, "bin.mjs"))) {
    return;
  }

  const offenders: Array<{ file: string; imports: ReadonlyArray<string> }> = [];
  for (const entry of readdirSync(serverDistDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) {
      continue;
    }
    const filePath = join(serverDistDir, entry.name);
    const source = readFileSync(filePath, "utf8");
    const bareImports = collectUnresolvedProductionImports(source);
    if (bareImports.length > 0) {
      offenders.push({ file: entry.name, imports: bareImports });
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    offenders.length > 0
      ? `Server dist has unresolved production dependency imports:\n${offenders
          .map(({ file, imports }) => `  ${file}: ${imports.join(", ")}`)
          .join(
            "\n",
          )}\nRebuild with vp pack after fixing apps/server/vite.config.ts deps.alwaysBundle.`
      : undefined,
  );
});

it("built server dist stages native runtime packages", () => {
  if (!existsSync(join(serverDistDir, "bin.mjs"))) {
    return;
  }

  assert.isTrue(
    existsSync(join(serverDistDir, "node_modules", "node-pty", "package.json")),
    "Expected node-pty native package under dist/node_modules after build",
  );
  assert.isTrue(
    existsSync(join(serverDistDir, "build", "Release", "pty.node")) ||
      existsSync(join(serverDistDir, "prebuilds")),
    "Expected node-pty native binaries beside dist/",
  );
});

it("stageNativeRuntimePackages copies node-pty assets into dist", () => {
  const tempDist = mkdtempSync(join(tmpdir(), "t3-server-dist-"));
  try {
    stageNativeRuntimePackages(tempDist);
    assert.isTrue(existsSync(join(tempDist, "node_modules", "node-pty", "package.json")));
  } finally {
    rmSync(tempDist, { recursive: true, force: true });
  }
});

it("productionDependencyNames matches apps/server/package.json dependencies", () => {
  assert.include(productionDependencyNames, "node-pty");
  assert.include(productionDependencyNames, "effect");
});
