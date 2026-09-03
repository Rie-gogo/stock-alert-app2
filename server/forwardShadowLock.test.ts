import { describe, expect, it } from "vitest";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";

describe("前向きシャドー共有状態ロック", () => {
  it("長いrelayイベントIDでもowner_token varchar(64)以内の一意なSHA-256を生成する", () => {
    const input = {
      strategyVersion: "forward-shadow-285a-five-routes-atr036-route-daily-end-v1",
      sourceEventId: `${"relay-session".repeat(12)}:999999`,
      evaluationMode: "capital_constrained",
    };
    const first = createForwardShadowLockOwnerToken(input);
    const second = createForwardShadowLockOwnerToken(input);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});
