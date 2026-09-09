export const COOKIE_NAME = "app_session_id";
export const OAUTH_STATE_COOKIE = "__Host-oauth_state";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

export type OAuthState = {
  redirectUri: string;
  nonce: string;
};

export function encodeOAuthState(state: OAuthState): string {
  return globalThis.btoa(JSON.stringify(state));
}

export function decodeOAuthState(value: unknown): Partial<OAuthState> {
  if (typeof value !== "string" || value.length === 0) return {};

  try {
    const decoded = JSON.parse(globalThis.atob(value)) as unknown;
    if (!decoded || typeof decoded !== "object") return {};

    const record = decoded as Record<string, unknown>;
    return {
      redirectUri:
        typeof record.redirectUri === "string" ? record.redirectUri : undefined,
      nonce: typeof record.nonce === "string" ? record.nonce : undefined,
    };
  } catch {
    return {};
  }
}
