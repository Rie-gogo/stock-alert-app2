import { describe, expect, it } from "vitest";
import { formatTaiyoCandidateBDryRunReport } from "./taiyoCandidateBDryRunReport";

describe("6976候補B30分 DRY_RUN乖離報告", () => {
  it("理論取引と拒否後再探索を時刻順に集計する", () => {
    const result = formatTaiyoCandidateBDryRunReport([
      { symbol: "6976", action: "cover", tradeTime: "10:40", price: 9900, shares: 100, pnl: 10000, reason: "利確" },
      { symbol: "6976", action: "short", tradeTime: "10:10", price: 10000, shares: 100, pnl: null, reason: "太陽誘電候補BSHORT: テスト" },
      { symbol: "5803", action: "sell", tradeTime: "10:20", price: 5000, shares: 100, pnl: 1000, reason: "他銘柄" },
    ], [
      { time: "09:50", symbol: "6976", action: "margin_block", price: 10100, reason: "証拠金使用率制限 (太陽誘電候補BLONG: テスト)" },
      { time: "10:00", symbol: "6976", action: "candidate_b_block", price: 10050, reason: "太陽誘電候補B拒否・後続再探索: atr_block" },
    ]);
    expect(result.summary).toEqual({
      entries: 1,
      exits: 1,
      marginBlocks: 1,
      otherEngineBlocks: 1,
      confirmationRejects: 0,
    });
    expect(result.section).toContain("DRY_RUN乖離監視");
    expect(result.section).toContain("拒否・再探索継続");
    expect(result.section.indexOf("09:50")).toBeLessThan(result.section.indexOf("10:10"));
  });

  it("再起動でメモリー履歴が空でもDBイベントから拒否・確認失敗を復元する", () => {
    const result = formatTaiyoCandidateBDryRunReport([], [], [
      {
        candleTime: "09:51",
        eventType: "engine_rejected",
        side: "long",
        triggerTime: "09:50",
        rejectionCodes: null,
        detail: "margin_block",
        referencePrice: "10100.00",
      },
      {
        candleTime: "10:01",
        eventType: "confirmation_rejected",
        side: "short",
        triggerTime: "10:00",
        rejectionCodes: ["confirmation_direction_failed"],
        detail: null,
        referencePrice: "10050.00",
      },
    ]);

    expect(result.summary).toEqual({
      entries: 0,
      exits: 0,
      marginBlocks: 1,
      otherEngineBlocks: 0,
      confirmationRejects: 1,
    });
    expect(result.section).toContain("確認失敗・再探索: 1件");
    expect(result.section).toContain("margin_block");
    expect(result.section).toContain("confirmation_direction_failed");
  });

  it("同一拒否がメモリーとDBの両方にあっても二重計上しない", () => {
    const volatile = {
      time: "09:51",
      symbol: "6976",
      action: "margin_block",
      price: 10100,
      reason: "太陽誘電候補B拒否・後続再探索: margin_block",
    };
    const result = formatTaiyoCandidateBDryRunReport([], [volatile], [{
      candleTime: "09:51",
      eventType: "engine_rejected",
      side: "long",
      triggerTime: "09:50",
      rejectionCodes: null,
      detail: "margin_block",
      referencePrice: "10100.00",
    }]);

    expect(result.summary.marginBlocks).toBe(1);
  });
});
