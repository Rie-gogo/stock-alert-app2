/**
 * 5803（フジクラ）安値反転ブレイクLONG A＋Bの前向きシャドー専用仕様。
 * 現行売買エンジン・8035シャドー・注文生成から分離した純粋判定コア。
 */
export const FUJIKURA_FORWARD_SHADOW_SPEC = Object.freeze({
  symbol: "5803",
  dryRunOnly: true,
  liveOrderApproved: false,
  entry: Object.freeze({
    startTime: "09:45",
    endTime: "14:30",
    lowLookback: 20,
    highLookback: 5,
    maPeriod: 8,
    minMaSlope2Pct: 0.02,
    minVolumeRatio: 1.0,
    maxDayLowDropPct: -0.5,
    minReboundFromDayLowPct: 0,
    bprFloorExclusive: 0.25,
    bprMaxInclusive: 0.70,
    nextCandleConfirmation: true,
    rejectionTransition: "continue_search_without_consuming_daily_slot",
  }),
  exit: Object.freeze({
    slPct: 0.5,
    tpPct: 1.0,
    profitProtectionTriggerPct: 0.5,
    profitProtectionFloorPct: 0.3,
    protectionMayExitOnArmingEvent: false,
    stopLossPriority: true,
    gapFill: "adverse_current_candle_open",
    amSessionExitTime: "11:27",
    marketExitTime: "15:25",
  }),
});

export interface FujikuraForwardCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FujikuraTriggerMetrics {
  dayLow: number;
  recentHigh: number;
  dayLowDropPct: number;
  reboundFromDayLowPct: number;
  maSlope2Pct: number;
  volumeRatio: number;
  eligible: boolean;
}

export interface FujikuraBoardMetrics {
  buyPressureRatio: number | null;
  executablePrice: number | null;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculateFujikuraTriggerMetrics(
  candles: readonly FujikuraForwardCandle[],
): FujikuraTriggerMetrics | null {
  const spec = FUJIKURA_FORWARD_SHADOW_SPEC.entry;
  const requiredBars = Math.max(spec.lowLookback + 1, spec.highLookback + 1, spec.maPeriod + 2, 21);
  if (candles.length < requiredBars) return null;
  const candle = candles[candles.length - 1];
  if (candle.time < spec.startTime || candle.time > spec.endTime) return null;
  const previousHighBars = candles.slice(candles.length - 1 - spec.highLookback, candles.length - 1);
  const previousTwenty = candles.slice(candles.length - 21, candles.length - 1);
  const dayOpen = candles[0]?.open ?? candle.open;
  const dayLow = Math.min(...candles.map(item => item.low));
  const recentHigh = Math.max(...previousHighBars.map(item => item.high));
  const dayLowDropPct = dayOpen > 0 ? (dayLow - dayOpen) / dayOpen * 100 : 0;
  const reboundFromDayLowPct = dayLow > 0 ? (candle.close - dayLow) / dayLow * 100 : 0;
  const currentMa = average(candles.slice(candles.length - spec.maPeriod).map(item => item.close));
  const twoBarsAgoMa = average(
    candles.slice(candles.length - spec.maPeriod - 2, candles.length - 2).map(item => item.close),
  );
  const maSlope2Pct = twoBarsAgoMa > 0 ? (currentMa - twoBarsAgoMa) / twoBarsAgoMa * 100 : 0;
  const averageVolume = average(previousTwenty.map(item => item.volume));
  const volumeRatio = averageVolume > 0 ? candle.volume / averageVolume : 0;
  const eligible = dayLowDropPct <= spec.maxDayLowDropPct
    && reboundFromDayLowPct >= spec.minReboundFromDayLowPct
    && candle.close > recentHigh
    && candle.close > candle.open
    && maSlope2Pct >= spec.minMaSlope2Pct
    && volumeRatio >= spec.minVolumeRatio;
  return {
    dayLow,
    recentHigh,
    dayLowDropPct,
    reboundFromDayLowPct,
    maSlope2Pct,
    volumeRatio,
    eligible,
  };
}

export function calculateFujikuraBoardMetrics(board: unknown): FujikuraBoardMetrics {
  if (!board || typeof board !== "object") return { buyPressureRatio: null, executablePrice: null };
  const raw = board as {
    currentPrice?: unknown;
    asks?: Array<{ qty?: unknown }>;
    bids?: Array<{ qty?: unknown }>;
    overSellQty?: unknown;
    underBuyQty?: unknown;
  };
  const executablePrice = Number(raw.currentPrice);
  const askQty = (Array.isArray(raw.asks) ? raw.asks : [])
    .reduce((sum, item) => sum + Math.max(0, Number(item.qty) || 0), 0) + Math.max(0, Number(raw.overSellQty) || 0);
  const bidQty = (Array.isArray(raw.bids) ? raw.bids : [])
    .reduce((sum, item) => sum + Math.max(0, Number(item.qty) || 0), 0) + Math.max(0, Number(raw.underBuyQty) || 0);
  return {
    buyPressureRatio: askQty > 0 ? Math.round((bidQty / askQty) * 100) / 100 : null,
    executablePrice: Number.isFinite(executablePrice) && executablePrice > 0 ? executablePrice : null,
  };
}

export function confirmFujikuraPending(input: {
  triggerClose: number;
  confirmationCandle: FujikuraForwardCandle;
  board: unknown;
}): {
  accepted: boolean;
  reason: string;
  buyPressureRatio: number | null;
  executablePrice: number | null;
} {
  const boardMetrics = calculateFujikuraBoardMetrics(input.board);
  const candle = input.confirmationCandle;
  if (!(candle.close > input.triggerClose && candle.close > candle.open)) {
    return { accepted: false, reason: "confirmation_failed", ...boardMetrics };
  }
  if (boardMetrics.buyPressureRatio === null) {
    return { accepted: false, reason: "board_unavailable", ...boardMetrics };
  }
  if (boardMetrics.buyPressureRatio <= FUJIKURA_FORWARD_SHADOW_SPEC.entry.bprFloorExclusive) {
    return { accepted: false, reason: "bpr_extreme_sell_pressure", ...boardMetrics };
  }
  if (boardMetrics.buyPressureRatio > FUJIKURA_FORWARD_SHADOW_SPEC.entry.bprMaxInclusive) {
    return { accepted: false, reason: "bpr_above_0_70", ...boardMetrics };
  }
  if (boardMetrics.executablePrice === null) {
    return { accepted: false, reason: "executable_price_unavailable", ...boardMetrics };
  }
  return { accepted: true, reason: "confirmed", ...boardMetrics };
}
