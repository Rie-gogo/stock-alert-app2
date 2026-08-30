import { describe, expect, it } from "vitest";
import { SOFTBANK_BREAKOUT_LONG_REASON_PREFIX } from "./softbankBreakoutLong";
import { formatSoftbankBreakoutLongDryRunReport } from "./softbankBreakoutLongDryRunReport";

describe("9984専用LONG 16時DRY_RUN報告", () => {
  it("エントリー・決済・証拠金拒否・理論損益を集計する", () => {
    const result = formatSoftbankBreakoutLongDryRunReport(
      [
        { symbol: "9984", action: "buy", tradeTime: "09:50", price: 5_000, shares: 100, pnl: null, reason: `${SOFTBANK_BREAKOUT_LONG_REASON_PREFIX}: test` },
        { symbol: "9984", action: "sell", tradeTime: "10:05", price: 5_015, shares: 100, pnl: 1_500, reason: "TP" },
      ],
      [{ time: "09:45", symbol: "9984", action: "margin_block", price: 4_990, reason: `${SOFTBANK_BREAKOUT_LONG_REASON_PREFIX} margin_block` }],
    );
    expect(result.summary).toEqual({ entries: 1, exits: 1, realizedPnl: 1_500, marginBlocks: 1, otherEngineBlocks: 0 });
    expect(result.section).toContain("理論エントリー: 1件");
    expect(result.section).toContain("確定理論損益: +1,500円");
  });

  it("再起動後のDB拒否履歴を復元し、メモリー履歴と重複排除する", () => {
    const signal = { time: "09:45", symbol: "9984", action: "softbank_breakout_long_block", price: 4_990, reason: `${SOFTBANK_BREAKOUT_LONG_REASON_PREFIX}拒否・後続再探索: atr_block` };
    const persisted = { candleTime: "09:45", eventType: "engine_rejected" as const, side: "long" as const, detail: "atr_block", referencePrice: "4990" };
    const result = formatSoftbankBreakoutLongDryRunReport([], [signal], [persisted]);
    expect(result.summary.otherEngineBlocks).toBe(1);
    expect(result.summary.marginBlocks).toBe(0);
  });
});
