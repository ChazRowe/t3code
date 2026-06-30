export interface StatusViewModel {
  readonly ready: boolean;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly descriptorJson: string | null;
  readonly error: string | null;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const shouldContinueStatusPolling = (model: StatusViewModel): boolean =>
  !model.ready && model.error === null;

export const renderStatusHtml = (model: StatusViewModel): string => {
  const status = model.error !== null ? "Error" : model.ready ? "Ready" : "Starting...";
  const body =
    model.error !== null
      ? `<p class="err">${escapeHtml(model.error)}</p>`
      : !model.ready
        ? `<p>Embedded server is starting.</p>`
        : `<dl>
           <dt>HTTP</dt><dd>${escapeHtml(model.httpBaseUrl)}</dd>
           <dt>WebSocket</dt><dd>${escapeHtml(model.wsBaseUrl)}</dd>
           <dt>Descriptor</dt><dd><pre>${escapeHtml(model.descriptorJson ?? "(none)")}</pre></dd>
         </dl>`;
  return `<!doctype html><html><head><meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <style>body{font-family:var(--vscode-font-family);padding:12px}.err{color:var(--vscode-errorForeground)}
    dt{font-weight:600;margin-top:8px}pre{white-space:pre-wrap}</style></head>
    <body><h2>T3 Code — ${escapeHtml(status)}</h2>${body}</body></html>`;
};
