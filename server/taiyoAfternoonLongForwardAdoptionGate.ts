import {
  TAIYO_AFTERNOON_LONG_RR2_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
} from "./runtimeIdentity";

const TARGETS = new Set([TAIYO_AFTERNOON_LONG_RR2_VERSION, TAIYO_AFTERNOON_LONG_WINRATE_VERSION]);

export type TaiyoAfternoonLongAdoptionGate = {
  applicable: boolean;
  strategyVariant: "rr2_10" | "recovery_winrate" | null;
  eligibleForAdoption: boolean | null;
  historicalSelection: {
    fixedThroughDate: "2026-09-11" | null;
    savedTradeCount: number | null;
    savedWinRatePct: number | null;
    recentTenWins: number | null;
    recentTenTrades: number | null;
    recentFiveWins: number | null;
    recentFiveTrades: number | null;
    adverseExecutionStatus: "failed" | "fragile" | "not_applicable";
    formalPerformanceUsable: false | null;
  };
  portfolioGate: {
    status: "manual_comparison_required" | "diagnostic_only" | "not_applicable";
    baseline: "current_10_symbol_891m" | null;
    rule: "candidate_must_not_reduce_portfolio_pnl" | null;
    automaticAdoption: false;
  };
};

export function resolveTaiyoAfternoonLongAdoptionGate(strategyVersion: string): TaiyoAfternoonLongAdoptionGate {
  if (!TARGETS.has(strategyVersion)) {
    return {
      applicable: false,
      strategyVariant: null,
      eligibleForAdoption: null,
      historicalSelection: {
        fixedThroughDate: null,
        savedTradeCount: null,
        savedWinRatePct: null,
        recentTenWins: null,
        recentTenTrades: null,
        recentFiveWins: null,
        recentFiveTrades: null,
        adverseExecutionStatus: "not_applicable",
        formalPerformanceUsable: null,
      },
      portfolioGate: { status: "not_applicable", baseline: null, rule: null, automaticAdoption: false },
    };
  }
  const rr2 = strategyVersion === TAIYO_AFTERNOON_LONG_RR2_VERSION;
  return {
    applicable: true,
    strategyVariant: rr2 ? "rr2_10" : "recovery_winrate",
    eligibleForAdoption: !rr2,
    historicalSelection: {
      fixedThroughDate: "2026-09-11",
      savedTradeCount: rr2 ? 17 : 33,
      savedWinRatePct: rr2 ? 70.59 : 81.82,
      recentTenWins: rr2 ? 4 : 5,
      recentTenTrades: rr2 ? 4 : 5,
      recentFiveWins: 2,
      recentFiveTrades: 2,
      adverseExecutionStatus: rr2 ? "failed" : "fragile",
      formalPerformanceUsable: false,
    },
    portfolioGate: {
      status: rr2 ? "diagnostic_only" : "manual_comparison_required",
      baseline: "current_10_symbol_891m",
      rule: rr2 ? null : "candidate_must_not_reduce_portfolio_pnl",
      automaticAdoption: false,
    },
  };
}

export function applyTaiyoAfternoonLongAdoptionGate<Decision extends { status: string; reason: string; days: number }>(
  decision: Decision,
  gate: TaiyoAfternoonLongAdoptionGate,
) {
  if (!gate.applicable || decision.status !== "eligible") return decision;
  return gate.eligibleForAdoption
    ? { ...decision, status: "interim_continue" as const, reason: "taiyo_afternoon_long_891m_manual_comparison_required" as const }
    : { ...decision, status: "interim_continue" as const, reason: "taiyo_afternoon_long_rr2_diagnostic_only" as const };
}
