import {
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
} from "./runtimeIdentity";

const TARGET_VERSIONS = new Set([SOFTBANK_DEPTH_CONFIRM_VERSION, SOFTBANK_RR2_PROTECT_VERSION]);

export const SOFTBANK_MINIMUM_REALIZED_PAYOFF_RATIO = 0.8;

export type SoftbankAdoptionGate = {
  applicable: boolean;
  minimumRealizedPayoffRatio: number;
  realizedPayoffRatio: number | null;
  payoffStatus: "passed" | "failed" | "insufficient" | "not_applicable";
  takeProfitExits: number;
  completedTrades: number;
  takeProfitReachRatePct: number | null;
  portfolioGate: {
    status: "manual_comparison_required" | "not_applicable";
    baseline: "current_10_symbol_891m" | null;
    rule: "candidate_must_not_reduce_portfolio_pnl" | null;
    automaticAdoption: false;
  };
};

export function resolveSoftbankAdoptionGate(input: {
  strategyVersion: string;
  realizedPayoffRatio: number | null;
  trades: Array<{ pnl: number | null; exitReason?: string | null }>;
}): SoftbankAdoptionGate {
  if (!TARGET_VERSIONS.has(input.strategyVersion)) {
    return {
      applicable: false,
      minimumRealizedPayoffRatio: SOFTBANK_MINIMUM_REALIZED_PAYOFF_RATIO,
      realizedPayoffRatio: null,
      payoffStatus: "not_applicable",
      takeProfitExits: 0,
      completedTrades: 0,
      takeProfitReachRatePct: null,
      portfolioGate: {
        status: "not_applicable",
        baseline: null,
        rule: null,
        automaticAdoption: false,
      },
    };
  }
  const completed = input.trades.filter(trade => trade.pnl !== null);
  const takeProfitExits = completed.filter(trade => trade.exitReason === "take_profit").length;
  const payoffStatus = completed.length === 0
    ? "insufficient"
    : input.realizedPayoffRatio === null || input.realizedPayoffRatio >= SOFTBANK_MINIMUM_REALIZED_PAYOFF_RATIO
      ? "passed"
      : "failed";
  return {
    applicable: true,
    minimumRealizedPayoffRatio: SOFTBANK_MINIMUM_REALIZED_PAYOFF_RATIO,
    realizedPayoffRatio: input.realizedPayoffRatio,
    payoffStatus,
    takeProfitExits,
    completedTrades: completed.length,
    takeProfitReachRatePct: completed.length > 0 ? takeProfitExits / completed.length * 100 : null,
    portfolioGate: {
      status: "manual_comparison_required",
      baseline: "current_10_symbol_891m",
      rule: "candidate_must_not_reduce_portfolio_pnl",
      automaticAdoption: false,
    },
  };
}

export function applySoftbankAdoptionGate<Decision extends { status: string; reason: string; days: number }>(
  decision: Decision,
  gate: SoftbankAdoptionGate,
): Decision | (Omit<Decision, "status" | "reason"> & {
  status: "stopped" | "interim_continue";
  reason: "softbank_realized_payoff_ratio_below_080" | "softbank_891m_manual_comparison_required";
}) {
  if (!gate.applicable || decision.status !== "eligible") return decision;
  if (gate.payoffStatus === "failed") {
    return { ...decision, status: "stopped", reason: "softbank_realized_payoff_ratio_below_080" };
  }
  return { ...decision, status: "interim_continue", reason: "softbank_891m_manual_comparison_required" };
}
