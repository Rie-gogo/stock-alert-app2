import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";
import { calculateClockSafeBoardAge, calculateDepthVwap } from "./telExecutableConfirmDepth";

export const ADVANTEST_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-30";
export const ADVANTEST_FORWARD_COLLECTION_START_DATE = "2026-10-02";
export const ADVANTEST_FORWARD_FORMAL_START_DATE = "2026-10-02";

export const ADVANTEST_SHORT_BODY008_DEPTH_SPEC = Object.freeze({
  symbol: "6857",
  routeId: "advantestHighFadeShort",
  candidateKey: "6857_short_body008_depth",
  entry: Object.freeze({
    startTime: "09:45",
    endTime: "11:15",
    minimumRiseFromOpenPct: 1.0,
    minimumDropFromDayHighPct: 0.8,
    lowLookback: 5,
    minimumVolumeRatio: 1.2,
    maximumMa8Slope2Pct: -0.05,
    minimumPriorBearBodyPct: 0.08,
    weakVolumeBlockMinimumRisePct: 1.9,
    weakVolumeBlockMaximumVolumeRatioExclusive: 2.2,
    confirmation: "next_same_symbol_source_event_only",
    executionProxy: "bid_depth_vwap",
    executionDepthShares: 100,
    maximumAdverseEntryPct: 0.1,
    maximumClockSafeBoardAgeMs: 5_000,
    rejectionConsumesDailySlot: false,
    rejectedImpulseReusable: false,
  }),
  exit: Object.freeze({
    slPct: 1.0,
    tpPct: 3.0,
    profitProtectionTriggerPct: 0.8,
    profitProtectionFloorPct: 0.7,
    sessionExitTime: "11:27",
    sameBarPriority: ["stop_loss", "previously_armed_profit_protection", "take_profit", "new_profit_protection_arm", "session_exit"],
    stopAndProtectionGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export const ADVANTEST_CONTINUATION_LONG_DEPTH_SPEC = Object.freeze({
  symbol: "6857",
  routeId: "advantestConfirmedBreakLong",
  candidateKey: "6857_confirmed_continuation_depth",
  entry: Object.freeze({
    startTime: "10:00",
    endTime: "11:00",
    highLookback: 20,
    minimumMa8Slope2PctExclusive: 0,
    minimumVolumeRatio: 1.0,
    maximumRecentFiveRangePct: 1.5,
    confirmation: "next_same_symbol_source_event_only",
    executionProxy: "ask_depth_vwap",
    executionDepthShares: 100,
    maximumAdverseEntryPct: 0.1,
    maximumClockSafeBoardAgeMs: 5_000,
    rejectionConsumesDailySlot: false,
    rejectedImpulseReusable: false,
  }),
  exit: Object.freeze({
    slPct: 0.5,
    tpPct: 1.0,
    maxHoldingMinutes: 45,
    sessionExitTime: "11:27",
    sameBarPriority: ["stop_loss", "take_profit", "time_exit", "session_exit"],
    stopGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export type AdvantestForwardVariant = "short_body008_depth" | "confirmed_continuation_depth";
export type AdvantestForwardResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

type Candle = ForwardSourceEventInput["candle"];

type PendingEntry = {
  side: "long" | "short";
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  breakoutLevel: number;
  metrics: Record<string, number | boolean>;
};

export type AdvantestForwardPosition = {
  side: "long" | "short";
  signalSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  breakoutLevel: number;
  shares: number;
  slPct: number;
  tpPct: number;
  executionProxyKind: "ask_depth_vwap_100" | "bid_depth_vwap_100";
  adverseEntryPct: number;
  boardAgeMs: number;
  profitProtectionArmedAtSourceEventId: string | null;
};

export type AdvantestForwardState = {
  version: 1;
  variant: AdvantestForwardVariant;
  tradeDate: string;
  candles: Candle[];
  pending: PendingEntry | null;
  position: AdvantestForwardPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: AdvantestForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type AdvantestClosedPosition = {
  position: AdvantestForwardPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "profit_protection" | "time_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type AdvantestForwardTransition = {
  nextState: AdvantestForwardState;
  resultType: AdvantestForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: AdvantestForwardPosition | null;
  closedPosition: AdvantestClosedPosition | null;
};

export function createEmptyAdvantestForwardState(variant: AdvantestForwardVariant): AdvantestForwardState {
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

export function normalizeAdvantestForwardState(
  value: unknown,
  variant: AdvantestForwardVariant,
  tradeDate?: string,
): AdvantestForwardState {
  const raw = value && typeof value === "object" ? value as Partial<AdvantestForwardState> : {};
  let state: AdvantestForwardState = {
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
    state = createEmptyAdvantestForwardState(variant);
    state.tradeDate = tradeDate;
  }
  return state;
}

function appendCandle(state: AdvantestForwardState, input: ForwardSourceEventInput) {
  state.candles.push({ ...input.candle });
  state.candles = state.candles.slice(-180);
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function minutesBetween(start: string, end: string): number {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return endHour * 60 + endMinute - startHour * 60 - startMinute;
}

function sharesForMode(mode: ForwardEvaluationMode, price: number): number {
  if (mode === "signal_quality") return 100;
  const rawShares = Math.floor((3_000_000 * 0.9) / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function finish(
  state: AdvantestForwardState,
  input: ForwardSourceEventInput,
  resultType: AdvantestForwardResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: AdvantestForwardPosition | null,
  closedPosition: AdvantestClosedPosition | null,
): AdvantestForwardTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

function closePosition(
  position: AdvantestForwardPosition,
  exitPrice: number,
  exitReason: AdvantestClosedPosition["exitReason"],
): AdvantestClosedPosition {
  const direction = position.side === "long" ? 1 : -1;
  const pnl = Math.round((exitPrice - position.entryPrice) * direction * position.shares);
  const adverseExit = position.side === "long"
    ? exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100)
    : exitPrice * (1 + FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const pnlAfterAdverseExit = Math.round((adverseExit - position.entryPrice) * direction * position.shares);
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

function calculateExit(position: AdvantestForwardPosition, input: ForwardSourceEventInput): AdvantestClosedPosition | null {
  const candle = input.candle;
  if (position.side === "long") {
    const stopLine = position.entryPrice * (1 - position.slPct / 100);
    const targetLine = position.entryPrice * (1 + position.tpPct / 100);
    if (candle.low <= stopLine) return closePosition(position, Math.min(candle.open, stopLine), "stop_loss");
    if (candle.high >= targetLine) return closePosition(position, targetLine, "take_profit");
    if (minutesBetween(position.entryTime, candle.candleTime) >= ADVANTEST_CONTINUATION_LONG_DEPTH_SPEC.exit.maxHoldingMinutes) {
      return closePosition(position, candle.close, "time_exit");
    }
    if (candle.candleTime >= ADVANTEST_CONTINUATION_LONG_DEPTH_SPEC.exit.sessionExitTime) {
      return closePosition(position, candle.close, "session_exit");
    }
    return null;
  }

  const stopLine = position.entryPrice * (1 + position.slPct / 100);
  const targetLine = position.entryPrice * (1 - position.tpPct / 100);
  const protectionLine = position.entryPrice * (1 - ADVANTEST_SHORT_BODY008_DEPTH_SPEC.exit.profitProtectionFloorPct / 100);
  if (candle.high >= stopLine) return closePosition(position, Math.max(candle.open, stopLine), "stop_loss");
  if (position.profitProtectionArmedAtSourceEventId
    && position.profitProtectionArmedAtSourceEventId !== input.sourceEventId
    && candle.high >= protectionLine) {
    return closePosition(position, Math.max(candle.open, protectionLine), "profit_protection");
  }
  if (candle.low <= targetLine) return closePosition(position, targetLine, "take_profit");
  if (candle.candleTime >= ADVANTEST_SHORT_BODY008_DEPTH_SPEC.exit.sessionExitTime) {
    return closePosition(position, candle.close, "session_exit");
  }
  return null;
}

function armShortProfitProtection(position: AdvantestForwardPosition, input: ForwardSourceEventInput) {
  if (position.side !== "short" || position.profitProtectionArmedAtSourceEventId) return false;
  const triggerLine = position.entryPrice * (1 - ADVANTEST_SHORT_BODY008_DEPTH_SPEC.exit.profitProtectionTriggerPct / 100);
  if (input.candle.low > triggerLine) return false;
  position.profitProtectionArmedAtSourceEventId = input.sourceEventId;
  return true;
}

function shortSignal(candles: readonly Candle[]): PendingEntry | null {
  const spec = ADVANTEST_SHORT_BODY008_DEPTH_SPEC.entry;
  if (candles.length < 22) return null;
  const current = candles.at(-1)!;
  if (current.candleTime < spec.startTime || current.candleTime > spec.endTime) return null;
  const prior = candles.at(-2)!;
  const ma8 = average(candles.slice(-8).map(candle => candle.close));
  const previousMa8 = average(candles.slice(-9, -1).map(candle => candle.close));
  const ma8TwoAgo = average(candles.slice(-10, -2).map(candle => candle.close));
  const maSlope2Pct = ma8TwoAgo > 0 ? (ma8 - ma8TwoAgo) / ma8TwoAgo * 100 : 0;
  const previousVolumes = candles.slice(-21, -1).map(candle => candle.volume);
  const averageVolume = average(previousVolumes);
  const volumeRatio = averageVolume > 0 ? current.volume / averageVolume : 0;
  const recentLow = Math.min(...candles.slice(-1 - spec.lowLookback, -1).map(candle => candle.low));
  const dayOpen = candles[0]?.open ?? current.open;
  const dayHigh = Math.max(...candles.map(candle => candle.high));
  const riseFromOpenPct = dayOpen > 0 ? (dayHigh - dayOpen) / dayOpen * 100 : 0;
  const dropFromHighPct = dayHigh > 0 ? (dayHigh - current.close) / dayHigh * 100 : 0;
  const priorBearBodyPct = prior.open > 0 ? (prior.open - prior.close) / prior.open * 100 : 0;
  const weakVolumeBlocked = riseFromOpenPct >= spec.weakVolumeBlockMinimumRisePct
    && volumeRatio < spec.weakVolumeBlockMaximumVolumeRatioExclusive;
  const eligible = riseFromOpenPct >= spec.minimumRiseFromOpenPct
    && dropFromHighPct >= spec.minimumDropFromDayHighPct
    && current.close < recentLow
    && current.close < current.open
    && priorBearBodyPct >= spec.minimumPriorBearBodyPct
    && ma8 < previousMa8
    && maSlope2Pct <= spec.maximumMa8Slope2Pct
    && volumeRatio >= spec.minimumVolumeRatio
    && !weakVolumeBlocked;
  if (!eligible) return null;
  return {
    side: "short",
    signalSourceEventId: "",
    signalTime: current.candleTime,
    theoreticalSignalPrice: current.close,
    breakoutLevel: recentLow,
    metrics: {
      riseFromOpenPct,
      dropFromHighPct,
      priorBearBodyPct,
      maSlope2Pct,
      volumeRatio,
      recentLow,
      weakVolumeBlocked,
    },
  };
}

function longSignal(candles: readonly Candle[]): PendingEntry | null {
  const spec = ADVANTEST_CONTINUATION_LONG_DEPTH_SPEC.entry;
  if (candles.length < spec.highLookback + 2) return null;
  const current = candles.at(-1)!;
  if (current.candleTime < spec.startTime || current.candleTime > spec.endTime) return null;
  const prior = candles.at(-2)!;
  const priorHigh = Math.max(...candles.slice(-2 - spec.highLookback, -2).map(candle => candle.high));
  const currentHigh = Math.max(...candles.slice(-1 - spec.highLookback, -1).map(candle => candle.high));
  const ma8 = average(candles.slice(-8).map(candle => candle.close));
  const ma8TwoAgo = average(candles.slice(-10, -2).map(candle => candle.close));
  const maSlope2Pct = ma8TwoAgo > 0 ? (ma8 - ma8TwoAgo) / ma8TwoAgo * 100 : 0;
  const averageVolume = average(candles.slice(-21, -1).map(candle => candle.volume));
  const volumeRatio = averageVolume > 0 ? current.volume / averageVolume : 0;
  const runningVolume = candles.reduce((sum, candle) => sum + candle.volume, 0);
  const dayVwap = runningVolume > 0
    ? candles.reduce((sum, candle) => sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume, 0) / runningVolume
    : current.close;
  const recentFive = candles.slice(-5);
  const recentFiveRangePct = current.close > 0
    ? (Math.max(...recentFive.map(candle => candle.high)) - Math.min(...recentFive.map(candle => candle.low))) / current.close * 100
    : Number.POSITIVE_INFINITY;
  const dayOpen = candles[0]?.open ?? current.open;
  const eligible = prior.close > prior.open
    && prior.close > priorHigh
    && current.close > current.open
    && current.close > currentHigh
    && current.close > dayOpen
    && current.close > dayVwap
    && maSlope2Pct > spec.minimumMa8Slope2PctExclusive
    && volumeRatio >= spec.minimumVolumeRatio
    && recentFiveRangePct <= spec.maximumRecentFiveRangePct;
  if (!eligible) return null;
  return {
    side: "long",
    signalSourceEventId: "",
    signalTime: current.candleTime,
    theoreticalSignalPrice: current.close,
    breakoutLevel: currentHigh,
    metrics: {
      priorHigh,
      currentHigh,
      maSlope2Pct,
      volumeRatio,
      dayVwap,
      recentFiveRangePct,
    },
  };
}

function confirmPending(
  state: AdvantestForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
  actions: Array<Record<string, unknown>>,
): AdvantestForwardPosition | null {
  const pending = state.pending;
  if (!pending) return null;
  state.pending = null;
  const depth = calculateDepthVwap({ board: input.board, side: pending.side, shares: 100 });
  const executablePrice = depth?.price ?? null;
  const clockAge = calculateClockSafeBoardAge(input.currentAudit);
  const boardObservedAtMs = input.currentAudit?.boardObservedAtMs ?? null;
  const relayAssembledAtMs = input.currentAudit?.relayAssembledAtMs ?? null;
  const boardSourceCausal = boardObservedAtMs !== null
    && relayAssembledAtMs !== null
    && boardObservedAtMs <= relayAssembledAtMs;
  const adverseEntryPct = executablePrice === null
    ? null
    : pending.side === "long"
      ? (executablePrice - pending.theoreticalSignalPrice) / pending.theoreticalSignalPrice * 100
      : (pending.theoreticalSignalPrice - executablePrice) / pending.theoreticalSignalPrice * 100;
  const breakoutMaintained = executablePrice !== null && (pending.side === "long"
    ? executablePrice > pending.breakoutLevel
    : executablePrice < pending.breakoutLevel);
  const spec = pending.side === "long"
    ? ADVANTEST_CONTINUATION_LONG_DEPTH_SPEC
    : ADVANTEST_SHORT_BODY008_DEPTH_SPEC;
  const accepted = clockAge.timestampsAvailable
    && clockAge.causal
    && clockAge.fresh
    && boardSourceCausal
    && executablePrice !== null
    && breakoutMaintained
    && adverseEntryPct !== null
    && adverseEntryPct <= spec.entry.maximumAdverseEntryPct;
  if (!accepted || executablePrice === null || adverseEntryPct === null || clockAge.boardAgeMs === null) {
    actions.push({
      type: "entry_rejected",
      side: pending.side,
      reason: !clockAge.timestampsAvailable || boardObservedAtMs === null
        ? "board_observed_or_decision_time_unavailable"
        : !clockAge.causal || !boardSourceCausal
          ? "same_clock_interval_negative"
          : !clockAge.fresh
            ? "board_snapshot_stale_over_5000ms"
            : executablePrice === null
              ? `insufficient_${pending.side === "long" ? "ask" : "bid"}_depth_for_100_shares`
              : !breakoutMaintained
                ? "breakout_not_maintained_at_next_event"
                : "adverse_entry_gap_over_010pct",
      originalSignalSourceEventId: pending.signalSourceEventId,
      theoreticalSignalPrice: pending.theoreticalSignalPrice,
      breakoutLevel: pending.breakoutLevel,
      executablePriceProxy: executablePrice,
      adverseEntryPct,
      boardAgeMs: clockAge.boardAgeMs,
      dailySlotConsumed: false,
      originalImpulseReusable: false,
    });
    return null;
  }
  const shares = sharesForMode(mode, executablePrice);
  const position: AdvantestForwardPosition = {
    side: pending.side,
    signalSourceEventId: pending.signalSourceEventId,
    entrySourceEventId: input.sourceEventId,
    signalTime: pending.signalTime,
    entryTime: input.candle.candleTime,
    theoreticalSignalPrice: pending.theoreticalSignalPrice,
    entryPrice: executablePrice,
    breakoutLevel: pending.breakoutLevel,
    shares,
    slPct: spec.exit.slPct,
    tpPct: spec.exit.tpPct,
    executionProxyKind: pending.side === "long" ? "ask_depth_vwap_100" : "bid_depth_vwap_100",
    adverseEntryPct,
    boardAgeMs: clockAge.boardAgeMs,
    profitProtectionArmedAtSourceEventId: null,
  };
  actions.push({
    type: "entry",
    side: pending.side,
    originalSignalSourceEventId: pending.signalSourceEventId,
    theoreticalSignalPrice: pending.theoreticalSignalPrice,
    breakoutLevel: pending.breakoutLevel,
    executableEntryPrice: executablePrice,
    executablePriceProxyKind: position.executionProxyKind,
    depth,
    adverseEntryPct,
    boardAgeMs: clockAge.boardAgeMs,
    shares,
  });
  return position;
}

export function applyAdvantestForwardTransition(
  stateBefore: AdvantestForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): AdvantestForwardTransition {
  const state = normalizeAdvantestForwardState(stateBefore, stateBefore.variant, input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: AdvantestForwardResultType = "no_signal";
  let openedPosition: AdvantestForwardPosition | null = null;
  let closedPosition: AdvantestClosedPosition | null = null;
  let skipSignalDetection = false;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < ADVANTEST_FORWARD_COLLECTION_START_DATE) {
    return finish(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: ADVANTEST_FORWARD_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.pending && !state.position && !state.dailySlotConsumed) {
    openedPosition = confirmPending(state, input, mode, actions);
    skipSignalDetection = true;
    if (openedPosition) {
      state.position = openedPosition;
      state.dailySlotConsumed = true;
      resultType = "entry";
    } else {
      resultType = "rejected";
    }
  }

  if (state.position && !openedPosition) {
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
      if (armShortProfitProtection(state.position, input)) {
        actions.push({ type: "profit_protection_armed", effectiveFromNextSourceEvent: true });
      }
      resultType = "hold";
    }
  }

  if (!skipSignalDetection && !state.position && !state.pending && !state.dailySlotConsumed) {
    const detected = state.variant === "short_body008_depth"
      ? shortSignal(state.candles)
      : longSignal(state.candles);
    if (detected) {
      state.pending = { ...detected, signalSourceEventId: input.sourceEventId };
      resultType = "pending";
      actions.push({
        type: "pending",
        side: detected.side,
        theoreticalSignalPrice: detected.theoreticalSignalPrice,
        breakoutLevel: detected.breakoutLevel,
        metrics: detected.metrics,
      });
    }
  }

  return finish(state, input, resultType, actions, openedPosition, closedPosition);
}
