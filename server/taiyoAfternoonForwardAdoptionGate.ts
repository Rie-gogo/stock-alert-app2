import {
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
} from "./runtimeIdentity";

const TARGET_VERSIONS = new Set([TAIYO_AFTERNOON_RR2_VERSION, TAIYO_AFTERNOON_DEPTH_VERSION]);

export type TaiyoAfternoonAdoptionGate = {
  applicable: boolean;
  strategyVariant: "rr2_exit" | "depth_execution" | null;
  historicalSelection: {
    fixedThroughDate: "2026-09-04" | null;
    savedDays: 51 | null;
    depthReplayDays: 0 | 2 | null;
    selectionTradeCount: number | null;
    selectionWinRatePct: number | null;
    formalPerformanceUsable: false | null;
    role: "exit_structure_candidate" | "execution_quality_candidate" | "not_applicable";
    depthCoverage: "insufficient_for_historical_performance" | "not_applicable";
  };
  eligibleForAdoption: boolean | null;
  portfolioGate: {
    status: "manual_comparison_required" | "not_applicable";
    baseline: "current_10_symbol_891m" | null;
    rule: "candidate_must_not_reduce_portfolio_pnl" | null;
    automaticAdoption: false;
  };
};

export function resolveTaiyoAfternoonAdoptionGate(strategyVersion: string): TaiyoAfternoonAdoptionGate {
  if (!TARGET_VERSIONS.has(strategyVersion)) {
    return {
      applicable: false,
      strategyVariant: null,
      historicalSelection: {
        fixedThroughDate: null,
        savedDays: null,
        depthReplayDays: null,
        selectionTradeCount: null,
        selectionWinRatePct: null,
        formalPerformanceUsable: null,
        role: "not_applicable",
        depthCoverage: "not_applicable",
      },
      eligibleForAdoption: null,
      portfolioGate: { status: "not_applicable", baseline: null, rule: null, automaticAdoption: false },
    };
  }
  const rr2 = strategyVersion === TAIYO_AFTERNOON_RR2_VERSION;
  return {
    applicable: true,
    strategyVariant: rr2 ? "rr2_exit" : "depth_execution",
    historicalSelection: {
      fixedThroughDate: "2026-09-04",
      savedDays: 51,
      depthReplayDays: rr2 ? 0 : 2,
      selectionTradeCount: rr2 ? 8 : 0,
      selectionWinRatePct: rr2 ? 87.5 : null,
      formalPerformanceUsable: false,
      role: rr2 ? "exit_structure_candidate" : "execution_quality_candidate",
      depthCoverage: rr2 ? "not_applicable" : "insufficient_for_historical_performance",
    },
    eligibleForAdoption: true,
    portfolioGate: {
      status: "manual_comparison_required",
      baseline: "current_10_symbol_891m",
      rule: "candidate_must_not_reduce_portfolio_pnl",
      automaticAdoption: false,
    },
  };
}

export function applyTaiyoAfternoonAdoptionGate<Decision extends { status: string; reason: string; days: number }>(
  decision: Decision,
  gate: TaiyoAfternoonAdoptionGate,
): Decision | (Omit<Decision, "status" | "reason"> & {
  status: "interim_continue";
  reason: "taiyo_afternoon_891m_manual_comparison_required";
}) {
  if (!gate.applicable || decision.status !== "eligible") return decision;
  return { ...decision, status: "interim_continue", reason: "taiyo_afternoon_891m_manual_comparison_required" };
}
