import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { layer as ProcessRunnerLive } from "../processRunner.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect(
  "captureCheckpoint reuses the real index stat cache instead of re-hashing via read-tree HEAD",
  () => {
    // Records the git argv of every VCS command while delegating to real git,
    // so we can assert capture's command sequence.
    const recordedArgs: ReadonlyArray<string>[] = [];
    const RecordingVcsProcessLayer = Layer.effect(
      VcsProcess.VcsProcess,
      Effect.gen(function* () {
        const real = yield* VcsProcess.make();
        return VcsProcess.VcsProcess.of({
          run: (input) => {
            recordedArgs.push([...input.args]);
            return real.run(input);
          },
        });
      }),
    ).pipe(Layer.provide(ProcessRunnerLive));

    const RecordingGitLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
      Layer.provide(ServerConfigLayer),
      Layer.provideMerge(RecordingVcsProcessLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    const ranReadTreeHead = (argv: ReadonlyArray<string>): boolean => {
      const index = argv.indexOf("read-tree");
      return index >= 0 && argv[index + 1] === "HEAD";
    };

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-capture-index-" });

      yield* runGit(cwd, ["init"]);
      yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(cwd, "file.ts"), "export const a = 1;\n");
      yield* runGit(cwd, ["add", "."]);
      yield* runGit(cwd, ["commit", "-m", "init"]);
      // Diverge the working tree so the capture has real changes to snapshot.
      yield* fileSystem.writeFileString(path.join(cwd, "file.ts"), "export const a = 2;\n");
      yield* fileSystem.writeFileString(path.join(cwd, "added.ts"), "export const b = 3;\n");

      const driver = yield* VcsDriver.VcsDriver;
      const checkpoints = driver.checkpoints;
      assert.isDefined(checkpoints);

      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/capture-index-test/turn/1");
      recordedArgs.length = 0;
      yield* checkpoints!.captureCheckpoint({ cwd, checkpointRef });

      // Capture must succeed: the checkpoint ref is actually written.
      assert.isTrue(yield* checkpoints!.hasCheckpointRef({ cwd, checkpointRef }));

      // Regression guard for the large-repo capture timeout: seeding the temp
      // index via `read-tree HEAD` drops the stat cache and forces `git add -A`
      // to re-hash the entire working tree (tens of seconds on big repos, which
      // trips the VCS timeout so no checkpoint is ever written). Capture must
      // instead seed from the real index, which preserves the stat cache.
      assert.isFalse(recordedArgs.some(ranReadTreeHead));
    }).pipe(Effect.scoped, Effect.provide(RecordingGitLayer));
  },
);

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});
