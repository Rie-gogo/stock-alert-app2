export type ReferenceTechnicalSide = "long" | "short";
export type ReferenceEntryConfirmation =
  | "immediate"
  | "pullback_reclaim"
  | "micro_trend_turn"
  | "pullback_then_micro_trend";

export interface ReferenceTechnicalCandle {
  symbol: string;
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Reference-only D-1 plan.
 *
 * This contract is intentionally separate from the forward-shadow contract:
 * - it never writes trades or strategy state;
 * - it never participates in formal OOS performance;
 * - it uses the next one-minute bar open as the historical execution proxy;
 * - every level must be frozen before the target day is replayed.
 */
export interface FrozenReferenceTechnicalPlan {
  version: "technical-reference-replay-v1";
  symbol: string;
  sourceTradeDate: string;
  targetTradeDate: string;
  side: ReferenceTechnicalSide;
  signalWindow: { start: string; end: string };
  triggerPrice: number;
  stopPrice: number;
  targetPrice: number;
  /** Defaults to the live Technical A guard (1.2R) when omitted. */
  minimumRewardRisk?: number;
  minVolumeRatio: number;
  requireBullishCandle: boolean;
  requireBearishCandle: boolean;
  requireVwapConfirmation: boolean;
  /** Reference-only causal confirmation applied after the first breakout signal. */
  entryConfirmation?: ReferenceEntryConfirmation;
  /** Maximum completed one-minute candles allowed after the first breakout. */
  maxConfirmationBars?: number;
  rationale: string[];
}

export interface ReferenceTechnicalReplayResult {
  status: "no_signal" | "signal_unconfirmed" | "signal_without_next_bar" | "signal_rejected_invalid_levels" | "signal_rejected_reward_risk" | "closed" | "open_at_day_end";
  plan: FrozenReferenceTechnicalPlan;
  signalTime: string | null;
  signalPrice: number | null;
  volumeRatio: number | null;
  vwapAtSignal: number | null;
  confirmationTime: string | null;
  confirmationPrice: number | null;
  entryTime: string | null;
  entryPrice: number | null;
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: "technical_stop" | "technical_target" | "day_end_reference" | null;
  pnlPer100: number | null;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function orderedUniqueCandles(input: ReferenceTechnicalCandle[], plan: FrozenReferenceTechnicalPlan) {
  const byTime = new Map<string, ReferenceTechnicalCandle>();
  for (const candle of input) {
    if (candle.symbol !== plan.symbol || candle.tradeDate !== plan.targetTradeDate) continue;
    if (candle.candleTime > "15:30") continue;
    // The last persisted observation for a minute is the authoritative reference row.
    byTime.set(candle.candleTime, candle);
  }
  return Array.from(byTime.values()).sort((a, b) => a.candleTime.localeCompare(b.candleTime));
}

function targetOrStop(
  candle: ReferenceTechnicalCandle,
  side: ReferenceTechnicalSide,
  stopPrice: number,
  targetPrice: number,
) {
  // Conservative same-bar ordering: stop is evaluated before target.
  if (side === "long") {
    if (candle.open <= stopPrice) return { price: candle.open, reason: "technical_stop" as const };
    if (candle.low <= stopPrice) return { price: stopPrice, reason: "technical_stop" as const };
    if (candle.high >= targetPrice) return { price: targetPrice, reason: "technical_target" as const };
  } else {
    if (candle.open >= stopPrice) return { price: candle.open, reason: "technical_stop" as const };
    if (candle.high >= stopPrice) return { price: stopPrice, reason: "technical_stop" as const };
    if (candle.low <= targetPrice) return { price: targetPrice, reason: "technical_target" as const };
  }
  return null;
}

export function replayFrozenReferenceTechnicalPlan(
  plan: FrozenReferenceTechnicalPlan,
  input: ReferenceTechnicalCandle[],
): ReferenceTechnicalReplayResult {
  const candles = orderedUniqueCandles(input, plan);
  let cumulativeVolume = 0;
  let cumulativePriceVolume = 0;
  let signalIndex = -1;
  let signalVolumeRatio: number | null = null;
  let signalVwap: number | null = null;
  const cumulativeVwap: number[] = [];
  const volumeRatios: number[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    cumulativeVolume += candle.volume;
    cumulativePriceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    if (index < 10 || candle.candleTime < plan.signalWindow.start || candle.candleTime > plan.signalWindow.end) continue;
    const priorVolumes = candles.slice(index - 10, index).map(item => item.volume);
    const typicalVolume = average(priorVolumes);
    const volumeRatio = typicalVolume !== null && typicalVolume > 0 ? candle.volume / typicalVolume : 0;
    const vwap = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : candle.close;
    cumulativeVwap[index] = vwap;
    volumeRatios[index] = volumeRatio;
    const crossed = plan.side === "long" ? candle.close > plan.triggerPrice : candle.close < plan.triggerPrice;
    const candleDirectionOk = (!plan.requireBullishCandle || candle.close > candle.open)
      && (!plan.requireBearishCandle || candle.close < candle.open);
    const vwapOk = !plan.requireVwapConfirmation
      || (plan.side === "long" ? candle.close > vwap : candle.close < vwap);
    if (crossed && candleDirectionOk && vwapOk && volumeRatio >= plan.minVolumeRatio) {
      signalIndex = index;
      signalVolumeRatio = volumeRatio;
      signalVwap = vwap;
      break;
    }
  }

  // Complete the causal VWAP timeline even after the first breakout.  Confirmation
  // may only inspect completed candles up to the candidate confirmation minute.
  if (signalIndex >= 0) {
    for (let index = signalIndex + 1; index < candles.length; index += 1) {
      const candle = candles[index];
      cumulativeVolume += candle.volume;
      cumulativePriceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
      cumulativeVwap[index] = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : candle.close;
      const priorVolumes = candles.slice(Math.max(0, index - 10), index).map(item => item.volume);
      const typicalVolume = average(priorVolumes);
      volumeRatios[index] = typicalVolume !== null && typicalVolume > 0 ? candle.volume / typicalVolume : 0;
    }
  }

  const base = {
    plan,
    signalTime: signalIndex >= 0 ? candles[signalIndex].candleTime : null,
    signalPrice: signalIndex >= 0 ? candles[signalIndex].close : null,
    volumeRatio: signalVolumeRatio,
    vwapAtSignal: signalVwap,
    confirmationTime: null,
    confirmationPrice: null,
  };
  if (signalIndex < 0) {
    return { status: "no_signal", ...base, entryTime: null, entryPrice: null, exitTime: null, exitPrice: null, exitReason: null, pnlPer100: null };
  }
  const confirmationMode = plan.entryConfirmation ?? "immediate";
  const maxConfirmationBars = Math.max(1, plan.maxConfirmationBars ?? 20);
  const triggerBuffer = Math.abs(plan.triggerPrice - plan.stopPrice);
  const directionAndVwapOk = (index: number) => {
    const candle = candles[index];
    const vwap = cumulativeVwap[index] ?? candle.close;
    return plan.side === "long"
      ? candle.close > plan.triggerPrice && candle.close > candle.open && candle.close > vwap
      : candle.close < plan.triggerPrice && candle.close < candle.open && candle.close < vwap;
  };
  const pullbackReclaimed = (index: number) => {
    const candle = candles[index];
    if (!directionAndVwapOk(index)) return false;
    return plan.side === "long"
      ? candle.low <= plan.triggerPrice + triggerBuffer && candle.low > plan.stopPrice
      : candle.high >= plan.triggerPrice - triggerBuffer && candle.high < plan.stopPrice;
  };
  const microTrendTurned = (index: number) => {
    if (index < 3 || !directionAndVwapOk(index)) return false;
    const beforePivot = candles[index - 3];
    const pivot = candles[index - 2];
    const follow = candles[index - 1];
    const current = candles[index];
    return plan.side === "long"
      ? pivot.low <= beforePivot.low
        && follow.low > pivot.low
        && current.close > Math.max(pivot.high, follow.high)
      : pivot.high >= beforePivot.high
        && follow.high < pivot.high
        && current.close < Math.min(pivot.low, follow.low);
  };

  let confirmationIndex = confirmationMode === "immediate" ? signalIndex : -1;
  let pullbackSeen = false;
  const confirmationEnd = Math.min(candles.length - 1, signalIndex + maxConfirmationBars);
  for (let index = signalIndex + 1; confirmationIndex < 0 && index <= confirmationEnd; index += 1) {
    if (candles[index].candleTime > plan.signalWindow.end) break;
    const pullback = pullbackReclaimed(index);
    if (pullback) pullbackSeen = true;
    const trendTurn = microTrendTurned(index);
    if (confirmationMode === "pullback_reclaim" && pullback) confirmationIndex = index;
    else if (confirmationMode === "micro_trend_turn" && trendTurn) confirmationIndex = index;
    else if (confirmationMode === "pullback_then_micro_trend" && pullbackSeen && trendTurn) confirmationIndex = index;
  }
  if (confirmationIndex < 0) {
    return { status: "signal_unconfirmed", ...base, entryTime: null, entryPrice: null, exitTime: null, exitPrice: null, exitReason: null, pnlPer100: null };
  }
  const confirmedBase = {
    ...base,
    confirmationTime: candles[confirmationIndex].candleTime,
    confirmationPrice: candles[confirmationIndex].close,
  };
  const entry = candles[confirmationIndex + 1];
  if (!entry) {
    return { status: "signal_without_next_bar", ...confirmedBase, entryTime: null, entryPrice: null, exitTime: null, exitPrice: null, exitReason: null, pnlPer100: null };
  }
  const entryPrice = entry.open;
  const levelsAreValid = plan.side === "long"
    ? plan.stopPrice < entryPrice && entryPrice < plan.targetPrice
    : plan.targetPrice < entryPrice && entryPrice < plan.stopPrice;
  if (!levelsAreValid) {
    return {
      status: "signal_rejected_invalid_levels", ...confirmedBase,
      entryTime: entry.candleTime, entryPrice,
      exitTime: null, exitPrice: null, exitReason: null, pnlPer100: null,
    };
  }
  const risk = plan.side === "long" ? entryPrice - plan.stopPrice : plan.stopPrice - entryPrice;
  const reward = plan.side === "long" ? plan.targetPrice - entryPrice : entryPrice - plan.targetPrice;
  const minimumRewardRisk = plan.minimumRewardRisk ?? 1.2;
  if (risk <= 0 || reward / risk < minimumRewardRisk) {
    return {
      status: "signal_rejected_reward_risk", ...confirmedBase,
      entryTime: entry.candleTime, entryPrice,
      exitTime: null, exitPrice: null, exitReason: null, pnlPer100: null,
    };
  }
  for (let index = confirmationIndex + 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const closed = targetOrStop(candle, plan.side, plan.stopPrice, plan.targetPrice);
    if (!closed) continue;
    const direction = plan.side === "long" ? 1 : -1;
    return {
      status: "closed", ...confirmedBase,
      entryTime: entry.candleTime, entryPrice,
      exitTime: candle.candleTime, exitPrice: closed.price, exitReason: closed.reason,
      pnlPer100: Math.round((closed.price - entryPrice) * direction * 100),
    };
  }
  const last = candles.at(-1)!;
  const direction = plan.side === "long" ? 1 : -1;
  return {
    status: "open_at_day_end", ...confirmedBase,
    entryTime: entry.candleTime, entryPrice,
    exitTime: last.candleTime, exitPrice: last.close, exitReason: "day_end_reference",
    pnlPer100: Math.round((last.close - entryPrice) * direction * 100),
  };
}
