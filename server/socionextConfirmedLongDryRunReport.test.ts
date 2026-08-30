import { describe, expect, it } from "vitest";
import { formatSocionextConfirmedLongDryRunReport } from "./socionextConfirmedLongDryRunReport";

describe("6526確認型LONG 16時DRY_RUN報告", () => {
  it("エントリー・決済・理論損益・拒否を時系列で集計する", () => {
    const result = formatSocionextConfirmedLongDryRunReport(
      [
        { symbol: "6526", action: "buy", tradeTime: "10:01", price: 2000, shares: 100, pnl: null, reason: "ソシオネクスト確認型LONG: test" },
        { symbol: "6526", action: "sell", tradeTime: "10:08", price: 2010, shares: 100, pnl: 1000, reason: "利確" },
      ],
      [{ time: "09:51", symbol: "6526", action: "margin_block", price: 1990, reason: "証拠金使用率制限 (ソシオネクスト確認型LONG: test)" }],
      [],
    );
    expect(result.summary).toEqual({ entries: 1, exits: 1, realizedPnl: 1000, marginBlocks: 1, otherEngineBlocks: 0, confirmationRejects: 0 });
    expect(result.section).toContain("確定理論損益: +1,000円");
    expect(result.section).toContain("証拠金:1");
  });

  it("再起動後はDBイベントだけでも確認失敗とATR拒否を復元する", () => {
    const result = formatSocionextConfirmedLongDryRunReport([], [], [
      { candleTime: "09:41", eventType: "confirmation_rejected", side: "long", triggerTime: "09:40", rejectionCodes: ["confirm_price"], detail: null, referencePrice: 1980 },
      { candleTime: "10:11", eventType: "engine_rejected", side: "long", triggerTime: "10:10", rejectionCodes: null, detail: "atr_block:0.1000%<0.12%", referencePrice: 1995 },
    ]);
    expect(result.summary.confirmationRejects).toBe(1);
    expect(result.summary.otherEngineBlocks).toBe(1);
    expect(result.section).toContain("confirm_price");
    expect(result.section).toContain("atr_block");
  });

  it("同じ拒否がメモリーとDBにあっても重複集計しない", () => {
    const result = formatSocionextConfirmedLongDryRunReport(
      [],
      [{ time: "10:11", symbol: "6526", action: "socionext_confirmed_long_block", price: 1995, reason: "ソシオネクスト確認型LONG拒否・後続再探索: atr_block" }],
      [{ candleTime: "10:11", eventType: "engine_rejected", side: "long", triggerTime: "10:10", rejectionCodes: null, detail: "atr_block", referencePrice: 1995 }],
    );
    expect(result.summary.otherEngineBlocks).toBe(1);
  });
});
