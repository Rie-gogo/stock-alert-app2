import {
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
} from "./runtimeIdentity";

const TARGET_VERSIONS = new Set([SUMCO_VOLUME_110_VERSION, SUMCO_TIME_15_VERSION]);

export type SumcoAdoptionGate = {
  applicable: boolean;
  strategyVariant: "volume_110" | "time_15" | null;
  historicalSelection: {
    fixedThroughDate: "2026-09-04" | null;
    baselineSavedDays: 29 | null;
    supplementSavedDays: 5 | null;
    selectionSavedDays: 34 | null;
    winRatePct: number | null;
    passedMinimumWinRate: boolean | null;
    supplementHasKnownGap: boolean | null;
    role: "entry_quality_candidate" | "exit_timing_candidate" | "not_applicable";
  };
  eligibleForAdoption: boolean | null;
  portfolioGate: {
    status: "manual_comparison_required" | "not_applicable";
    baseline: "current_10_symbol_891m" | null;
    rule: "candidate_must_not_reduce_portfolio_pnl" | null;
    automaticAdoption: false;
  };
};

export function resolveSumcoAdoptionGate(strategyVersion: string): SumcoAdoptionGate {
  if (!TARGET_VERSIONS.has(strategyVersion)) {
    return {
      applicable: false,
      strategyVariant: null,
      historicalSelection: {
        fixedThroughDate: null,
        baselineSavedDays: null,
        supplementSavedDays: null,
        selectionSavedDays: null,
        winRatePct: null,
        passedMinimumWinRate: null,
        supplementHasKnownGap: null,
        role: "not_applicable",
      },
      eligibleForAdoption: null,
      portfolioGate: { status: "not_applicable", baseline: null, rule: null, automaticAdoption: false },
    };
  }
  const volume = strategyVersion === SUMCO_VOLUME_110_VERSION;
  return {
    applicable: true,
    strategyVariant: volume ? "volume_110" : "time_15",
    historicalSelection: {
      fixedThroughDate: "2026-09-04",
      baselineSavedDays: 29,
      supplementSavedDays: 5,
      selectionSavedDays: 34,
      winRatePct: volume ? 76 : 73.07692307692308,
      passedMinimumWinRate: true,
      supplementHasKnownGap: true,
      role: volume ? "entry_quality_candidate" : "exit_timing_candidate",
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

export function applySumcoAdoptionGate<Decision extends { status: string; reason: string; days: number }>(
  decision: Decision,
  gate: SumcoAdoptionGate,
): Decision | (Omit<Decision, "status" | "reason"> & {
  status: "interim_continue";
  reason: "sumco_891m_manual_comparison_required";
}) {
  if (!gate.applicable || decision.status !== "eligible") return decision;
  return { ...decision, status: "interim_continue", reason: "sumco_891m_manual_comparison_required" };
}
