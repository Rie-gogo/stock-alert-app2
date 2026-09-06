import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";
import {
  calculateSocionextConfirmedLongMetrics,
  evaluateSocionextConfirmedLongConfirmation,
  getSocionextConfirmedLongDayOpen,
  isSocionextConfirmedLongConfirmationTime,
  isSocionextConfirmedLongInitialTriggerTime,
  type SocionextConfirmedLongCandle,
  type SocionextConfirmedLongPending,
} from "./socionextConfirmedLong";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";

export const SOCIONEXT_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-04";
export const SOCIONEXT_FORWARD_COLLECTION_START_DATE = "2026-09-07";
export const SOCIONEXT_FORWARD_FORMAL_START_DATE = "2026-09-08";

export const SOCIONEXT_INITIAL_STRENGTH_SPEC = Object.freeze({
  symbol: "6526",
  routeId: "socionextConfirmedLong",
  candidateKey: "6526_confirmed_long_initial_strength_daily_stop",
  historicalRole: "diagnostic_candidate_latest_51d_win_rate_below_70",
  entry: Object.freeze({
    sharedDetectionCore: "calculateSocionextConfirmedLongMetrics_and_evaluateSocionextConfirmedLongConfirmation",
    minimumInitialOpenMovePct: 0.25,
    rejectionTiming: "initial_trigger_detection",
    rejectionTransition: "stop_search_for_trade_date",
    confirmationPrice: "completed_confirmation_candle_close",
  }),
  exit: Object.freeze({
    slPct: 0.25,
    tpPct: 0.5,
    maxHoldingMinutes: 20,
    sameBarPriority: ["stop_loss", "take_profit", "session_exit", "time_exit"],
    stopGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export const SOCIONEXT_CONFIRM_STRENGTH_SPEC = Object.freeze({
  symbol: "6526",
  routeId: "socionextConfirmedLong",
  candidateKey: "6526_confirmed_long_confirmation_strength_daily_stop",
  historicalRole: "adoption_review_candidate",
  entry: Object.freeze({
    sharedDetectionCore: "calculateSocionextConfirmedLongMetrics_and_evaluateSocionextConfirmedLongConfirmation",
    minimumConfirmationRisePct: 0.075,
    rejectionTiming: "confirmation_candle",
    rejectionTransition: "stop_search_for_trade_date",
    confirmationPrice: "completed_confirmation_candle_close",
  }),
  exit: Object.freeze({
    slPct: 0.35,
    tpPct: 0.7,
    maxHoldingMinutes: 20,
    sameBarPriority: ["stop_loss", "take_profit", "session_exit", "time_exit"],
    stopGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export type SocionextForwardVariant = "initial_strength" | "confirmation_strength";
export type SocionextForwardResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

export type SocionextForwardPosition = {
  side: "long";
  signalSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  entryPrice: number;
  shares: number;
  slPct: number;
  tpPct: number;
  triggerOpenMovePct: number;
  confirmationRisePct: number;
  executionProxyKind: "confirmation_candle_close";
};

export type SocionextForwardPending = SocionextConfirmedLongPending & {
  signalSourceEventId: string;
};

export type SocionextForwardState = {
  version: 1;
  variant: SocionextForwardVariant;
  tradeDate: string;
  candles: SocionextConfirmedLongCandle[];
  dayOpen: number | null;
  pending: SocionextForwardPending | null;
  position: SocionextForwardPosition | null;
  dailySlotConsumed: boolean;
  dailySearchStopped: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: SocionextForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type SocionextClosedPosition = {
  position: SocionextForwardPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "time_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type SocionextForwardTransition = {
  nextState: SocionextForwardState;
  resultType: SocionextForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: SocionextForwardPosition | null;
  closedPosition: SocionextClosedPosition | null;
};

export function createEmptySocionextForwardState(variant: SocionextForwardVariant): SocionextForwardState {
  return {
    version: 1,
    variant,
    tradeDate: "",
    candles: [],
    dayOpen: null,
    pending: null,
    position: null,
    dailySlotConsumed: false,
    dailySearchStopped: false,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function normalizeSocionextForwardState(
  value: unknown,
  variant: SocionextForwardVariant,
  tradeDate?: string,
): SocionextForwardState {
  const raw = value && typeof value === "object" ? value as Partial<SocionextForwardState> : {};
  let state: SocionextForwardState = {
    version: 1,
    variant,
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-180) : [],
    dayOpen: typeof raw.dayOpen === "number" ? raw.dayOpen : null,
    pending: raw.pending ?? null,
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    dailySearchStopped: raw.dailySearchStopped === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
  if (tradeDate && state.tradeDate !== tradeDate) {
    state = createEmptySocionextForwardState(variant);
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

function appendCandle(state: SocionextForwardState, input: ForwardSourceEventInput) {
  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-180);
  state.dayOpen ??= getSocionextConfirmedLongDayOpen(state.candles);
}

function finalize(
  state: SocionextForwardState,
  input: ForwardSourceEventInput,
  resultType: SocionextForwardResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: SocionextForwardPosition | null,
  closedPosition: SocionextClosedPosition | null,
): SocionextForwardTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

function closePosition(
  position: SocionextForwardPosition,
  exitPrice: number,
  exitReason: SocionextClosedPosition["exitReason"],
): SocionextClosedPosition {
  const pnl = Math.round((exitPrice - position.entryPrice) * position.shares);
  const adversePrice = exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const pnlAfterAdverseExit = Math.round((adversePrice - position.entryPrice) * position.shares);
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

function calculateExit(position: SocionextForwardPosition, input: ForwardSourceEventInput): SocionextClosedPosition | null {
  if (input.candle.candleTime >= "12:30") {
    return closePosition(position, input.candle.close, "session_exit");
  }
  const stopLine = position.entryPrice * (1 - position.slPct / 100);
  const targetLine = position.entryPrice * (1 + position.tpPct / 100);
  if (input.candle.low <= stopLine) return closePosition(position, Math.min(input.candle.open, stopLine), "stop_loss");
  if (input.candle.high >= targetLine) return closePosition(position, targetLine, "take_profit");
  if (input.candle.candleTime >= "11:27") return closePosition(position, input.candle.close, "session_exit");
  if (minutesBetween(position.entryTime, input.candle.candleTime) >= SOCIONEXT_INITIAL_STRENGTH_SPEC.exit.maxHoldingMinutes) {
    return closePosition(position, input.candle.close, "time_exit");
  }
  return null;
}

function createPending(
  state: SocionextForwardState,
  input: ForwardSourceEventInput,
): { pending: SocionextForwardPending | null; metrics: ReturnType<typeof calculateSocionextConfirmedLongMetrics> } {
  if (state.dayOpen === null || !isSocionextConfirmedLongInitialTriggerTime(input.candle.candleTime)) {
    return { pending: null, metrics: null };
  }
  const metrics = calculateSocionextConfirmedLongMetrics(state.candles, state.dayOpen);
  if (!metrics?.eligible) return { pending: null, metrics };
  const pending: SocionextForwardPending = {
    triggerClose: input.candle.close,
    triggerTime: input.candle.candleTime,
    triggerMaSlope2Pct: metrics.maSlope2Pct,
    triggerVolumeRatio: metrics.volumeRatio,
    triggerOpenMovePct: metrics.openMovePct,
    signalSourceEventId: input.sourceEventId,
  };
  return { pending, metrics };
}

function openPosition(input: {
  state: SocionextForwardState;
  source: ForwardSourceEventInput;
  mode: ForwardEvaluationMode;
  pending: SocionextForwardPending;
  slPct: number;
  tpPct: number;
}): SocionextForwardPosition {
  const confirmationRisePct = (input.source.candle.close - input.pending.triggerClose) / input.pending.triggerClose * 100;
  const position: SocionextForwardPosition = {
    side: "long",
    signalSourceEventId: input.pending.signalSourceEventId,
    entrySourceEventId: input.source.sourceEventId,
    signalTime: input.pending.triggerTime,
    entryTime: input.source.candle.candleTime,
    entryPrice: input.source.candle.close,
    shares: sharesForMode(input.mode, input.source.candle.close),
    slPct: input.slPct,
    tpPct: input.tpPct,
    triggerOpenMovePct: input.pending.triggerOpenMovePct,
    confirmationRisePct,
    executionProxyKind: "confirmation_candle_close",
  };
  input.state.position = position;
  input.state.dailySlotConsumed = true;
  return position;
}

/** A案: 初動候補が始値比+0.25%未満なら、その日の探索を終了する。 */
export function applySocionextInitialStrengthTransition(
  stateBefore: SocionextForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): SocionextForwardTransition {
  const state = normalizeSocionextForwardState(stateBefore, "initial_strength", input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: SocionextForwardResultType = "no_signal";
  let openedPosition: SocionextForwardPosition | null = null;
  let closedPosition: SocionextClosedPosition | null = null;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < SOCIONEXT_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: SOCIONEXT_FORWARD_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.position) {
    closedPosition = calculateExit(state.position, input);
    if (closedPosition) {
      state.position = null;
      resultType = "exit";
      actions.push({ type: "exit", reason: closedPosition.exitReason, exitPrice: closedPosition.exitPrice, pnl: closedPosition.pnl, pnlAfterAdverseExit: closedPosition.pnlAfterAdverseExit, realizedR: closedPosition.realizedR });
    } else resultType = "hold";
  } else if (!state.dailySearchStopped && state.pending) {
    const pending = state.pending;
    state.pending = null;
    if (!isSocionextConfirmedLongConfirmationTime(input.candle.candleTime)) {
      resultType = "rejected";
      actions.push({ type: "confirmation_rejected", reason: "confirmation_time_expired", originalSignalSourceEventId: pending.signalSourceEventId });
    } else {
      const confirmation = evaluateSocionextConfirmedLongConfirmation({ pending, candle: state.candles[state.candles.length - 1] });
      if (!confirmation.allowed) {
        resultType = "rejected";
        actions.push({ type: "confirmation_rejected", reason: "current_confirmation_failed", codes: confirmation.codes, originalSignalSourceEventId: pending.signalSourceEventId, sameCandleRedetectionAllowed: true });
      } else {
        openedPosition = openPosition({
          state,
          source: input,
          mode,
          pending,
          slPct: SOCIONEXT_INITIAL_STRENGTH_SPEC.exit.slPct,
          tpPct: SOCIONEXT_INITIAL_STRENGTH_SPEC.exit.tpPct,
        });
        resultType = "entry";
        actions.push({ type: "entry", side: "long", entryPrice: openedPosition.entryPrice, priceSource: "completed_confirmation_candle_close", shares: openedPosition.shares });
      }
    }
  }

  if (!state.position && !state.pending && !state.dailySlotConsumed && !state.dailySearchStopped) {
    const detected = createPending(state, input);
    if (detected.pending && detected.metrics) {
      if (detected.metrics.openMovePct < SOCIONEXT_INITIAL_STRENGTH_SPEC.entry.minimumInitialOpenMovePct) {
        state.dailySearchStopped = true;
        resultType = "rejected";
        actions.push({
          type: "initial_strength_daily_stop",
          reason: "initial_open_move_below_025",
          openMovePct: detected.metrics.openMovePct,
          thresholdPct: SOCIONEXT_INITIAL_STRENGTH_SPEC.entry.minimumInitialOpenMovePct,
          dailySlotConsumed: false,
          laterCandidatesIgnored: true,
        });
      } else {
        state.pending = detected.pending;
        resultType = "pending";
        actions.push({ type: "pending", side: "long", triggerClose: detected.pending.triggerClose, metrics: detected.pending });
      }
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closedPosition);
}

/** B案: 確認足が初動終値を上回っても+0.075%未満なら、その日の探索を終了する。 */
export function applySocionextConfirmationStrengthTransition(
  stateBefore: SocionextForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): SocionextForwardTransition {
  const state = normalizeSocionextForwardState(stateBefore, "confirmation_strength", input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: SocionextForwardResultType = "no_signal";
  let openedPosition: SocionextForwardPosition | null = null;
  let closedPosition: SocionextClosedPosition | null = null;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < SOCIONEXT_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: SOCIONEXT_FORWARD_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.position) {
    closedPosition = calculateExit(state.position, input);
    if (closedPosition) {
      state.position = null;
      resultType = "exit";
      actions.push({ type: "exit", reason: closedPosition.exitReason, exitPrice: closedPosition.exitPrice, pnl: closedPosition.pnl, pnlAfterAdverseExit: closedPosition.pnlAfterAdverseExit, realizedR: closedPosition.realizedR });
    } else resultType = "hold";
  } else if (!state.dailySearchStopped && state.pending) {
    const pending = state.pending;
    state.pending = null;
    if (!isSocionextConfirmedLongConfirmationTime(input.candle.candleTime)) {
      resultType = "rejected";
      actions.push({ type: "confirmation_rejected", reason: "confirmation_time_expired", originalSignalSourceEventId: pending.signalSourceEventId });
    } else {
      const confirmation = evaluateSocionextConfirmedLongConfirmation({ pending, candle: state.candles[state.candles.length - 1] });
      if (!confirmation.allowed) {
        resultType = "rejected";
        actions.push({ type: "confirmation_rejected", reason: "current_confirmation_failed", codes: confirmation.codes, originalSignalSourceEventId: pending.signalSourceEventId, sameCandleRedetectionAllowed: true });
      } else {
        const confirmationRisePct = (input.candle.close - pending.triggerClose) / pending.triggerClose * 100;
        if (confirmationRisePct < SOCIONEXT_CONFIRM_STRENGTH_SPEC.entry.minimumConfirmationRisePct) {
          state.dailySearchStopped = true;
          resultType = "rejected";
          actions.push({
            type: "confirmation_strength_daily_stop",
            reason: "confirmation_rise_below_0075",
            confirmationRisePct,
            thresholdPct: SOCIONEXT_CONFIRM_STRENGTH_SPEC.entry.minimumConfirmationRisePct,
            originalSignalSourceEventId: pending.signalSourceEventId,
            dailySlotConsumed: false,
            laterCandidatesIgnored: true,
          });
        } else {
          openedPosition = openPosition({
            state,
            source: input,
            mode,
            pending,
            slPct: SOCIONEXT_CONFIRM_STRENGTH_SPEC.exit.slPct,
            tpPct: SOCIONEXT_CONFIRM_STRENGTH_SPEC.exit.tpPct,
          });
          resultType = "entry";
          actions.push({ type: "entry", side: "long", entryPrice: openedPosition.entryPrice, priceSource: "completed_confirmation_candle_close", shares: openedPosition.shares, confirmationRisePct });
        }
      }
    }
  }

  if (!state.position && !state.pending && !state.dailySlotConsumed && !state.dailySearchStopped) {
    const detected = createPending(state, input);
    if (detected.pending) {
      state.pending = detected.pending;
      resultType = "pending";
      actions.push({ type: "pending", side: "long", triggerClose: detected.pending.triggerClose, metrics: detected.pending });
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closedPosition);
}
