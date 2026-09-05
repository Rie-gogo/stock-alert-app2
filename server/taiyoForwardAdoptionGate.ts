import {
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
} from "./runtimeIdentity";

const TARGET_VERSIONS = new Set([TAIYO_BOARD_DEMAND_VERSION, TAIYO_RR2_PROTECT_VERSION]);

export const TAIYO_RR2_MINIMUM_REALIZED_PAYOFF_RATIO = 0.8;

export type TaiyoAdoptionGate = {
  applicable: boolean;
  strategyVariant: "board_demand" | "rr2_protect" | null;
  realizedPayoffRatioRequired: boolean;
  minimumRealizedPayoffRatio: number | null;
  realizedPayoffRatio: number | null;
  payoffStatus: "passed" | "failed" | "insufficient" | "not_required" | "not_applicable";
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

export function resolveTaiyoAdoptionGate(input: {
  strategyVersion: string;
  realizedPayoffRatio: number | null;
  trades: Array<{ pnl: number | null; exitReason?: string | null }>;
}): TaiyoAdoptionGate {
  if (!TARGET_VERSIONS.has(input.strategyVersion)) {
    return {
      applicable: false,
      strategyVariant: null,
      realizedPayoffRatioRequired: false,
      minimumRealizedPayoffRatio: null,
      realizedPayoffRatio: null,
      payoffStatus: "not_applicable",
      takeProfitExits: 0,
      completedTrades: 0,
      takeProfitReachRatePct: null,
      portfolioGate: { status: "not_applicable", baseline: null, rule: null, automaticAdoption: false },
    };
  }
  const completed = input.trades.filter(trade => trade.pnl !== null);
  const takeProfitExits = completed.filter(trade => trade.exitReason === "take_profit").length;
  const realizedPayoffRatioRequired = input.strategyVersion === TAIYO_RR2_PROTECT_VERSION;
  const payoffStatus = !realizedPayoffRatioRequired
    ? "not_required" as const
    : completed.length === 0
      ? "insufficient" as const
      : input.realizedPayoffRatio === null || input.realizedPayoffRatio >= TAIYO_RR2_MINIMUM_REALIZED_PAYOFF_RATIO
        ? "passed" as const
        : "failed" as const;
  return {
    applicable: true,
    strategyVariant: input.strategyVersion === TAIYO_RR2_PROTECT_VERSION ? "rr2_protect" : "board_demand",
    realizedPayoffRatioRequired,
    minimumRealizedPayoffRatio: realizedPayoffRatioRequired ? TAIYO_RR2_MINIMUM_REALIZED_PAYOFF_RATIO : null,
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

export function applyTaiyoAdoptionGate<Decision extends { status: string; reason: string; days: number }>(
  decision: Decision,
  gate: TaiyoAdoptionGate,
): Decision | (Omit<Decision, "status" | "reason"> & {
  status: "stopped" | "interim_continue";
  reason: "taiyo_rr2_realized_payoff_ratio_below_080" | "taiyo_891m_manual_comparison_required";
}) {
  if (!gate.applicable || decision.status !== "eligible") return decision;
  if (gate.payoffStatus === "failed") {
    return { ...decision, status: "stopped", reason: "taiyo_rr2_realized_payoff_ratio_below_080" };
  }
  return { ...decision, status: "interim_continue", reason: "taiyo_891m_manual_comparison_required" };
}
