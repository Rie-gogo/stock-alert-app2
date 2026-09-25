import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CURRENT_SIGNAL_CANDIDATE_VERSION } from "./currentSignalCandidateRegistry";
import {
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
} from "./runtimeIdentity";
import { buildKioxiaMonitoringTrend } from "./monitoringComparisonTrend";

const dates = [
  "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22",
  "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29",
];

function candidate(id: number, tradeDate: string, decision = "accepted") {
  return {
    id,
    candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
    tradeDate,
    symbol: "285A",
    routeId: "confirmedMorningLong",
    realtimeDecision: decision,
  } as any;
}

function candidateTrade(candidateId: number, tradeDate: string, pnl: number) {
  return { candidateId, tradeDate, shares: 100, pnl, completed: true } as any;
}

function shadowTrade(strategyVersion: string, tradeDate: string, pnl: number) {
  return {
    strategyVersion,
    evaluationMode: "signal_quality",
    symbol: "285A",
    entryTradeDate: tradeDate,
    exitTradeDate: tradeDate,
    shares: 100,
    pnl,
  } as any;
}

function materialization(tradeDate: string) {
  return {
    status: "complete",
    tradeDate,
    resultJson: {
      entries: [
        {
          origin: "current_baseline",
          strategyVersion: `baseline:${CURRENT_SIGNAL_CANDIDATE_VERSION}`,
          sourceDisposition: "accepted",
          adverseEntryGapPct: 0.03,
          resolution: { status: "filled" },
        },
        {
          origin: "forward_shadow",
          strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
          sourceDisposition: "forward_shadow",
          adverseEntryGapPct: null,
          resolution: { status: "unfillable" },
        },
      ],
    },
  } as any;
}

describe("285A monitoring trend", () => {
  it("監査確定日だけで5/10/20/全期間を集計し、最近の改善・悪化を分ける", () => {
    const candidates = dates.map((date, index) => candidate(index + 1, date));
    candidates.push(candidate(99, "2026-09-29", "shadow_only"));
    const result = buildKioxiaMonitoringTrend({
      asOfDate: "2026-09-29",
      eligibleTradeDates: dates,
      candidates,
      candidateTrades: [
        ...dates.slice(0, 5).map((date, index) => candidateTrade(index + 1, date, index < 2 ? 1_000 : -1_000)),
        ...dates.slice(5).map((date, index) => candidateTrade(index + 6, date, 2_000)),
        candidateTrade(99, "2026-09-29", 99_000),
      ],
      shadowATrades: [
        ...dates.slice(0, 5).map(date => shadowTrade(KIOXIA_FORWARD_STRATEGY_VERSION, date, 1_000)),
        ...dates.slice(5).map((date, index) => shadowTrade(KIOXIA_FORWARD_STRATEGY_VERSION, date, index === 0 ? 1_000 : -1_000)),
      ],
      shadowBTrades: [shadowTrade(KIOXIA_ATR_FORWARD_STRATEGY_VERSION, dates.at(-1)!, 500)],
      comparisonMaterializations: dates.map(materialization),
    });

    const current = result.plans.find(plan => plan.planId === "current_285a")!;
    const shadowA = result.plans.find(plan => plan.planId === "shadow_a_confirmed_long")!;
    const shadowB = result.plans.find(plan => plan.planId === "shadow_b_atr_routes")!;
    expect(current.windows.recent5).toMatchObject({ completedTrades: 5, wins: 5, winRatePct: 100, pnlPer100: 10_000 });
    expect(current.windows.previous5).toMatchObject({ completedTrades: 5, wins: 2, losses: 3, pnlPer100: -1_000 });
    expect(current.windows.all.completedTrades).toBe(10);
    expect(current.trend.status).toBe("improving");
    expect(shadowA.trend.status).toBe("deteriorating");
    expect(shadowB.trend.status).toBe("insufficient");
    expect(current.strictExecution.recent5).toMatchObject({ signals: 5, filled: 5, fillRatePct: 100 });
    expect(shadowA.strictExecution.recent5).toMatchObject({ signals: 5, unfillable: 5, fillRatePct: 0 });
    expect(result.automaticAdoption).toBe(false);
    expect(result.existingTradingAndShadowExecutionChanged).toBe(false);
  });

  it("通常取引・注文・正式Gateの更新経路へ接続しない", () => {
    const source = readFileSync(new URL("./monitoringComparisonTrend.ts", import.meta.url), "utf8");
    expect(source).not.toContain("./orderBridge");
    expect(source).not.toContain("insertRtTrade(");
    expect(source).not.toContain("updateRtStrategyVersionStatus");
    expect(source).not.toContain("upsertRtForwardEvaluationControl");
  });
});
