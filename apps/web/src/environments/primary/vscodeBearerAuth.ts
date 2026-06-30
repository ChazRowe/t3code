let vscodePrimaryBearerToken: string | null = null;

export function getVsCodePrimaryBearerToken(): string | null {
  return vscodePrimaryBearerToken;
}

export function setVsCodePrimaryBearerToken(token: string | null): void {
  vscodePrimaryBearerToken = token;
}

export function __resetVsCodePrimaryBearerTokenForTests(): void {
  vscodePrimaryBearerToken = null;
}
