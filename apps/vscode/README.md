# t3-code

T3 Code as a VSCode extension. Embeds the existing `@t3tools/server` and UI.

## Develop

1. Build the server once: `pnpm build:server` (produces `apps/server/dist/bin.mjs`).
2. Build the extension (host + chat webview): `pnpm --filter t3-code build:bundle && pnpm --filter t3-code build:webview`
   (or `pnpm exec vp run --filter t3-code dev` to watch the host bundle).
3. Open this repo in VSCode and press **F5** (Run Extension) to launch the
   Extension Development Host. Run **T3 Code: Open Chat** from the command palette
   (or open the **T3 Code** activity-bar icon → **Chat**). **T3 Code: Status**
   verifies the embedded server is up.

## Package VSIX

From the repo root (after `pnpm build:server`):

```bash
pnpm --filter t3-code package:vsix
```

`vscode:prepublish` builds the extension bundle and copies `apps/server/dist` into
`apps/vscode/server/dist` before `vsce package` runs. The staged server tree is
gitignored; do not copy it by hand.

`extensionKind` is `["workspace"]`, so under Remote-SSH the extension and the
server run on the remote host.
