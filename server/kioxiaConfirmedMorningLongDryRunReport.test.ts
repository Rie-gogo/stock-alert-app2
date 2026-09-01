import { describe, expect, it } from "vitest";
import { formatKioxiaConfirmedMorningLongDryRunReport } from "./kioxiaConfirmedMorningLongDryRunReport";

describe("285A確認型前場LONG 16時DRY_RUN報告", () => {
  it("取引・揮発拒否・DB復元拒否を重複排除して集計する", () => {
    const result = formatKioxiaConfirmedMorningLongDryRunReport(
      [
        { symbol: "285A", action: "buy", tradeTime: "10:00", price: 100, shares: 100, pnl: null, reason: "キオクシア確認型前場LONG: テスト" },
        { symbol: "285A", action: "sell", tradeTime: "10:10", price: 101.6, shares: 100, pnl: 160, reason: "利確" },
        { symbol: "285A", action: "short", tradeTime: "10:20", price: 101, shares: 100, pnl: null, reason: "反転SHORT: 別経路" },
        { symbol: "285A", action: "cover", tradeTime: "10:30", price: 100, shares: 100, pnl: 100, reason: "利確" },
      ],
      [
        { time: "09:55", symbol: "285A", action: "margin_block", price: 99, reason: "キオクシア確認型前場LONG: margin_block" },
      ],
      [
        { candleTime: "09:55", eventType: "engine_rejected", side: "long", detail: "margin_block", referencePrice: "99" },
        { candleTime: "09:58", eventType: "engine_rejected", side: "long", detail: "atr_block:0.10", referencePrice: "99.5" },
      ],
    );
    expect(result.summary).toEqual({ entries: 1, exits: 1, realizedPnl: 160, marginBlocks: 1, otherEngineBlocks: 1 });
    expect(result.section).toContain("285A確認型前場LONG DRY_RUN乖離監視");
    expect(result.section).toContain("共通ゲート拒否・再探索: 2件");
    expect(result.section).toContain("LONG @100円 ×100株");
  });
});
