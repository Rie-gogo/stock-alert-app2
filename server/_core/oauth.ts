import {
  COOKIE_NAME,
  decodeOAuthState,
  OAUTH_STATE_COOKIE,
  ONE_YEAR_MS,
} from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export type OAuthCallbackStage =
  | "state_validation"
  | "code_exchange"
  | "user_info"
  | "open_id_validation"
  | "user_upsert"
  | "session_creation"
  | "cookie_and_redirect";

export type OAuthCallbackDependencies = {
  exchangeCodeForToken: typeof sdk.exchangeCodeForToken;
  getUserInfo: typeof sdk.getUserInfo;
  upsertUser: typeof db.upsertUser;
  createSessionToken: typeof sdk.createSessionToken;
};

const defaultDependencies: OAuthCallbackDependencies = {
  exchangeCodeForToken: sdk.exchangeCodeForToken.bind(sdk),
  getUserInfo: sdk.getUserInfo.bind(sdk),
  upsertUser: db.upsertUser,
  createSessionToken: sdk.createSessionToken.bind(sdk),
};

function safeErrorMetadata(error: unknown) {
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  } | null;

  return {
    errorType:
      typeof candidate?.name === "string" ? candidate.name : "UnknownError",
    errorCode:
      typeof candidate?.code === "string" ? candidate.code : undefined,
    httpStatus:
      typeof candidate?.response?.status === "number"
        ? candidate.response.status
        : undefined,
  };
}

function logOAuthFailure(stage: OAuthCallbackStage, error: unknown) {
  console.error("[OAuth] callback_failed", {
    stage,
    ...safeErrorMetadata(error),
  });
}

function clearOAuthStateCookie(res: Response) {
  res.clearCookie(OAUTH_STATE_COOKIE, {
    httpOnly: false,
    path: "/",
    sameSite: "none",
    secure: true,
  });
}

export function createOAuthCallbackHandler(
  dependencies: OAuthCallbackDependencies = defaultDependencies,
) {
  return async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "OAuth parameters are invalid" });
      return;
    }

    let stage: OAuthCallbackStage = "state_validation";

    try {
      const { nonce, redirectUri } = decodeOAuthState(state);
      const expectedNonce = parseCookieHeader(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];

      if (!nonce || !redirectUri || !expectedNonce || nonce !== expectedNonce) {
        clearOAuthStateCookie(res);
        res.status(403).json({ error: "OAuth state is invalid or expired" });
        return;
      }

      clearOAuthStateCookie(res);

      stage = "code_exchange";
      const tokenResponse = await dependencies.exchangeCodeForToken(code, state);

      stage = "user_info";
      const userInfo = await dependencies.getUserInfo(tokenResponse.accessToken);

      stage = "open_id_validation";
      if (!userInfo.openId) {
        res.status(400).json({ error: "OAuth user information is invalid" });
        return;
      }

      stage = "user_upsert";
      await dependencies.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      stage = "session_creation";
      const sessionToken = await dependencies.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      stage = "cookie_and_redirect";
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      logOAuthFailure(stage, error);
      const status = stage === "code_exchange" ? 401 : 500;
      res.status(status).json({
        error:
          stage === "code_exchange"
            ? "OAuth authorization code is invalid or expired"
            : "OAuth callback failed",
        stage,
      });
    }
  };
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", createOAuthCallbackHandler());
}
