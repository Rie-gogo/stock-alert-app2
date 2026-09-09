import { encodeOAuthState } from "@shared/const";
import type { AxiosInstance } from "axios";
import { describe, expect, it, vi } from "vitest";
import { OAuthService, getOAuthRedirectUriFromState } from "./_core/sdk";
import { ENV } from "./_core/env";

describe("OAuth SDK request contract", () => {
  it("sends clientId, authorization_code grant, code, and the exact redirectUri", async () => {
    const redirectUri = "https://stock.example/api/oauth/callback";
    const state = encodeOAuthState({ redirectUri, nonce: "nonce" });
    const post = vi.fn(async () => ({ data: { accessToken: "token" } }));
    const service = new OAuthService({ post } as unknown as AxiosInstance);

    await service.getTokenByCode("one-time-code", state);

    expect(post).toHaveBeenCalledWith(
      "/webdev.v1.WebDevAuthPublicService/ExchangeToken",
      {
        clientId: ENV.appId,
        grantType: "authorization_code",
        code: "one-time-code",
        redirectUri,
      },
    );
    expect(getOAuthRedirectUriFromState(state)).toBe(redirectUri);
  });

  it("rejects malformed state before making an OAuth request", () => {
    expect(() => getOAuthRedirectUriFromState("not-base64-json")).toThrow(
      "invalid_oauth_state",
    );
  });
});
