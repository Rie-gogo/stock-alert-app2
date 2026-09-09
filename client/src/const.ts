import {
  encodeOAuthState,
  OAUTH_STATE_COOKIE,
} from "@shared/const";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

const OAUTH_STATE_MAX_AGE_SECONDS = 600;

type LoginUrlOptions = {
  oauthPortalUrl: string;
  appId: string;
  origin: string;
  nonce: string;
};

export function buildLoginUrl({
  oauthPortalUrl,
  appId,
  origin,
  nonce,
}: LoginUrlOptions) {
  const redirectUri = `${origin}/api/oauth/callback`;
  const state = encodeOAuthState({ redirectUri, nonce });

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");
  url.searchParams.set("responseType", "code");

  return url.toString();
}

// Generate login URL at runtime so redirect URI reflects the current origin.
export const getLoginUrl = () => {
  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;
  const appId = import.meta.env.VITE_APP_ID;
  const nonce = crypto.randomUUID();

  document.cookie = `${OAUTH_STATE_COOKIE}=${encodeURIComponent(nonce)}; Path=/; Max-Age=${OAUTH_STATE_MAX_AGE_SECONDS}; SameSite=None; Secure`;

  return buildLoginUrl({
    oauthPortalUrl,
    appId,
    origin: window.location.origin,
    nonce,
  });
};

export const startLogin = () => {
  window.location.href = getLoginUrl();
};
