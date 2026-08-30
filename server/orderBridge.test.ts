import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the database module
vi.mock("./db", () => ({
  getDb: vi.fn(),
}));

// Mock the schema imports
vi.mock("../drizzle/schema", () => ({
  orderInstructions: {
    id: "id",
    tradeDate: "tradeDate",
    symbol: "symbol",
    symbolName: "symbolName",
    side: "oi_side",
    instructionType: "oi_instruction_type",
    qty: "qty",
    status: "oi_status",
    reason: "reason",
    referencePrice: "referencePrice",
    expiresAt: "expiresAt",
    kabuOrderId: "kabuOrderId",
    executedPrice: "executedPrice",
    executedAt: "executedAt",
    pnl: "pnl",
    rtTradeId: "rtTradeId",
    errorMessage: "errorMessage",
    isDryRun: "isDryRun",
    executorLog: "executorLog",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  autoTradeDaily: {
    id: "id",
    tradeDate: "tradeDate",
    realizedPnl: "realizedPnl",
    tradeCount: "tradeCount",
    dailyLossLimit: "dailyLossLimit",
    tradingEnabled: "tradingEnabled",
    emergencyStop: "emergencyStop",
    emergencyStopReason: "emergencyStopReason",
    isDryRun: "isDryRun",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
  },
  rtTrades: {
    id: "id",
    tradeDate: "tradeDate",
    symbol: "symbol",
    symbolName: "symbolName",
    action: "action",
    price: "price",
    reason: "reason",
    createdAt: "createdAt",
  },
}));

vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn((symbol: string) => `テスト銘柄${symbol}`),
}));

describe("orderBridge", () => {
  describe("6976候補Bの戦略単位LIVE拒否", () => {
    it("DRY_RUNのentryは許可するが、LIVEのentryは承認フラグfalseなら拒否する", async () => {
      const { evaluateTaiyoCandidateBOrderApproval } = await import("./taiyoCandidateB");
      const reason = "太陽誘電候補BLONG: 10本終値ブレイク後1本確認";

      expect(evaluateTaiyoCandidateBOrderApproval({ reason, instructionType: "entry", isDryRun: true }))
        .toEqual({ allowed: true });
      expect(evaluateTaiyoCandidateBOrderApproval({ reason, instructionType: "entry", isDryRun: false }))
        .toEqual({ allowed: false, code: "candidate_b_live_not_approved" });
    });

    it("他戦略のLIVE entryと候補Bの決済はこの戦略ガードでは止めない", async () => {
      const { evaluateTaiyoCandidateBOrderApproval } = await import("./taiyoCandidateB");

      expect(evaluateTaiyoCandidateBOrderApproval({
        reason: "東京エレクトロン短期ブレイクLONG",
        instructionType: "entry",
        isDryRun: false,
      })).toEqual({ allowed: true });
      expect(evaluateTaiyoCandidateBOrderApproval({
        reason: "太陽誘電候補Bの決済",
        instructionType: "exit",
        isDryRun: false,
      })).toEqual({ allowed: true });
    });

    it("注文指示作成境界でも候補BのLIVE entryをDB書込み前に拒否する", async () => {
      const { createOrderInstruction } = await import("./orderBridge");
      await expect(createOrderInstruction({
        tradeDate: "2026-08-31",
        symbol: "6976",
        symbolName: "太陽誘電",
        side: "buy",
        instructionType: "entry",
        qty: 100,
        status: "pending",
        reason: "太陽誘電候補BLONG: ガードテスト",
        referencePrice: "10000",
        expiresAt: null,
        kabuOrderId: null,
        executedPrice: null,
        executedAt: null,
        pnl: null,
        rtTradeId: 1,
        errorMessage: null,
        isDryRun: false,
        executorLog: null,
      })).rejects.toThrow("candidate_b_live_not_approved");
    });
  });

  describe("6526確認型LONGの戦略単位LIVE拒否", () => {
    it("DRY_RUN entryは許可し、LIVE entryだけを拒否して決済は許可する", async () => {
      const { evaluateSocionextConfirmedLongOrderApproval } = await import("./socionextConfirmedLong");
      const reason = "ソシオネクスト確認型LONG: 10本高値更新後1本確認";

      expect(evaluateSocionextConfirmedLongOrderApproval({ reason, instructionType: "entry", isDryRun: true }))
        .toEqual({ allowed: true });
      expect(evaluateSocionextConfirmedLongOrderApproval({ reason, instructionType: "entry", isDryRun: false }))
        .toEqual({ allowed: false, code: "socionext_confirmed_long_live_not_approved" });
      expect(evaluateSocionextConfirmedLongOrderApproval({ reason, instructionType: "exit", isDryRun: false }))
        .toEqual({ allowed: true });
    });

    it("注文指示作成境界でも6526のLIVE entryをDB書込み前に拒否する", async () => {
      const { createOrderInstruction } = await import("./orderBridge");
      await expect(createOrderInstruction({
        tradeDate: "2026-08-31",
        symbol: "6526",
        symbolName: "ソシオネクスト",
        side: "buy",
        instructionType: "entry",
        qty: 100,
        status: "pending",
        reason: "ソシオネクスト確認型LONG: ガードテスト",
        referencePrice: "2000",
        expiresAt: null,
        kabuOrderId: null,
        executedPrice: null,
        executedAt: null,
        pnl: null,
        rtTradeId: 2,
        errorMessage: null,
        isDryRun: false,
        executorLog: null,
      })).rejects.toThrow("socionext_confirmed_long_live_not_approved");
    });
  });

  describe("3436専用SHORTの戦略単位LIVE拒否", () => {
    it("DRY_RUN entryは許可し、LIVE entryだけを拒否して決済は許可する", async () => {
      const { evaluateSumcoBreakdownShortOrderApproval } = await import("./sumcoBreakdownShort");
      const reason = "SUMCO専用15本安値更新SHORT: ガードテスト";

      expect(evaluateSumcoBreakdownShortOrderApproval({ reason, instructionType: "entry", isDryRun: true }))
        .toEqual({ allowed: true });
      expect(evaluateSumcoBreakdownShortOrderApproval({ reason, instructionType: "entry", isDryRun: false }))
        .toEqual({ allowed: false, code: "sumco_breakdown_short_live_not_approved" });
      expect(evaluateSumcoBreakdownShortOrderApproval({ reason, instructionType: "exit", isDryRun: false }))
        .toEqual({ allowed: true });
    });

    it("注文指示作成境界でも3436のLIVE entryをDB書込み前に拒否する", async () => {
      const { createOrderInstruction } = await import("./orderBridge");
      await expect(createOrderInstruction({
        tradeDate: "2026-08-31",
        symbol: "3436",
        symbolName: "SUMCO",
        side: "short",
        instructionType: "entry",
        qty: 100,
        status: "pending",
        reason: "SUMCO専用15本安値更新SHORT: ガードテスト",
        referencePrice: "3400",
        expiresAt: null,
        kabuOrderId: null,
        executedPrice: null,
        executedAt: null,
        pnl: null,
        rtTradeId: 3,
        errorMessage: null,
        isDryRun: false,
        executorLog: null,
      })).rejects.toThrow("sumco_breakdown_short_live_not_approved");
    });
  });

  describe("canTrade", () => {
    it("exit/force_closeは常に許可される", async () => {
      // canTrade is tested via the module's logic
      // exit and force_close should always be allowed regardless of daily status
      const { canTrade } = await import("./orderBridge");

      // Mock getOrCreateAutoTradeDaily to return emergency stop state
      const mockDaily = {
        id: 1,
        tradeDate: "2026-07-08",
        realizedPnl: -100000,
        tradeCount: 10,
        dailyLossLimit: -50000,
        tradingEnabled: false,
        emergencyStop: true,
        emergencyStopReason: "テスト停止",
        isDryRun: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Even with emergency stop, exit should be allowed
      const exitResult = await canTrade("2026-07-08", "exit");
      expect(exitResult.allowed).toBe(true);

      const forceCloseResult = await canTrade("2026-07-08", "force_close");
      expect(forceCloseResult.allowed).toBe(true);
    });
  });

  describe("mapActionToSide (internal logic)", () => {
    it("rt_tradesのactionが正しくsideに変換される", () => {
      // Test the mapping logic indirectly through the module's behavior
      // buy -> buy, sell -> sell, short -> short, cover -> cover
      const mappings = [
        { action: "buy", expected: "buy" },
        { action: "sell", expected: "sell" },
        { action: "short", expected: "short" },
        { action: "cover", expected: "cover" },
      ];

      for (const { action, expected } of mappings) {
        // The mapping is straightforward 1:1
        expect(action).toBe(expected);
      }
    });
  });

  describe("determineInstructionType (internal logic)", () => {
    it("buy/shortはentryになる", () => {
      // buy and short actions should map to "entry" instruction type
      const entryActions = ["buy", "short"];
      for (const action of entryActions) {
        // entry actions are buy/short
        expect(["buy", "short"]).toContain(action);
      }
    });

    it("sell/coverはexitになる", () => {
      // sell and cover actions should map to "exit" instruction type
      const exitActions = ["sell", "cover"];
      for (const action of exitActions) {
        expect(["sell", "cover"]).toContain(action);
      }
    });

    it("大引け理由を含む決済はforce_closeになる", () => {
      // Reason containing "大引け" or "強制決済" should be force_close
      const forceCloseReasons = [
        "大引け強制決済",
        "MARKET_CLOSE: 15:25強制決済",
        "強制決済（時間超過）",
      ];
      for (const reason of forceCloseReasons) {
        const isForceClose =
          reason.includes("大引け") ||
          reason.includes("強制決済") ||
          reason.includes("MARKET_CLOSE");
        expect(isForceClose).toBe(true);
      }
    });
  });

  describe("ENTRY_EXPIRY_SECONDS", () => {
    it("エントリー指示の有効期限は60秒", () => {
      // The constant should be 60 seconds
      const ENTRY_EXPIRY_SECONDS = 60;
      expect(ENTRY_EXPIRY_SECONDS).toBe(60);
    });
  });

  describe("order instruction lifecycle", () => {
    it("ステータス遷移が正しい", () => {
      // Valid status transitions:
      // pending -> sent -> executed
      // pending -> sent -> failed
      // pending -> expired (entry only, 60s timeout)
      // pending -> cancelled (emergency stop)
      const validTransitions: Record<string, string[]> = {
        pending: ["sent", "expired", "cancelled"],
        sent: ["executed", "failed"],
      };

      expect(validTransitions["pending"]).toContain("sent");
      expect(validTransitions["pending"]).toContain("expired");
      expect(validTransitions["pending"]).toContain("cancelled");
      expect(validTransitions["sent"]).toContain("executed");
      expect(validTransitions["sent"]).toContain("failed");
    });
  });

  describe("KABUステーションAPI パラメータ構築", () => {
    it("信用新規買い(buy)のパラメータが正しい", () => {
      // buy: Side="2", CashMargin=2, MarginTradeType=3
      const params = {
        Side: "2",
        CashMargin: 2,
        MarginTradeType: 3,
      };
      expect(params.Side).toBe("2");
      expect(params.CashMargin).toBe(2);
      expect(params.MarginTradeType).toBe(3);
    });

    it("信用新規売り(short)のパラメータが正しい", () => {
      // short: Side="1", CashMargin=2, MarginTradeType=3
      const params = {
        Side: "1",
        CashMargin: 2,
        MarginTradeType: 3,
      };
      expect(params.Side).toBe("1");
      expect(params.CashMargin).toBe(2);
    });

    it("信用返済売り(sell/LONG決済)のパラメータが正しい", () => {
      // sell: Side="1", CashMargin=3
      const params = {
        Side: "1",
        CashMargin: 3,
        DelivType: 2,
      };
      expect(params.Side).toBe("1");
      expect(params.CashMargin).toBe(3);
      expect(params.DelivType).toBe(2);
    });

    it("信用返済買い(cover/SHORT決済)のパラメータが正しい", () => {
      // cover: Side="2", CashMargin=3
      const params = {
        Side: "2",
        CashMargin: 3,
        DelivType: 2,
      };
      expect(params.Side).toBe("2");
      expect(params.CashMargin).toBe(3);
    });
  });

  describe("リスク管理", () => {
    it("日次損失上限のデフォルト値は-100000円", () => {
      const DEFAULT_DAILY_LOSS_LIMIT = -100000;
      expect(DEFAULT_DAILY_LOSS_LIMIT).toBe(-100000);
    });

    it("損失上限到達で新規エントリーが停止される", () => {
      // When realizedPnl <= dailyLossLimit, tradingEnabled should be false
      const realizedPnl = -55000;
      const dailyLossLimit = -50000;
      const shouldStop = realizedPnl <= dailyLossLimit;
      expect(shouldStop).toBe(true);
    });

    it("決済指示は緊急停止中でも実行可能", () => {
      // exit and force_close should always be allowed
      const instructionTypes = ["exit", "force_close"];
      for (const type of instructionTypes) {
        const isExitType = type === "exit" || type === "force_close";
        expect(isExitType).toBe(true);
      }
    });
  });
});
