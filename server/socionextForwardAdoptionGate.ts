import {
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
} from "./runtimeIdentity";

const TARGET_VERSIONS = new Set([SOCIONEXT_INITIAL_STRENGTH_VERSION, SOCIONEXT_CONFIRM_STRENGTH_VERSION]);

export type SocionextAdoptionGate = {
  applicable: boolean;
  strategyVariant: "initial_strength" | "confirmation_strength" | null;
  historicalSelection: {
    fixedThroughDate: "2026-09-04" | null;
    fixedSavedDays: 51 | null;
    winRatePct: number | null;
    passedMinimumWinRate: boolean | null;
    role: "diagnostic_candidate" | "adoption_review_candidate" | "not_applicable";
  };
  eligibleForAdoption: boolean | null;
  portfolioGate: {
    status: "manual_comparison_required" | "not_applicable";
    baseline: "current_10_symbol_891m" | null;
    rule: "candidate_must_not_reduce_portfolio_pnl" | null;
    automaticAdoption: false;
  };
};

export function resolveSocionextAdoptionGate(strategyVersion: string): SocionextAdoptionGate {
  if (!TARGET_VERSIONS.has(strategyVersion)) {
    return {
      applicable: false,
      strategyVariant: null,
      historicalSelection: {
        fixedThroughDate: null,
        fixedSavedDays: null,
        winRatePct: null,
        passedMinimumWinRate: null,
        role: "not_applicable",
      },
      eligibleForAdoption: null,
      portfolioGate: { status: "not_applicable", baseline: null, rule: null, automaticAdoption: false },
    };
  }
  const initial = strategyVersion === SOCIONEXT_INITIAL_STRENGTH_VERSION;
  return {
    applicable: true,
    strategyVariant: initial ? "initial_strength" : "confirmation_strength",
    historicalSelection: {
      fixedThroughDate: "2026-09-04",
      fixedSavedDays: 51,
      winRatePct: initial ? 68.75 : 73.33333333333333,
      passedMinimumWinRate: !initial,
      role: initial ? "diagnostic_candidate" : "adoption_review_candidate",
    },
    eligibleForAdoption: !initial,
    portfolioGate: {
      status: "manual_comparison_required",
      baseline: "current_10_symbol_891m",
      rule: "candidate_must_not_reduce_portfolio_pnl",
      automaticAdoption: false,
    },
  };
}

export function applySocionextAdoptionGate<Decision extends { status: string; reason: string; days: number }>(
  decision: Decision,
  gate: SocionextAdoptionGate,
): Decision | (Omit<Decision, "status" | "reason"> & {
  status: "interim_continue";
  reason: "socionext_diagnostic_manual_reclassification_required" | "socionext_891m_manual_comparison_required";
}) {
  if (!gate.applicable || decision.status !== "eligible") return decision;
  if (gate.eligibleForAdoption === false) {
    return { ...decision, status: "interim_continue", reason: "socionext_diagnostic_manual_reclassification_required" };
  }
  return { ...decision, status: "interim_continue", reason: "socionext_891m_manual_comparison_required" };
}
