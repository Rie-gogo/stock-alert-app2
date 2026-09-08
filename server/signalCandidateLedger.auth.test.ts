import { describe, expect, it } from "vitest";
import type { TrpcContext } from "./_core/context";
import { tradingRouter } from "./routers/trading";

function context(user: TrpcContext["user"]): TrpcContext {
  return {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

const user: NonNullable<TrpcContext["user"]> = {
  id: 1,
  openId: "ledger-user",
  name: "Ledger User",
  email: "ledger@example.com",
  loginMethod: "manus",
  role: "user",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
};

describe("trading.getRtSignalCandidateLedger 認証と入力", () => {
  it("未認証アクセスを拒否する", async () => {
    const caller = tradingRouter.createCaller(context(null));
    await expect(caller.getRtSignalCandidateLedger({ tradeDate: "2026-09-08" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("形式不正と存在しない日付を拒否する", async () => {
    const caller = tradingRouter.createCaller(context(user));
    await expect(caller.getRtSignalCandidateLedger({ tradeDate: "2026-9-8" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.getRtSignalCandidateLedger({ tradeDate: "2026-02-30" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
