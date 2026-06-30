const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export interface WebviewHttpFetchMessage {
  readonly type: "t3code.http.fetch";
  readonly id: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface WebviewHttpResultMessage {
  readonly type: "t3code.http.result";
  readonly id: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly networkError?: boolean;
}

export const isWebviewHttpFetchMessage = (message: unknown): message is WebviewHttpFetchMessage =>
  typeof message === "object" &&
  message !== null &&
  (message as WebviewHttpFetchMessage).type === "t3code.http.fetch" &&
  typeof (message as WebviewHttpFetchMessage).id === "string" &&
  typeof (message as WebviewHttpFetchMessage).url === "string";

const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

/** Rewrites webview loopback URLs to the embedded server's actual bind address. */
export const rewriteLoopbackFetchUrl = (requestUrl: string, localHttpBaseUrl: string): string => {
  const requested = new URL(requestUrl);
  if (!isLoopbackHostname(requested.hostname)) {
    return requestUrl;
  }
  const local = new URL(localHttpBaseUrl);
  requested.protocol = local.protocol;
  requested.username = local.username;
  requested.password = local.password;
  requested.hostname = local.hostname;
  requested.port = local.port;
  return requested.toString();
};

export const proxyWebviewHttpFetch = async (
  message: WebviewHttpFetchMessage,
  localHttpBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WebviewHttpResultMessage> => {
  const targetUrl = rewriteLoopbackFetchUrl(message.url, localHttpBaseUrl);
  try {
    const response = await fetchImpl(targetUrl, {
      method: message.method ?? "GET",
      ...(message.headers === undefined ? {} : { headers: message.headers }),
      ...(message.body === undefined ? {} : { body: message.body }),
    });
    const body = await response.text();
    return {
      type: "t3code.http.result",
      id: message.id,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } catch (error) {
    return {
      type: "t3code.http.result",
      id: message.id,
      status: 0,
      statusText: "NetworkError",
      headers: {},
      body: error instanceof Error ? error.message : String(error),
      networkError: true,
    };
  }
};
