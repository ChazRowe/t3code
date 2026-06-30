const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export interface WebviewPortMapping {
  readonly webviewPort: number;
  readonly extensionHostPort: number;
}

export const isLoopbackHttpUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const stripTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

/** VS Code webview port mapping expects `localhost`, not `127.0.0.1`. */
export const toWebviewLoopbackUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.hostname === "127.0.0.1" || parsed.hostname === "::1") {
    parsed.hostname = "localhost";
  }
  return stripTrailingSlash(parsed.toString());
};

export const resolveWebviewPortMappings = (httpBaseUrl: string): readonly WebviewPortMapping[] => {
  if (!isLoopbackHttpUrl(httpBaseUrl)) {
    return [];
  }
  try {
    const port = Number.parseInt(new URL(httpBaseUrl).port, 10);
    if (!Number.isFinite(port) || port <= 0) {
      return [];
    }
    return [{ webviewPort: port, extensionHostPort: port }];
  } catch {
    return [];
  }
};
