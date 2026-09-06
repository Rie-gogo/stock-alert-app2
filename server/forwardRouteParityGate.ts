import {
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  TEL_EXECUTABLE_CONFIRM_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
} from "./runtimeIdentity";
import { TEL_CURRENT_PARITY_VERSION } from "./telCurrentParity";

export type RouteParityGate = {
  status: "passed" | "required" | "not_applicable";
  requiredRoutes: string[];
  baselineVersion: string | null;
  evidence: {
    kind: "saved_kabu_source_audit" | "missing_route_parity" | "not_applicable";
    verifiedThrough: string | null;
    replayedTradingDays: number | null;
    matchedTrades: number | null;
    mismatches: number | null;
  };
};

const TEL_ALL_CURRENT_ROUTES = [
  "open_direction_breakout_long",
  "open_direction_breakout_short",
  "fallback_trend_long",
  "fallback_trend_short",
] as const;

const PASSED_TEL_GATE: RouteParityGate = {
  status: "passed",
  requiredRoutes: [...TEL_ALL_CURRENT_ROUTES],
  baselineVersion: TEL_CURRENT_PARITY_VERSION,
  evidence: {
    kind: "saved_kabu_source_audit",
    verifiedThrough: "2026-08-31",
    replayedTradingDays: 48,
    matchedTrades: 35,
    mismatches: 0,
  },
};

const REQUIRED_BY_VERSION: Record<string, string[]> = {
  [FUJIKURA_FORWARD_STRATEGY_VERSION]: ["lowReversalBreakLong"],
  [SOFTBANK_DEPTH_CONFIRM_VERSION]: ["softbankBreakoutLong"],
  [SOFTBANK_RR2_PROTECT_VERSION]: ["softbankBreakoutLong"],
  [TAIYO_BOARD_DEMAND_VERSION]: ["taiyoCandidateBLong"],
  [TAIYO_RR2_PROTECT_VERSION]: ["taiyoCandidateBLong"],
  [SOCIONEXT_INITIAL_STRENGTH_VERSION]: ["socionextConfirmedLong"],
  [SOCIONEXT_CONFIRM_STRENGTH_VERSION]: ["socionextConfirmedLong"],
  [KIOXIA_FORWARD_STRATEGY_VERSION]: ["kioxiaConfirmedMorningLong"],
  [KIOXIA_ATR_FORWARD_STRATEGY_VERSION]: [
    "confirmed_morning_long",
    "reversal_long",
    "reversal_short",
    "trend_short",
    "safe_cb_short",
  ],
};

export function resolveForwardRouteParityGate(strategyVersion: string): RouteParityGate {
  if ([FORWARD_STRATEGY_VERSION, TEL_EXECUTABLE_CONFIRM_VERSION, TEL_EXECUTABLE_DEPTH_VERSION].includes(strategyVersion)) {
    return { ...PASSED_TEL_GATE, requiredRoutes: [...PASSED_TEL_GATE.requiredRoutes] };
  }
  const requiredRoutes = REQUIRED_BY_VERSION[strategyVersion];
  if (requiredRoutes) {
    return {
      status: "required",
      requiredRoutes: [...requiredRoutes],
      baselineVersion: null,
      evidence: {
        kind: "missing_route_parity",
        verifiedThrough: null,
        replayedTradingDays: null,
        matchedTrades: null,
        mismatches: null,
      },
    };
  }
  return {
    status: "not_applicable",
    requiredRoutes: [],
    baselineVersion: null,
    evidence: {
      kind: "not_applicable",
      verifiedThrough: null,
      replayedTradingDays: null,
      matchedTrades: null,
      mismatches: null,
    },
  };
}

export function applyForwardRouteParityGate<Decision extends { status: string; reason: string; days: number }>(
  decision: Decision,
  gate: RouteParityGate,
): Decision | (Omit<Decision, "status" | "reason"> & { status: "interim_continue"; reason: "route_parity_required_before_manual_review" }) {
  if (decision.status !== "eligible" || gate.status === "passed" || gate.status === "not_applicable") return decision;
  return {
    ...decision,
    status: "interim_continue",
    reason: "route_parity_required_before_manual_review",
  };
}
