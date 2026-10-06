import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { calculateClockSafeBoardAge, calculateDepthVwap } from "./telExecutableConfirmDepth";

export const BOLLINGER_DIRECTIONAL_COLLECTION_START_DATE = "2026-10-07";
export const BOLLINGER_DIRECTIONAL_LEARNING_CUTOFF_DATE = "2026-10-06";
export const BOLLINGER_DIRECTIONAL_FORMAL_START_DATE = "2026-10-07";
export const BOLLINGER_DIRECTIONAL_PERIOD = 20;
export const BOLLINGER_DIRECTIONAL_SIGMA = 2;
export const BOLLINGER_DIRECTIONAL_STOP_PCT = 1.4;
export const BOLLINGER_DIRECTIONAL_STOP_COOLDOWN_MINUTES = 30;
export const BOLLINGER_DIRECTIONAL_MAX_BOARD_AGE_MS = 5_000;
export const BOLLINGER_DIRECTIONAL_ENTRY_START = "09:20";
export const BOLLINGER_DIRECTIONAL_ENTRY_END = "14:57";
export const BOLLINGER_DIRECTIONAL_DAY_END = "15:20";

export type BollingerDirectionalVariant =
  | "fixed_stop_140_cooldown_30"
  | "fixed_stop_140_cooldown_30_sma20_gap060"
  | "fixed_stop_140_cooldown_30_sma10_slope_gap050";
export type BollingerDirectionalSide = "long" | "short";
export type BollingerDirectionalResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

export interface BollingerDirectionalVariantConfig {
  movingAverageTimeframeMinutes: 5 | null;
  movingAveragePeriod: 10 | 20 | null;
  requireDirectionalSlope: boolean;
  minimumTargetDistancePct: number;
}

export interface BollingerDirectionalMovingAverageSnapshot {
  timeframeMinutes: 5;
  period: 10 | 20;
  value: number;
  previousValue: number;
  slope: number;
  completedBars: number;
}

export function bollingerDirectionalVariantConfig(variant: BollingerDirectionalVariant): BollingerDirectionalVariantConfig {
  if (variant === "fixed_stop_140_cooldown_30_sma20_gap060") {
    return { movingAverageTimeframeMinutes: 5, movingAveragePeriod: 20, requireDirectionalSlope: false, minimumTargetDistancePct: 0.6 };
  }
  if (variant === "fixed_stop_140_cooldown_30_sma10_slope_gap050") {
    return { movingAverageTimeframeMinutes: 5, movingAveragePeriod: 10, requireDirectionalSlope: true, minimumTargetDistancePct: 0.5 };
  }
  return { movingAverageTimeframeMinutes: null, movingAveragePeriod: null, requireDirectionalSlope: false, minimumTargetDistancePct: 0 };
}

export interface BollingerDirectionalPlan {
  tradeDate: string;
  sourceSnapshotId: string | null;
  sourceQuality: "verified" | "degraded" | "invalid" | "missing";
  regimeState: string;
  confidence: string;
  direction: BollingerDirectionalSide | "wait";
  reasonCodes: string[];
}

export interface BollingerDirectionalCandle {
  sourceEventId: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BollingerBandSnapshot {
  middle: number;
  upper: number;
  lower: number;
  standardDeviation: number;
  inputCount: number;
}

export interface BollingerDirectionalPending {
  side: BollingerDirectionalSide;
  touchSourceEventId: string;
  touchTime: string;
  touchPrice: number;
  touchBand: number;
  bands: BollingerBandSnapshot;
  movingAverage: BollingerDirectionalMovingAverageSnapshot | null;
}

export interface BollingerDirectionalPosition {
  side: BollingerDirectionalSide;
  touchSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  initialTargetPrice: number;
  stopPrice: number | null;
  shares: number;
  slPct: number;
  tpPct: number;
  comparisonRiskPct: number;
  executionProxyKind: "ask_depth_vwap_100" | "bid_depth_vwap_100";
  boardAgeMs: number;
  minimumTargetDistancePct: number;
  targetDistancePct: number;
}

export interface BollingerDirectionalState {
  version: 2;
  tradeDate: string;
  plan: BollingerDirectionalPlan;
  variant: BollingerDirectionalVariant;
  candles: BollingerDirectionalCandle[];
  pending: BollingerDirectionalPending | null;
  position: BollingerDirectionalPosition | null;
  completedTrades: number;
  entryBlockedUntilMinute: number | null;
  lastSourceEventId: string | null;
  lastResultType: BollingerDirectionalResultType | null;
  lastActions: Array<Record<string, unknown>>;
}

export interface BollingerDirectionalTransition {
  nextState: BollingerDirectionalState;
  resultType: BollingerDirectionalResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: BollingerDirectionalPosition | null;
  closedPosition: {
    position: BollingerDirectionalPosition;
    exitPrice: number;
    exitReason: string;
    pnl: number;
    pnlAfterAdverseExit: number;
    /** 固定1.40%損切りを1Rとして表示する。 */
    realizedR: number;
  } | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function directionFromPremarketRegime(regimeState: string): BollingerDirectionalPlan["direction"] {
  if (regimeState === "strong_up" || regimeState === "up") return "long";
  if (regimeState === "strong_down" || regimeState === "down") return "short";
  return "wait";
}

export function buildBollingerDirectionalPlan(input: {
  tradeDate: string;
  snapshot: unknown | null;
}): BollingerDirectionalPlan {
  const snapshot = object(input.snapshot);
  const sourceSnapshotId = typeof snapshot.sourceSnapshotId === "string" ? snapshot.sourceSnapshotId : null;
  const sourceQuality = snapshot.qualityStatus === "verified" || snapshot.qualityStatus === "degraded" || snapshot.qualityStatus === "invalid"
    ? snapshot.qualityStatus
    : "missing";
  const regimeState = typeof snapshot.regimeState === "string" ? snapshot.regimeState : "unavailable";
  const confidence = typeof snapshot.confidence === "string" ? snapshot.confidence : "unavailable";
  const usable = sourceQuality === "verified" || sourceQuality === "degraded";
  const direction = usable ? directionFromPremarketRegime(regimeState) : "wait";
  return {
    tradeDate: input.tradeDate,
    sourceSnapshotId,
    sourceQuality,
    regimeState,
    confidence,
    direction,
    reasonCodes: !sourceSnapshotId
      ? ["premarket_1_to_3_snapshot_missing"]
      : !usable
        ? ["premarket_1_to_3_snapshot_not_usable"]
        : direction === "wait"
          ? ["premarket_1_to_3_direction_mixed_or_unavailable"]
          : ["premarket_1_to_3_direction_frozen"],
  };
}

export function createEmptyBollingerDirectionalState(
  plan: BollingerDirectionalPlan,
  variant: BollingerDirectionalVariant,
): BollingerDirectionalState {
  return {
    version: 2,
    tradeDate: plan.tradeDate,
    plan,
    variant,
    candles: [],
    pending: null,
    position: null,
    completedTrades: 0,
    entryBlockedUntilMinute: null,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function normalizeBollingerDirectionalState(
  value: unknown,
  plan: BollingerDirectionalPlan,
  variant: BollingerDirectionalVariant,
): BollingerDirectionalState {
  const raw = object(value);
  if (raw.tradeDate !== plan.tradeDate || raw.variant !== variant) return createEmptyBollingerDirectionalState(plan, variant);
  return {
    version: 2,
    tradeDate: plan.tradeDate,
    plan: object(raw.plan).tradeDate === plan.tradeDate ? raw.plan as unknown as BollingerDirectionalPlan : plan,
    variant,
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-128) as BollingerDirectionalCandle[] : [],
    pending: raw.pending && typeof raw.pending === "object" ? raw.pending as BollingerDirectionalPending : null,
    position: raw.position && typeof raw.position === "object" ? raw.position as BollingerDirectionalPosition : null,
    completedTrades: Number.isInteger(raw.completedTrades) ? Number(raw.completedTrades) : 0,
    entryBlockedUntilMinute: Number.isInteger(raw.entryBlockedUntilMinute) ? Number(raw.entryBlockedUntilMinute) : null,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: typeof raw.lastResultType === "string" ? raw.lastResultType as BollingerDirectionalResultType : null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions as Array<Record<string, unknown>> : [],
  };
}

export function calculateBollingerBands(candles: BollingerDirectionalCandle[]): BollingerBandSnapshot | null {
  const closes = candles.slice(-BOLLINGER_DIRECTIONAL_PERIOD).map(candle => candle.close);
  if (closes.length !== BOLLINGER_DIRECTIONAL_PERIOD || closes.some(value => !Number.isFinite(value))) return null;
  const middle = closes.reduce((sum, value) => sum + value, 0) / closes.length;
  const variance = closes.reduce((sum, value) => sum + (value - middle) ** 2, 0) / closes.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    middle,
    upper: middle + BOLLINGER_DIRECTIONAL_SIGMA * standardDeviation,
    lower: middle - BOLLINGER_DIRECTIONAL_SIGMA * standardDeviation,
    standardDeviation,
    inputCount: closes.length,
  };
}

function inEntryWindow(candleTime: string) {
  return candleTime >= BOLLINGER_DIRECTIONAL_ENTRY_START && candleTime <= BOLLINGER_DIRECTIONAL_ENTRY_END;
}

function minuteOfDay(candleTime: string) {
  const [hour, minute] = candleTime.split(":").map(Number);
  return hour * 60 + minute;
}

function completedFiveMinuteCloses(candles: BollingerDirectionalCandle[], currentTime: string): number[] {
  const currentMinute = minuteOfDay(currentTime);
  const buckets = new Map<number, number>();
  for (const candle of candles) {
    const minute = minuteOfDay(candle.candleTime);
    const sessionStart = minute < 12 * 60 ? 9 * 60 : 12 * 60 + 30;
    if (minute < sessionStart) continue;
    const bucketStart = sessionStart + Math.floor((minute - sessionStart) / 5) * 5;
    const bucketEnd = bucketStart + 4;
    if (bucketEnd > currentMinute) continue;
    buckets.set(bucketStart, candle.close);
  }
  return Array.from(buckets.entries()).sort(([left], [right]) => left - right).map(([, close]) => close);
}

export function calculateBollingerDirectionalMovingAverage(
  candles: BollingerDirectionalCandle[],
  currentTime: string,
  period: 10 | 20,
  requirePrevious = true,
): BollingerDirectionalMovingAverageSnapshot | null {
  const closes = completedFiveMinuteCloses(candles, currentTime);
  if (closes.length < period + (requirePrevious ? 1 : 0)) return null;
  const current = closes.slice(-period).reduce((sum, value) => sum + value, 0) / period;
  const previous = closes.length >= period + 1
    ? closes.slice(-(period + 1), -1).reduce((sum, value) => sum + value, 0) / period
    : current;
  return {
    timeframeMinutes: 5,
    period,
    value: current,
    previousValue: previous,
    slope: current - previous,
    completedBars: closes.length,
  };
}

function movingAverageAllowsTouch(
  variant: BollingerDirectionalVariant,
  side: BollingerDirectionalSide,
  current: BollingerDirectionalCandle,
  candlesIncludingCurrent: BollingerDirectionalCandle[],
) {
  const config = bollingerDirectionalVariantConfig(variant);
  if (config.movingAveragePeriod === null) return { allowed: true, snapshot: null, reason: null };
  const snapshot = calculateBollingerDirectionalMovingAverage(
    candlesIncludingCurrent,
    current.candleTime,
    config.movingAveragePeriod,
    config.requireDirectionalSlope,
  );
  if (!snapshot) return { allowed: false, snapshot: null, reason: "five_minute_sma_unavailable" };
  const priceAligned = side === "long" ? current.close > snapshot.value : current.close < snapshot.value;
  if (!priceAligned) return { allowed: false, snapshot, reason: side === "long" ? "touch_close_not_above_sma" : "touch_close_not_below_sma" };
  const slopeAligned = !config.requireDirectionalSlope || (side === "long" ? snapshot.slope > 0 : snapshot.slope < 0);
  if (!slopeAligned) return { allowed: false, snapshot, reason: side === "long" ? "sma_slope_not_rising" : "sma_slope_not_falling" };
  return { allowed: true, snapshot, reason: null };
}

function sharesForMode(mode: ForwardEvaluationMode, price: number) {
  if (mode === "signal_quality") return 100;
  return Math.max(100, Math.floor(Math.floor(3_000_000 * 0.9 / price) / 100) * 100);
}

function entryFromConfirmedCandle(
  state: BollingerDirectionalState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
  actions: Array<Record<string, unknown>>,
): BollingerDirectionalPosition | null {
  const pending = state.pending;
  if (!pending) return null;
  state.pending = null;
  const candle = input.candle;
  const confirmation = pending.side === "long" ? candle.close > candle.open : candle.close < candle.open;
  if (!confirmation) {
    actions.push({
      type: "entry_rejected",
      routeId: `bollinger_directional_${state.variant}_${pending.side}`,
      side: pending.side,
      reason: pending.side === "long" ? "next_candle_not_bullish" : "next_candle_not_bearish",
      touchSourceEventId: pending.touchSourceEventId,
      confirmationSourceEventId: input.sourceEventId,
    });
    return null;
  }
  const clockAge = calculateClockSafeBoardAge(input.currentAudit);
  const depth = calculateDepthVwap({ board: input.board, side: pending.side, shares: 100 });
  const entryPrice = depth?.price ?? null;
  const targetBands = calculateBollingerBands(state.candles);
  const targetPrice = targetBands ? (pending.side === "long" ? targetBands.upper : targetBands.lower) : null;
  const targetBeyondEntry = entryPrice !== null && targetPrice !== null
    && (pending.side === "long" ? targetPrice > entryPrice : targetPrice < entryPrice);
  const variantConfig = bollingerDirectionalVariantConfig(state.variant);
  const targetDistancePct = entryPrice !== null && targetPrice !== null
    ? Math.abs(targetPrice - entryPrice) / entryPrice * 100
    : null;
  const targetDistanceAccepted = targetDistancePct !== null
    && targetDistancePct + 1e-12 >= variantConfig.minimumTargetDistancePct;
  const accepted = clockAge.timestampsAvailable && clockAge.causal && clockAge.fresh
    && clockAge.boardAgeMs !== null && clockAge.boardAgeMs <= BOLLINGER_DIRECTIONAL_MAX_BOARD_AGE_MS
    && entryPrice !== null && targetPrice !== null && targetBeyondEntry && targetDistanceAccepted;
  if (!accepted || entryPrice === null || targetPrice === null || targetDistancePct === null || clockAge.boardAgeMs === null) {
    actions.push({
      type: "entry_rejected",
      routeId: `bollinger_directional_${state.variant}_${pending.side}`,
      side: pending.side,
      reason: !clockAge.timestampsAvailable ? "board_timestamps_unavailable"
        : !clockAge.causal ? "board_clock_not_causal"
          : !clockAge.fresh || (clockAge.boardAgeMs !== null && clockAge.boardAgeMs > BOLLINGER_DIRECTIONAL_MAX_BOARD_AGE_MS) ? "board_stale_over_5000ms"
            : entryPrice === null ? "insufficient_directional_depth_100_shares"
              : targetPrice === null ? "bollinger_target_unavailable"
                : !targetBeyondEntry ? "opposite_band_not_beyond_entry"
                  : "minimum_fixed_target_distance_not_met",
      touchSourceEventId: pending.touchSourceEventId,
      confirmationSourceEventId: input.sourceEventId,
      executableEntryPrice: entryPrice,
      fixedTargetPrice: targetPrice,
      targetDistancePct,
      minimumTargetDistancePct: variantConfig.minimumTargetDistancePct,
      boardAgeMs: clockAge.boardAgeMs,
    });
    return null;
  }
  const stopPrice = pending.side === "long"
    ? entryPrice * (1 - BOLLINGER_DIRECTIONAL_STOP_PCT / 100)
    : entryPrice * (1 + BOLLINGER_DIRECTIONAL_STOP_PCT / 100);
  const position: BollingerDirectionalPosition = {
    side: pending.side,
    touchSourceEventId: pending.touchSourceEventId,
    entrySourceEventId: input.sourceEventId,
    signalTime: pending.touchTime,
    entryTime: candle.candleTime,
    theoreticalSignalPrice: candle.close,
    entryPrice,
    initialTargetPrice: targetPrice,
    stopPrice,
    shares: sharesForMode(mode, entryPrice),
    slPct: BOLLINGER_DIRECTIONAL_STOP_PCT,
    tpPct: Math.abs(targetPrice - entryPrice) / entryPrice * 100,
    comparisonRiskPct: BOLLINGER_DIRECTIONAL_STOP_PCT,
    executionProxyKind: pending.side === "long" ? "ask_depth_vwap_100" : "bid_depth_vwap_100",
    boardAgeMs: clockAge.boardAgeMs,
    minimumTargetDistancePct: variantConfig.minimumTargetDistancePct,
    targetDistancePct,
  };
  actions.push({
    type: "entry",
    routeId: `bollinger_directional_${state.variant}_${pending.side}`,
    side: position.side,
    touchSourceEventId: pending.touchSourceEventId,
    confirmationSourceEventId: input.sourceEventId,
    executableEntryPrice: entryPrice,
    stopPrice,
    fixedTargetPrice: targetPrice,
    targetDistancePct,
    minimumTargetDistancePct: variantConfig.minimumTargetDistancePct,
    movingAverage: pending.movingAverage,
    shares: position.shares,
    depth,
  });
  return position;
}

function closePosition(state: BollingerDirectionalState, input: ForwardSourceEventInput) {
  const position = state.position;
  if (!position) return null;
  const candle = input.candle;
  const targetPrice = position.initialTargetPrice;
  let exitPrice: number | null = null;
  let exitReason: string | null = null;
  if (position.side === "long") {
    if (position.stopPrice !== null && candle.open <= position.stopPrice) { exitPrice = candle.open; exitReason = "fixed_stop_140_gap"; }
    else if (position.stopPrice !== null && candle.low <= position.stopPrice) { exitPrice = position.stopPrice; exitReason = "fixed_stop_140"; }
    else if (candle.open >= targetPrice) { exitPrice = candle.open; exitReason = "fixed_entry_upper_band_gap"; }
    else if (candle.high >= targetPrice) { exitPrice = targetPrice; exitReason = "fixed_entry_upper_band"; }
  } else {
    if (position.stopPrice !== null && candle.open >= position.stopPrice) { exitPrice = candle.open; exitReason = "fixed_stop_140_gap"; }
    else if (position.stopPrice !== null && candle.high >= position.stopPrice) { exitPrice = position.stopPrice; exitReason = "fixed_stop_140"; }
    else if (candle.open <= targetPrice) { exitPrice = candle.open; exitReason = "fixed_entry_lower_band_gap"; }
    else if (candle.low <= targetPrice) { exitPrice = targetPrice; exitReason = "fixed_entry_lower_band"; }
  }
  if (exitPrice === null && candle.candleTime >= BOLLINGER_DIRECTIONAL_DAY_END) {
    exitPrice = candle.close;
    exitReason = "day_end_flatten";
  }
  if (exitPrice === null || exitReason === null) return null;
  const direction = position.side === "long" ? 1 : -1;
  const pnl = Math.round((exitPrice - position.entryPrice) * direction * position.shares);
  const adverseExit = position.side === "long" ? exitPrice * 0.999 : exitPrice * 1.001;
  const pnlAfterAdverseExit = Math.round((adverseExit - position.entryPrice) * direction * position.shares);
  const comparisonRisk = position.entryPrice * position.shares * (position.comparisonRiskPct / 100);
  return {
    position,
    exitPrice,
    exitReason,
    pnl,
    pnlAfterAdverseExit,
    realizedR: comparisonRisk > 0 ? pnl / comparisonRisk : 0,
    fixedTargetPrice: targetPrice,
  };
}

export function applyBollingerDirectionalTransition(
  previous: BollingerDirectionalState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): BollingerDirectionalTransition {
  const state: BollingerDirectionalState = {
    ...previous,
    candles: [...previous.candles],
    pending: previous.pending ? { ...previous.pending, bands: { ...previous.pending.bands } } : null,
    position: previous.position ? { ...previous.position } : null,
    lastActions: [],
  };
  const actions: Array<Record<string, unknown>> = [];
  let openedPosition: BollingerDirectionalPosition | null = null;
  let closedPosition: BollingerDirectionalTransition["closedPosition"] = null;
  let resultType: BollingerDirectionalResultType = "no_signal";

  if (state.position) {
    const closed = closePosition(state, input);
    if (closed) {
      closedPosition = closed;
      if (closed.exitReason.startsWith("fixed_stop_140")) {
        state.entryBlockedUntilMinute = minuteOfDay(input.candle.candleTime) + BOLLINGER_DIRECTIONAL_STOP_COOLDOWN_MINUTES;
      }
      actions.push({
        type: "exit",
        routeId: `bollinger_directional_${state.variant}_${closed.position.side}`,
        side: closed.position.side,
        exitPrice: closed.exitPrice,
        exitReason: closed.exitReason,
        fixedTargetPrice: closed.fixedTargetPrice,
        pnl: closed.pnl,
        comparisonRiskPct: BOLLINGER_DIRECTIONAL_STOP_PCT,
        entryBlockedUntilMinute: state.entryBlockedUntilMinute,
      });
      state.position = null;
      state.completedTrades += 1;
      resultType = "exit";
    } else {
      resultType = "hold";
    }
  } else if (state.pending) {
    openedPosition = entryFromConfirmedCandle(state, input, mode, actions);
    if (openedPosition) {
      state.position = openedPosition;
      resultType = "entry";
    } else {
      resultType = "rejected";
    }
  }

  const bandsBeforeCurrent = calculateBollingerBands(state.candles);
  const current: BollingerDirectionalCandle = {
    sourceEventId: input.sourceEventId,
    candleTime: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  };
  state.candles.push(current);
  state.candles = state.candles.slice(-128);

  // exit足から即座に再entry候補を作らず、次の1分足から再探索する。
  if (!state.position && !state.pending && resultType !== "exit" && inEntryWindow(current.candleTime)) {
    const currentMinute = minuteOfDay(current.candleTime);
    if (state.entryBlockedUntilMinute !== null && currentMinute >= state.entryBlockedUntilMinute) {
      actions.push({
        type: "entry_cooldown_expired",
        expiredAtMinute: state.entryBlockedUntilMinute,
        currentMinute,
      });
      state.entryBlockedUntilMinute = null;
    }
    if (state.entryBlockedUntilMinute !== null && currentMinute < state.entryBlockedUntilMinute) {
      actions.push({
        type: "entry_cooldown_active",
        reason: "same_symbol_30_minutes_after_fixed_stop",
        currentMinute,
        entryBlockedUntilMinute: state.entryBlockedUntilMinute,
      });
    } else if (state.plan.direction === "wait") {
      actions.push({ type: "no_trade_plan", reasonCodes: state.plan.reasonCodes, sourceSnapshotId: state.plan.sourceSnapshotId });
    } else if (bandsBeforeCurrent) {
      const touched = state.plan.direction === "long"
        ? current.low <= bandsBeforeCurrent.lower
        : current.high >= bandsBeforeCurrent.upper;
      if (touched) {
        const touchBand = state.plan.direction === "long" ? bandsBeforeCurrent.lower : bandsBeforeCurrent.upper;
        const touchPrice = state.plan.direction === "long" ? current.low : current.high;
        const movingAverageFilter = movingAverageAllowsTouch(state.variant, state.plan.direction, current, state.candles);
        if (!movingAverageFilter.allowed) {
          actions.push({
            type: "entry_filter_rejected",
            routeId: `bollinger_directional_${state.variant}_${state.plan.direction}`,
            side: state.plan.direction,
            reason: movingAverageFilter.reason,
            movingAverage: movingAverageFilter.snapshot,
            touchPrice,
            touchBand,
          });
        } else {
          state.pending = {
            side: state.plan.direction,
            touchSourceEventId: current.sourceEventId,
            touchTime: current.candleTime,
            touchPrice,
            touchBand,
            bands: bandsBeforeCurrent,
            movingAverage: movingAverageFilter.snapshot,
          };
          actions.push({
            type: "signal_pending_next_candle_confirmation",
            routeId: `bollinger_directional_${state.variant}_${state.plan.direction}`,
            side: state.plan.direction,
            touchPrice,
            touchBand,
            bandPeriod: BOLLINGER_DIRECTIONAL_PERIOD,
            sigma: BOLLINGER_DIRECTIONAL_SIGMA,
            sourceSnapshotId: state.plan.sourceSnapshotId,
            regimeState: state.plan.regimeState,
            movingAverage: movingAverageFilter.snapshot,
          });
          resultType = "pending";
        }
      }
    }
  }

  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}
