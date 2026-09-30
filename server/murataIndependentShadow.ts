import type { RelayCandleProvenance } from "./relayProvenance";
import type { ForwardSourceEventInput } from "./forwardShadow";
import { calculateClockSafeBoardAge, calculateDepthVwap } from "./telExecutableConfirmDepth";

export const MURATA_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-30";
export const MURATA_FORWARD_COLLECTION_START_DATE = "2026-10-01";
export const MURATA_FORWARD_FORMAL_START_DATE = "2026-10-01";

export type MurataIndependentVariant = "deep_reversal_long" | "morning_breakdown_short";
export type MurataIndependentResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";
export type MurataIndependentSide = "long" | "short";

type MurataCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Pending = {
  phase: "await_confirmation" | "await_execution";
  signalSourceEventId: string;
  signalTime: string;
  triggerClose: number;
  confirmationTime?: string;
  metrics: Record<string, number | boolean>;
};

type Position = {
  side: MurataIndependentSide;
  signalSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  executableDepthVwap: number;
  entryPrice: number;
  shares: 100;
  slPct: number;
  tpPct: number;
};

export type MurataIndependentShadowState = {
  version: 1;
  variant: MurataIndependentVariant;
  tradeDate: string;
  candles: MurataCandle[];
  pending: Pending | null;
  position: Position | null;
  dailySlotConsumed: boolean;
  dayUnresolved: boolean;
  lastSourceEventId: string | null;
  lastResultType: MurataIndependentResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type MurataIndependentClosedPosition = {
  position: Position;
  exitPriceBeforeAdverseFriction: number;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "time_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type MurataIndependentTransition = {
  nextState: MurataIndependentShadowState;
  resultType: MurataIndependentResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: Position | null;
  closedPosition: MurataIndependentClosedPosition | null;
};

export const MURATA_INDEPENDENT_SHADOW_SPECS = Object.freeze({
  deep_reversal_long: Object.freeze({
    symbol: "6981",
    routeId: "murataDeepReversalLong",
    canonicalLogic: "candidate-6981-deep-reversal-long",
    title: "6981 私案A・深い下落後の確認型反発LONG",
    side: "long" as const,
    entry: Object.freeze({
      startTime: "09:45",
      endTime: "11:29",
      minimumWarmupBars: 21,
      maxDayLowFromOpenPct: -2.0,
      minReboundFromDayLowPct: 1.0,
      highLookback: 5,
      maPeriod: 8,
      minMaSlope2Pct: 0.01,
      volumeLookback: 20,
      minVolumeRatio: 0.6,
      confirmation: "next_candle_bullish_and_close_above_trigger",
      execution: "strict_next_source_event_ask_depth_vwap_100_after_confirmation",
      boardFilter: false,
    }),
    exit: Object.freeze({
      slPct: 0.4,
      tpPct: 0.8,
      maxHoldingMinutes: 10,
      sameBarPriority: ["stop_loss", "take_profit", "time_exit"] as const,
    }),
  }),
  morning_breakdown_short: Object.freeze({
    symbol: "6981",
    routeId: "murataMorning20BarBreakdownShort",
    canonicalLogic: "candidate-6981-morning-20bar-breakdown-short",
    title: "6981 私案B・前場20本安値更新の確認型SHORT",
    side: "short" as const,
    entry: Object.freeze({
      startTime: "09:55",
      endTime: "10:45",
      minimumWarmupBars: 21,
      maxCloseFromOpenPct: -1.0,
      lowLookback: 20,
      maPeriod: 8,
      maxMaSlope2Pct: -0.01,
      volumeLookback: 20,
      minVolumeRatio: 0.6,
      shockRangePct: 0.8,
      shockVolumeRatio: 2.0,
      confirmation: "next_candle_bearish_and_close_below_trigger",
      execution: "strict_next_source_event_bid_depth_vwap_100_after_confirmation",
      boardFilter: false,
    }),
    exit: Object.freeze({
      slPct: 0.8,
      tpPct: 2.4,
      maxHoldingMinutes: 30,
      sameBarPriority: ["stop_loss", "take_profit", "time_exit"] as const,
    }),
  }),
  dryRunOnly: true,
  automaticSelection: false,
  automaticAdoption: false,
  orderInstructionConnection: false,
  shares: 100,
  adverseEntryPct: 0.1,
  adverseExitPct: 0.1,
  historicalSelectionStatus: "unresolved_no_strict_complete_day" as const,
});

function specFor(variant: MurataIndependentVariant) {
  return MURATA_INDEPENDENT_SHADOW_SPECS[variant];
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function minuteOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function minuteGap(from: string, to: string): number {
  return minuteOf(to) - minuteOf(from);
}

function isMorningTradableLabel(time: string): boolean {
  return time >= "09:00" && time <= "11:29";
}

function hasStrictProvenance(input: ForwardSourceEventInput): boolean {
  const provenance = (input.candle as typeof input.candle & { provenance?: RelayCandleProvenance | null }).provenance;
  return provenance?.valueSource === "ws_aggregated"
    && provenance.rawCandleTime === input.candle.candleTime
    && typeof provenance.barStartJst === "string"
    && typeof provenance.barEndJst === "string"
    && provenance.isNoTrade === false
    && provenance.clockHealth?.timezone === "JST"
    && provenance.clockHealth?.monotonicAnomaly !== true;
}

function emptyState(variant: MurataIndependentVariant): MurataIndependentShadowState {
  return {
    version: 1,
    variant,
    tradeDate: "",
    candles: [],
    pending: null,
    position: null,
    dailySlotConsumed: false,
    dayUnresolved: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function createEmptyMurataIndependentShadowState(variant: MurataIndependentVariant): MurataIndependentShadowState {
  return emptyState(variant);
}

export function normalizeMurataIndependentShadowState(
  value: unknown,
  variant: MurataIndependentVariant,
  tradeDate?: string,
): MurataIndependentShadowState {
  const raw = value && typeof value === "object" ? value as Partial<MurataIndependentShadowState> : {};
  let state: MurataIndependentShadowState = {
    version: 1,
    variant,
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-180) : [],
    pending: raw.pending ?? null,
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    dayUnresolved: raw.dayUnresolved === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
  if (tradeDate && state.tradeDate !== tradeDate) {
    state = emptyState(variant);
    state.tradeDate = tradeDate;
  }
  return state;
}

function appendCandle(state: MurataIndependentShadowState, input: ForwardSourceEventInput): "ok" | "time_gap" {
  const prior = state.candles.at(-1);
  if (prior && minuteGap(prior.time, input.candle.candleTime) !== 1) return "time_gap";
  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-180);
  return "ok";
}

function calculateMetrics(variant: MurataIndependentVariant, candles: MurataCandle[]) {
  const spec = specFor(variant).entry;
  if (candles.length < spec.minimumWarmupBars) return null;
  const candle = candles.at(-1)!;
  const dayOpen = candles[0]!.open;
  const dayLow = Math.min(...candles.map(item => item.low));
  const maNow = average(candles.slice(-spec.maPeriod).map(item => item.close));
  const maTwoBarsAgo = average(candles.slice(-spec.maPeriod - 2, -2).map(item => item.close));
  const maSlope2Pct = maTwoBarsAgo > 0 ? (maNow / maTwoBarsAgo - 1) * 100 : 0;
  const volumeLookback = "volumeLookback" in spec ? spec.volumeLookback : 20;
  const averageVolume = average(candles.slice(-1 - volumeLookback, -1).map(item => item.volume));
  const volumeRatio = averageVolume > 0 ? candle.volume / averageVolume : 0;
  const fromOpenPct = dayOpen > 0 ? (candle.close / dayOpen - 1) * 100 : 0;
  const reboundFromDayLowPct = dayLow > 0 ? (candle.close / dayLow - 1) * 100 : 0;
  const rangePct = candle.high > 0 ? (candle.high - candle.low) / candle.high * 100 : 0;

  if (variant === "deep_reversal_long") {
    const longSpec = MURATA_INDEPENDENT_SHADOW_SPECS.deep_reversal_long.entry;
    const priorHigh = Math.max(...candles.slice(-1 - longSpec.highLookback, -1).map(item => item.high));
    return {
      eligible: candle.time >= longSpec.startTime && candle.time <= longSpec.endTime
        && (dayLow / dayOpen - 1) * 100 <= longSpec.maxDayLowFromOpenPct
        && reboundFromDayLowPct >= longSpec.minReboundFromDayLowPct
        && candle.close > candle.open
        && candle.close > priorHigh
        && maSlope2Pct >= longSpec.minMaSlope2Pct
        && volumeRatio >= longSpec.minVolumeRatio,
      dayLow,
      fromOpenPct,
      reboundFromDayLowPct,
      priorHigh,
      maSlope2Pct,
      volumeRatio,
    };
  }

  const shortSpec = MURATA_INDEPENDENT_SHADOW_SPECS.morning_breakdown_short.entry;
  const priorLow = Math.min(...candles.slice(-1 - shortSpec.lowLookback, -1).map(item => item.low));
  const shock = rangePct >= shortSpec.shockRangePct && volumeRatio >= shortSpec.shockVolumeRatio;
  return {
    eligible: candle.time >= shortSpec.startTime && candle.time <= shortSpec.endTime
      && fromOpenPct <= shortSpec.maxCloseFromOpenPct
      && candle.close < candle.open
      && candle.close < priorLow
      && maSlope2Pct <= shortSpec.maxMaSlope2Pct
      && volumeRatio >= shortSpec.minVolumeRatio
      && !shock,
    fromOpenPct,
    priorLow,
    maSlope2Pct,
    volumeRatio,
    rangePct,
    shock,
  };
}

function executePending(variant: MurataIndependentVariant, pending: Pending, input: ForwardSourceEventInput) {
  const side = specFor(variant).side;
  const age = calculateClockSafeBoardAge(input.currentAudit);
  const observed = input.currentAudit?.boardObservedAtMs ?? null;
  const assembled = input.currentAudit?.relayAssembledAtMs ?? null;
  const sourceCausal = observed !== null && assembled !== null && observed <= assembled;
  const depth = calculateDepthVwap({ board: input.board, side, shares: 100 });
  const rawPrice = depth?.price ?? null;
  const adverseEntryPrice = rawPrice === null
    ? null
    : side === "long"
      ? rawPrice * (1 + MURATA_INDEPENDENT_SHADOW_SPECS.adverseEntryPct / 100)
      : rawPrice * (1 - MURATA_INDEPENDENT_SHADOW_SPECS.adverseEntryPct / 100);
  const timely = pending.confirmationTime !== undefined && minuteGap(pending.confirmationTime, input.candle.candleTime) > 0;
  const accepted = timely && age.timestampsAvailable && age.causal && age.fresh && sourceCausal && depth !== null && adverseEntryPrice !== null;
  const reason = accepted
    ? null
    : !timely
      ? "strict_next_source_event_missing_or_noncausal"
      : !age.timestampsAvailable
        ? "board_timestamps_unavailable"
        : !age.causal || !sourceCausal
          ? "board_source_not_causal"
          : !age.fresh
            ? "board_stale_over_5000ms"
            : "insufficient_directional_depth_for_100_shares";
  return { accepted, reason, age, sourceCausal, depth, rawPrice, adverseEntryPrice };
}

function closePosition(position: Position, rawExitPrice: number, exitReason: MurataIndependentClosedPosition["exitReason"]): MurataIndependentClosedPosition {
  const exitPrice = position.side === "long"
    ? rawExitPrice * (1 - MURATA_INDEPENDENT_SHADOW_SPECS.adverseExitPct / 100)
    : rawExitPrice * (1 + MURATA_INDEPENDENT_SHADOW_SPECS.adverseExitPct / 100);
  const pnl = Math.round((position.side === "long" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice) * position.shares);
  const risk = position.entryPrice * position.shares * position.slPct / 100;
  return {
    position: { ...position },
    exitPriceBeforeAdverseFriction: rawExitPrice,
    exitPrice,
    exitReason,
    pnl,
    pnlAfterAdverseExit: pnl,
    realizedR: risk > 0 ? pnl / risk : 0,
  };
}

function calculateExit(variant: MurataIndependentVariant, position: Position, input: ForwardSourceEventInput): MurataIndependentClosedPosition | null {
  const spec = specFor(variant).exit;
  const candle = input.candle;
  if (position.side === "long") {
    const stop = position.entryPrice * (1 - position.slPct / 100);
    const target = position.entryPrice * (1 + position.tpPct / 100);
    if (candle.low <= stop) return closePosition(position, Math.min(candle.open, stop), "stop_loss");
    if (candle.high >= target) return closePosition(position, target, "take_profit");
  } else {
    const stop = position.entryPrice * (1 + position.slPct / 100);
    const target = position.entryPrice * (1 - position.tpPct / 100);
    if (candle.high >= stop) return closePosition(position, Math.max(candle.open, stop), "stop_loss");
    if (candle.low <= target) return closePosition(position, target, "take_profit");
  }
  if (minuteGap(position.entryTime, candle.candleTime) >= spec.maxHoldingMinutes) return closePosition(position, candle.close, "time_exit");
  if (candle.candleTime >= "11:29") return closePosition(position, candle.close, "session_exit");
  return null;
}

function finalize(
  state: MurataIndependentShadowState,
  input: ForwardSourceEventInput,
  resultType: MurataIndependentResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: Position | null,
  closedPosition: MurataIndependentClosedPosition | null,
): MurataIndependentTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

/**
 * A/B共通の副作用なし遷移。provenance/連続性/板が不足する場合は未解決として
 * fail-closedし、終値・後続板・外部値で補完しない。
 */
export function applyMurataIndependentShadowTransition(
  variant: MurataIndependentVariant,
  stateBefore: MurataIndependentShadowState,
  input: ForwardSourceEventInput,
): MurataIndependentTransition {
  const state = normalizeMurataIndependentShadowState(stateBefore, variant, input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: MurataIndependentResultType = "no_signal";
  let openedPosition: Position | null = null;
  let closedPosition: MurataIndependentClosedPosition | null = null;

  if (input.candle.symbol !== "6981") return finalize(state, input, "rejected", [{ type: "non_6981_symbol" }], null, null);
  if (input.candle.tradeDate < MURATA_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{ type: "before_forward_collection_start", collectionStartDate: MURATA_FORWARD_COLLECTION_START_DATE }], null, null);
  }
  if (!isMorningTradableLabel(input.candle.candleTime)) {
    return finalize(state, input, "no_signal", [{ type: "out_of_morning_session_raw_preserved_not_used" }], null, null);
  }
  if (state.dayUnresolved) {
    return finalize(state, input, "rejected", [{ type: "day_already_unresolved", reason: "prior_provenance_or_time_gap" }], null, null);
  }
  if (!hasStrictProvenance(input)) {
    state.dayUnresolved = true;
    state.pending = null;
    actions.push({ type: "unresolved", reason: "relay_provenance_incomplete_or_non_ws_aggregated", candidateMarginEquivalent: "not_applicable_independent_100_share_shadow" });
    return finalize(state, input, "rejected", actions, null, null);
  }
  const append = appendCandle(state, input);
  if (append !== "ok") {
    state.dayUnresolved = true;
    state.pending = null;
    actions.push({ type: "unresolved", reason: "intra_morning_candle_time_gap", candidateMarginEquivalent: "not_applicable_independent_100_share_shadow" });
    return finalize(state, input, "rejected", actions, null, null);
  }

  if (state.position) {
    closedPosition = calculateExit(variant, state.position, input);
    if (closedPosition) {
      state.position = null;
      resultType = "exit";
      actions.push({ type: "exit", reason: closedPosition.exitReason, exitPriceBeforeAdverseFriction: closedPosition.exitPriceBeforeAdverseFriction, exitPrice: closedPosition.exitPrice, pnl: closedPosition.pnl, realizedR: closedPosition.realizedR, sameBarPriority: "stop_loss_before_take_profit" });
      return finalize(state, input, resultType, actions, null, closedPosition);
    }
    return finalize(state, input, "hold", [{ type: "hold" }], null, null);
  }

  if (state.pending?.phase === "await_confirmation") {
    const pending = state.pending;
    state.pending = null;
    const candle = input.candle;
    const confirmed = variant === "deep_reversal_long"
      ? candle.close > candle.open && candle.close > pending.triggerClose
      : candle.close < candle.open && candle.close < pending.triggerClose;
    if (!confirmed) {
      actions.push({ type: "confirmation_rejected", reason: "confirmation_candle_failed", dailySlotConsumed: false, continueSearch: true });
      return finalize(state, input, "rejected", actions, null, null);
    }
    state.pending = { ...pending, phase: "await_execution", confirmationTime: candle.candleTime };
    actions.push({ type: "confirmation_complete_await_strict_next_source_event", confirmationTime: candle.candleTime, dailySlotConsumed: false });
    return finalize(state, input, "pending", actions, null, null);
  }

  if (state.pending?.phase === "await_execution") {
    const pending = state.pending;
    state.pending = null;
    const execution = executePending(variant, pending, input);
    if (!execution.accepted || execution.adverseEntryPrice === null || execution.rawPrice === null) {
      actions.push({ type: "entry_unfillable", reason: execution.reason, dailySlotConsumed: false, candidateMarginEquivalent: "not_applicable_independent_100_share_shadow", boardAgeMs: execution.age.boardAgeMs, sourceCausal: execution.sourceCausal });
      return finalize(state, input, "rejected", actions, null, null);
    }
    const spec = specFor(variant);
    state.position = {
      side: spec.side,
      signalSourceEventId: pending.signalSourceEventId,
      entrySourceEventId: input.sourceEventId,
      signalTime: pending.signalTime,
      entryTime: input.candle.candleTime,
      theoreticalSignalPrice: pending.triggerClose,
      executableDepthVwap: execution.rawPrice,
      entryPrice: execution.adverseEntryPrice,
      shares: 100,
      slPct: spec.exit.slPct,
      tpPct: spec.exit.tpPct,
    };
    openedPosition = { ...state.position };
    state.dailySlotConsumed = true;
    actions.push({ type: "entry", side: spec.side, executableDepthVwap: execution.rawPrice, adverseEntryPrice: execution.adverseEntryPrice, shares: 100, boardAgeMs: execution.age.boardAgeMs, capitalConstraint: "none_independent_shadow" });
    return finalize(state, input, "entry", actions, openedPosition, null);
  }

  if (state.dailySlotConsumed) return finalize(state, input, "no_signal", [{ type: "daily_slot_consumed" }], null, null);
  const metrics = calculateMetrics(variant, state.candles);
  if (metrics?.eligible) {
    state.pending = {
      phase: "await_confirmation",
      signalSourceEventId: input.sourceEventId,
      signalTime: input.candle.candleTime,
      triggerClose: input.candle.close,
      metrics: metrics as unknown as Record<string, number | boolean>,
    };
    actions.push({ type: "signal_candidate", side: specFor(variant).side, metrics, candidateMarginEquivalent: "not_applicable_independent_100_share_shadow" });
    resultType = "pending";
  }
  return finalize(state, input, resultType, actions, null, null);
}
