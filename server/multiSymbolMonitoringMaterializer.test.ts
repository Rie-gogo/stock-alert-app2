import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KIOXIA_FORWARD_STRATEGY_VERSION } from "./runtimeIdentity";
import {
  buildMultiSymbolMonitoringDailySnapshot,
  resolveMonitoringCandidateVirtualGeneration,
  selectNextPendingMultiSymbolMonitoringDate,
} from "./multiSymbolMonitoringMaterializer";

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
  it("過去v1候補は同じv1 virtual engineを読み、9/11以降は既存世代解決を維持する", () => {
    expect(resolveMonitoringCandidateVirtualGeneration("2026-09-10")).toEqual({
      candidateVersion: "current-10-symbol-candidates-v1",
      virtualEngineVersion: "current-10-symbol-signal-quality-v1",
    });
    expect(resolveMonitoringCandidateVirtualGeneration("2026-09-11")).toEqual({
      candidateVersion: "current-10-symbol-candidates-v2-disco-short-paused",
      virtualEngineVersion: "current-10-symbol-signal-quality-v2-disco-short-paused",
    });
    expect(resolveMonitoringCandidateVirtualGeneration("2026-09-16")).toEqual({
      candidateVersion: "current-10-symbol-candidates-v3-low-win-routes-shadow-only",
      virtualEngineVersion: "current-10-symbol-signal-quality-v2-disco-short-paused",
    });
  });

  it("incomplete_sourceの最新日を無限再試行せず、再試行可能な過去日を1日選ぶ", () => {
    expect(selectNextPendingMultiSymbolMonitoringDate(
      ["2026-09-07", "2026-09-08", "2026-09-10", "2026-09-25"],
      [
        { tradeDate: "2026-09-25", status: "incomplete_source" },
        { tradeDate: "2026-09-10", status: "complete" },
        { tradeDate: "2026-09-08", status: "processing" },
      ],
    )).toBe("2026-09-08");
    expect(selectNextPendingMultiSymbolMonitoringDate(
      ["2026-09-07", "2026-09-08"],
      [
        { tradeDate: "2026-09-08", status: "incomplete_source" },
        { tradeDate: "2026-09-07", status: "complete" },
      ],
    )).toBeNull();
  });

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
