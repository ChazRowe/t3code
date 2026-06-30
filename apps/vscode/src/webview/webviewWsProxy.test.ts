import { describe, expect, it, vi } from "vite-plus/test";

import {
  decodeWebSocketFrameData,
  isWebviewWsInboundMessage,
  rewriteLoopbackWebSocketUrl,
  WebviewWsProxy,
} from "./webviewWsProxy.ts";

describe("rewriteLoopbackWebSocketUrl", () => {
  it("rewrites localhost websocket urls to the local server bind address", () => {
    expect(
      rewriteLoopbackWebSocketUrl("ws://localhost:3774/ws?wsTicket=abc", "http://127.0.0.1:3774"),
    ).toBe("ws://127.0.0.1:3774/ws?wsTicket=abc");
  });

  it("leaves non-loopback websocket urls unchanged", () => {
    expect(
      rewriteLoopbackWebSocketUrl(
        "wss://abc-3774.vscode-cdn.example/ws?wsTicket=abc",
        "http://127.0.0.1:3774",
      ),
    ).toBe("wss://abc-3774.vscode-cdn.example/ws?wsTicket=abc");
  });
});

describe("isWebviewWsInboundMessage", () => {
  it("accepts websocket control messages", () => {
    expect(
      isWebviewWsInboundMessage({
        type: "t3code.ws.connect",
        id: "1",
        url: "ws://localhost:3774/ws",
      }),
    ).toBe(true);
    expect(
      isWebviewWsInboundMessage({
        type: "t3code.ws.send",
        id: "1",
        data: "{}",
      }),
    ).toBe(true);
  });

  it("rejects unrelated messages", () => {
    expect(isWebviewWsInboundMessage({ type: "other" })).toBe(false);
  });
});

describe("decodeWebSocketFrameData", () => {
  it("passes through string frames", () => {
    expect(decodeWebSocketFrameData('{"hello":true}')).toBe('{"hello":true}');
  });

  it("decodes binary ArrayBuffer frames (Effect RPC sends JSON as bytes)", () => {
    const bytes = new TextEncoder().encode('{"hello":true}');
    expect(decodeWebSocketFrameData(bytes.buffer)).toBe('{"hello":true}');
  });

  it("decodes typed-array views honouring byte offsets", () => {
    const padded = new TextEncoder().encode('XX{"a":1}');
    const view = new Uint8Array(padded.buffer, 2, padded.byteLength - 2);
    expect(decodeWebSocketFrameData(view)).toBe('{"a":1}');
  });

  it("returns null for undecodable frames", () => {
    expect(decodeWebSocketFrameData({ not: "a frame" })).toBeNull();
  });
});

describe("WebviewWsProxy", () => {
  it("sets binaryType to arraybuffer and decodes binary frames to text", () => {
    const posted: Array<unknown> = [];
    const listeners = new Map<string, EventListener>();
    const socket = {
      binaryType: "blob",
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      send: vi.fn(),
      close: vi.fn(),
    };
    const WebSocketImpl = function (_url: string) {
      return socket;
    };

    new WebviewWsProxy().handle(
      { type: "t3code.ws.connect", id: "ws-bin", url: "ws://localhost:3774/ws" },
      "http://127.0.0.1:3774",
      (message) => posted.push(message),
      WebSocketImpl as unknown as typeof WebSocket,
    );

    expect(socket.binaryType).toBe("arraybuffer");

    const frame = new TextEncoder().encode('{"event":"ok"}');
    listeners.get("message")?.(new MessageEvent("message", { data: frame.buffer }));

    expect(posted).toEqual([{ type: "t3code.ws.message", id: "ws-bin", data: '{"event":"ok"}' }]);
  });

  it("relays websocket lifecycle events back to the webview", () => {
    const posted: Array<unknown> = [];
    const listeners = new Map<string, EventListener>();
    const socket = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      send: vi.fn(),
      close: vi.fn(),
    };
    const WebSocketImpl = function (_url: string) {
      return socket;
    };

    const proxy = new WebviewWsProxy();
    proxy.handle(
      {
        type: "t3code.ws.connect",
        id: "ws-1",
        url: "ws://localhost:3774/ws?wsTicket=abc",
      },
      "http://127.0.0.1:3774",
      (message) => {
        posted.push(message);
      },
      WebSocketImpl as unknown as typeof WebSocket,
    );

    expect(socket.addEventListener).toHaveBeenCalled();

    listeners.get("open")?.(new Event("open"));
    listeners.get("message")?.(new MessageEvent("message", { data: '{"hello":true}' }));

    expect(posted).toEqual([
      { type: "t3code.ws.open", id: "ws-1" },
      { type: "t3code.ws.message", id: "ws-1", data: '{"hello":true}' },
    ]);

    proxy.handle(
      { type: "t3code.ws.send", id: "ws-1", data: '{"ping":true}' },
      "http://127.0.0.1:3774",
      () => undefined,
      WebSocketImpl as unknown as typeof WebSocket,
    );
    expect(socket.send).toHaveBeenCalledWith('{"ping":true}');
  });
});
