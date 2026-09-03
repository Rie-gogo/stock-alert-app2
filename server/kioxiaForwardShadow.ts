import { calcATR } from "./intradayRegime";
import {
  KIOXIA_CONFIRMED_MORNING_LONG_SPEC,
  calculateKioxiaConfirmedMorningLongMetrics,
  isKioxiaConfirmedMorningLongEntryTime,
  type KioxiaConfirmedMorningLongCandle,
  type KioxiaConfirmedMorningLongMetrics,
} from "./kioxiaConfirmedMorningLong";

/** 285A確認型前場LONGへMA8失速確認付き利益保護だけを追加する前向きシャドー仕様。 */
export const KIOXIA_FORWARD_SHADOW_SPEC = Object.freeze({
  symbol: "285A",
  dryRunOnly: true,
  liveOrderApproved: false,
  entry: Object.freeze({
    ...KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary,
    commonAtrPeriod: 7,
    commonMinAtrPct: 0.12,
    executablePriceSource: "board_current_price_at_server_receipt",
  }),
  exit: Object.freeze({
    slPct: KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary.slPct,
    tpPct: KIOXIA_CONFIRMED_MORNING_LONG_SPEC.primary.tpPct,
    profitProtectionTriggerPct: 0.6,
    profitProtectionFloorPct: 0.3,
    maxMaSlope2Pct: -0.05,
    protectionMayExitOnArmingEvent: false,
    stopLossPriority: true,
    gapFill: "adverse_current_candle_open",
    amSessionExitTime: "11:27",
  }),
});

export interface KioxiaForwardBoardMetrics {
  executablePrice: number | null;
}

export interface KioxiaForwardEntryMetrics extends KioxiaConfirmedMorningLongMetrics {
  atrPct: number | null;
  atrAccepted: boolean;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculateKioxiaForwardEntryMetrics(
  candles: readonly KioxiaConfirmedMorningLongCandle[],
): KioxiaForwardEntryMetrics | null {
  const base = calculateKioxiaConfirmedMorningLongMetrics(candles);
  if (!base) return null;
  const period = KIOXIA_FORWARD_SHADOW_SPEC.entry.commonAtrPeriod;
  const highs = candles.map(candle => candle.high);
  const lows = candles.map(candle => candle.low);
  const closes = candles.map(candle => candle.close);
  const atrSeries = calcATR(highs, lows, closes, period);
  const latestAtr = atrSeries[atrSeries.length - 1];
  const currentClose = candles[candles.length - 1]?.close ?? 0;
  const atrPct = latestAtr !== null && currentClose > 0 ? latestAtr / currentClose * 100 : null;
  return {
    ...base,
    atrPct,
    eligible: base.eligible && isKioxiaConfirmedMorningLongEntryTime(candles[candles.length - 1]?.time ?? ""),
    atrAccepted: atrPct === null || atrPct >= KIOXIA_FORWARD_SHADOW_SPEC.entry.commonMinAtrPct,
  };
}

export function calculateKioxiaForwardMaSlope2Pct(
  candles: readonly KioxiaConfirmedMorningLongCandle[],
): number | null {
  const period = KIOXIA_FORWARD_SHADOW_SPEC.entry.maPeriod;
  if (candles.length < period + 2) return null;
  const currentMa = average(candles.slice(candles.length - period).map(candle => candle.close));
  const twoBarsAgoMa = average(
    candles.slice(candles.length - period - 2, candles.length - 2).map(candle => candle.close),
  );
  return twoBarsAgoMa > 0 ? (currentMa - twoBarsAgoMa) / twoBarsAgoMa * 100 : null;
}

export function calculateKioxiaForwardBoardMetrics(board: unknown): KioxiaForwardBoardMetrics {
  if (!board || typeof board !== "object") return { executablePrice: null };
  const price = Number((board as { currentPrice?: unknown }).currentPrice);
  return { executablePrice: Number.isFinite(price) && price > 0 ? price : null };
}
