const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export interface WebviewWsConnectMessage {
  readonly type: "t3code.ws.connect";
  readonly id: string;
  readonly url: string;
}

export interface WebviewWsSendMessage {
  readonly type: "t3code.ws.send";
  readonly id: string;
  readonly data: string;
}

export interface WebviewWsCloseMessage {
  readonly type: "t3code.ws.close";
  readonly id: string;
  readonly code?: number;
  readonly reason?: string;
}

export type WebviewWsInboundMessage =
  | WebviewWsConnectMessage
  | WebviewWsSendMessage
  | WebviewWsCloseMessage;

export type WebviewWsOutboundMessage =
  | { readonly type: "t3code.ws.open"; readonly id: string }
  | { readonly type: "t3code.ws.message"; readonly id: string; readonly data: string }
  | {
      readonly type: "t3code.ws.close";
      readonly id: string;
      readonly code: number;
      readonly reason: string;
    }
  | { readonly type: "t3code.ws.error"; readonly id: string; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isWebviewWsInboundMessage = (message: unknown): message is WebviewWsInboundMessage => {
  if (!isRecord(message) || typeof message.id !== "string") {
    return false;
  }
  switch (message.type) {
    case "t3code.ws.connect":
      return typeof message.url === "string";
    case "t3code.ws.send":
      return typeof message.data === "string";
    case "t3code.ws.close":
      return true;
    default:
      return false;
  }
};

const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

/**
 * Effect RPC frames arrive as binary WebSocket messages (a `Uint8Array` of
 * UTF-8 JSON, even under `RpcSerialization.layerJson`). The webview bridge's
 * Effect socket expects text, so decode binary frames here before forwarding —
 * `String(event.data)` would yield "[object ArrayBuffer]"/"[object Blob]" and
 * silently break the entire server→client receive path.
 */
export const decodeWebSocketFrameData = (data: unknown): string | null => {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  // Blob (or anything else) cannot be decoded synchronously here; binaryType is
  // set to "arraybuffer" on the socket so we never reach this branch in practice.
  return null;
};

/** Rewrites webview loopback websocket URLs to the embedded server's bind address. */
export const rewriteLoopbackWebSocketUrl = (
  requestUrl: string,
  localHttpBaseUrl: string,
): string => {
  const requested = new URL(requestUrl);
  if (!isLoopbackHostname(requested.hostname)) {
    return requestUrl;
  }
  const local = new URL(localHttpBaseUrl);
  requested.protocol = local.protocol === "https:" ? "wss:" : "ws:";
  requested.hostname = local.hostname;
  requested.port = local.port;
  return requested.toString();
};

export class WebviewWsProxy {
  private readonly sockets = new Map<string, WebSocket>();

  handle(
    message: WebviewWsInboundMessage,
    localHttpBaseUrl: string,
    post: (message: WebviewWsOutboundMessage) => void,
    webSocketImpl: typeof WebSocket = WebSocket,
  ): void {
    switch (message.type) {
      case "t3code.ws.connect":
        this.connect(message, localHttpBaseUrl, post, webSocketImpl);
        return;
      case "t3code.ws.send":
        this.sockets.get(message.id)?.send(message.data);
        return;
      case "t3code.ws.close":
        this.sockets.get(message.id)?.close(message.code, message.reason);
        return;
    }
  }

  dispose(): void {
    for (const socket of this.sockets.values()) {
      socket.close();
    }
    this.sockets.clear();
  }

  private connect(
    message: WebviewWsConnectMessage,
    localHttpBaseUrl: string,
    post: (message: WebviewWsOutboundMessage) => void,
    webSocketImpl: typeof WebSocket,
  ): void {
    this.sockets.get(message.id)?.close();

    const targetUrl = rewriteLoopbackWebSocketUrl(message.url, localHttpBaseUrl);
    let socket: WebSocket;
    try {
      socket = new webSocketImpl(targetUrl);
    } catch (error) {
      post({
        type: "t3code.ws.error",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Effect RPC sends binary frames; receive them as ArrayBuffer so they can be
    // decoded to text rather than stringified into "[object Blob]".
    socket.binaryType = "arraybuffer";
    this.sockets.set(message.id, socket);

    socket.addEventListener("open", () => {
      post({ type: "t3code.ws.open", id: message.id });
    });

    socket.addEventListener("message", (event) => {
      const data = decodeWebSocketFrameData(event.data);
      if (data === null) {
        post({
          type: "t3code.ws.error",
          id: message.id,
          message: "Received an undecodable WebSocket frame.",
        });
        return;
      }
      post({ type: "t3code.ws.message", id: message.id, data });
    });

    socket.addEventListener("error", () => {
      post({
        type: "t3code.ws.error",
        id: message.id,
        message: "WebSocket connection failed.",
      });
    });

    socket.addEventListener("close", (event) => {
      this.sockets.delete(message.id);
      post({
        type: "t3code.ws.close",
        id: message.id,
        code: event.code,
        reason: event.reason,
      });
    });
  }
}
