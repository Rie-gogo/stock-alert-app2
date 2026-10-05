import { NAME_BY_SYMBOL } from "../shared/stocks";
import { CURRENT_SIGNAL_CANDIDATE_VERSION } from "./currentSignalCandidateRegistry";
import {
  ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION,
  ADVANTEST_SHORT_BODY008_DEPTH_VERSION,
  BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS,
  BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS,
  DISCO_LONG_PRIOR_THREE_B_VERSION,
  DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  DISCO_SHORT_RETEST_B_VERSION,
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
  KIOXIA_REVERSAL_LONG_REOPEN_VERSION,
  MURATA_DEEP_REVERSAL_LONG_VERSION,
  MURATA_MORNING_BREAKDOWN_SHORT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION,
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
  /** A dual-direction strategyVersion is partitioned by persisted action side. */
  shadowSide?: "long" | "short";
  lifecycleRequirement: "current_candidate_ledger" | "stopped_current" | "monitoring_candidate" | "invalid_mapping" | "unavailable" | "unclassified";
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
function stoppedCurrent(input: Omit<RouteGranularVariant, "rowId" | "symbolName" | "origin" | "strategyVersion" | "lifecycleRequirement" | "unavailableReason">): RouteGranularVariant {
  return {
    ...input,
    rowId: `stopped-current:${input.symbol}:${input.routeGroupId}:${input.candidateRouteId ?? "unknown"}`,
    symbolName: name(input.symbol), origin: "unavailable", strategyVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
    lifecycleRequirement: "stopped_current", unavailableReason: "stopped_current_route_display_only",
  };
}
function invalidMapping(input: Omit<RouteGranularVariant, "rowId" | "symbolName" | "origin" | "lifecycleRequirement" | "unavailableReason">): RouteGranularVariant {
  return {
    ...input,
    rowId: `invalid-mapping:${input.strategyVersion ?? input.symbol}:${input.routeGroupId}:${input.shadowRouteId ?? "single"}`,
    symbolName: name(input.symbol), origin: "unavailable", lifecycleRequirement: "invalid_mapping",
    unavailableReason: "invalid_mapping_quarantined_not_dispatched_or_selectable",
  };
}
function stoppedShadow(input: Omit<RouteGranularVariant, "rowId" | "symbolName" | "origin" | "lifecycleRequirement" | "unavailableReason">): RouteGranularVariant {
  return {
    ...input,
    rowId: `stopped-shadow:${input.strategyVersion ?? input.symbol}:${input.routeGroupId}:${input.shadowRouteId ?? input.shadowSide ?? "single"}`,
    symbolName: name(input.symbol), origin: "unavailable", lifecycleRequirement: "unavailable",
    unavailableReason: "stopped_or_superseded_shadow_display_only",
  };
}

const variants: RouteGranularVariant[] = [
  // 285A: five current canonical routes and each independently attributable shadow route.
  current({ symbol: "285A", routeGroupId: "confirmed_morning_long", direction: "long", label: "Current：確認型前場LONG", canonicalLogic: "current-285a-trend-long", candidateRouteId: "trendLong" }),
  shadow({ symbol: "285A", routeGroupId: "confirmed_morning_long", direction: "long", label: "Plan A：確認型前場LONG", canonicalLogic: "285a_confirmed_long_ma8_protection", strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, shadowRouteId: "confirmed_morning_long" }),
  shadow({ symbol: "285A", routeGroupId: "confirmed_morning_long", direction: "long", label: "Plan B：確認型前場LONG", canonicalLogic: "285a_five_routes_atr036_route_daily_end", strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, shadowRouteId: "confirmed_morning_long" }),
  stoppedCurrent({ symbol: "285A", routeGroupId: "reversal_long", direction: "long", label: "旧Current：反転LONG（停止・履歴表示）", canonicalLogic: "current-285a-reversal-long", candidateRouteId: "reversalLong" }),
  shadow({ symbol: "285A", routeGroupId: "reversal_long", direction: "long", label: "Plan B：反転LONG（既存複合内）", canonicalLogic: "285a_five_routes_atr036_route_daily_end", strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, shadowRouteId: "reversal_long" }),
  shadow({ symbol: "285A", routeGroupId: "reversal_long", direction: "long", label: "再開監視：旧Current反転LONG（完全一致）", canonicalLogic: "candidate-285a-current-reversal-long-exact-monitoring-reopen", strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, shadowRouteId: "kioxiaReversalLong" }),
  invalidMapping({ symbol: "285A", routeGroupId: "reversal_long", direction: "long", label: "隔離：Plan B切出しATR版（誤mapping）", canonicalLogic: "candidate-285a-reversal-long-monitoring-reopen", strategyVersion: KIOXIA_REVERSAL_LONG_REOPEN_VERSION, shadowRouteId: "reversal_long" }),
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
  stoppedShadow({ symbol: "5803", routeGroupId: "low_reversal_long", direction: "long", label: "旧A：安値反転LONG v1（停止・履歴表示）", canonicalLogic: "5803_low_reversal_long_ab", strategyVersion: "forward-shadow-5803-low-reversal-ab-v1" }),
  current({ symbol: "5803", routeGroupId: "high_fade_short", direction: "short", label: "Current：高値失速SHORT", canonicalLogic: "current-5803-high-fade-short", candidateRouteId: "highFadeBreakShort" }),
  unavailable({ symbol: "5803", routeGroupId: "high_fade_short", direction: "short", label: "B：停止・旧版", unavailableReason: "stopped_shadow_version_excluded" }),
  stoppedCurrent({ symbol: "5803", routeGroupId: "afternoon_low_break_short", direction: "short", label: "旧Current：後場安値更新SHORT（停止・履歴表示）", canonicalLogic: "current-5803-afternoon-low-break-short", candidateRouteId: "afternoonLowBreakShort" }),

  stoppedCurrent({ symbol: "6146", routeGroupId: "opening_short", direction: "short", label: "旧Current：寄り付きSHORT（停止・履歴表示）", canonicalLogic: "current-6146-opening-short", candidateRouteId: "discoOpeningBreakShort" }),
  shadow({ symbol: "6146", routeGroupId: "opening_short", direction: "short", label: "A：実行可能価格確認", canonicalLogic: "candidate-6146-opening-short-executable-a", strategyVersion: DISCO_SHORT_EXECUTABLE_A_VERSION }),
  shadow({ symbol: "6146", routeGroupId: "opening_short", direction: "short", label: "B：再安値リテスト", canonicalLogic: "candidate-6146-opening-short-retest-b", strategyVersion: DISCO_SHORT_RETEST_B_VERSION }),
  current({ symbol: "6146", routeGroupId: "confirmed_long", direction: "long", label: "Current：確認型LONG", canonicalLogic: "current-6146-confirmed-long", candidateRouteId: "discoConfirmedBreakLong" }),
  shadow({ symbol: "6146", routeGroupId: "confirmed_long", direction: "long", label: "A：利益保護", canonicalLogic: "candidate-6146-confirmed-long-profit-protection-a", strategyVersion: DISCO_LONG_PROFIT_PROTECTION_A_VERSION }),
  shadow({ symbol: "6146", routeGroupId: "confirmed_long", direction: "long", label: "B：直前3本確認", canonicalLogic: "candidate-6146-confirmed-long-prior-three-b", strategyVersion: DISCO_LONG_PRIOR_THREE_B_VERSION }),

  stoppedCurrent({ symbol: "6526", routeGroupId: "confirmed_long", direction: "long", label: "旧Current：確認型LONG（停止・履歴表示）", canonicalLogic: "current-6526-confirmed-long", candidateRouteId: "socionextConfirmedLong" }),
  shadow({ symbol: "6526", routeGroupId: "confirmed_long", direction: "long", label: "再開監視：旧Current確認型LONG（完全一致）", canonicalLogic: "candidate-6526-confirmed-long-exact-monitoring-reopen", strategyVersion: SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION }),
  shadow({ symbol: "6526", routeGroupId: "confirmed_long", direction: "long", label: "B：確認足強度", canonicalLogic: "candidate-6526-confirm-strength-daily-stop", strategyVersion: SOCIONEXT_CONFIRM_STRENGTH_VERSION }),
  invalidMapping({ symbol: "6526", routeGroupId: "confirmed_long", direction: "long", label: "隔離：初動強度LONG（要求対象外）", canonicalLogic: "candidate-6526-initial-strength-monitoring-reopen", strategyVersion: SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION }),

  current({ symbol: "6857", routeGroupId: "confirmed_break_long", direction: "long", label: "Current：確認ブレイクLONG", canonicalLogic: "current-6857-confirmed-break-long", candidateRouteId: "advantestConfirmedBreakLong" }),
  shadow({ symbol: "6857", routeGroupId: "confirmed_break_long", direction: "long", label: "B：確認型継続LONG・次イベント板", canonicalLogic: "candidate-6857-confirmed-continuation-depth", strategyVersion: ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION }),
  current({ symbol: "6857", routeGroupId: "high_fade_short", direction: "short", label: "Current：高値失速SHORT", canonicalLogic: "current-6857-high-fade-short", candidateRouteId: "advantestHighFadeShort" }),
  shadow({ symbol: "6857", routeGroupId: "high_fade_short", direction: "short", label: "A：陰線実体0.08%＋次イベント板", canonicalLogic: "candidate-6857-short-body008-depth", strategyVersion: ADVANTEST_SHORT_BODY008_DEPTH_VERSION }),

  current({ symbol: "6976", routeGroupId: "candidate_b_long", direction: "long", label: "Current：候補B LONG", canonicalLogic: "current-6976-candidate-b-long", candidateRouteId: "taiyoCandidateB" }),
  shadow({ symbol: "6976", routeGroupId: "candidate_b_long", direction: "long", label: "A：板需要確認", canonicalLogic: "candidate-6976-board-demand-bpr130", strategyVersion: TAIYO_BOARD_DEMAND_VERSION }),
  shadow({ symbol: "6976", routeGroupId: "candidate_b_long", direction: "long", label: "B：2R利益保護", canonicalLogic: "candidate-6976-rr2-protect", strategyVersion: TAIYO_RR2_PROTECT_VERSION }),
  stoppedCurrent({ symbol: "6976", routeGroupId: "candidate_b_short", direction: "short", label: "旧Current：候補B SHORT（停止・履歴表示）", canonicalLogic: "current-6976-candidate-b-short", candidateRouteId: "taiyoCandidateB" }),
  stoppedCurrent({ symbol: "6976", routeGroupId: "morning_initial_short", direction: "short", label: "旧Current：朝初動SHORT（停止・履歴表示）", canonicalLogic: "current-6976-morning-initial-short", candidateRouteId: "taiyoMorningInitialShort" }),
  stoppedCurrent({ symbol: "6976", routeGroupId: "afternoon_reversal_long", direction: "long", label: "旧Current：後場反転LONG（停止・履歴表示）", canonicalLogic: "current-6976-afternoon-reversal-long", candidateRouteId: "taiyoAfternoonReversal" }),
  current({ symbol: "6976", routeGroupId: "afternoon_reversal_short", direction: "short", label: "Current：後場反転SHORT", canonicalLogic: "current-6976-afternoon-reversal-short", candidateRouteId: "taiyoAfternoonReversal" }),
  shadow({ symbol: "6976", routeGroupId: "afternoon_reversal_short", direction: "short", label: "A：後場反転SHORT 2R", canonicalLogic: "candidate-6976-afternoon-short-rr2-45", strategyVersion: TAIYO_AFTERNOON_RR2_VERSION }),
  shadow({ symbol: "6976", routeGroupId: "afternoon_reversal_short", direction: "short", label: "B：後場反転SHORT depth", canonicalLogic: "candidate-6976-afternoon-short-depth", strategyVersion: TAIYO_AFTERNOON_DEPTH_VERSION }),
  shadow({ symbol: "6976", routeGroupId: "afternoon_reversal_long", direction: "long", label: "A：後場反転LONG 2R", canonicalLogic: "candidate-6976-afternoon-long-rr2-10", strategyVersion: TAIYO_AFTERNOON_LONG_RR2_VERSION }),
  shadow({ symbol: "6976", routeGroupId: "afternoon_reversal_long", direction: "long", label: "B：後場反転LONG回復型", canonicalLogic: "candidate-6976-afternoon-long-recovery-winrate", strategyVersion: TAIYO_AFTERNOON_LONG_WINRATE_VERSION }),

  current({ symbol: "6981", routeGroupId: "low_reversal_long", direction: "long", label: "Current：安値反転LONG", canonicalLogic: "current-6981-low-reversal-long", candidateRouteId: "lowReversalBreakLong" }),
  stoppedCurrent({ symbol: "6981", routeGroupId: "opening_break_short", direction: "short", label: "旧Current：寄り付きブレイクSHORT（停止・履歴表示）", canonicalLogic: "current-6981-opening-break-short", candidateRouteId: "openingBreakShort" }),
  shadow({ symbol: "6981", routeGroupId: "deep_reversal_long", direction: "long", label: "A：深い下落後の確認反発", canonicalLogic: "candidate-6981-deep-reversal-long", strategyVersion: MURATA_DEEP_REVERSAL_LONG_VERSION }),
  shadow({ symbol: "6981", routeGroupId: "morning_breakdown_short", direction: "short", label: "B：前場20本安値更新", canonicalLogic: "candidate-6981-morning-20bar-breakdown-short", strategyVersion: MURATA_MORNING_BREAKDOWN_SHORT_VERSION }),

  current({ symbol: "8035", routeGroupId: "open_direction_breakout_long", direction: "long", label: "Current：始値方向ブレイクLONG", canonicalLogic: "current-8035-open-break-long", candidateRouteId: "telShortBreak" }),
  shadow({ symbol: "8035", routeGroupId: "open_direction_breakout_long", direction: "long", label: "A：始値方向ブレイクLONG", canonicalLogic: "8035_open_direction_breakout", strategyVersion: FORWARD_STRATEGY_VERSION, shadowSide: "long" }),
  shadow({ symbol: "8035", routeGroupId: "open_direction_breakout_long", direction: "long", label: "B：次イベント板depth LONG", canonicalLogic: "candidate-8035-executable-depth", strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION, shadowSide: "long" }),
  current({ symbol: "8035", routeGroupId: "open_direction_breakout_short", direction: "short", label: "Current：始値方向ブレイクSHORT", canonicalLogic: "current-8035-open-break-short", candidateRouteId: "telShortBreak" }),
  shadow({ symbol: "8035", routeGroupId: "open_direction_breakout_short", direction: "short", label: "A：始値方向ブレイクSHORT", canonicalLogic: "8035_open_direction_breakout", strategyVersion: FORWARD_STRATEGY_VERSION, shadowSide: "short" }),
  shadow({ symbol: "8035", routeGroupId: "open_direction_breakout_short", direction: "short", label: "B：次イベント板depth SHORT", canonicalLogic: "candidate-8035-executable-depth", strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION, shadowSide: "short" }),
  current({ symbol: "8035", routeGroupId: "fallback_trend_long", direction: "long", label: "Current：順張りLONG（予備）", canonicalLogic: "current-8035-fallback-trend-long", candidateRouteId: "trendLong" }),
  current({ symbol: "8035", routeGroupId: "fallback_trend_short", direction: "short", label: "Current：順張りSHORT（予備）", canonicalLogic: "current-8035-fallback-trend-short", candidateRouteId: "trendShort" }),
  stoppedCurrent({ symbol: "8035", routeGroupId: "peak_reversal_short", direction: "short", label: "旧Current：高値反転SHORT（停止・履歴表示）", canonicalLogic: "current-8035-peak-reversal-short", candidateRouteId: "peakReversalShort" }),

  current({ symbol: "9984", routeGroupId: "breakout_long", direction: "long", label: "Current：ブレイクLONG", canonicalLogic: "current-9984-breakout-long", candidateRouteId: "softbankBreakoutLong" }),
  shadow({ symbol: "9984", routeGroupId: "breakout_long", direction: "long", label: "A：次イベント板確認", canonicalLogic: "candidate-9984-breakout-depth-confirm", strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION }),
  shadow({ symbol: "9984", routeGroupId: "breakout_long", direction: "long", label: "B：2R利益保護", canonicalLogic: "candidate-9984-breakout-rr2-protect", strategyVersion: SOFTBANK_RR2_PROTECT_VERSION }),
];

// ボリンジャー2案は、variantと方向を混ぜずに4経路として集計する。
for (const symbol of Object.keys(BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS)) {
  const noStopVersion = BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS];
  const stopVersion = BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS];
  for (const direction of ["long", "short"] as const) {
    variants.push(
      shadow({
        symbol,
        routeGroupId: `bollinger_directional_no_stop_${direction}`,
        direction,
        label: `ボリンジャー方向判定・SLなし ${direction.toUpperCase()}`,
        canonicalLogic: `${symbol.toLowerCase()}_bollinger_directional_no_stop`,
        strategyVersion: noStopVersion,
        shadowSide: direction,
      }),
      shadow({
        symbol,
        routeGroupId: `bollinger_directional_stop060_${direction}`,
        direction,
        label: `ボリンジャー方向判定・SL0.60% ${direction.toUpperCase()}`,
        canonicalLogic: `${symbol.toLowerCase()}_bollinger_directional_stop060`,
        strategyVersion: stopVersion,
        shadowSide: direction,
      }),
    );
  }
}

export const ROUTE_GRANULAR_VARIANTS = Object.freeze(variants);
export const ROUTE_GRANULAR_SYMBOLS = Object.freeze(Array.from(new Set(variants.map(item => item.symbol))).sort());
export const ROUTE_GRANULAR_GROUPS = Object.freeze(Array.from(new Set(variants.map(item => `${item.symbol}:${item.routeGroupId}`))).sort());

/**
 * Code-derived obligations for routes that were previously absent or mapped to an
 * unrelated composite. This is intentionally route identity based, never a fixed
 * row count: one strategyVersion may legitimately have direction child rows.
 */
const AUTHORITATIVE_ROUTE_REQUIREMENTS = Object.freeze([
  { symbol: "285A", candidateRouteId: "reversalLong", direction: "long", routeGroupId: "reversal_long", lifecycleRequirement: "stopped_current" },
  { symbol: "285A", strategyVersion: KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION, shadowRouteId: "kioxiaReversalLong", direction: "long", routeGroupId: "reversal_long", lifecycleRequirement: "monitoring_candidate" },
  { symbol: "6526", candidateRouteId: "socionextConfirmedLong", direction: "long", routeGroupId: "confirmed_long", lifecycleRequirement: "stopped_current" },
  { symbol: "6526", strategyVersion: SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION, direction: "long", routeGroupId: "confirmed_long", lifecycleRequirement: "monitoring_candidate" },
  { symbol: "5803", candidateRouteId: "afternoonLowBreakShort", direction: "short", routeGroupId: "afternoon_low_break_short", lifecycleRequirement: "stopped_current" },
  { symbol: "6981", candidateRouteId: "openingBreakShort", direction: "short", routeGroupId: "opening_break_short", lifecycleRequirement: "stopped_current" },
  { symbol: "6976", candidateRouteId: "taiyoMorningInitialShort", direction: "short", routeGroupId: "morning_initial_short", lifecycleRequirement: "stopped_current" },
  { symbol: "6976", candidateRouteId: "taiyoCandidateB", direction: "short", routeGroupId: "candidate_b_short", lifecycleRequirement: "stopped_current" },
  { symbol: "6976", candidateRouteId: "taiyoAfternoonReversal", direction: "long", routeGroupId: "afternoon_reversal_long", lifecycleRequirement: "stopped_current" },
  { symbol: "6976", strategyVersion: TAIYO_AFTERNOON_LONG_RR2_VERSION, direction: "long", routeGroupId: "afternoon_reversal_long", lifecycleRequirement: "monitoring_candidate" },
  { symbol: "6976", strategyVersion: TAIYO_AFTERNOON_LONG_WINRATE_VERSION, direction: "long", routeGroupId: "afternoon_reversal_long", lifecycleRequirement: "monitoring_candidate" },
  { symbol: "8035", strategyVersion: FORWARD_STRATEGY_VERSION, shadowSide: "long", direction: "long", routeGroupId: "open_direction_breakout_long", lifecycleRequirement: "monitoring_candidate" },
  { symbol: "8035", strategyVersion: FORWARD_STRATEGY_VERSION, shadowSide: "short", direction: "short", routeGroupId: "open_direction_breakout_short", lifecycleRequirement: "monitoring_candidate" },
  { symbol: "8035", strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION, shadowSide: "long", direction: "long", routeGroupId: "open_direction_breakout_long", lifecycleRequirement: "monitoring_candidate" },
  { symbol: "8035", strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION, shadowSide: "short", direction: "short", routeGroupId: "open_direction_breakout_short", lifecycleRequirement: "monitoring_candidate" },
]);

function matchesRequirement(variant: RouteGranularVariant, requirement: typeof AUTHORITATIVE_ROUTE_REQUIREMENTS[number]) {
  return variant.symbol === requirement.symbol
    && variant.routeGroupId === requirement.routeGroupId
    && variant.direction === requirement.direction
    && variant.lifecycleRequirement === requirement.lifecycleRequirement
    && (requirement.candidateRouteId === undefined || variant.candidateRouteId === requirement.candidateRouteId)
    && (requirement.strategyVersion === undefined || variant.strategyVersion === requirement.strategyVersion)
    && (requirement.shadowRouteId === undefined || variant.shadowRouteId === requirement.shadowRouteId)
    && (requirement.shadowSide === undefined || variant.shadowSide === requirement.shadowSide);
}

export type RouteCatalogLifecycleRecord = Readonly<{
  versionId: string;
  strategyId: string;
  status: string;
  evaluationPurpose: string;
  eligibleForAdoption: boolean;
  configJson: unknown;
}>;

function symbolFromLifecycleConfig(configJson: unknown) {
  if (!configJson || typeof configJson !== "object") return null;
  const symbol = (configJson as Record<string, unknown>).symbol;
  return typeof symbol === "string" ? symbol : null;
}

export function auditRouteGranularCatalog(input: readonly RouteGranularVariant[] = ROUTE_GRANULAR_VARIANTS, lifecycleRows: readonly RouteCatalogLifecycleRecord[] = []) {
  const requirementMissing = AUTHORITATIVE_ROUTE_REQUIREMENTS
    .filter(requirement => !input.some(variant => matchesRequirement(variant, requirement)))
    .map(requirement => `${requirement.symbol}:${requirement.routeGroupId}:${requirement.strategyVersion ?? requirement.candidateRouteId ?? "unknown"}:${requirement.direction}`);
  const selectable = input.filter(item => item.lifecycleRequirement === "current_candidate_ledger" || item.lifecycleRequirement === "monitoring_candidate");
  const duplicateSelectableRows = Array.from(new Set(selectable
    .map(item => `${item.symbol}:${item.routeGroupId}:${item.strategyVersion ?? item.candidateRouteId ?? "unknown"}:${item.shadowRouteId ?? item.shadowSide ?? item.direction}`)
    .filter((key, _index, values) => values.filter(value => value === key).length > 1)));
  const invalidMappedSelectableRows = input.filter(item => item.lifecycleRequirement === "invalid_mapping" && selectable.some(candidate => candidate.strategyVersion === item.strategyVersion)).map(item => item.rowId);
  const catalogStrategyVersions = new Set(selectable.flatMap(item => item.strategyVersion ? [item.strategyVersion] : []));
  const symbols = new Set(ROUTE_GRANULAR_SYMBOLS);
  const orphanMonitoringCandidateVersions = lifecycleRows
    .filter(row => row.status === "monitoring" && row.evaluationPurpose === "candidate" && symbols.has(symbolFromLifecycleConfig(row.configJson) ?? ""))
    .filter(row => !catalogStrategyVersions.has(row.versionId))
    .map(row => row.versionId)
    .sort();
  return {
    complete: requirementMissing.length === 0 && duplicateSelectableRows.length === 0 && invalidMappedSelectableRows.length === 0 && orphanMonitoringCandidateVersions.length === 0,
    requirementMissing,
    duplicateSelectableRows,
    invalidMappedSelectableRows,
    orphanMonitoringCandidateVersions,
    catalogHashSource: "authoritative_current_and_dispatch_route_requirements_v1",
  };
}
