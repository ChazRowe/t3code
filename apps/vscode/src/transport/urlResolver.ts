export interface ResolveExternalBaseUrlsInput {
  readonly localHttpBaseUrl: string;
  readonly asExternalUri: (url: string) => Promise<string>;
}

export interface ResolvedBaseUrls {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly readinessUrl: string;
}

const stripTrailingSlash = (value: string): string =>
  value.endsWith("/") ? value.slice(0, -1) : value;

export const resolveExternalBaseUrls = async (
  input: ResolveExternalBaseUrlsInput,
): Promise<ResolvedBaseUrls> => {
  const external = await input.asExternalUri(input.localHttpBaseUrl);
  const url = new URL(external);
  const httpBaseUrl = stripTrailingSlash(url.toString());
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  const wsBaseUrl = stripTrailingSlash(`${wsScheme}//${url.host}${url.pathname}`);
  const readinessUrl = `${httpBaseUrl}/.well-known/t3/environment`;
  return { httpBaseUrl, wsBaseUrl, readinessUrl };
};
