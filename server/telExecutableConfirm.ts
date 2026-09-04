import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY, TEL_EXECUTABLE_CONFIRM_VERSION } from "./runtimeIdentity";
export { TEL_EXECUTABLE_CONFIRM_VERSION } from "./runtimeIdentity";
import {
  TEL_OPEN_DIRECTION_BREAKOUT_SPEC,
  calculateTelOpenDirectionBreakoutMetrics,
  isTelOpenDirectionBreakoutEntryTime,
  type TelOpenDirectionBreakoutCandle,
} from "./telOpenDirectionBreakout";

export const TEL_EXECUTABLE_CONFIRM_LEARNING_CUTOFF_DATE = "2026-09-04";
export const TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE = "2026-09-07";
export const TEL_EXECUTABLE_CONFIRM_MAX_ADVERSE_PCT = 0.1;

export interface TelExecutablePending {
  side: "long" | "short";
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  breakoutLevel: number;
  metrics: Record<string, number | boolean>;
}

export interface TelExecutablePosition {
  side: "long" | "short";
  signalSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  breakoutLevel: number;
  adverseEntryPct: number;
  shares: number;
  slPct: number;
  tpPct: number;
}

export interface TelExecutableConfirmState {
  version: 1;
  tradeDate: string;
  candles: TelOpenDirectionBreakoutCandle[];
  pending: TelExecutablePending | null;
  position: TelExecutablePosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: TelExecutableResultType | null;
  lastActions: Array<Record<string, unknown>>;
}

export type TelExecutableResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

export interface TelExecutableTransition {
  nextState: TelExecutableConfirmState;
  resultType: TelExecutableResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: TelExecutablePosition | null;
  closedPosition: {
    position: TelExecutablePosition;
    exitPrice: number;
    exitReason: string;
    pnl: number;
    pnlAfterAdverseExit: number;
    realizedR: number;
  } | null;
}

export function createEmptyTelExecutableConfirmState(): TelExecutableConfirmState {
  return {
    version: 1,
    tradeDate: "",
    candles: [],
    pending: null,
    position: null,
    dailySlotConsumed: false,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function normalizeTelExecutableConfirmState(value: unknown, tradeDate?: string): TelExecutableConfirmState {
  const raw = value && typeof value === "object" ? value as Partial<TelExecutableConfirmState> : {};
  let state: TelExecutableConfirmState = {
    version: 1,
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-64) : [],
    pending: raw.pending ?? null,
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
  if (tradeDate && state.tradeDate !== tradeDate) {
    state = createEmptyTelExecutableConfirmState();
    state.tradeDate = tradeDate;
  }
  return state;
}

function boardPrice(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const price = Number((value as { currentPrice?: unknown }).currentPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function sharesFor(mode: ForwardEvaluationMode, price: number): number {
  if (mode === "signal_quality") return 100;
  return Math.max(100, Math.floor(Math.floor(3_000_000 * 0.9 / price) / 100) * 100);
}

function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh * 60 + em - sh * 60 - sm;
}

function closePosition(state: TelExecutableConfirmState, input: ForwardSourceEventInput) {
  const position = state.position;
  if (!position) return null;
  const candle = input.candle;
  const stop = position.side === "long"
    ? position.entryPrice * (1 - position.slPct / 100)
    : position.entryPrice * (1 + position.slPct / 100);
  const target = position.side === "long"
    ? position.entryPrice * (1 + position.tpPct / 100)
    : position.entryPrice * (1 - position.tpPct / 100);
  let exitPrice: number | null = null;
  let exitReason = "";
  if (position.side === "long" && candle.low <= stop) {
    exitPrice = Math.min(candle.open, stop);
    exitReason = "stop_loss";
  } else if (position.side === "short" && candle.high >= stop) {
    exitPrice = Math.max(candle.open, stop);
    exitReason = "stop_loss";
  } else if (position.side === "long" && candle.high >= target) {
    exitPrice = target;
    exitReason = "take_profit";
  } else if (position.side === "short" && candle.low <= target) {
    exitPrice = target;
    exitReason = "take_profit";
  } else if (candle.candleTime >= "11:27") {
    exitPrice = candle.close;
    exitReason = "session_exit";
  } else if (minutesBetween(position.entryTime, candle.candleTime) >= TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.maxHoldingMinutes) {
    exitPrice = candle.close;
    exitReason = "time_exit";
  }
  if (exitPrice === null) return null;
  const pnl = Math.round((position.side === "long"
    ? exitPrice - position.entryPrice
    : position.entryPrice - exitPrice) * position.shares);
  const adverse = position.side === "long"
    ? exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100)
    : exitPrice * (1 + FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const pnlAfterAdverseExit = Math.round((position.side === "long"
    ? adverse - position.entryPrice
    : position.entryPrice - adverse) * position.shares);
  const risk = position.entryPrice * position.shares * position.slPct / 100;
  return { position: { ...position }, exitPrice, exitReason, pnl, pnlAfterAdverseExit, realizedR: risk > 0 ? pnl / risk : 0 };
}

function adverseEntryPct(pending: TelExecutablePending, executable: number): number {
  return pending.side === "long"
    ? (executable - pending.theoreticalSignalPrice) / pending.theoreticalSignalPrice * 100
    : (pending.theoreticalSignalPrice - executable) / pending.theoreticalSignalPrice * 100;
}

function finalize(state: TelExecutableConfirmState, input: ForwardSourceEventInput, resultType: TelExecutableResultType, actions: Array<Record<string, unknown>>, openedPosition: TelExecutablePosition | null, closedPosition: TelExecutableTransition["closedPosition"]): TelExecutableTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

export function applyTelExecutableConfirmTransition(stateBefore: TelExecutableConfirmState, input: ForwardSourceEventInput, mode: ForwardEvaluationMode): TelExecutableTransition {
  const state = normalizeTelExecutableConfirmState(stateBefore, input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: TelExecutableResultType = "no_signal";
  let openedPosition: TelExecutablePosition | null = null;
  let closedPosition: TelExecutableTransition["closedPosition"] = null;
  let skipSignalDetection = false;

  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-64);

  if (state.stopped || input.candle.tradeDate < TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      evaluationStartDate: TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE,
    }], null, null);
  }

  if (state.pending && !state.position && !state.dailySlotConsumed) {
    const pending = state.pending;
    state.pending = null;
    skipSignalDetection = true;
    const executable = boardPrice(input.board);
    const adversePct = executable === null ? null : adverseEntryPct(pending, executable);
    const breakoutMaintained = executable !== null && (pending.side === "long"
      ? executable > pending.breakoutLevel
      : executable < pending.breakoutLevel);
    const adverseAllowed = adversePct !== null && adversePct <= TEL_EXECUTABLE_CONFIRM_MAX_ADVERSE_PCT;
    if (executable === null || !breakoutMaintained || !adverseAllowed) {
      resultType = "rejected";
      actions.push({
        type: "entry_rejected",
        reason: executable === null
          ? "executable_price_proxy_unavailable"
          : !breakoutMaintained
            ? "breakout_not_maintained_at_next_event"
            : "adverse_entry_gap_over_010pct",
        originalSignalSourceEventId: pending.signalSourceEventId,
        breakoutLevel: pending.breakoutLevel,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        executablePriceProxy: executable,
        adverseEntryPct: adversePct,
        dailySlotConsumed: false,
        originalImpulseReusable: false,
      });
    } else {
      const shares = sharesFor(mode, executable);
      state.position = {
        side: pending.side,
        signalSourceEventId: pending.signalSourceEventId,
        entrySourceEventId: input.sourceEventId,
        signalTime: pending.signalTime,
        entryTime: input.candle.candleTime,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        entryPrice: executable,
        breakoutLevel: pending.breakoutLevel,
        adverseEntryPct: adversePct!,
        shares,
        slPct: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.slPct,
        tpPct: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.tpPct,
      };
      openedPosition = { ...state.position };
      state.dailySlotConsumed = true;
      resultType = "entry";
      actions.push({
        type: "entry",
        side: pending.side,
        originalSignalSourceEventId: pending.signalSourceEventId,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        breakoutLevel: pending.breakoutLevel,
        executablePriceProxy: executable,
        adverseEntryPct,
        shares,
      });
    }
  }

  if (state.position && !openedPosition) {
    closedPosition = closePosition(state, input);
    if (closedPosition) {
      state.position = null;
      resultType = "exit";
      actions.push({ type: "exit", ...closedPosition });
    } else if (resultType === "no_signal") {
      resultType = "hold";
    }
  }

  if (!skipSignalDetection && !state.position && !state.pending && !state.dailySlotConsumed
    && isTelOpenDirectionBreakoutEntryTime(input.candle.candleTime)) {
    const metrics = calculateTelOpenDirectionBreakoutMetrics(state.candles);
    const side = metrics?.longEligible ? "long" : metrics?.shortEligible ? "short" : null;
    if (metrics && side) {
      const previousBars = state.candles.slice(-TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.lookback - 1, -1);
      const breakoutLevel = side === "long"
        ? Math.max(...previousBars.map(candle => candle.high))
        : Math.min(...previousBars.map(candle => candle.low));
      state.pending = {
        side,
        signalSourceEventId: input.sourceEventId,
        signalTime: input.candle.candleTime,
        theoreticalSignalPrice: input.candle.close,
        breakoutLevel,
        metrics: {
          maSlope2Pct: metrics.maSlope2Pct,
          volumeRatio: metrics.volumeRatio,
          openGainPct: metrics.openGainPct,
          closeBreaksHigh: metrics.closeBreaksHigh,
          closeBreaksLow: metrics.closeBreaksLow,
        },
      };
      resultType = "pending";
      actions.push({ type: "pending", side, theoreticalSignalPrice: input.candle.close, breakoutLevel, metrics: state.pending.metrics });
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closedPosition);
}

export const TEL_EXECUTABLE_CONFIRM_SPEC = Object.freeze({
  strategyVersion: TEL_EXECUTABLE_CONFIRM_VERSION,
  symbol: "8035",
  learningCutoffDate: TEL_EXECUTABLE_CONFIRM_LEARNING_CUTOFF_DATE,
  evaluationStartDate: TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE,
  entry: Object.freeze({
    signal: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary,
    confirmationEvent: "next_same_symbol_source_event",
    long: "board.currentPrice > original_5bar_high",
    short: "board.currentPrice < original_5bar_low",
    maxAdversePctFromSignalClose: TEL_EXECUTABLE_CONFIRM_MAX_ADVERSE_PCT,
    missingBoard: "reject_without_consuming_daily_slot",
    rejectedImpulse: "never_reused_on_same_event",
  }),
  exit: Object.freeze({
    slPct: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.slPct,
    tpPct: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.tpPct,
    sameBarPriority: "stop_loss_first",
    stopGapFill: "adverse_open",
    timeExit: "completed_candle_close",
  }),
  evaluationModes: FORWARD_EVALUATION_POLICY.evaluationModes,
  orderInstructionConnection: false,
  automaticAdoption: false,
});
