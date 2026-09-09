import { encodeOAuthState, OAUTH_STATE_COOKIE } from "@shared/const";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOAuthCallbackHandler,
  type OAuthCallbackDependencies,
} from "./_core/oauth";

type ResponseDouble = Response & {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  cookie: ReturnType<typeof vi.fn>;
  clearCookie: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
};

function makeResponse(): ResponseDouble {
  const response = {} as ResponseDouble;
  response.status = vi.fn(() => response);
  response.json = vi.fn(() => response);
  response.cookie = vi.fn(() => response);
  response.clearCookie = vi.fn(() => response);
  response.redirect = vi.fn(() => response);
  return response;
}

function makeRequest(input?: {
  code?: string;
  state?: string;
  nonceCookie?: string;
}): Request {
  const nonceCookie = input?.nonceCookie;
  return {
    query: {
      code: input?.code,
      state: input?.state,
    },
    protocol: "http",
    headers: {
      cookie: nonceCookie
        ? `${OAUTH_STATE_COOKIE}=${encodeURIComponent(nonceCookie)}`
        : undefined,
      "x-forwarded-proto": "https",
    },
  } as unknown as Request;
}

function makeDependencies(
  overrides: Partial<OAuthCallbackDependencies> = {},
): OAuthCallbackDependencies {
  return {
    exchangeCodeForToken: vi.fn(async () => ({ accessToken: "test-access-token" })) as OAuthCallbackDependencies["exchangeCodeForToken"],
    getUserInfo: vi.fn(async () => ({
      openId: "test-open-id",
      name: "Test User",
      email: "test@example.invalid",
      loginMethod: "email",
      platform: "email",
    })) as OAuthCallbackDependencies["getUserInfo"],
    upsertUser: vi.fn(async () => undefined),
    createSessionToken: vi.fn(async () => "test-session-token") as OAuthCallbackDependencies["createSessionToken"],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuth callback", () => {
  it("runs every stage, sets a secure session cookie, and redirects", async () => {
    const nonce = "matching-nonce";
    const state = encodeOAuthState({
      redirectUri: "https://stock.example/api/oauth/callback",
      nonce,
    });
    const dependencies = makeDependencies();
    const response = makeResponse();

    await createOAuthCallbackHandler(dependencies)(
      makeRequest({ code: "one-time-code", state, nonceCookie: nonce }),
      response,
    );

    expect(dependencies.exchangeCodeForToken).toHaveBeenCalledWith(
      "one-time-code",
      state,
    );
    expect(dependencies.getUserInfo).toHaveBeenCalledWith("test-access-token");
    expect(dependencies.upsertUser).toHaveBeenCalledTimes(1);
    expect(dependencies.createSessionToken).toHaveBeenCalledWith(
      "test-open-id",
      expect.objectContaining({ name: "Test User" }),
    );
    expect(response.clearCookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.objectContaining({ secure: true, sameSite: "none", path: "/" }),
    );
    expect(response.cookie).toHaveBeenCalledWith(
      "app_session_id",
      "test-session-token",
      expect.objectContaining({
        secure: true,
        httpOnly: true,
        sameSite: "none",
        path: "/",
      }),
    );
    expect(response.redirect).toHaveBeenCalledWith(302, "/");
  });

  it("rejects a missing or mismatched nonce before code exchange", async () => {
    const state = encodeOAuthState({
      redirectUri: "https://stock.example/api/oauth/callback",
      nonce: "state-nonce",
    });
    const dependencies = makeDependencies();
    const response = makeResponse();

    await createOAuthCallbackHandler(dependencies)(
      makeRequest({ code: "unused-code", state, nonceCookie: "other-nonce" }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(dependencies.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("reports the failing stage without logging or returning secrets", async () => {
    const nonce = "private-nonce";
    const state = encodeOAuthState({
      redirectUri: "https://stock.example/api/oauth/callback",
      nonce,
    });
    const sensitiveError = Object.assign(
      new Error("contains-private-code-and-token"),
      { code: "ER_NO_SUCH_TABLE" },
    );
    const dependencies = makeDependencies({
      upsertUser: vi.fn(async () => {
        throw sensitiveError;
      }),
    });
    const response = makeResponse();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createOAuthCallbackHandler(dependencies)(
      makeRequest({ code: "private-code", state, nonceCookie: nonce }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: "OAuth callback failed",
      stage: "user_upsert",
    });
    const serializedLogs = JSON.stringify(errorSpy.mock.calls);
    expect(serializedLogs).toContain("user_upsert");
    expect(serializedLogs).toContain("ER_NO_SUCH_TABLE");
    expect(serializedLogs).not.toContain("private-code");
    expect(serializedLogs).not.toContain("private-nonce");
    expect(serializedLogs).not.toContain("contains-private-code-and-token");
  });

  it("returns a safe 401 for an invalid, expired, or reused code", async () => {
    const nonce = "single-use-nonce";
    const state = encodeOAuthState({
      redirectUri: "https://stock.example/api/oauth/callback",
      nonce,
    });
    const dependencies = makeDependencies({
      exchangeCodeForToken: vi.fn(async () => {
        throw Object.assign(new Error("private-provider-body"), {
          name: "AxiosError",
          response: { status: 400 },
        });
      }) as OAuthCallbackDependencies["exchangeCodeForToken"],
    });
    const response = makeResponse();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createOAuthCallbackHandler(dependencies)(
      makeRequest({ code: "reused-private-code", state, nonceCookie: nonce }),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      error: "OAuth authorization code is invalid or expired",
      stage: "code_exchange",
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      "reused-private-code",
    );
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      "private-provider-body",
    );
  });
});
