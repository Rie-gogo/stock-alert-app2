import { decodeOAuthState } from "@shared/const";
import { describe, expect, it } from "vitest";
import { buildLoginUrl } from "./const";

describe("OAuth login URL", () => {
  it("adds every required Manus OAuth parameter and binds state to redirectUri", () => {
    const loginUrl = buildLoginUrl({
      oauthPortalUrl: "https://manus.example",
      appId: "app-id",
      origin: "https://stock.example",
      nonce: "nonce-value",
    });

    const parsed = new URL(loginUrl);
    const state = parsed.searchParams.get("state");

    expect(parsed.origin + parsed.pathname).toBe("https://manus.example/app-auth");
    expect(parsed.searchParams.get("appId")).toBe("app-id");
    expect(parsed.searchParams.get("redirectUri")).toBe(
      "https://stock.example/api/oauth/callback",
    );
    expect(parsed.searchParams.get("type")).toBe("signIn");
    expect(parsed.searchParams.get("responseType")).toBe("code");
    expect(decodeOAuthState(state)).toEqual({
      redirectUri: "https://stock.example/api/oauth/callback",
      nonce: "nonce-value",
    });
  });
});
