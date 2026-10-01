import { NAME_BY_SYMBOL } from "../shared/stocks";
import { CURRENT_SIGNAL_CANDIDATE_VERSION } from "./currentSignalCandidateRegistry";
import {
  DISCO_LONG_PRIOR_THREE_B_VERSION,
  DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  DISCO_SHORT_RETEST_B_VERSION,
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  KIOXIA_REVERSAL_LONG_REOPEN_VERSION,
  MURATA_DEEP_REVERSAL_LONG_VERSION,
  MURATA_MORNING_BREAKDOWN_SHORT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_LONG_RR2_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
} from "./runtimeIdentity";

/**
 * Explicit allowlist for the route-granular monitoring selector.
 * A row is never inferred from a raw payload: an unknown route remains excluded.
 */
export type RouteGranularVariant = Readonly<{
  rowId: string;
  symbol: string;
  symbolName: string;
  routeGroupId: string;
  direction: "long" | "short" | "unknown";
  label: string;
  canonicalLogic: string | null;
  strategyVersion: string | null;
  origin: "current" | "forward_shadow" | "unavailable" | "unclassified";
  candidateRouteId?: string;
  shadowRouteId?: string;
  lifecycleRequirement: "current_candidate_ledger" | "monitoring_candidate" | "unavailable" | "unclassified";
  unavailableReason: string | null;
}>;

function name(symbol: string) { return NAME_BY_SYMBOL[symbol] ?? symbol; }
function current(input: Omit<RouteGranularVariant, "rowId" | "symbolName" | "origin" | "strategyVersion" | "lifecycleRequirement" | "unavailableReason">): RouteGranularVariant {
  return {
    ...input,
    rowId: `current:${input.symbol}:${input.routeGroupId}:${input.candidateRouteId ?? "unknown"}`,
    symbolName: name(input.symbol), origin: "current", strategyVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
    lifecycleRequirement: "current_candidate_ledger", unavailableReason: null,
  };
}
function shadow(input: Omit<RouteGranularVariant, "rowId" | "symbolName" | "origin" | "lifecycleRequirement" | "unavailableReason">): RouteGranularVariant {
  return {
    ...input,
    rowId: `shadow:${input.strategyVersion}:${input.routeGroupId}:${input.shadowRouteId ?? "single"}`,
    symbolName: name(input.symbol), origin: "forward_shadow", lifecycleRequirement: "monitoring_candidate", unavailableReason: null,
  };
}
function unavailable(input: Omit<RouteGranularVariant, "rowId" | "symbolName" | "origin" | "strategyVersion" | "canonicalLogic" | "lifecycleRequirement">): RouteGranularVariant {
  return {
    ...input,
    rowId: `unavailable:${input.symbol}:${input.routeGroupId}:${input.label}`,
    symbolName: name(input.symbol), origin: "unavailable", strategyVersion: null, canonicalLogic: null,
    lifecycleRequirement: "unavailable",
  };
}

const variants: RouteGranularVariant[] = [
  // 285A: five current canonical routes and each independently attributable shadow route.
  current({ symbol: "285A", routeGroupId: "confirmed_morning_long", direction: "long", label: "Current：確認型前場LONG", canonicalLogic: "current-285a-trend-long", candidateRouteId: "trendLong" }),
  shadow({ symbol: "285A", routeGroupId: "confirmed_morning_long", direction: "long", label: "Plan A：確認型前場LONG", canonicalLogic: "285a_confirmed_long_ma8_protection", strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, shadowRouteId: "confirmed_morning_long" }),
  shadow({ symbol: "285A", routeGroupId: "confirmed_morning_long", direction: "long", label: "Plan B：確認型前場LONG", canonicalLogic: "285a_five_routes_atr036_route_daily_end", strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, shadowRouteId: "confirmed_morning_long" }),
  current({ symbol: "285A", routeGroupId: "reversal_long", direction: "long", label: "Current：反転LONG", canonicalLogic: "current-285a-reversal-long", candidateRouteId: "reversalLong" }),
  shadow({ symbol: "285A", routeGroupId: "reversal_long", direction: "long", label: "Plan B：反転LONG（既存複合内）", canonicalLogic: "285a_five_routes_atr036_route_daily_end", strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, shadowRouteId: "reversal_long" }),
  shadow({ symbol: "285A", routeGroupId: "reversal_long", direction: "long", label: "再開監視：反転LONG", canonicalLogic: "candidate-285a-reversal-long-monitoring-reopen", strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, shadowRouteId: "reversal_long" }),
  current({ symbol: "285A", routeGroupId: "reversal_short", direction: "short", label: "Current：反転SHORT", canonicalLogic: "current-285a-reversal-short", candidateRouteId: "reversalShort" }),
  shadow({ symbol: "285A", routeGroupId: "reversal_short", direction: "short", label: "Plan B：反転SHORT", canonicalLogic: "285a_five_routes_atr036_route_daily_end", strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, shadowRouteId: "reversal_short" }),
  current({ symbol: "285A", routeGroupId: "trend_short", direction: "short", label: "Current：順張りSHORT", canonicalLogic: "current-285a-trend-short", candidateRouteId: "trendShort" }),
  shadow({ symbol: "285A", routeGroupId: "trend_short", direction: "short", label: "Plan B：順張りSHORT", canonicalLogic: "285a_five_routes_atr036_route_daily_end", strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, shadowRouteId: "trend_short" }),
  current({ symbol: "285A", routeGroupId: "safe_cb_short", direction: "short", label: "Current：安全CB SHORT", canonicalLogic: "current-285a-safe-cb-short", candidateRouteId: "kioxiaSafeCbShort" }),
  shadow({ symbol: "285A", routeGroupId: "safe_cb_short", direction: "short", label: "Plan B：安全CB SHORT", canonicalLogic: "285a_five_routes_atr036_route_daily_end", strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, shadowRouteId: "safe_cb_short" }),
  { rowId: "unclassified:285A", symbol: "285A", symbolName: name("285A"), routeGroupId: "unclassified", direction: "unknown", label: "未分類（選択対象外）", canonicalLogic: null, strategyVersion: null, origin: "unclassified", lifecycleRequirement: "unclassified", unavailableReason: "unclassified_route_is_never_selectable" },

  current({ symbol: "3436", routeGroupId: "sumco_breakdown_short", direction: "short", label: "Current：前場安値更新SHORT", canonicalLogic: "current-3436-breakdown-short", candidateRouteId: "sumcoBreakdownShort" }),
  shadow({ symbol: "3436", routeGroupId: "sumco_breakdown_short", direction: "short", label: "A：出来高1.10倍", canonicalLogic: "candidate-3436-volume110-time15", strategyVersion: SUMCO_VOLUME_110_VERSION }),
  shadow({ symbol: "3436", routeGroupId: "sumco_breakdown_short", direction: "short", label: "B：15分時間決済", canonicalLogic: "candidate-3436-current-entry-time15", strategyVersion: SUMCO_TIME_15_VERSION }),

  current({ symbol: "5803", routeGroupId: "low_reversal_long", direction: "long", label: "Current：安値反転LONG", canonicalLogic: "current-5803-low-reversal-long", candidateRouteId: "lowReversalBreakLong" }),
  shadow({ symbol: "5803", routeGroupId: "low_reversal_long", direction: "long", label: "A：安値反転LONG", canonicalLogic: "5803_low_reversal_long_ab", strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION }),
  current({ symbol: "5803", routeGroupId: "high_fade_short", direction: "short", label: "Current：高値失速SHORT", canonicalLogic: "current-5803-high-fade-short", candidateRouteId: "highFadeBreakShort" }),
  unavailable({ symbol: "5803", routeGroupId: "high_fade_short", direction: "short", label: "B：停止・旧版", unavailableReason: "stopped_shadow_version_excluded" }),

  unavailable({ symbol: "6146", routeGroupId: "opening_short", direction: "short", label: "Current：停止中（対象外）", unavailableReason: "paused_current_route_excluded" }),
  shadow({ symbol: "6146", routeGroupId: "opening_short", direction: "short", label: "A：実行可能価格確認", canonicalLogic: "candidate-6146-opening-short-executable-a", strategyVersion: DISCO_SHORT_EXECUTABLE_A_VERSION }),
  shadow({ symbol: "6146", routeGroupId: "opening_short", direction: "short", label: "B：再安値リテスト", canonicalLogic: "candidate-6146-opening-short-retest-b", strategyVersion: DISCO_SHORT_RETEST_B_VERSION }),
  current({ symbol: "6146", routeGroupId: "confirmed_long", direction: "long", label: "Current：確認型LONG", canonicalLogic: "current-6146-confirmed-long", candidateRouteId: "discoConfirmedBreakLong" }),
  shadow({ symbol: "6146", routeGroupId: "confirmed_long", direction: "long", label: "A：利益保護", canonicalLogic: "candidate-6146-confirmed-long-profit-protection-a", strategyVersion: DISCO_LONG_PROFIT_PROTECTION_A_VERSION }),
  shadow({ symbol: "6146", routeGroupId: "confirmed_long", direction: "long", label: "B：直前3本確認", canonicalLogic: "candidate-6146-confirmed-long-prior-three-b", strategyVersion: DISCO_LONG_PRIOR_THREE_B_VERSION }),

  current({ symbol: "6526", routeGroupId: "confirmed_long", direction: "long", label: "Current：確認型LONG", canonicalLogic: "current-6526-confirmed-long", candidateRouteId: "socionextConfirmedLong" }),
  shadow({ symbol: "6526", routeGroupId: "confirmed_long", direction: "long", label: "再開監視A：初動強度", canonicalLogic: "candidate-6526-initial-strength-monitoring-reopen", strategyVersion: SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION }),
  shadow({ symbol: "6526", routeGroupId: "confirmed_long", direction: "long", label: "B：確認足強度", canonicalLogic: "candidate-6526-confirm-strength-daily-stop", strategyVersion: SOCIONEXT_CONFIRM_STRENGTH_VERSION }),

  current({ symbol: "6857", routeGroupId: "confirmed_break_long", direction: "long", label: "Current：確認ブレイクLONG", canonicalLogic: "current-6857-confirmed-break-long", candidateRouteId: "advantestConfirmedBreakLong" }),
  unavailable({ symbol: "6857", routeGroupId: "confirmed_break_long", direction: "long", label: "A：未登録", unavailableReason: "no_exact_active_monitoring_version" }),
  unavailable({ symbol: "6857", routeGroupId: "confirmed_break_long", direction: "long", label: "B：未登録", unavailableReason: "no_exact_active_monitoring_version" }),
  current({ symbol: "6857", routeGroupId: "high_fade_short", direction: "short", label: "Current：高値失速SHORT", canonicalLogic: "current-6857-high-fade-short", candidateRouteId: "advantestHighFadeShort" }),

  current({ symbol: "6976", routeGroupId: "candidate_b_long", direction: "long", label: "Current：候補B LONG", canonicalLogic: "current-6976-candidate-b-long", candidateRouteId: "taiyoCandidateB" }),
  shadow({ symbol: "6976", routeGroupId: "candidate_b_long", direction: "long", label: "A：板需要確認", canonicalLogic: "candidate-6976-board-demand-bpr130", strategyVersion: TAIYO_BOARD_DEMAND_VERSION }),
  shadow({ symbol: "6976", routeGroupId: "candidate_b_long", direction: "long", label: "B：2R利益保護", canonicalLogic: "candidate-6976-rr2-protect", strategyVersion: TAIYO_RR2_PROTECT_VERSION }),
  current({ symbol: "6976", routeGroupId: "afternoon_reversal_long", direction: "long", label: "Current：後場反転LONG", canonicalLogic: "current-6976-afternoon-reversal", candidateRouteId: "taiyoAfternoonReversal" }),
  shadow({ symbol: "6976", routeGroupId: "afternoon_short", direction: "short", label: "A：後場SHORT 2R", canonicalLogic: "candidate-6976-afternoon-short-rr2-45", strategyVersion: TAIYO_AFTERNOON_RR2_VERSION }),
  shadow({ symbol: "6976", routeGroupId: "afternoon_short", direction: "short", label: "B：後場SHORT depth", canonicalLogic: "candidate-6976-afternoon-short-depth", strategyVersion: TAIYO_AFTERNOON_DEPTH_VERSION }),
  shadow({ symbol: "6976", routeGroupId: "afternoon_long", direction: "long", label: "A：後場LONG 2R", canonicalLogic: "candidate-6976-afternoon-long-rr2-10", strategyVersion: TAIYO_AFTERNOON_LONG_RR2_VERSION }),
  shadow({ symbol: "6976", routeGroupId: "afternoon_long", direction: "long", label: "B：後場LONG回復型", canonicalLogic: "candidate-6976-afternoon-long-recovery-winrate", strategyVersion: TAIYO_AFTERNOON_LONG_WINRATE_VERSION }),

  current({ symbol: "6981", routeGroupId: "low_reversal_long", direction: "long", label: "Current：安値反転LONG", canonicalLogic: "current-6981-low-reversal-long", candidateRouteId: "lowReversalBreakLong" }),
  shadow({ symbol: "6981", routeGroupId: "deep_reversal_long", direction: "long", label: "A：深い下落後の確認反発", canonicalLogic: "candidate-6981-deep-reversal-long", strategyVersion: MURATA_DEEP_REVERSAL_LONG_VERSION }),
  shadow({ symbol: "6981", routeGroupId: "morning_breakdown_short", direction: "short", label: "B：前場20本安値更新", canonicalLogic: "candidate-6981-morning-20bar-breakdown-short", strategyVersion: MURATA_MORNING_BREAKDOWN_SHORT_VERSION }),

  current({ symbol: "8035", routeGroupId: "open_direction_breakout_long", direction: "long", label: "Current：始値方向ブレイクLONG", canonicalLogic: "current-8035-open-break-long", candidateRouteId: "telShortBreak" }),
  shadow({ symbol: "8035", routeGroupId: "open_direction_breakout_long", direction: "long", label: "A：始値方向ブレイク", canonicalLogic: "8035_open_direction_breakout", strategyVersion: FORWARD_STRATEGY_VERSION }),
  shadow({ symbol: "8035", routeGroupId: "open_direction_breakout_long", direction: "long", label: "B：次イベント板depth", canonicalLogic: "candidate-8035-executable-depth", strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION }),
  current({ symbol: "8035", routeGroupId: "open_direction_breakout_short", direction: "short", label: "Current：始値方向ブレイクSHORT", canonicalLogic: "current-8035-open-break-short", candidateRouteId: "telShortBreak" }),

  current({ symbol: "9984", routeGroupId: "breakout_long", direction: "long", label: "Current：ブレイクLONG", canonicalLogic: "current-9984-breakout-long", candidateRouteId: "softbankBreakoutLong" }),
  shadow({ symbol: "9984", routeGroupId: "breakout_long", direction: "long", label: "A：次イベント板確認", canonicalLogic: "candidate-9984-breakout-depth-confirm", strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION }),
  shadow({ symbol: "9984", routeGroupId: "breakout_long", direction: "long", label: "B：2R利益保護", canonicalLogic: "candidate-9984-breakout-rr2-protect", strategyVersion: SOFTBANK_RR2_PROTECT_VERSION }),
];

export const ROUTE_GRANULAR_VARIANTS = Object.freeze(variants);
export const ROUTE_GRANULAR_SYMBOLS = Object.freeze(Array.from(new Set(variants.map(item => item.symbol))).sort());
export const ROUTE_GRANULAR_GROUPS = Object.freeze(Array.from(new Set(variants.map(item => `${item.symbol}:${item.routeGroupId}`))).sort());
