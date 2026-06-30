import { resolveExternalBaseUrls } from "../transport/urlResolver.ts";

const stripTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

export interface ResolvedServerSession {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  /** Loopback bind address used by the extension host when proxying webview HTTP. */
  readonly localHttpBaseUrl: string;
  readonly bootstrapToken: string;
  readonly label: string;
}

export async function resolveServerSession(input: {
  readonly localHttpBaseUrl: string;
  readonly bootstrapToken: string;
  readonly label?: string;
  readonly asExternalUri: (url: string) => Promise<string>;
}): Promise<ResolvedServerSession> {
  const resolved = await resolveExternalBaseUrls({
    localHttpBaseUrl: input.localHttpBaseUrl,
    asExternalUri: input.asExternalUri,
  });
  return {
    httpBaseUrl: resolved.httpBaseUrl,
    wsBaseUrl: resolved.wsBaseUrl,
    localHttpBaseUrl: stripTrailingSlash(input.localHttpBaseUrl),
    bootstrapToken: input.bootstrapToken,
    label: input.label ?? "Local environment",
  };
}
