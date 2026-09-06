import {
  calculateSumcoBreakdownShortMetrics,
  isSumcoBreakdownShortEntryTime,
  type SumcoBreakdownShortCandle,
} from "./sumcoBreakdownShort";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";

export const SUMCO_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-04";
export const SUMCO_FORWARD_COLLECTION_START_DATE = "2026-09-07";
export const SUMCO_FORWARD_FORMAL_START_DATE = "2026-09-08";

export const SUMCO_VOLUME_110_SPEC = Object.freeze({
  symbol: "3436",
  routeId: "sumcoBreakdownShort",
  candidateKey: "3436_breakdown_short_volume_110_time_15",
  historicalRole: "adoption_review_candidate_entry_quality",
  entry: Object.freeze({
    sharedDetectionCore: "calculateSumcoBreakdownShortMetrics",
    minimumWarmupBars: 30,
    minimumVolumeRatio: 1.10,
    rejectionTransition: "next_candle_continue_search_without_consuming_daily_slot",
    entryPrice: "completed_signal_candle_close",
  }),
  exit: Object.freeze({
    slPct: 0.8,
    tpPct: 1.6,
    maxHoldingMinutes: 15,
    sameBarPriority: ["stop_loss", "take_profit", "session_exit", "time_exit"],
    stopGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export const SUMCO_TIME_15_SPEC = Object.freeze({
  symbol: "3436",
  routeId: "sumcoBreakdownShort",
  candidateKey: "3436_breakdown_short_current_entry_time_15",
  historicalRole: "adoption_review_candidate_exit_timing",
  entry: Object.freeze({
    sharedDetectionCore: "calculateSumcoBreakdownShortMetrics",
    minimumWarmupBars: 30,
    minimumVolumeRatio: 1.0,
    rejectionTransition: "next_candle_continue_search_without_consuming_daily_slot",
    entryPrice: "completed_signal_candle_close",
  }),
  exit: Object.freeze({
    slPct: 0.8,
    tpPct: 1.6,
    maxHoldingMinutes: 15,
    sameBarPriority: ["stop_loss", "take_profit", "session_exit", "time_exit"],
    stopGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export type SumcoForwardVariant = "volume_110" | "time_15";
export type SumcoForwardResultType = "no_signal" | "rejected" | "entry" | "hold" | "exit";

export type SumcoForwardPosition = {
  side: "short";
  signalSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  entryPrice: number;
  shares: number;
  slPct: number;
  tpPct: number;
  triggerVolumeRatio: number;
  triggerMaSlope2Pct: number;
  executionProxyKind: "completed_signal_candle_close";
};

export type SumcoForwardState = {
  version: 1;
  variant: SumcoForwardVariant;
  tradeDate: string;
  candles: SumcoBreakdownShortCandle[];
  position: SumcoForwardPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: SumcoForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type SumcoClosedPosition = {
  position: SumcoForwardPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "time_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type SumcoForwardTransition = {
  nextState: SumcoForwardState;
  resultType: SumcoForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: SumcoForwardPosition | null;
  closedPosition: SumcoClosedPosition | null;
};

export function createEmptySumcoForwardState(variant: SumcoForwardVariant): SumcoForwardState {
  return {
    version: 1,
    variant,
    tradeDate: "",
    candles: [],
    position: null,
    dailySlotConsumed: false,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function normalizeSumcoForwardState(
  value: unknown,
  variant: SumcoForwardVariant,
  tradeDate?: string,
): SumcoForwardState {
  const raw = value && typeof value === "object" ? value as Partial<SumcoForwardState> : {};
  let state: SumcoForwardState = {
    version: 1,
    variant,
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-180) : [],
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
  if (tradeDate && state.tradeDate !== tradeDate) {
    state = createEmptySumcoForwardState(variant);
    state.tradeDate = tradeDate;
  }
  return state;
}

function sharesForMode(mode: ForwardEvaluationMode, price: number): number {
  if (mode === "signal_quality") return 100;
  const rawShares = Math.floor((3_000_000 * 0.9) / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function minutesBetween(start: string, end: string): number {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return endHour * 60 + endMinute - startHour * 60 - startMinute;
}

function appendCandle(state: SumcoForwardState, input: ForwardSourceEventInput) {
  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-180);
}

function finalize(
  state: SumcoForwardState,
  input: ForwardSourceEventInput,
  resultType: SumcoForwardResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: SumcoForwardPosition | null,
  closedPosition: SumcoClosedPosition | null,
): SumcoForwardTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

function closePosition(
  position: SumcoForwardPosition,
  exitPrice: number,
  exitReason: SumcoClosedPosition["exitReason"],
): SumcoClosedPosition {
  const pnl = Math.round((position.entryPrice - exitPrice) * position.shares);
  const adversePrice = exitPrice * (1 + FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const pnlAfterAdverseExit = Math.round((position.entryPrice - adversePrice) * position.shares);
  const risk = position.entryPrice * position.shares * position.slPct / 100;
  return {
    position: { ...position },
    exitPrice,
    exitReason,
    pnl,
    pnlAfterAdverseExit,
    realizedR: risk > 0 ? pnl / risk : 0,
  };
}

function calculateExit(position: SumcoForwardPosition, input: ForwardSourceEventInput): SumcoClosedPosition | null {
  if (input.candle.candleTime >= "12:30") {
    return closePosition(position, input.candle.close, "session_exit");
  }
  const stopLine = position.entryPrice * (1 + position.slPct / 100);
  const targetLine = position.entryPrice * (1 - position.tpPct / 100);
  if (input.candle.high >= stopLine) return closePosition(position, Math.max(input.candle.open, stopLine), "stop_loss");
  if (input.candle.low <= targetLine) return closePosition(position, targetLine, "take_profit");
  if (input.candle.candleTime >= "11:27") return closePosition(position, input.candle.close, "session_exit");
  if (minutesBetween(position.entryTime, input.candle.candleTime) >= SUMCO_TIME_15_SPEC.exit.maxHoldingMinutes) {
    return closePosition(position, input.candle.close, "time_exit");
  }
  return null;
}

function applyTransition(
  stateBefore: SumcoForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
  variant: SumcoForwardVariant,
): SumcoForwardTransition {
  const state = normalizeSumcoForwardState(stateBefore, variant, input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: SumcoForwardResultType = "no_signal";
  let openedPosition: SumcoForwardPosition | null = null;
  let closedPosition: SumcoClosedPosition | null = null;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < SUMCO_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: SUMCO_FORWARD_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.position) {
    closedPosition = calculateExit(state.position, input);
    if (closedPosition) {
      state.position = null;
      resultType = "exit";
      actions.push({
        type: "exit",
        reason: closedPosition.exitReason,
        exitPrice: closedPosition.exitPrice,
        pnl: closedPosition.pnl,
        pnlAfterAdverseExit: closedPosition.pnlAfterAdverseExit,
        realizedR: closedPosition.realizedR,
      });
    } else {
      resultType = "hold";
    }
  } else if (
    !state.dailySlotConsumed
    && state.candles.length >= SUMCO_TIME_15_SPEC.entry.minimumWarmupBars
    && isSumcoBreakdownShortEntryTime(input.candle.candleTime)
  ) {
    const metrics = calculateSumcoBreakdownShortMetrics(state.candles);
    if (metrics?.eligible) {
      const minimumVolumeRatio = variant === "volume_110"
        ? SUMCO_VOLUME_110_SPEC.entry.minimumVolumeRatio
        : SUMCO_TIME_15_SPEC.entry.minimumVolumeRatio;
      if (metrics.volumeRatio < minimumVolumeRatio) {
        resultType = "rejected";
        actions.push({
          type: "volume_filter_rejected",
          volumeRatio: metrics.volumeRatio,
          minimumVolumeRatio,
          dailySlotConsumed: false,
          nextCandleSearchAllowed: true,
        });
      } else {
        const spec = variant === "volume_110" ? SUMCO_VOLUME_110_SPEC : SUMCO_TIME_15_SPEC;
        openedPosition = {
          side: "short",
          signalSourceEventId: input.sourceEventId,
          entrySourceEventId: input.sourceEventId,
          signalTime: input.candle.candleTime,
          entryTime: input.candle.candleTime,
          entryPrice: input.candle.close,
          shares: sharesForMode(mode, input.candle.close),
          slPct: spec.exit.slPct,
          tpPct: spec.exit.tpPct,
          triggerVolumeRatio: metrics.volumeRatio,
          triggerMaSlope2Pct: metrics.maSlope2Pct,
          executionProxyKind: "completed_signal_candle_close",
        };
        state.position = openedPosition;
        state.dailySlotConsumed = true;
        resultType = "entry";
        actions.push({
          type: "entry",
          side: "short",
          entryPrice: openedPosition.entryPrice,
          priceSource: "completed_signal_candle_close",
          shares: openedPosition.shares,
          metrics,
        });
      }
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closedPosition);
}

export function applySumcoVolume110Transition(
  stateBefore: SumcoForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): SumcoForwardTransition {
  return applyTransition(stateBefore, input, mode, "volume_110");
}

export function applySumcoTime15Transition(
  stateBefore: SumcoForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): SumcoForwardTransition {
  return applyTransition(stateBefore, input, mode, "time_15");
}
