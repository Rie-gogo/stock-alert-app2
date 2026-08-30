import { describe, expect, it } from "vitest";
import { SUMCO_BREAKDOWN_SHORT_REASON_PREFIX } from "./sumcoBreakdownShort";
import { formatSumcoBreakdownShortDryRunReport } from "./sumcoBreakdownShortDryRunReport";

describe("3436専用SHORT 16時DRY_RUN報告", () => {
  it("エントリー・決済・証拠金拒否・理論損益を集計する", () => {
    const result = formatSumcoBreakdownShortDryRunReport(
      [
        { symbol: "3436", action: "short", tradeTime: "09:40", price: 3400, shares: 100, pnl: null, reason: `${SUMCO_BREAKDOWN_SHORT_REASON_PREFIX}: test` },
        { symbol: "3436", action: "cover", tradeTime: "10:00", price: 3370, shares: 100, pnl: 3000, reason: "TP" },
      ],
      [{ time: "09:35", symbol: "3436", action: "margin_block", price: 3410, reason: `${SUMCO_BREAKDOWN_SHORT_REASON_PREFIX} margin_block` }],
    );
    expect(result.summary).toEqual({ entries: 1, exits: 1, realizedPnl: 3000, marginBlocks: 1, otherEngineBlocks: 0 });
    expect(result.section).toContain("理論エントリー: 1件");
    expect(result.section).toContain("確定理論損益: +3,000円");
  });

  it("再起動後のDB拒否履歴を復元し、メモリー履歴と重複排除する", () => {
    const signal = { time: "09:35", symbol: "3436", action: "sumco_breakdown_short_block", price: 3410, reason: `${SUMCO_BREAKDOWN_SHORT_REASON_PREFIX}拒否・後続再探索: atr_block` };
    const persisted = { candleTime: "09:35", eventType: "engine_rejected" as const, side: "short" as const, detail: "atr_block", referencePrice: "3410" };
    const result = formatSumcoBreakdownShortDryRunReport([], [signal], [persisted]);
    expect(result.summary.otherEngineBlocks).toBe(1);
    expect(result.summary.marginBlocks).toBe(0);
  });
});
