import {
  getSymbolConfig,
  resolveRestoredRiskOverrides,
  resolveSpecializedFiredStateKeys,
} from "./realtimeSimEngine";

export const CURRENT_SIGNAL_CANDIDATE_VERSION = "current-10-symbol-candidates-v1";
export const CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION = "current-10-symbol-signal-quality-v1";

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
