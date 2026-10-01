import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";

export const KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC = Object.freeze({
  symbol: "285A",
  routeId: "kioxiaReversalLong",
  candidateKey: "285a_current_reversal_long_exact_monitoring_reopen",
  historicalRole: "exact_copy_of_stopped_current_reversal_long_monitoring_only",
  entry: Object.freeze({
    window: ["09:45", "11:27"],
    minimumWarmupCandles: 30,
    dayHighDropPct: 2.5,
    maPeriod: 8,
    maRising: "current_ma8_gt_previous_ma8",
    maSlope2PctGte: 0.02,
    highBreak: "current_high_gt_prior_10_high_max",
    boardBlock: "sell_pressure",
    price: "completed_candle_close",
    dailySlot: "one_successful_entry_only",
    rejectedCandidateSearch: "continue_without_consuming_slot",
  }),
  exit: Object.freeze({
    slPct: 0.6,
    tpPct: 1.2,
    sameBarPriority: ["stop_loss", "take_profit", "board_early_exit", "am_session_exit", "market_exit"],
    stopFill: "stop_line",
    boardEarlyExit: "long_pnl_ge_005_and_sell_pressure_or_large_sell_wall",
    signalReversalExit: "not_reached_in_current_engine_order_before_late_signal_detection",
  }),
  orderInstructionConnection: false,
});

export const KIOXIA_CURRENT_REVERSAL_LONG_EXACT_REOPEN_COLLECTION_START_DATE = "2026-10-02";

export type KioxiaCurrentReversalLongExactCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type KioxiaCurrentReversalLongExactPosition = {
  side: "long";
  signalSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  shares: number;
  slPct: number;
  tpPct: number;
  dayHigh: number;
  dropFromHighPct: number;
  maSlope2Pct: number;
  executionProxyKind: "completed_candle_close";
};

export type KioxiaCurrentReversalLongExactState = {
  version: 1;
  tradeDate: string;
  candles: KioxiaCurrentReversalLongExactCandle[];
  position: KioxiaCurrentReversalLongExactPosition | null;
  dailySlotConsumed: boolean;
  lastSourceEventId: string | null;
  lastResultType: KioxiaCurrentReversalLongExactResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type KioxiaCurrentReversalLongExactResultType = "no_signal" | "rejected" | "entry" | "hold" | "exit";

export type KioxiaCurrentReversalLongExactClosedPosition = {
  position: KioxiaCurrentReversalLongExactPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "board_early_exit" | "session_exit" | "market_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type KioxiaCurrentReversalLongExactTransition = {
  nextState: KioxiaCurrentReversalLongExactState;
  resultType: KioxiaCurrentReversalLongExactResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: KioxiaCurrentReversalLongExactPosition | null;
  closedPosition: KioxiaCurrentReversalLongExactClosedPosition | null;
};

export function emptyKioxiaCurrentReversalLongExactState(): KioxiaCurrentReversalLongExactState {
  return {
    version: 1,
    tradeDate: "",
    candles: [],
    position: null,
    dailySlotConsumed: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function parseKioxiaCurrentReversalLongExactState(value: unknown, tradeDate?: string): KioxiaCurrentReversalLongExactState {
  const raw = value && typeof value === "object" ? value as Partial<KioxiaCurrentReversalLongExactState> : {};
  let state: KioxiaCurrentReversalLongExactState = {
    version: 1,
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-180) : [],
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
  if (tradeDate && state.tradeDate !== tradeDate) {
    state = emptyKioxiaCurrentReversalLongExactState();
    state.tradeDate = tradeDate;
  }
  return state;
}

function minutesBetween(start: string, end: string): number {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return endHour * 60 + endMinute - startHour * 60 - startMinute;
}

function sharesFor(mode: ForwardEvaluationMode): number {
  // Monitoring signal-quality is fixed to 100; capital view remains separately stored
  // and does not use, reserve, or mutate the normal 8.91m portfolio.
  return mode === "signal_quality" ? 100 : 100;
}

function finalize(
  state: KioxiaCurrentReversalLongExactState,
  source: ForwardSourceEventInput,
  resultType: KioxiaCurrentReversalLongExactResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: KioxiaCurrentReversalLongExactPosition | null,
  closedPosition: KioxiaCurrentReversalLongExactClosedPosition | null,
): KioxiaCurrentReversalLongExactTransition {
  state.lastSourceEventId = source.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

function closePosition(
  position: KioxiaCurrentReversalLongExactPosition,
  exitPrice: number,
  exitReason: KioxiaCurrentReversalLongExactClosedPosition["exitReason"],
): KioxiaCurrentReversalLongExactClosedPosition {
  const pnl = Math.round((exitPrice - position.entryPrice) * position.shares);
  const adverseExit = exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const pnlAfterAdverseExit = Math.round((adverseExit - position.entryPrice) * position.shares);
  const risk = position.entryPrice * position.shares * position.slPct / 100;
  return { position: { ...position }, exitPrice, exitReason, pnl, pnlAfterAdverseExit, realizedR: risk > 0 ? pnl / risk : 0 };
}

function currentBoardSignal(board: unknown): string | null {
  if (!board || typeof board !== "object") return null;
  const signal = (board as Record<string, unknown>).signal;
  return typeof signal === "string" ? signal : null;
}

function calculateExit(
  position: KioxiaCurrentReversalLongExactPosition,
  source: ForwardSourceEventInput,
): KioxiaCurrentReversalLongExactClosedPosition | null {
  const stopLine = position.entryPrice * (1 - position.slPct / 100);
  const targetLine = position.entryPrice * (1 + position.tpPct / 100);
  // checkExitConditions runs before session close and resolves same-bar SL before TP.
  if (source.candle.low <= stopLine) return closePosition(position, stopLine, "stop_loss");
  if (source.candle.high >= targetLine) return closePosition(position, targetLine, "take_profit");
  const pnlPct = (source.candle.close - position.entryPrice) / position.entryPrice * 100;
  const boardSignal = currentBoardSignal(source.board);
  if (pnlPct >= 0.05 && (boardSignal === "sell_pressure" || boardSignal === "large_sell_wall")) {
    return closePosition(position, source.candle.close, "board_early_exit");
  }
  // This route's position check occurs before late detectSignals(), so no completed
  // same-source reversal signal is available to this current route at the exit check.
  if (position.entryTime < "11:30" && source.candle.candleTime >= "11:27" && source.candle.candleTime < "11:30") {
    return closePosition(position, source.candle.close, "session_exit");
  }
  if (source.candle.candleTime >= "15:25") return closePosition(position, source.candle.close, "market_exit");
  return null;
}

function routeMetrics(candles: KioxiaCurrentReversalLongExactCandle[]) {
  const period = KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC.entry.maPeriod;
  if (candles.length < period + 1) return null;
  const latest = candles[candles.length - 1];
  const currentMa = candles.slice(-period).reduce((sum, item) => sum + item.close, 0) / period;
  const previousMa = candles.slice(-period - 1, -1).reduce((sum, item) => sum + item.close, 0) / period;
  let maSlope2Pct: number | null = null;
  if (candles.length >= period + 2) {
    const ma2Ago = candles.slice(-period - 2, -2).reduce((sum, item) => sum + item.close, 0) / period;
    maSlope2Pct = ma2Ago > 0 ? (currentMa - ma2Ago) / ma2Ago * 100 : 0;
  }
  const dayHigh = Math.max(...candles.map(item => item.high));
  const dropFromHighPct = dayHigh > 0 ? (dayHigh - latest.close) / dayHigh * 100 : 0;
  const lookback = Math.min(10, candles.length - 1);
  const recentHigh = Math.max(...candles.slice(-1 - lookback, -1).map(item => item.high));
  return {
    dayHigh,
    dropFromHighPct,
    currentMa,
    previousMa,
    maSlope2Pct,
    maRising: currentMa > previousMa,
    highBreak: latest.high > recentHigh,
  };
}

export function applyKioxiaCurrentReversalLongExactTransition(
  stateBefore: KioxiaCurrentReversalLongExactState,
  source: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): KioxiaCurrentReversalLongExactTransition {
  const state = parseKioxiaCurrentReversalLongExactState(stateBefore, source.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: KioxiaCurrentReversalLongExactResultType = "no_signal";
  let openedPosition: KioxiaCurrentReversalLongExactPosition | null = null;
  let closedPosition: KioxiaCurrentReversalLongExactClosedPosition | null = null;
  state.candles.push({
    time: source.candle.candleTime,
    open: source.candle.open,
    high: source.candle.high,
    low: source.candle.low,
    close: source.candle.close,
    volume: source.candle.volume,
  });
  state.candles = state.candles.slice(-180);

  if (state.position) {
    closedPosition = calculateExit(state.position, source);
    if (closedPosition) {
      state.position = null;
      resultType = "exit";
      actions.push({ type: "exit", route: "kioxia_reversal_long", reason: closedPosition.exitReason, exitPrice: closedPosition.exitPrice, pnl: closedPosition.pnl, pnlAfterAdverseExit: closedPosition.pnlAfterAdverseExit, realizedR: closedPosition.realizedR });
    } else {
      resultType = "hold";
      actions.push({ type: "hold", route: "kioxia_reversal_long" });
    }
  }

  if (!state.position && !state.dailySlotConsumed
    && source.candle.candleTime >= "09:45" && source.candle.candleTime <= "11:27"
    && state.candles.length >= KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC.entry.minimumWarmupCandles) {
    const metrics = routeMetrics(state.candles);
    if (metrics
      && metrics.dropFromHighPct >= KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC.entry.dayHighDropPct
      && metrics.maRising
      && metrics.highBreak
      && metrics.maSlope2Pct !== null
      && metrics.maSlope2Pct >= KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC.entry.maSlope2PctGte) {
      if (currentBoardSignal(source.board) === "sell_pressure") {
        resultType = "rejected";
        actions.push({ type: "entry_rejected", route: "kioxia_reversal_long", reason: "sell_pressure", metrics });
      } else {
        openedPosition = {
          side: "long",
          signalSourceEventId: source.sourceEventId,
          entrySourceEventId: source.sourceEventId,
          signalTime: source.candle.candleTime,
          entryTime: source.candle.candleTime,
          theoreticalSignalPrice: source.candle.close,
          entryPrice: source.candle.close,
          shares: sharesFor(mode),
          slPct: KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC.exit.slPct,
          tpPct: KIOXIA_CURRENT_REVERSAL_LONG_EXACT_SPEC.exit.tpPct,
          dayHigh: metrics.dayHigh,
          dropFromHighPct: metrics.dropFromHighPct,
          maSlope2Pct: metrics.maSlope2Pct,
          executionProxyKind: "completed_candle_close",
        };
        state.position = openedPosition;
        state.dailySlotConsumed = true;
        resultType = "entry";
        actions.push({ type: "entry", route: "kioxia_reversal_long", side: "long", entryPrice: openedPosition.entryPrice, shares: openedPosition.shares, metrics });
      }
    }
  }

  return finalize(state, source, resultType, actions, openedPosition, closedPosition);
}
