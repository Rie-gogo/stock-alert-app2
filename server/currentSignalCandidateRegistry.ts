import {
  getSymbolConfig,
  resolveRestoredRiskOverrides,
  resolveSpecializedFiredStateKeys,
} from "./realtimeSimEngine";

// 6146寄り付きSHORTの本採用停止を、停止前の候補・仮想損益と混在させない。
export const CURRENT_SIGNAL_CANDIDATE_VERSION = "current-10-symbol-candidates-v2-disco-short-paused";
export const CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION = "current-10-symbol-signal-quality-v2-disco-short-paused";

export type CandidateSide = "long" | "short";

export interface CurrentRouteSpec {
  routeId: string;
  side: CandidateSide;
  slPct: number;
  tpPct: number;
  maxHoldingMinutes: number | null;
  timeExitPriceMode: "next_bar_open" | "boundary_close" | null;
  sessionExitTime: string | null;
  usesSignalReversalExit: boolean;
  usesBoardEarlyExit: boolean;
  profitProtection: null | {
    triggerPct: number;
    floorPct: number;
  };
  eligibleNominalRiskReward: boolean;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function routeIdFromReason(symbol: string, side: CandidateSide, reason: string): string {
  const action = side === "long" ? "buy" : "short";
  const resolved = resolveSpecializedFiredStateKeys(symbol, action, reason)[0];
  if (resolved) return resolved;
  if (symbol === "285A" && side === "short" && (reason.startsWith("大台割れ") || reason.startsWith("大台確認"))) {
    return "kioxiaSafeCbShort";
  }
  return `${symbol}:${side}:unclassified`;
}

const EXTERNAL_AUDIT_ROUTE_MAP: Record<string, { symbol: string; side: CandidateSide; internalRouteId: string }> = {
  high_fade_break_short: { symbol: "5803", side: "short", internalRouteId: "highFadeBreakShort" },
};

const EXTERNAL_AUDIT_ROUTE_SIDE_MAP: Record<string, CandidateSide> = {
  "8035:8035_open_direction_breakout_long": "long",
  "8035:8035_open_direction_breakout_short": "short",
  "8035:trend_long": "long",
  "8035:trend_short": "short",
  "8035:high_fade_break_short": "short",
  "285A:285A_confirmed_morning_long": "long",
  "285A:reversal_long": "long",
  "285A:reversal_short": "short",
  "285A:trend_long": "long",
  "285A:trend_short": "short",
  "285A:safe_cb_short": "short",
  "5803:low_reversal_break_long": "long",
  "5803:high_fade_break_short": "short",
  "5803:afternoon_low_break_short": "short",
  "6981:low_reversal_break_long": "long",
  "6981:opening_break_short": "short",
  "6976:reversal_long": "long",
  "6976:reversal_short": "short",
  "6976:taiyo_candidate_b_long": "long",
  "6976:taiyo_candidate_b_short": "short",
  "6976:taiyo_morning_initial_short": "short",
  "6857:advantest_high_fade_short": "short",
  "6857:advantest_confirmed_long": "long",
  "6146:disco_confirmed_long": "long",
  "6146:disco_opening_short": "short",
  "6146:confirmed_break_long": "long",
  "6146:opening_break_short": "short",
  "6526:socionext_confirmed_long": "long",
  "6526:confirmed_break_long": "long",
  "3436:sumco_15bar_breakdown_short": "short",
  "9984:ten_bar_breakout_long": "long",
};

/**
 * 監査routeは判断時に固定済みなので、後段workerは日本語理由を再解釈せずsideを復元する。
 * symbolとの組み合わせも固定し、別銘柄の同名routeを誤用しない。
 */
export function resolveCandidateSideFromAuditRoute(input: {
  externalRouteId: string | null | undefined;
  symbol: string;
}): CandidateSide | null {
  if (!input.externalRouteId) return null;
  return EXTERNAL_AUDIT_ROUTE_SIDE_MAP[`${input.symbol}:${input.externalRouteId}`] ?? null;
}

/**
 * 修復・監査専用の固定mapping。日本語理由や正規表現からrouteを再推測しない。
 */
export function resolveCurrentRouteSpecFromAuditRoute(input: {
  externalRouteId: string;
  symbol: string;
  side?: CandidateSide | null;
  entryCandleTime: string;
}): CurrentRouteSpec | null {
  const mapped = EXTERNAL_AUDIT_ROUTE_MAP[input.externalRouteId];
  if (!mapped || mapped.symbol !== input.symbol || (input.side && mapped.side !== input.side)) return null;
  const config = getSymbolConfig(input.symbol);
  const slPct = finite(config.highFadeBreakShortSlPct) ?? finite(config.sl?.[mapped.side]) ?? 0;
  const tpPct = finite(config.highFadeBreakShortTpPct) ?? finite(config.tp?.[mapped.side]) ?? 0;
  return {
    routeId: mapped.internalRouteId,
    side: mapped.side,
    slPct,
    tpPct,
    maxHoldingMinutes: null,
    timeExitPriceMode: null,
    sessionExitTime: input.entryCandleTime < "11:30" ? "11:27" : null,
    usesSignalReversalExit: true,
    usesBoardEarlyExit: true,
    profitProtection: null,
    eligibleNominalRiskReward: slPct > 0 && tpPct >= slPct * 2,
  };
}

export function resolveCurrentRouteSpec(input: {
  symbol: string;
  side: CandidateSide;
  reason: string;
  entryCandleTime: string;
}): CurrentRouteSpec {
  const { symbol, side, reason, entryCandleTime } = input;
  const config = getSymbolConfig(symbol);
  const routeId = routeIdFromReason(symbol, side, reason);
  const risk = resolveRestoredRiskOverrides(symbol, side, reason);
  const slPct = finite(risk.slPct) ?? finite(config.sl?.[side]) ?? 0;
  const tpPct = finite(risk.tpPct) ?? finite(config.tp?.[side]) ?? 0;

  let maxHoldingMinutes: number | null = null;
  let timeExitPriceMode: CurrentRouteSpec["timeExitPriceMode"] = null;
  if (symbol === "8035") {
    maxHoldingMinutes = routeId === "telShortBreak"
      ? finite(config.telShortBreakMaxHoldingMinutes)
      : finite(config.telMaxHoldingMinutes);
    timeExitPriceMode = maxHoldingMinutes === null ? null : "next_bar_open";
  } else if (routeId === "taiyoCandidateB") {
    maxHoldingMinutes = 30;
    timeExitPriceMode = "boundary_close";
  } else if (routeId === "socionextConfirmedLong") {
    maxHoldingMinutes = 20;
    timeExitPriceMode = "boundary_close";
  } else if (routeId === "sumcoBreakdownShort") {
    maxHoldingMinutes = 30;
    timeExitPriceMode = "boundary_close";
  } else if (routeId === "softbankBreakoutLong") {
    maxHoldingMinutes = 45;
    timeExitPriceMode = "boundary_close";
  }

  const specializedExitOnly = [
    "taiyoCandidateB",
    "socionextConfirmedLong",
    "sumcoBreakdownShort",
    "softbankBreakoutLong",
    "telShortBreak",
  ].includes(routeId);

  let profitProtection: CurrentRouteSpec["profitProtection"] = null;
  if (routeId === "discoOpeningBreakShort") {
    const triggerPct = finite(config.discoOpeningBreakShortProfitProtectionTriggerPct);
    const floorPct = finite(config.discoOpeningBreakShortProfitProtectionFloorPct);
    if (triggerPct !== null && floorPct !== null) profitProtection = { triggerPct, floorPct };
  } else if (routeId === "advantestHighFadeShort") {
    const triggerPct = finite(config.advantestHighFadeShortProfitProtectionTriggerPct);
    const floorPct = finite(config.advantestHighFadeShortProfitProtectionFloorPct);
    if (triggerPct !== null && floorPct !== null) profitProtection = { triggerPct, floorPct };
  }

  return {
    routeId,
    side,
    slPct,
    tpPct,
    maxHoldingMinutes,
    timeExitPriceMode,
    sessionExitTime: entryCandleTime < "11:30" ? "11:27" : null,
    usesSignalReversalExit: !specializedExitOnly,
    usesBoardEarlyExit: !specializedExitOnly && routeId !== "lowReversalBreakLong",
    profitProtection,
    eligibleNominalRiskReward: slPct > 0 && tpPct >= slPct * 2,
  };
}

export function parseMarginCandidateReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const match = reason.match(/\(([\s\S]+)\)\s*$/);
  return match?.[1]?.trim() || null;
}

export function parseRequiredMarginFromReason(reason: string | null | undefined): number | null {
  if (!reason) return null;
  const match = reason.match(/候補(\d+)円/);
  return match ? Number(match[1]) : null;
}
