import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KIOXIA_FORWARD_STRATEGY_VERSION } from "./runtimeIdentity";
import { buildMultiSymbolMonitoringDailySnapshot } from "./multiSymbolMonitoringMaterializer";

function candidate(id: number, symbol: string, decision: "accepted" | "margin_block" | "shadow_only") {
  return { id, symbol, realtimeDecision: decision } as any;
}

function currentTrade(candidateId: number, symbol: string, pnl: number | null, completed = true, shares = 100) {
  return { candidateId, symbol, pnl, completed, shares } as any;
}

function shadowTrade(pnl: number | null, exitTradeDate: string | null = "2026-09-25") {
  return {
    strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
    evaluationMode: "signal_quality",
    symbol: "285A",
    pnl,
    shares: 200,
    exitTradeDate,
  } as any;
}

describe("10-symbol daily monitoring snapshot", () => {
  it("現行はmargin blockを含みshadow_onlyを除外し、現行・shadowを100株換算する", () => {
    const result = buildMultiSymbolMonitoringDailySnapshot({
      tradeDate: "2026-09-25",
      candidates: [
        candidate(1, "285A", "accepted"),
        candidate(2, "285A", "margin_block"),
        candidate(3, "285A", "shadow_only"),
      ],
      candidateTrades: [
        currentTrade(1, "285A", 2_000, true, 200),
        currentTrade(2, "285A", -500, true, 100),
        currentTrade(3, "285A", 99_000, true, 100),
      ],
      shadowTrades: [shadowTrade(4_000)],
    });

    const current = result.plans.find(plan => plan.planId === "current:285A")!;
    const shadow = result.plans.find(plan => plan.strategyVersion === KIOXIA_FORWARD_STRATEGY_VERSION)!;
    expect(current).toMatchObject({
      signals: 2,
      completedTrades: 2,
      wins: 1,
      losses: 1,
      pnlPer100: 500,
      missingTrades: 0,
    });
    expect(shadow).toMatchObject({ completedTrades: 1, pnlPer100: 2_000 });
    expect(result.scope.symbols).toHaveLength(10);
    expect(result.ready).toBe(true);
  });

  it("未追跡の現行候補や未決済shadowがある日はcompleteにしない", () => {
    const result = buildMultiSymbolMonitoringDailySnapshot({
      tradeDate: "2026-09-25",
      candidates: [candidate(1, "285A", "accepted")],
      candidateTrades: [],
      shadowTrades: [shadowTrade(null, null)],
    });
    expect(result.ready).toBe(false);
    expect(result.summary).toMatchObject({ openTrades: 1, missingTrades: 1 });
  });

  it("通常取引・注文・現行エンジンに接続しない", () => {
    const source = readFileSync(new URL("./multiSymbolMonitoringMaterializer.ts", import.meta.url), "utf8");
    expect(source).not.toContain("./realtimeSimEngine");
    expect(source).not.toContain("./orderBridge");
    expect(source).not.toContain("insertRtTrade(");
    expect(source).not.toContain("orderInstructions");
  });
});
