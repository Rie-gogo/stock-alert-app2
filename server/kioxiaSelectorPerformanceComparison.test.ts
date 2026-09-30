import { describe, expect, it } from "vitest";
import { buildKioxiaSelectorPerformanceComparison } from "./kioxiaSelectorPerformanceComparison";

function metrics(totalR: number, completedTrades = totalR === 0 ? 0 : 1) {
  return {
    signalCount: completedTrades,
    openTrades: 0,
    completedTrades,
    wins: totalR > 0 ? completedTrades : 0,
    losses: totalR < 0 ? completedTrades : 0,
    draws: totalR === 0 && completedTrades ? completedTrades : 0,
    totalR,
    grossProfitR: Math.max(0, totalR),
    grossLossR: Math.max(0, -totalR),
    outcome: completedTrades ? "observed" : "no_signal",
  };
}

function day(index: number, selectorR: number, fixedR: number, options: { ready?: boolean; snapshot?: boolean } = {}) {
  return {
    tradeDate: `2026-11-${String(index + 1).padStart(2, "0")}`,
    snapshotFound: options.snapshot ?? true,
    evaluationReady: options.ready ?? true,
    selectorOutcome: { key: "selector", label: "selector", signalQuality: metrics(selectorR), capitalConstrained: metrics(selectorR) },
    fixedRouteOutcomes: [{ key: "route:a", label: "route A", signalQuality: metrics(fixedR), capitalConstrained: metrics(fixedR) }],
    fixedPlanOutcomes: [{ key: "plan:current", label: "Current固定", signalQuality: metrics(fixedR), capitalConstrained: metrics(fixedR) }],
  };
}

describe("285A selector vs fixed prospective comparison", () => {
  it("does not issue a verdict before both the 20-day and 10-trade gates", () => {
    const result = buildKioxiaSelectorPerformanceComparison(Array.from({ length: 19 }, (_, index) => day(index, 1, 0)));
    expect(result.verdict).toBe("insufficient_data");
    expect(result.signalQuality.remainingEvaluationDays).toBe(1);
    expect(result.signalQuality.remainingSelectorCompletedTrades).toBe(0);
  });

  it("keeps warm-up days out but retains a mature no-trade day as paired 0R", () => {
    const result = buildKioxiaSelectorPerformanceComparison([
      day(0, 5, -5, { ready: false }),
      day(1, 0, 1),
    ]);
    expect(result.evaluationDates).toEqual(["2026-11-02"]);
    expect(result.signalQuality.selector.totalR).toBe(0);
    expect(result.signalQuality.bestFixedPlan?.metrics.totalR).toBe(1);
  });

  it("confirms superiority only when the paired 95% lower bound is above zero in both modes", () => {
    const result = buildKioxiaSelectorPerformanceComparison(Array.from({ length: 20 }, (_, index) => day(index, 1, index % 2 ? 0.1 : 0.2)));
    expect(result.signalQuality.ready).toBe(true);
    expect(result.signalQuality.bestFixedPlan?.pairedVsSelector.ci95LowerR).toBeGreaterThan(0);
    expect(result.verdict).toBe("selector_outperformed_fixed_in_both_modes");
  });

  it("reports underperformance when the paired interval is entirely below zero", () => {
    const result = buildKioxiaSelectorPerformanceComparison(Array.from({ length: 20 }, (_, index) => day(index, index % 2 ? 0.1 : 0.2, 1)));
    expect(result.verdict).toBe("selector_underperformed_fixed_in_at_least_one_mode");
  });
});
