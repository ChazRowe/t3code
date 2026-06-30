import { resolveExternalBaseUrls } from "../transport/urlResolver.ts";

export interface ResolvedServerSession {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
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
    bootstrapToken: input.bootstrapToken,
    label: input.label ?? "Local environment",
  };
}
