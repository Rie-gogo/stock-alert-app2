import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";

export const TAIYO_AFTERNOON_LONG_LEARNING_CUTOFF_DATE = "2026-09-11";
export const TAIYO_AFTERNOON_LONG_COLLECTION_START_DATE = "2026-09-14";
export const TAIYO_AFTERNOON_LONG_FORMAL_START_DATE = "2026-09-14";

const ENTRY_START_TIME = "13:00";
const ENTRY_END_TIME = "14:20";
const SESSION_EXIT_TIME = "15:25";
const WINRATE_EXCEPTION = "user_approved_forward_shadow_tp_below_2r_2026-09-12";

const SHARED_ENTRY = Object.freeze({
  startTime: ENTRY_START_TIME,
  endTime: ENTRY_END_TIME,
  recentHighLookback: 5,
  maPeriod: 8,
  minimumMaSlope2Pct: 0,
  volumeLookback: 20,
  minimumVolumeRatio: 1,
  candle: "bullish_close_above_previous_5_highs",
  confirmation: "next_same_symbol_source_event_bullish_close_above_trigger_close",
  confirmationFailure: "discard_trigger_and_search_from_following_source_event",
  rejectionConsumesDailySlot: false,
  entryPrice: "completed_confirmation_candle_close",
});

export const TAIYO_AFTERNOON_LONG_RR2_SPEC = Object.freeze({
  symbol: "6976",
  routeId: "taiyoAfternoonReversalLong",
  side: "long",
  candidateKey: "6976_afternoon_long_morning_drop_confirmed_rr2_10",
  historicalRole: "diagnostic_2r_entry_candidate",
  entry: Object.freeze({
    ...SHARED_ENTRY,
    dayOpenBasis: "first_saved_candle_at_or_after_0900",
    morningCloseBasis: "last_saved_candle_before_1200",
    maximumMorningMovePct: -2,
    minimumReboundFromDayLowPct: 1,
    maximumConfirmationMovePct: 0.3,
  }),
  exit: Object.freeze({
    slPct: 0.8,
    tpPct: 1.6,
    maxHoldingMinutes: 10,
    sameBarPriority: ["stop_loss", "take_profit", "time_exit", "session_exit"],
    stopGapFill: "adverse_open",
    timeExitPrice: "completed_boundary_candle_close",
  }),
  riskRewardPolicy: Object.freeze({ minimumTpToSlRatio: 2, automaticAdoption: false }),
  orderInstructionConnection: false,
});

export const TAIYO_AFTERNOON_LONG_WINRATE_SPEC = Object.freeze({
  symbol: "6976",
  routeId: "taiyoAfternoonReversalLong",
  side: "long",
  candidateKey: "6976_afternoon_long_recovery_confirmed_winrate_30",
  historicalRole: "execution_sensitive_winrate_candidate",
  entry: Object.freeze({
    ...SHARED_ENTRY,
    dayOpenBasis: "first_saved_candle_at_or_after_0900",
    minimumReboundFromDayLowPct: 1.5,
    maximumConfirmationMovePct: 0.5,
  }),
  exit: Object.freeze({
    slPct: 1.2,
    tpPct: 0.3,
    maxHoldingMinutes: 30,
    sameBarPriority: ["stop_loss", "take_profit", "time_exit", "session_exit"],
    stopGapFill: "adverse_open",
    timeExitPrice: "completed_boundary_candle_close",
  }),
  riskRewardPolicy: Object.freeze({
    exception: WINRATE_EXCEPTION,
    minimumTpToSlRatio: 0.25,
    automaticAdoption: false,
    forwardRequirements: [
      "four_weeks_and_ten_trades",
      "win_rate_at_least_70pct",
      "profit_factor_at_least_1_5",
      "executable_price_pnl_positive",
      "current_10_symbol_891m_portfolio_non_degradation",
    ],
  }),
  orderInstructionConnection: false,
});

export type TaiyoAfternoonLongVariant = "rr2_10" | "recovery_winrate";
export type TaiyoAfternoonLongResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";
export type TaiyoAfternoonLongExitReason = "stop_loss" | "take_profit" | "time_exit" | "session_exit";

export type TaiyoAfternoonLongCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type TaiyoAfternoonLongPending = {
  triggerSourceEventId: string;
  triggerTime: string;
  triggerClose: number;
  morningMovePct: number | null;
  reboundPctFromLow: number;
  maSlope2Pct: number;
  volumeRatio: number;
};

export type TaiyoAfternoonLongPosition = {
  side: "long";
  signalSourceEventId: string;
  entrySourceEventId: string;
  entryTradeDate: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  shares: number;
  slPct: number;
  tpPct: number;
};

export type TaiyoAfternoonLongState = {
  version: 1;
  variant: TaiyoAfternoonLongVariant;
  tradeDate: string;
  candles: TaiyoAfternoonLongCandle[];
  dayOpen: number | null;
  dayLow: number | null;
  pending: TaiyoAfternoonLongPending | null;
  position: TaiyoAfternoonLongPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: TaiyoAfternoonLongResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type TaiyoAfternoonLongClosedPosition = {
  position: TaiyoAfternoonLongPosition;
  exitPrice: number;
  theoreticalExitPrice: number;
  exitReason: TaiyoAfternoonLongExitReason;
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type TaiyoAfternoonLongTransition = {
  nextState: TaiyoAfternoonLongState;
  resultType: TaiyoAfternoonLongResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: TaiyoAfternoonLongPosition | null;
  closedPosition: TaiyoAfternoonLongClosedPosition | null;
};

function specFor(variant: TaiyoAfternoonLongVariant) {
  return variant === "rr2_10" ? TAIYO_AFTERNOON_LONG_RR2_SPEC : TAIYO_AFTERNOON_LONG_WINRATE_SPEC;
}

export function createEmptyTaiyoAfternoonLongState(variant: TaiyoAfternoonLongVariant): TaiyoAfternoonLongState {
  return {
    version: 1,
    variant,
    tradeDate: "",
    candles: [],
    dayOpen: null,
    dayLow: null,
    pending: null,
    position: null,
    dailySlotConsumed: false,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function normalizeTaiyoAfternoonLongState(
  value: unknown,
  variant: TaiyoAfternoonLongVariant,
  tradeDate?: string,
): TaiyoAfternoonLongState {
  const raw = value && typeof value === "object" ? value as Partial<TaiyoAfternoonLongState> : {};
  const state: TaiyoAfternoonLongState = {
    ...createEmptyTaiyoAfternoonLongState(variant),
    ...raw,
    version: 1,
    variant,
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-420) : [],
    pending: raw.pending ?? null,
    position: raw.position ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
  if (tradeDate && state.tradeDate && state.tradeDate !== tradeDate && !state.position) {
    return { ...createEmptyTaiyoAfternoonLongState(variant), tradeDate };
  }
  return state;
}

function minutes(value: string): number {
  const [hour, minute] = value.slice(0, 5).split(":").map(Number);
  return hour * 60 + minute;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sharesFor(mode: ForwardEvaluationMode, entryPrice: number): number {
  if (mode === "signal_quality") return 100;
  return Math.max(100, Math.floor((3_000_000 * 0.9) / entryPrice / 100) * 100);
}

function finalize(
  state: TaiyoAfternoonLongState,
  input: ForwardSourceEventInput,
  resultType: TaiyoAfternoonLongResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: TaiyoAfternoonLongPosition | null = null,
  closedPosition: TaiyoAfternoonLongClosedPosition | null = null,
): TaiyoAfternoonLongTransition {
  const nextState = {
    ...state,
    lastSourceEventId: input.sourceEventId,
    lastResultType: resultType,
    lastActions: actions,
  };
  return { nextState, resultType, actions, openedPosition, closedPosition };
}

function closePosition(
  state: TaiyoAfternoonLongState,
  input: ForwardSourceEventInput,
  exitPrice: number,
  theoreticalExitPrice: number,
  exitReason: TaiyoAfternoonLongExitReason,
  actions: Array<Record<string, unknown>>,
) {
  const position = state.position!;
  const pnl = (exitPrice - position.entryPrice) * position.shares;
  const adverseExit = exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const pnlAfterAdverseExit = (adverseExit - position.entryPrice) * position.shares;
  const risk = position.entryPrice * position.shares * position.slPct / 100;
  const closedPosition: TaiyoAfternoonLongClosedPosition = {
    position,
    exitPrice,
    theoreticalExitPrice,
    exitReason,
    pnl,
    pnlAfterAdverseExit,
    realizedR: risk > 0 ? pnl / risk : 0,
  };
  actions.push({ type: "exit", exitReason, exitPrice, theoreticalExitPrice, pnl });
  return finalize({ ...state, position: null }, input, "exit", actions, null, closedPosition);
}

function triggerMetrics(
  state: TaiyoAfternoonLongState,
  candle: TaiyoAfternoonLongCandle,
  variant: TaiyoAfternoonLongVariant,
): TaiyoAfternoonLongPending | null {
  if (candle.time < ENTRY_START_TIME || candle.time > ENTRY_END_TIME || state.candles.length < 20) return null;
  const prior5 = state.candles.slice(-5);
  const prior20 = state.candles.slice(-20);
  const series = [...state.candles, candle];
  if (series.length < 10 || state.dayLow === null) return null;
  const maNow = average(series.slice(-8).map(item => item.close));
  const maTwoBarsAgo = average(series.slice(-10, -2).map(item => item.close));
  const maSlope2Pct = (maNow / maTwoBarsAgo - 1) * 100;
  const averageVolume = average(prior20.map(item => item.volume));
  if (averageVolume <= 0) return null;
  const volumeRatio = candle.volume / averageVolume;
  const dayLow = Math.min(state.dayLow, candle.low);
  const reboundPctFromLow = (candle.close / dayLow - 1) * 100;
  const morning = state.candles.filter(item => item.time >= "09:00" && item.time < "12:00");
  const morningClose = morning.length > 0 ? morning[morning.length - 1].close : null;
  const morningMovePct = state.dayOpen && morningClose ? (morningClose / state.dayOpen - 1) * 100 : null;
  const spec = specFor(variant);
  const directionOk = candle.close > candle.open
    && candle.close > Math.max(...prior5.map(item => item.high))
    && maSlope2Pct >= spec.entry.minimumMaSlope2Pct
    && volumeRatio >= spec.entry.minimumVolumeRatio
    && reboundPctFromLow >= spec.entry.minimumReboundFromDayLowPct;
  const morningOk = variant !== "rr2_10"
    || (morningMovePct !== null && morningMovePct <= TAIYO_AFTERNOON_LONG_RR2_SPEC.entry.maximumMorningMovePct);
  if (!directionOk || !morningOk) return null;
  return {
    triggerSourceEventId: "",
    triggerTime: candle.time,
    triggerClose: candle.close,
    morningMovePct,
    reboundPctFromLow,
    maSlope2Pct,
    volumeRatio,
  };
}

function applyTransition(
  stateBefore: TaiyoAfternoonLongState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
  variant: TaiyoAfternoonLongVariant,
): TaiyoAfternoonLongTransition {
  let state = normalizeTaiyoAfternoonLongState(stateBefore, variant);
  const actions: Array<Record<string, unknown>> = [];
  const candle: TaiyoAfternoonLongCandle = {
    time: input.candle.candleTime.slice(0, 5),
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  };

  if (state.tradeDate && state.tradeDate !== input.candle.tradeDate) {
    if (state.position) {
      return closePosition(state, input, candle.open, candle.open, "session_exit", [
        { type: "forced_next_day_exit", previousTradeDate: state.tradeDate },
      ]);
    }
    state = { ...createEmptyTaiyoAfternoonLongState(variant), tradeDate: input.candle.tradeDate };
  } else if (!state.tradeDate) {
    state = { ...state, tradeDate: input.candle.tradeDate };
  }

  const previousCandles = state.candles;
  if (candle.time >= "09:00") {
    state = {
      ...state,
      dayOpen: state.dayOpen ?? candle.open,
      dayLow: state.dayLow === null ? candle.low : Math.min(state.dayLow, candle.low),
    };
  }
  state = { ...state, candles: [...previousCandles, candle].slice(-420) };

  if (state.position && state.position.entrySourceEventId !== input.sourceEventId) {
    const position = state.position;
    const stop = position.entryPrice * (1 - position.slPct / 100);
    const target = position.entryPrice * (1 + position.tpPct / 100);
    if (candle.low <= stop) return closePosition(state, input, Math.min(candle.open, stop), stop, "stop_loss", actions);
    if (candle.high >= target) return closePosition(state, input, target, target, "take_profit", actions);
    if (minutes(candle.time) - minutes(position.entryTime) >= specFor(variant).exit.maxHoldingMinutes) {
      return closePosition(state, input, candle.close, candle.close, "time_exit", actions);
    }
    if (candle.time >= SESSION_EXIT_TIME) return closePosition(state, input, candle.close, candle.close, "session_exit", actions);
    return finalize(state, input, "hold", actions);
  }

  if (state.stopped || input.candle.tradeDate < TAIYO_AFTERNOON_LONG_COLLECTION_START_DATE) {
    return finalize(state, input, "no_signal", [{ type: "collection_inactive" }]);
  }
  if (state.dailySlotConsumed || candle.time > ENTRY_END_TIME) {
    return finalize({ ...state, pending: null }, input, "no_signal", actions);
  }

  if (state.pending) {
    const pending = state.pending;
    const maxMove = specFor(variant).entry.maximumConfirmationMovePct;
    const confirmationMovePct = (candle.close / pending.triggerClose - 1) * 100;
    state = { ...state, pending: null };
    const confirmed = candle.time <= ENTRY_END_TIME
      && candle.close > candle.open
      && candle.close > pending.triggerClose
      && confirmationMovePct <= maxMove;
    if (!confirmed) {
      actions.push({ type: "confirmation_rejected", triggerSourceEventId: pending.triggerSourceEventId, confirmationMovePct });
      return finalize(state, input, "rejected", actions);
    }
    const spec = specFor(variant);
    const position: TaiyoAfternoonLongPosition = {
      side: "long",
      signalSourceEventId: pending.triggerSourceEventId,
      entrySourceEventId: input.sourceEventId,
      entryTradeDate: input.candle.tradeDate,
      signalTime: pending.triggerTime,
      entryTime: candle.time,
      theoreticalSignalPrice: pending.triggerClose,
      entryPrice: candle.close,
      shares: sharesFor(mode, candle.close),
      slPct: spec.exit.slPct,
      tpPct: spec.exit.tpPct,
    };
    actions.push({ type: "entry", variant, entryPrice: position.entryPrice, shares: position.shares, confirmationMovePct });
    return finalize({ ...state, position, dailySlotConsumed: true }, input, "entry", actions, position);
  }

  const metricsState = { ...state, candles: previousCandles };
  const pending = triggerMetrics(metricsState, candle, variant);
  if (!pending) return finalize(state, input, "no_signal", actions);
  const withSource = { ...pending, triggerSourceEventId: input.sourceEventId };
  actions.push({ type: "trigger_pending_confirmation", variant, ...withSource });
  return finalize({ ...state, pending: withSource }, input, "pending", actions);
}

export function applyTaiyoAfternoonLongRr2Transition(
  state: TaiyoAfternoonLongState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
) {
  return applyTransition(state, input, mode, "rr2_10");
}

export function applyTaiyoAfternoonLongWinrateTransition(
  state: TaiyoAfternoonLongState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
) {
  return applyTransition(state, input, mode, "recovery_winrate");
}
