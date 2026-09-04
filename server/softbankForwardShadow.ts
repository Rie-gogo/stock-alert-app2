import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";
import {
  SOFTBANK_BREAKOUT_LONG_SPEC,
  calculateSoftbankBreakoutLongMetrics,
  isSoftbankBreakoutLongEntryTime,
  type SoftbankBreakoutLongCandle,
} from "./softbankBreakoutLong";
import { calculateClockSafeBoardAge, calculateDepthVwap } from "./telExecutableConfirmDepth";

export const SOFTBANK_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-04";
export const SOFTBANK_FORWARD_COLLECTION_START_DATE = "2026-09-07";
export const SOFTBANK_FORWARD_FORMAL_START_DATE = "2026-09-08";

export const SOFTBANK_DEPTH_CONFIRM_SPEC = Object.freeze({
  symbol: "9984",
  routeId: "softbankBreakoutLong",
  candidateKey: "9984_breakout_depth_confirm",
  entry: Object.freeze({
    sharedDetectionCore: "calculateSoftbankBreakoutLongMetrics",
    confirmation: "next_same_symbol_source_event_only",
    side: "long",
    executionProxy: "ask_depth_vwap",
    executionDepthShares: 100,
    breakoutComparator: "strictly_above_original_ten_bar_high",
    maximumAdverseEntryPct: 0.1,
    maximumClockSafeBoardAgeMs: 5_000,
    boardAgeBasis: "relay_packaging_plus_cloud_processing_same_clock_intervals",
    networkTransitMeasurement: "unavailable_cross_clock_not_subtracted",
    rejectionConsumesDailySlot: false,
    rejectedImpulseReusable: false,
  }),
  exit: Object.freeze({
    slPct: 0.4,
    tpPct: 0.8,
    maxHoldingMinutes: 45,
    sameBarPriority: ["stop_loss", "take_profit", "time_exit"],
    stopGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export const SOFTBANK_RR2_PROTECT_SPEC = Object.freeze({
  symbol: "9984",
  routeId: "softbankBreakoutLong",
  candidateKey: "9984_breakout_rr2_protect",
  entry: Object.freeze({
    sharedDetectionCore: "calculateSoftbankBreakoutLongMetrics",
    timing: "same_completed_signal_candle",
    price: "completed_signal_candle_close",
  }),
  exit: Object.freeze({
    slPct: 0.5,
    tpPct: 1.0,
    profitProtectionTriggerPct: 0.2,
    profitProtectionFloorPct: 0.05,
    profitProtectionStarts: "next_source_event_after_arming",
    maxHoldingMinutes: 45,
    sameBarPriority: [
      "stop_loss",
      "previously_armed_profit_protection",
      "take_profit",
      "new_profit_protection_arm",
      "time_exit",
    ],
    stopAndProtectionGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export type SoftbankForwardResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

type SoftbankPendingEntry = {
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  breakoutLevel: number;
  metrics: Record<string, number | boolean>;
};

export type SoftbankForwardPosition = {
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
  executionProxyKind: "signal_candle_close" | "ask_depth_vwap_100";
  breakoutLevel: number | null;
  adverseEntryPct: number | null;
  boardAgeMs: number | null;
  profitProtectionArmedAtSourceEventId: string | null;
};

export type SoftbankForwardState = {
  version: 1;
  variant: "depth_confirm" | "rr2_protect";
  tradeDate: string;
  candles: SoftbankBreakoutLongCandle[];
  pending: SoftbankPendingEntry | null;
  position: SoftbankForwardPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: SoftbankForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type SoftbankClosedPosition = {
  position: SoftbankForwardPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "profit_protection" | "time_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type SoftbankForwardTransition = {
  nextState: SoftbankForwardState;
  resultType: SoftbankForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: SoftbankForwardPosition | null;
  closedPosition: SoftbankClosedPosition | null;
};

export function createEmptySoftbankForwardState(
  variant: SoftbankForwardState["variant"],
): SoftbankForwardState {
  return {
    version: 1,
    variant,
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

export function normalizeSoftbankForwardState(
  value: unknown,
  variant: SoftbankForwardState["variant"],
  tradeDate?: string,
): SoftbankForwardState {
  const raw = value && typeof value === "object" ? value as Partial<SoftbankForwardState> : {};
  let state: SoftbankForwardState = {
    version: 1,
    variant,
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-180) : [],
    pending: raw.pending ?? null,
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
  if (tradeDate && state.tradeDate !== tradeDate) {
    state = createEmptySoftbankForwardState(variant);
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

function pnlFor(position: SoftbankForwardPosition, exitPrice: number): number {
  return Math.round((exitPrice - position.entryPrice) * position.shares);
}

function adverseExitPrice(exitPrice: number): number {
  return exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
}

function closedPosition(position: SoftbankForwardPosition, exitPrice: number, exitReason: SoftbankClosedPosition["exitReason"]): SoftbankClosedPosition {
  const pnl = pnlFor(position, exitPrice);
  const pnlAfterAdverseExit = pnlFor(position, adverseExitPrice(exitPrice));
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

function appendCandle(state: SoftbankForwardState, input: ForwardSourceEventInput) {
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

function breakoutLevel(candles: readonly SoftbankBreakoutLongCandle[]): number | null {
  const lookback = SOFTBANK_BREAKOUT_LONG_SPEC.primary.lookback;
  if (candles.length < lookback + 1) return null;
  return Math.max(...candles.slice(-lookback - 1, -1).map(candle => candle.high));
}

function finalize(
  state: SoftbankForwardState,
  input: ForwardSourceEventInput,
  resultType: SoftbankForwardResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: SoftbankForwardPosition | null,
  closed: SoftbankClosedPosition | null,
): SoftbankForwardTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition: closed };
}

function calculateStandardExit(position: SoftbankForwardPosition, input: ForwardSourceEventInput) {
  const stopLine = position.entryPrice * (1 - position.slPct / 100);
  const targetLine = position.entryPrice * (1 + position.tpPct / 100);
  if (input.candle.low <= stopLine) {
    return closedPosition(position, Math.min(input.candle.open, stopLine), "stop_loss");
  }
  if (input.candle.high >= targetLine) {
    return closedPosition(position, targetLine, "take_profit");
  }
  if (input.candle.candleTime >= "11:27") {
    return closedPosition(position, input.candle.close, "session_exit");
  }
  if (minutesBetween(position.entryTime, input.candle.candleTime) >= SOFTBANK_BREAKOUT_LONG_SPEC.primary.maxHoldingMinutes) {
    return closedPosition(position, input.candle.close, "time_exit");
  }
  return null;
}

/** A案: 現行シグナル後の次イベントで100株ask depthとブレイク継続だけを確認する。 */
export function applySoftbankDepthConfirmTransition(
  stateBefore: SoftbankForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): SoftbankForwardTransition {
  const state = normalizeSoftbankForwardState(stateBefore, "depth_confirm", input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: SoftbankForwardResultType = "no_signal";
  let openedPosition: SoftbankForwardPosition | null = null;
  let closed: SoftbankClosedPosition | null = null;
  let skipSignalDetection = false;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < SOFTBANK_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: SOFTBANK_FORWARD_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.pending && !state.position && !state.dailySlotConsumed) {
    const pending = state.pending;
    state.pending = null;
    skipSignalDetection = true;
    const depth = calculateDepthVwap({
      board: input.board,
      side: "long",
      shares: SOFTBANK_DEPTH_CONFIRM_SPEC.entry.executionDepthShares,
    });
    const executablePrice = depth?.price ?? null;
    const clockAge = calculateClockSafeBoardAge(input.currentAudit);
    const boardObservedAtMs = input.currentAudit?.boardObservedAtMs ?? null;
    const relayAssembledAtMs = input.currentAudit?.relayAssembledAtMs ?? null;
    const boardSourceCausal = boardObservedAtMs !== null
      && relayAssembledAtMs !== null
      && boardObservedAtMs <= relayAssembledAtMs;
    const adverseEntryPct = executablePrice === null
      ? null
      : (executablePrice - pending.theoreticalSignalPrice) / pending.theoreticalSignalPrice * 100;
    const breakoutMaintained = executablePrice !== null && executablePrice > pending.breakoutLevel;
    const adverseAllowed = adverseEntryPct !== null
      && adverseEntryPct <= SOFTBANK_DEPTH_CONFIRM_SPEC.entry.maximumAdverseEntryPct;
    const accepted = clockAge.timestampsAvailable
      && clockAge.causal
      && clockAge.fresh
      && boardSourceCausal
      && executablePrice !== null
      && breakoutMaintained
      && adverseAllowed;
    if (!accepted) {
      resultType = "rejected";
      actions.push({
        type: "entry_rejected",
        reason: !clockAge.timestampsAvailable || boardObservedAtMs === null
          ? "board_observed_or_decision_time_unavailable"
          : !clockAge.causal || !boardSourceCausal
            ? "same_clock_interval_negative"
            : !clockAge.fresh
              ? "board_snapshot_stale_over_5000ms"
              : executablePrice === null
                ? "insufficient_ask_depth_for_100_shares"
                : !breakoutMaintained
                  ? "breakout_not_maintained_at_next_event"
                  : "adverse_entry_gap_over_010pct",
        originalSignalSourceEventId: pending.signalSourceEventId,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        breakoutLevel: pending.breakoutLevel,
        executablePriceProxy: executablePrice,
        executionDepthShares: SOFTBANK_DEPTH_CONFIRM_SPEC.entry.executionDepthShares,
        depth,
        adverseEntryPct,
        boardAgeMs: clockAge.boardAgeMs,
        relayPackagingMs: clockAge.relayPackagingMs,
        cloudProcessingMs: clockAge.cloudProcessingMs,
        networkTransitMeasurement: clockAge.networkTransitMeasurement,
        boardSourceCausal,
        dailySlotConsumed: false,
        originalImpulseReusable: false,
      });
    } else {
      const shares = sharesForMode(mode, executablePrice);
      state.position = {
        side: "long",
        signalSourceEventId: pending.signalSourceEventId,
        entrySourceEventId: input.sourceEventId,
        signalTime: pending.signalTime,
        entryTime: input.candle.candleTime,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        entryPrice: executablePrice,
        shares,
        slPct: SOFTBANK_DEPTH_CONFIRM_SPEC.exit.slPct,
        tpPct: SOFTBANK_DEPTH_CONFIRM_SPEC.exit.tpPct,
        executionProxyKind: "ask_depth_vwap_100",
        breakoutLevel: pending.breakoutLevel,
        adverseEntryPct,
        boardAgeMs: clockAge.boardAgeMs,
        profitProtectionArmedAtSourceEventId: null,
      };
      openedPosition = { ...state.position };
      state.dailySlotConsumed = true;
      resultType = "entry";
      actions.push({
        type: "entry",
        side: "long",
        originalSignalSourceEventId: pending.signalSourceEventId,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        breakoutLevel: pending.breakoutLevel,
        executableEntryPrice: executablePrice,
        executablePriceProxyKind: "ask_depth_vwap_100",
        executionDepthShares: SOFTBANK_DEPTH_CONFIRM_SPEC.entry.executionDepthShares,
        depth,
        adverseEntryPct,
        boardAgeMs: clockAge.boardAgeMs,
        shares,
      });
    }
  }

  if (state.position && !openedPosition) {
    closed = calculateStandardExit(state.position, input);
    if (closed) {
      state.position = null;
      resultType = "exit";
      actions.push({
        type: "exit",
        reason: closed.exitReason,
        exitPrice: closed.exitPrice,
        pnl: closed.pnl,
        pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
        realizedR: closed.realizedR,
      });
    } else if (resultType === "no_signal") {
      resultType = "hold";
    }
  }

  if (!skipSignalDetection
    && !state.position
    && !state.pending
    && !state.dailySlotConsumed
    && isSoftbankBreakoutLongEntryTime(input.candle.candleTime)) {
    const metrics = calculateSoftbankBreakoutLongMetrics(state.candles);
    const originalBreakoutLevel = breakoutLevel(state.candles);
    if (metrics?.eligible && originalBreakoutLevel !== null) {
      state.pending = {
        signalSourceEventId: input.sourceEventId,
        signalTime: input.candle.candleTime,
        theoreticalSignalPrice: input.candle.close,
        breakoutLevel: originalBreakoutLevel,
        metrics: {
          closeBreaksHigh: metrics.closeBreaksHigh,
          bullishCandle: metrics.bullishCandle,
          maSlope2Pct: metrics.maSlope2Pct,
          volumeRatio: metrics.volumeRatio,
        },
      };
      resultType = "pending";
      actions.push({
        type: "pending",
        side: "long",
        theoreticalSignalPrice: input.candle.close,
        breakoutLevel: originalBreakoutLevel,
        metrics: state.pending.metrics,
      });
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closed);
}

function calculateRr2ProtectExit(position: SoftbankForwardPosition, input: ForwardSourceEventInput) {
  const stopLine = position.entryPrice * (1 - SOFTBANK_RR2_PROTECT_SPEC.exit.slPct / 100);
  const protectionLine = position.entryPrice * (1 + SOFTBANK_RR2_PROTECT_SPEC.exit.profitProtectionFloorPct / 100);
  const targetLine = position.entryPrice * (1 + SOFTBANK_RR2_PROTECT_SPEC.exit.tpPct / 100);
  if (input.candle.low <= stopLine) {
    return closedPosition(position, Math.min(input.candle.open, stopLine), "stop_loss");
  }
  if (position.profitProtectionArmedAtSourceEventId
    && position.profitProtectionArmedAtSourceEventId !== input.sourceEventId
    && input.candle.low <= protectionLine) {
    return closedPosition(position, Math.min(input.candle.open, protectionLine), "profit_protection");
  }
  if (input.candle.high >= targetLine) {
    return closedPosition(position, targetLine, "take_profit");
  }
  return null;
}

/** B案: 現行入口を変えず、2R出口と次足以降の利益保護だけを比較する。 */
export function applySoftbankRr2ProtectTransition(
  stateBefore: SoftbankForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): SoftbankForwardTransition {
  const state = normalizeSoftbankForwardState(stateBefore, "rr2_protect", input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: SoftbankForwardResultType = "no_signal";
  let openedPosition: SoftbankForwardPosition | null = null;
  let closed: SoftbankClosedPosition | null = null;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < SOFTBANK_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: SOFTBANK_FORWARD_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.position) {
    closed = calculateRr2ProtectExit(state.position, input);
    if (closed) {
      state.position = null;
      resultType = "exit";
      actions.push({
        type: "exit",
        reason: closed.exitReason,
        exitPrice: closed.exitPrice,
        pnl: closed.pnl,
        pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
        realizedR: closed.realizedR,
      });
    } else {
      const position = state.position;
      const triggerLine = position.entryPrice * (1 + SOFTBANK_RR2_PROTECT_SPEC.exit.profitProtectionTriggerPct / 100);
      if (!position.profitProtectionArmedAtSourceEventId && input.candle.high >= triggerLine) {
        position.profitProtectionArmedAtSourceEventId = input.sourceEventId;
        actions.push({ type: "profit_protection_armed", triggerLine, effectiveFromNextSourceEvent: true });
      }
      if (input.candle.candleTime >= "11:27") {
        closed = closedPosition(position, input.candle.close, "session_exit");
      } else if (minutesBetween(position.entryTime, input.candle.candleTime) >= SOFTBANK_RR2_PROTECT_SPEC.exit.maxHoldingMinutes) {
        closed = closedPosition(position, input.candle.close, "time_exit");
      }
      if (closed) {
        state.position = null;
        resultType = "exit";
        actions.push({
          type: "exit",
          reason: closed.exitReason,
          exitPrice: closed.exitPrice,
          pnl: closed.pnl,
          pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
          realizedR: closed.realizedR,
        });
      } else {
        resultType = "hold";
      }
    }
  } else if (!state.dailySlotConsumed && isSoftbankBreakoutLongEntryTime(input.candle.candleTime)) {
    const metrics = calculateSoftbankBreakoutLongMetrics(state.candles);
    if (metrics?.eligible) {
      const shares = sharesForMode(mode, input.candle.close);
      state.position = {
        side: "long",
        signalSourceEventId: input.sourceEventId,
        entrySourceEventId: input.sourceEventId,
        signalTime: input.candle.candleTime,
        entryTime: input.candle.candleTime,
        theoreticalSignalPrice: input.candle.close,
        entryPrice: input.candle.close,
        shares,
        slPct: SOFTBANK_RR2_PROTECT_SPEC.exit.slPct,
        tpPct: SOFTBANK_RR2_PROTECT_SPEC.exit.tpPct,
        executionProxyKind: "signal_candle_close",
        breakoutLevel: breakoutLevel(state.candles),
        adverseEntryPct: 0,
        boardAgeMs: null,
        profitProtectionArmedAtSourceEventId: null,
      };
      openedPosition = { ...state.position };
      state.dailySlotConsumed = true;
      resultType = "entry";
      actions.push({
        type: "entry",
        side: "long",
        entryPrice: input.candle.close,
        priceSource: "completed_signal_candle_close",
        metrics,
        shares,
      });
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closed);
}
