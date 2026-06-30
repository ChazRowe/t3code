export const EMBEDDED_SERVER_BOOTSTRAP_FD = 3;

export const resolveEmbeddedServerSpawnArgs = (input: {
  readonly entryPath: string;
  readonly workspaceCwd: string | undefined;
}): readonly string[] => {
  const args: string[] = [input.entryPath, "--bootstrap-fd", String(EMBEDDED_SERVER_BOOTSTRAP_FD)];
  if (input.workspaceCwd !== undefined) {
    args.push(
      "--auto-bootstrap-project-from-cwd",
      "--auto-bootstrap-create-new-thread",
      input.workspaceCwd,
    );
  }
  return args;
};
