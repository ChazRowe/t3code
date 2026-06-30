export interface WebviewBootstrapPayload {
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bootstrapToken: string;
}

export interface RenderWebviewHtmlInput {
  readonly nonce: string;
  readonly bootstrap: WebviewBootstrapPayload;
  readonly scriptUri: string;
  readonly styleUris: readonly string[];
  readonly connectSrcOrigins: readonly string[];
  readonly cspSource?: string;
}

const escapeScriptJson = (value: string): string =>
  value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");

export const buildConnectSrcOrigins = (httpBaseUrl: string, wsBaseUrl: string): string[] => {
  const origins = new Set<string>();
  for (const raw of [httpBaseUrl, wsBaseUrl]) {
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // Ignore malformed URLs in tests; production callers validate upstream.
    }
  }
  return [...origins];
};

export const renderWebviewHtml = (input: RenderWebviewHtmlInput): string => {
  const cspSource = input.cspSource ?? "'self' https://*.vscode-cdn.net";
  const connectSrc = [...input.connectSrcOrigins, cspSource].join(" ");
  const styleTags = input.styleUris
    .map((href) => `<link rel="stylesheet" href="${href}" />`)
    .join("\n    ");
  const bootstrapJson = escapeScriptJson(
    JSON.stringify({
      label: input.bootstrap.label,
      httpBaseUrl: input.bootstrap.httpBaseUrl,
      wsBaseUrl: input.bootstrap.wsBaseUrl,
      bootstrapToken: input.bootstrap.bootstrapToken,
    }),
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${input.nonce}'; connect-src ${connectSrc};" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>T3 Code</title>
    <style>
      html, body, #root { height: 100%; margin: 0; }
      body {
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        color: var(--vscode-foreground, #ccc);
        background: var(--vscode-editor-background, #1e1e1e);
      }
    </style>
    ${styleTags}
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${input.nonce}">
      window.vscodeBridge = {
        getLocalEnvironmentBootstrap: () => (${bootstrapJson}),
      };
    </script>
    <script type="module" nonce="${input.nonce}" src="${input.scriptUri}"></script>
  </body>
</html>`;
};
