# @t3tools/vscode-extension

T3 Code as a VSCode extension. Embeds the existing `@t3tools/server` and UI.

## Develop

1. Build the server once: `pnpm build:server` (produces `apps/server/dist/bin.mjs`).
2. Build the extension: `pnpm --filter @t3tools/vscode-extension build`
   (or `pnpm --filter @t3tools/vscode-extension dev` to watch).
3. Open this repo in VSCode and press **F5** (Run Extension) to launch the
   Extension Development Host. Run **T3 Code: Status** from the command palette
   to verify the embedded server is up.

`extensionKind` is `["workspace"]`, so under Remote-SSH the extension and the
server run on the remote host.
