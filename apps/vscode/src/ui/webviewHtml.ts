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

export const renderVsCodeBridgeScript = (
  bootstrapJson: string,
): string => `const vscode = acquireVsCodeApi();
const pendingHttp = new Map();
const loopbackWebSockets = new Map();
const NativeWebSocket = window.WebSocket;
function isLoopbackWsUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}
function dispatchWsEvent(target, type, eventInit) {
  const event = new Event(type, eventInit);
  const handler = target["on" + type];
  if (typeof handler === "function") {
    handler.call(target, event);
  }
  const listeners = target._listeners && target._listeners[type];
  if (listeners) {
    for (const listener of listeners.slice()) {
      listener.call(target, event);
    }
  }
}
function LoopbackWebSocket(url, protocols) {
  this.url = url;
  this.protocol = "";
  this.extensions = "";
  this.binaryType = "blob";
  this.readyState = 0;
  this.bufferedAmount = 0;
  this._listeners = { open: [], message: [], error: [], close: [] };
  this.onopen = null;
  this.onmessage = null;
  this.onerror = null;
  this.onclose = null;
  this._id = crypto.randomUUID();
  loopbackWebSockets.set(this._id, this);
  vscode.postMessage({ type: "t3code.ws.connect", id: this._id, url });
}
LoopbackWebSocket.prototype.addEventListener = function (type, listener) {
  if (!this._listeners[type]) {
    return;
  }
  this._listeners[type].push(listener);
};
LoopbackWebSocket.prototype.removeEventListener = function (type, listener) {
  if (!this._listeners[type]) {
    return;
  }
  this._listeners[type] = this._listeners[type].filter((entry) => entry !== listener);
};
LoopbackWebSocket.prototype.send = function (data) {
  if (this.readyState !== 1) {
    throw new DOMException("WebSocket is not open.", "InvalidStateError");
  }
  const payload =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? new TextDecoder().decode(new Uint8Array(data))
        : new TextDecoder().decode(data);
  vscode.postMessage({ type: "t3code.ws.send", id: this._id, data: payload });
};
LoopbackWebSocket.prototype.close = function (code, reason) {
  if (this.readyState === 2 || this.readyState === 3) {
    return;
  }
  this.readyState = 2;
  vscode.postMessage({
    type: "t3code.ws.close",
    id: this._id,
    ...(code === undefined ? {} : { code }),
    ...(reason === undefined ? {} : { reason }),
  });
};
LoopbackWebSocket.prototype._handleOpen = function () {
  if (this.readyState === 3) {
    return;
  }
  this.readyState = 1;
  dispatchWsEvent(this, "open", {});
};
LoopbackWebSocket.prototype._handleMessage = function (data) {
  if (this.readyState !== 1) {
    return;
  }
  const event = new MessageEvent("message", { data });
  if (typeof this.onmessage === "function") {
    this.onmessage.call(this, event);
  }
  for (const listener of this._listeners.message.slice()) {
    listener.call(this, event);
  }
};
LoopbackWebSocket.prototype._handleError = function (message) {
  dispatchWsEvent(this, "error", {});
};
LoopbackWebSocket.prototype._handleClose = function (code, reason) {
  if (this.readyState === 3) {
    return;
  }
  loopbackWebSockets.delete(this._id);
  this.readyState = 3;
  const event = new CloseEvent("close", { code: code || 1000, reason: reason || "" });
  if (typeof this.onclose === "function") {
    this.onclose.call(this, event);
  }
  for (const listener of this._listeners.close.slice()) {
    listener.call(this, event);
  }
};
LoopbackWebSocket.CONNECTING = 0;
LoopbackWebSocket.OPEN = 1;
LoopbackWebSocket.CLOSING = 2;
LoopbackWebSocket.CLOSED = 3;
function PatchedWebSocket(url, protocols) {
  const href = typeof url === "string" ? url : url.toString();
  if (!isLoopbackWsUrl(href)) {
    return new NativeWebSocket(url, protocols);
  }
  return new LoopbackWebSocket(href, protocols);
}
PatchedWebSocket.CONNECTING = 0;
PatchedWebSocket.OPEN = 1;
PatchedWebSocket.CLOSING = 2;
PatchedWebSocket.CLOSED = 3;
PatchedWebSocket.prototype = NativeWebSocket.prototype;
window.WebSocket = PatchedWebSocket;
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "t3code.http.result" && typeof msg.id === "string") {
    const resolve = pendingHttp.get(msg.id);
    if (resolve) {
      pendingHttp.delete(msg.id);
      resolve(msg);
    }
    return;
  }
  if (!msg || typeof msg.id !== "string") {
    return;
  }
  const ws = loopbackWebSockets.get(msg.id);
  if (!ws) {
    return;
  }
  switch (msg.type) {
    case "t3code.ws.open":
      ws._handleOpen();
      break;
    case "t3code.ws.message":
      ws._handleMessage(msg.data);
      break;
    case "t3code.ws.error":
      ws._handleError(msg.message);
      break;
    case "t3code.ws.close":
      ws._handleClose(msg.code, msg.reason);
      break;
  }
});
function readFetchHeaders(init, input) {
  const headers = {};
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers[key] = value;
    });
  }
  if (init && init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value;
      }
    } else {
      Object.assign(headers, init.headers);
    }
  }
  return headers;
}
function readFetchBody(init) {
  if (!init || init.body == null) {
    return undefined;
  }
  const body = init.body;
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  return undefined;
}
window.vscodeBridge = {
  getLocalEnvironmentBootstrap: () => (${bootstrapJson}),
  fetch: (input, init) => {
    const request = input instanceof Request ? input : null;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : request.url;
    const method = (init && init.method) || (request ? request.method : "GET");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pendingHttp.set(id, (result) => {
        if (result.networkError) {
          reject(new TypeError(result.body || "Proxy fetch failed"));
          return;
        }
        resolve(
          new Response(result.body, {
            status: result.status,
            statusText: result.statusText,
            headers: result.headers,
          }),
        );
      });
      vscode.postMessage({
        type: "t3code.http.fetch",
        id,
        url,
        method,
        headers: readFetchHeaders(init, request),
        body: readFetchBody(init),
      });
    });
  },
};`;

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
  const bridgeScript = renderVsCodeBridgeScript(bootstrapJson);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; font-src ${cspSource}; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${input.nonce}' ${cspSource} blob:; worker-src ${cspSource} blob:; connect-src ${connectSrc};" />
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
      ${bridgeScript}
    </script>
    <script type="module" nonce="${input.nonce}" src="${input.scriptUri}"></script>
  </body>
</html>`;
};
