// @effect-diagnostics nodeBuiltinImport:off - build packaging utilities use Node fs/path directly.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import serverPackageJson from "../package.json" with { type: "json" };

/** Workspace packages imported at runtime but listed as devDependencies. */
const WORKSPACE_RUNTIME_PACKAGES = ["effect-acp", "effect-codex-app-server"] as const;

export const productionDependencyNames = Object.freeze(Object.keys(serverPackageJson.dependencies));

const bundledPackageNames = new Set<string>([
  ...productionDependencyNames,
  ...WORKSPACE_RUNTIME_PACKAGES,
]);

export function resolvePackageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  const slash = specifier.indexOf("/");
  return slash === -1 ? specifier : specifier.slice(0, slash);
}

export function shouldBundleCliDependency(id: string): boolean {
  const name = resolvePackageNameFromSpecifier(id);
  if (name === null) {
    return false;
  }
  if (bundledPackageNames.has(name)) {
    return true;
  }
  // @t3tools/* workspace packages are devDependencies but bundled at runtime.
  return name.startsWith("@t3tools/");
}

const stripSourceComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, "$1");

/** Packages whose JS is bundled but native assets must ship beside dist/. */
export const NATIVE_RUNTIME_PACKAGES = ["node-pty"] as const;

const requireForResolve = createRequire(import.meta.url);

export function resolvePackageRoot(packageName: string): string {
  return dirname(requireForResolve.resolve(`${packageName}/package.json`));
}

export function stageNativeRuntimePackages(distDir: string): void {
  for (const packageName of NATIVE_RUNTIME_PACKAGES) {
    if (!productionDependencyNames.includes(packageName)) {
      continue;
    }

    const packageRoot = resolvePackageRoot(packageName);
    const targetRoot = join(distDir, "node_modules", packageName);
    mkdirSync(dirname(targetRoot), { recursive: true });
    cpSync(packageRoot, targetRoot, {
      recursive: true,
      filter: (sourcePath) => {
        const relative = sourcePath.startsWith(packageRoot)
          ? sourcePath.slice(packageRoot.length)
          : sourcePath;
        return !relative.split("/").includes("node_modules");
      },
    });

    for (const relativeDir of ["prebuilds", "build"] as const) {
      const source = join(packageRoot, relativeDir);
      if (!existsSync(source)) {
        continue;
      }
      cpSync(source, join(distDir, relativeDir), { recursive: true });
    }
  }
}

const UNRESOLVED_IMPORT_PATTERN =
  /(?:import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s[\s\S]*?\sfrom\s+["']([^"']+)["'])/g;

export function collectUnresolvedProductionImports(
  source: string,
  dependencyNames: readonly string[] = productionDependencyNames,
): ReadonlyArray<string> {
  const dependencySet = new Set(dependencyNames);
  const found = new Set<string>();
  const stripped = stripSourceComments(source);

  for (const match of stripped.matchAll(UNRESOLVED_IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined) {
      continue;
    }
    const packageName = resolvePackageNameFromSpecifier(specifier);
    if (packageName !== null && dependencySet.has(packageName)) {
      found.add(specifier);
    }
  }

  return [...found].sort();
}

const BARE_IMPORT_PATTERN =
  /\b(?:import\s*\(\s*["']([^"']+)["']\s*\)|from\s+["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)|\.resolve\s*\(\s*["']([^"']+)["']\s*\))/g;

export function collectBareProductionImports(
  source: string,
  dependencyNames: readonly string[] = productionDependencyNames,
): ReadonlyArray<string> {
  const dependencySet = new Set(dependencyNames);
  const found = new Set<string>();
  const stripped = stripSourceComments(source);

  for (const match of stripped.matchAll(BARE_IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier === undefined) {
      continue;
    }
    const packageName = resolvePackageNameFromSpecifier(specifier);
    if (packageName !== null && dependencySet.has(packageName)) {
      found.add(specifier);
    }
  }

  return [...found].sort();
}
