import { describe, expect, it } from "vitest";
import { formatTelOpenDirectionBreakoutDryRunReport } from "./telOpenDirectionBreakoutDryRunReport";

describe("8035始値方向付き短期ブレイク 16時DRY_RUN報告", () => {
  it("対象経路だけを入口・出口順にペアリングし、永続／メモリ拒否を重複排除する", () => {
    const report = formatTelOpenDirectionBreakoutDryRunReport(
      [
        { symbol: "8035", action: "buy", tradeTime: "10:00", price: 70_000, shares: 100, pnl: null, reason: "東京エレクトロン短期ブレイクLONG: テスト" },
        { symbol: "8035", action: "sell", tradeTime: "10:21", price: 70_500, shares: 100, pnl: 50_000, reason: "最大保有20分経過後の次足始値決済" },
        { symbol: "8035", action: "short", tradeTime: "10:40", price: 69_000, shares: 100, pnl: null, reason: "順張りSHORT: 対象外" },
        { symbol: "8035", action: "cover", tradeTime: "10:50", price: 68_500, shares: 100, pnl: 50_000, reason: "対象外決済" },
      ],
      [{ time: "10:05", symbol: "8035", action: "margin_block", price: 70_100, reason: "東京エレクトロン短期ブレイクLONG: 証拠金使用率制限" }],
      [{ candleTime: "10:05", eventType: "engine_rejected", side: "long", detail: "margin_block", referencePrice: "70100" }],
    );

    expect(report.summary).toEqual({ entries: 1, exits: 1, realizedPnl: 50_000, marginBlocks: 1, otherEngineBlocks: 0 });
    expect(report.section).toContain("8035始値方向付き短期ブレイク DRY_RUN乖離監視");
    expect(report.section).toContain("確定理論損益: +50,000円");
  });
});
