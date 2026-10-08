import { describe, expect, it } from "vitest";
import {
  RollingMarketContextBars,
  buildIntradayContextPerformanceSelectorDecision,
  buildMarketContextPerformanceSnapshot,
  excludeExplicitlyRetiredRoutesFromFrozenScores,
} from "./marketContextPerformanceSelector";

const premarket: any = {
  version: "premarket-test", state: "up", confidence: "low", allowedDirections: ["long"], qualityStatus: "verified", verifiedLegs: 3,
  reasonCodes: ["test"], metrics: {},
};
const intraday: any = {
  version: "intraday-test", state: "up", confidence: "medium", allowedDirections: ["long"], observedThrough: "09:05", checkpoint: true,
  decisionAt: "09:05", reasonCodes: ["test"], metrics: {},
};
const score = (rowId: string, pnl: number) => ({
  symbol: "285A", rowId, canonicalLogic: `logic-${rowId}`, strategyVersion: `version-${rowId}`, routeGroupId: `trend-${rowId}`,
  direction: "long", marketContextEligible: true, selectable: true,
  marketContextRecent10PnlPer100: pnl, marketContextAllPnlPer100: pnl,
});

describe("market context performance selector v4", () => {
  it("preserves equal market-affinity routes in parallel without using recent P&L", () => {
    const decision = buildIntradayContextPerformanceSelectorDecision({
      tradeDate: "2026-10-09", sourceEventId: "mc-1", checkpoint: "09:05", intradayRegime: intraday, premarketRegime: premarket,
      routeSelectorSnapshot: { selectorVersion: "fixture", inputHash: "input", scores: [score("loss", -999), score("gain", 999)] },
    });
    expect(decision.selectionPolicy).toBe("frozen_market_context_route_style_affinity_then_parallel_ties");
    expect(decision.unconditionalRecentPnlUsedForSelection).toBe(false);
    expect(decision.conditionalRankingApplied).toBe(false);
    expect(decision.selections[0]?.selectedAlternatives).toHaveLength(2);
    expect(decision.selections[0]?.selectedAlternatives.map((item: any) => item.rowId)).toEqual(["gain", "loss"]);
  });

  it("keeps only one validated mini bar per minute and resets on a trade-date change", () => {
    const bars = new RollingMarketContextBars();
    bars.append({ tradeDate: "2026-10-09", candleTime: "09:00", open: 1, high: 2, low: 1, close: 2, previousClose: 1 });
    bars.append({ tradeDate: "2026-10-09", candleTime: "09:00", open: 9, high: 9, low: 9, close: 9, previousClose: 1 });
    bars.append({ tradeDate: "2026-10-09", candleTime: "09:01", open: 2, high: 3, low: 2, close: 3, previousClose: 1 });
    expect(bars.count()).toBe(2);
    expect(bars.bars()[0]?.close).toBe(2);
    bars.append({ tradeDate: "2026-10-12", candleTime: "09:00", open: 4, high: 5, low: 4, close: 5, previousClose: 3 });
    expect(bars.count()).toBe(1);
    expect(bars.tradeDate()).toBe("2026-10-12");
  });

  it("stores context-conditioned performance separately and marks it monitoring-only", () => {
    const decision = buildIntradayContextPerformanceSelectorDecision({
      tradeDate: "2026-10-09", sourceEventId: "mc-2", checkpoint: "09:05", intradayRegime: intraday, premarketRegime: premarket,
      routeSelectorSnapshot: { selectorVersion: "fixture", inputHash: "input", scores: [score("a", -50)] },
    });
    const snapshot = buildMarketContextPerformanceSnapshot({
      tradeDate: "2026-10-09",
      frozenDecisions: [decision],
      dailySnapshot: {
        ready: true,
        plans: [{ strategyVersion: "version-a", direction: "long", signals: 1, completedTrades: 1, wins: 0, losses: 1, draws: 0, pnlPer100: -50, grossProfitPer100: 0, grossLossPer100: 50 }],
      } as any,
    });
    expect(snapshot.monitoringOnly).toBe(true);
    expect(snapshot.formalPerformanceUse).toBe(false);
    expect(snapshot.automaticSelection).toBe(false);
    expect(snapshot.rows).toMatchObject([{ strategyVersion: "version-a", completedTrades: 1, pnlPer100: -50, status: "observed" }]);
  });

  it("keeps immutable frozen history but excludes only the six explicitly retired routes from future v4 candidates", () => {
    const frozen: any[] = [
      { ...score("kept-historical", 1), strategyVersion: "candidate-3436-bollinger-directional-fixed-stop140-cooldown30-v1" },
      { ...score("tel-long", 1), strategyVersion: "candidate-8035-executable-depth-v3-parity-reset" },
      { ...score("taiyo-short-a", 1), strategyVersion: "candidate-6976-afternoon-short-rr2-45-v1" },
      { ...score("taiyo-short-b", 1), strategyVersion: "candidate-6976-afternoon-short-depth-v1" },
      { ...score("taiyo-long-a", 1), strategyVersion: "candidate-6976-afternoon-long-rr2-10-v1" },
      { ...score("stopped-current", 1), canonicalLogic: "current-5803-afternoon-low-break-short" },
    ];
    const result = excludeExplicitlyRetiredRoutesFromFrozenScores(frozen);
    expect(frozen).toHaveLength(6);
    expect(result.map(row => row.rowId)).toEqual(["kept-historical"]);
  });
});
