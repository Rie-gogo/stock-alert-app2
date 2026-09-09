import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { getSessionCookieOptions } from "./_core/cookies";

describe("OAuth session cookie options", () => {
  it("uses a secure host-only cookie behind the HTTPS reverse proxy", () => {
    const options = getSessionCookieOptions({
      protocol: "http",
      headers: { "x-forwarded-proto": "https" },
    } as Request);

    expect(options).toEqual({
      httpOnly: true,
      path: "/",
      sameSite: "none",
      secure: true,
    });
    expect(options.domain).toBeUndefined();
  });

  it("does not mark a plain local HTTP request as secure", () => {
    const options = getSessionCookieOptions({
      protocol: "http",
      headers: {},
    } as Request);

    expect(options.secure).toBe(false);
  });
});
