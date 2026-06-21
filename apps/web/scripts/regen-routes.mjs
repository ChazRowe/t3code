// Headless regeneration of routeTree.gen.ts (no dev server needed).
// Mirrors what @tanstack/router-plugin/vite does during dev/build.
// @tanstack/router-generator is a transitive dep (under .pnpm), so locate its
// versioned directory by prefix instead of hard-coding the version.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd(); // run from apps/web
const repoRoot = path.resolve(root, "..", "..");
const pnpmDir = path.join(repoRoot, "node_modules/.pnpm");
const genDirName = fs.readdirSync(pnpmDir).find((d) => d.startsWith("@tanstack+router-generator@"));
if (!genDirName) {
  throw new Error("Could not locate @tanstack/router-generator under node_modules/.pnpm");
}
const genPkg = path.join(
  pnpmDir,
  genDirName,
  "node_modules/@tanstack/router-generator/dist/esm/index.js",
);
const { Generator, getConfig } = await import(genPkg);

const config = getConfig({}, root);
await new Generator({ config, root }).run();
console.log("routeTree.gen.ts regenerated");
