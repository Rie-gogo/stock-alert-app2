import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";
import { calculateClockSafeBoardAge } from "./telExecutableConfirmDepth";

export const TAIYO_AFTERNOON_LEARNING_CUTOFF_DATE = "2026-09-04";
export const TAIYO_AFTERNOON_COLLECTION_START_DATE = "2026-09-07";
export const TAIYO_AFTERNOON_FORMAL_START_DATE = "2026-09-08";

const REQUIRED_DEPTH_SHARES = 100;
const ENTRY_END_TIME = "14:20";
const SESSION_EXIT_TIME = "15:25";

export const TAIYO_AFTERNOON_RR2_SPEC = Object.freeze({
  symbol: "6976",
  routeId: "taiyoAfternoonReversal",
  side: "short",
  candidateKey: "6976_afternoon_reversal_short_current_entry_rr2_45",
  historicalRole: "adoption_review_candidate_exit_structure",
  entry: Object.freeze({
    sharedDetectionCore: "current_taiyo_afternoon_reversal_short_one_bar_confirmation",
    startTime: "12:50",
    endTime: ENTRY_END_TIME,
    dayOpenBasis: "first_saved_candle_at_or_after_0900",
    minimumMorningMovePct: 3.0,
    minimumReversalFromHighPct: 1.0,
    recentLowLookback: 5,
    maPeriod: 8,
    maximumMaSlope2Pct: -0.02,
    minimumVolumeRatio: 1.2,
    confirmation: "next_same_symbol_candle_bearish_and_close_below_trigger_close",
    confirmationFailure: "discard_original_trigger_and_search_from_next_source_event",
    entryPrice: "completed_confirmation_candle_close",
  }),
  exit: Object.freeze({
    slPct: 0.8,
    tpPct: 1.6,
    maxHoldingMinutes: 45,
    sameBarPriority: ["stop_loss", "take_profit", "time_exit", "session_exit"],
    stopGapFill: "adverse_open",
    timeExitPrice: "completed_boundary_candle_close",
  }),
  orderInstructionConnection: false,
});

export const TAIYO_AFTERNOON_DEPTH_SPEC = Object.freeze({
  symbol: "6976",
  routeId: "taiyoAfternoonReversal",
  side: "short",
  candidateKey: "6976_afternoon_reversal_short_bid_depth_execution",
  historicalRole: "adoption_review_candidate_execution_quality",
  entry: Object.freeze({
    sharedDetectionCore: "current_taiyo_afternoon_reversal_short_one_bar_confirmation",
    timing: "next_same_symbol_source_event_after_confirmation",
    price: "bid_side_depth_vwap",
    requiredDepthShares: REQUIRED_DEPTH_SHARES,
    requireAtOrBelowConfirmationClose: true,
    requireBelowOriginalRecentLow: true,
    maximumAdverseMovePct: 0.1,
    maximumClockSafeBoardAgeMs: 5_000,
    boardAgeBasis: "relay_packaging_plus_cloud_processing_same_clock_intervals",
    rejectionConsumesDailySlot: false,
    rejectedCandidateSearch: "discard_original_trigger_and_search_from_next_source_event",
  }),
  exit: Object.freeze({
    slPct: 0.8,
    tpPct: 1.6,
    maxHoldingMinutes: 45,
    price: "ask_side_depth_vwap",
    requiredDepthShares: REQUIRED_DEPTH_SHARES,
    maximumClockSafeBoardAgeMs: 5_000,
    sameBarPriority: ["stop_loss", "take_profit", "time_exit", "session_exit"],
    boardFailure: "latch_exit_intent_and_retry_next_same_symbol_source_event",
    exitIntentReasonImmutable: true,
  }),
  orderInstructionConnection: false,
});

export type TaiyoAfternoonVariant = "rr2_exit" | "depth_execution";
export type TaiyoAfternoonResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";
export type TaiyoAfternoonExitReason = "stop_loss" | "take_profit" | "time_exit" | "session_exit";

export type TaiyoAfternoonCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type TaiyoAfternoonInitialPending = {
  triggerSourceEventId: string;
  triggerTime: string;
  triggerClose: number;
  recentLow: number;
  morningMovePct: number;
  reversalPctFromHigh: number;
  maSlope2Pct: number;
  volumeRatio: number;
};

export type TaiyoAfternoonExecutionPending = {
  signalSourceEventId: string;
  triggerSourceEventId: string;
  confirmationSourceEventId: string;
  triggerTime: string;
  confirmationTime: string;
  confirmationClose: number;
  originalRecentLow: number;
};

export type TaiyoAfternoonExitIntent = {
  reason: TaiyoAfternoonExitReason;
  detectedSourceEventId: string;
  detectedTradeDate: string;
  detectedCandleTime: string;
  theoreticalExitPrice: number;
  retryCount: number;
};

export type TaiyoAfternoonPosition = {
  side: "short";
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
  executionProxyKind: "confirmation_candle_close" | "bid_depth_vwap_100";
  entryBoardAgeMs: number | null;
  entryAdverseMovePct: number | null;
};

export type TaiyoAfternoonState = {
  version: 1;
  variant: TaiyoAfternoonVariant;
  tradeDate: string;
  candles: TaiyoAfternoonCandle[];
  dayOpen: number | null;
  dayHigh: number | null;
  initialPending: TaiyoAfternoonInitialPending | null;
  executionPending: TaiyoAfternoonExecutionPending | null;
  position: TaiyoAfternoonPosition | null;
  exitIntent: TaiyoAfternoonExitIntent | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: TaiyoAfternoonResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type TaiyoAfternoonClosedPosition = {
  position: TaiyoAfternoonPosition;
  exitPrice: number;
  theoreticalExitPrice: number;
  exitReason: TaiyoAfternoonExitReason;
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
  executionProxyKind: "completed_candle_or_risk_line" | "ask_depth_vwap_100";
  exitBoardAgeMs: number | null;
  exitIntentRetryCount: number;
};

export type TaiyoAfternoonTransition = {
  nextState: TaiyoAfternoonState;
  resultType: TaiyoAfternoonResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: TaiyoAfternoonPosition | null;
  closedPosition: TaiyoAfternoonClosedPosition | null;
};

type DepthSide = "bid" | "ask";
type DepthResult = { price: number; requiredShares: number; availableShares: number; consumedLevels: number };

export function createEmptyTaiyoAfternoonState(variant: TaiyoAfternoonVariant): TaiyoAfternoonState {
  return {
    version: 1,
    variant,
    tradeDate: "",
    candles: [],
    dayOpen: null,
    dayHigh: null,
    initialPending: null,
    executionPending: null,
    position: null,
    exitIntent: null,
    dailySlotConsumed: false,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function normalizeTaiyoAfternoonState(
  value: unknown,
  variant: TaiyoAfternoonVariant,
  tradeDate?: string,
): TaiyoAfternoonState {
  const raw = value && typeof value === "object" ? value as Partial<TaiyoAfternoonState> : {};
  let state: TaiyoAfternoonState = {
    version: 1,
    variant,
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-420) : [],
    dayOpen: typeof raw.dayOpen === "number" ? raw.dayOpen : null,
    dayHigh: typeof raw.dayHigh === "number" ? raw.dayHigh : null,
    initialPending: raw.initialPending ?? null,
    executionPending: raw.executionPending ?? null,
    position: raw.position ?? null,
    exitIntent: raw.exitIntent ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };

  if (tradeDate && state.tradeDate !== tradeDate) {
    if (state.position) {
      const carriedPosition = state.position;
      const carriedIntent = state.exitIntent;
      state = createEmptyTaiyoAfternoonState(variant);
      state.tradeDate = tradeDate;
      state.position = carriedPosition;
      state.exitIntent = carriedIntent;
      state.dailySlotConsumed = true;
    } else {
      state = createEmptyTaiyoAfternoonState(variant);
      state.tradeDate = tradeDate;
    }
  }
  return state;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDepthLevels(value: unknown): Array<{ price: number; qty: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const price = finiteNumber(row.price ?? row.Price);
    const qty = finiteNumber(row.qty ?? row.Qty);
    return price > 0 && qty > 0 ? [{ price, qty }] : [];
  });
}

export function calculateTaiyoAfternoonDepthVwap(
  board: unknown,
  side: DepthSide,
  requiredShares = REQUIRED_DEPTH_SHARES,
): DepthResult | null {
  if (!board || typeof board !== "object" || requiredShares <= 0) return null;
  const raw = board as Record<string, unknown>;
  const value = side === "bid" ? raw.bids ?? raw.Bids : raw.asks ?? raw.Asks;
  const levels = normalizeDepthLevels(value).sort((left, right) => side === "bid"
    ? right.price - left.price
    : left.price - right.price);
  const availableShares = levels.reduce((sum, level) => sum + level.qty, 0);
  if (availableShares < requiredShares) return null;

  let remaining = requiredShares;
  let notional = 0;
  let consumedLevels = 0;
  for (const level of levels) {
    if (remaining <= 0) break;
    const consumed = Math.min(level.qty, remaining);
    notional += level.price * consumed;
    remaining -= consumed;
    consumedLevels += 1;
  }
  if (remaining > 0) return null;
  return { price: notional / requiredShares, requiredShares, availableShares, consumedLevels };
}

function sharesForMode(mode: ForwardEvaluationMode, price: number): number {
  if (mode === "signal_quality") return 100;
  const rawShares = Math.floor((3_000_000 * 0.9) / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function minutesBetween(start: string, end: string): number {
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  return endHour * 60 + endMinute - startHour * 60 - startMinute;
}

function appendCandle(state: TaiyoAfternoonState, input: ForwardSourceEventInput) {
  const candle: TaiyoAfternoonCandle = {
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  };
  state.candles.push(candle);
  state.candles = state.candles.slice(-420);
  if (state.dayOpen === null && candle.time >= "09:00") state.dayOpen = candle.open;
  state.dayHigh = state.dayHigh === null ? candle.high : Math.max(state.dayHigh, candle.high);
}

type TriggerMetrics = {
  recentLow: number;
  morningMovePct: number;
  reversalPctFromHigh: number;
  maSlope2Pct: number;
  volumeRatio: number;
};

export function calculateTaiyoAfternoonShortMetrics(
  candles: readonly TaiyoAfternoonCandle[],
  dayOpen: number | null,
  dayHigh: number | null,
): (TriggerMetrics & { eligible: boolean }) | null {
  if (candles.length < 21 || dayOpen === null || dayOpen <= 0 || dayHigh === null || dayHigh <= 0) return null;
  const candle = candles[candles.length - 1];
  if (candle.time < TAIYO_AFTERNOON_RR2_SPEC.entry.startTime || candle.time > ENTRY_END_TIME) return null;
  const morningCandles = candles.filter(item => item.time >= "09:00" && item.time < "12:00");
  if (morningCandles.length === 0) return null;
  const morningClose = morningCandles[morningCandles.length - 1].close;
  const previousFive = candles.slice(candles.length - 6, candles.length - 1);
  const previousTwenty = candles.slice(candles.length - 21, candles.length - 1);
  if (previousFive.length < 5 || previousTwenty.length < 20) return null;
  const recentLow = Math.min(...previousFive.map(item => item.low));
  const currentMa = average(candles.slice(-8).map(item => item.close));
  const previousMa = average(candles.slice(-9, -1).map(item => item.close));
  const ma2Ago = average(candles.slice(-10, -2).map(item => item.close));
  const maSlope2Pct = ma2Ago > 0 ? (currentMa - ma2Ago) / ma2Ago * 100 : 0;
  const averageVolume = average(previousTwenty.map(item => item.volume));
  const volumeRatio = averageVolume > 0 ? candle.volume / averageVolume : 0;
  const morningMovePct = (morningClose - dayOpen) / dayOpen * 100;
  const reversalPctFromHigh = (dayHigh - candle.close) / dayHigh * 100;
  const eligible = morningMovePct >= TAIYO_AFTERNOON_RR2_SPEC.entry.minimumMorningMovePct
    && reversalPctFromHigh >= TAIYO_AFTERNOON_RR2_SPEC.entry.minimumReversalFromHighPct
    && candle.close < recentLow
    && candle.close < candle.open
    && currentMa < previousMa
    && maSlope2Pct <= TAIYO_AFTERNOON_RR2_SPEC.entry.maximumMaSlope2Pct
    && volumeRatio >= TAIYO_AFTERNOON_RR2_SPEC.entry.minimumVolumeRatio;
  return { recentLow, morningMovePct, reversalPctFromHigh, maSlope2Pct, volumeRatio, eligible };
}

function finalize(
  state: TaiyoAfternoonState,
  input: ForwardSourceEventInput,
  resultType: TaiyoAfternoonResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: TaiyoAfternoonPosition | null,
  closedPosition: TaiyoAfternoonClosedPosition | null,
): TaiyoAfternoonTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

function openPosition(args: {
  state: TaiyoAfternoonState;
  input: ForwardSourceEventInput;
  mode: ForwardEvaluationMode;
  pending: TaiyoAfternoonExecutionPending;
  entryPrice: number;
  executionProxyKind: TaiyoAfternoonPosition["executionProxyKind"];
  boardAgeMs: number | null;
  adverseMovePct: number | null;
}): TaiyoAfternoonPosition {
  const position: TaiyoAfternoonPosition = {
    side: "short",
    signalSourceEventId: args.pending.signalSourceEventId,
    entrySourceEventId: args.input.sourceEventId,
    entryTradeDate: args.input.candle.tradeDate,
    signalTime: args.pending.triggerTime,
    entryTime: args.input.candle.candleTime,
    theoreticalSignalPrice: args.pending.confirmationClose,
    entryPrice: args.entryPrice,
    shares: sharesForMode(args.mode, args.entryPrice),
    slPct: 0.8,
    tpPct: 1.6,
    executionProxyKind: args.executionProxyKind,
    entryBoardAgeMs: args.boardAgeMs,
    entryAdverseMovePct: args.adverseMovePct,
  };
  args.state.position = position;
  args.state.dailySlotConsumed = true;
  return position;
}

function theoreticalClose(
  position: TaiyoAfternoonPosition,
  exitPrice: number,
  theoreticalExitPrice: number,
  exitReason: TaiyoAfternoonExitReason,
  executionProxyKind: TaiyoAfternoonClosedPosition["executionProxyKind"],
  exitBoardAgeMs: number | null,
  exitIntentRetryCount: number,
): TaiyoAfternoonClosedPosition {
  const pnl = Math.round((position.entryPrice - exitPrice) * position.shares);
  const adversePrice = exitPrice * (1 + FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const pnlAfterAdverseExit = Math.round((position.entryPrice - adversePrice) * position.shares);
  const risk = position.entryPrice * position.shares * position.slPct / 100;
  return {
    position: { ...position },
    exitPrice,
    theoreticalExitPrice,
    exitReason,
    pnl,
    pnlAfterAdverseExit,
    realizedR: risk > 0 ? pnl / risk : 0,
    executionProxyKind,
    exitBoardAgeMs,
    exitIntentRetryCount,
  };
}

function detectExitIntent(
  position: TaiyoAfternoonPosition,
  input: ForwardSourceEventInput,
): Omit<TaiyoAfternoonExitIntent, "retryCount"> | null {
  const stopLine = position.entryPrice * (1 + position.slPct / 100);
  const targetLine = position.entryPrice * (1 - position.tpPct / 100);
  if (input.candle.high >= stopLine) {
    return {
      reason: "stop_loss",
      detectedSourceEventId: input.sourceEventId,
      detectedTradeDate: input.candle.tradeDate,
      detectedCandleTime: input.candle.candleTime,
      theoreticalExitPrice: Math.max(input.candle.open, stopLine),
    };
  }
  if (input.candle.low <= targetLine) {
    return {
      reason: "take_profit",
      detectedSourceEventId: input.sourceEventId,
      detectedTradeDate: input.candle.tradeDate,
      detectedCandleTime: input.candle.candleTime,
      theoreticalExitPrice: targetLine,
    };
  }
  if (input.candle.tradeDate !== position.entryTradeDate) {
    return {
      reason: "session_exit",
      detectedSourceEventId: input.sourceEventId,
      detectedTradeDate: input.candle.tradeDate,
      detectedCandleTime: input.candle.candleTime,
      theoreticalExitPrice: input.candle.close,
    };
  }
  if (minutesBetween(position.entryTime, input.candle.candleTime) >= 45) {
    return {
      reason: "time_exit",
      detectedSourceEventId: input.sourceEventId,
      detectedTradeDate: input.candle.tradeDate,
      detectedCandleTime: input.candle.candleTime,
      theoreticalExitPrice: input.candle.close,
    };
  }
  if (input.candle.candleTime >= SESSION_EXIT_TIME) {
    return {
      reason: "session_exit",
      detectedSourceEventId: input.sourceEventId,
      detectedTradeDate: input.candle.tradeDate,
      detectedCandleTime: input.candle.candleTime,
      theoreticalExitPrice: input.candle.close,
    };
  }
  return null;
}

function boardAudit(input: ForwardSourceEventInput) {
  const age = calculateClockSafeBoardAge(input.currentAudit);
  const boardObservedAtMs = input.currentAudit?.boardObservedAtMs ?? null;
  const relayAssembledAtMs = input.currentAudit?.relayAssembledAtMs ?? null;
  const sourceCausal = boardObservedAtMs !== null
    && relayAssembledAtMs !== null
    && boardObservedAtMs <= relayAssembledAtMs;
  const accepted = age.timestampsAvailable && age.causal && age.fresh && sourceCausal;
  return { ...age, sourceCausal, accepted };
}

function boardFailureReason(
  input: ForwardSourceEventInput,
  audit: ReturnType<typeof boardAudit>,
  depth: DepthResult | null,
): string | null {
  if (!input.board) return "board_snapshot_missing";
  if (!audit.timestampsAvailable || input.currentAudit?.boardObservedAtMs === null) return "board_timestamps_unavailable";
  if (!audit.causal || !audit.sourceCausal) return "board_same_clock_interval_negative";
  if (!audit.fresh) return "board_snapshot_stale_over_5000ms";
  if (!depth) return "board_depth_under_100_shares";
  return null;
}

function tryExecuteDepthExit(
  state: TaiyoAfternoonState,
  input: ForwardSourceEventInput,
  actions: Array<Record<string, unknown>>,
): TaiyoAfternoonClosedPosition | null {
  if (!state.position || !state.exitIntent) return null;
  const depth = calculateTaiyoAfternoonDepthVwap(input.board, "ask");
  const audit = boardAudit(input);
  const failureReason = boardFailureReason(input, audit, depth);
  if (failureReason || !depth) {
    state.exitIntent.retryCount += 1;
    actions.push({
      type: "exit_intent_retry_pending",
      reason: state.exitIntent.reason,
      failureReason,
      detectedSourceEventId: state.exitIntent.detectedSourceEventId,
      retryCount: state.exitIntent.retryCount,
      boardAgeMs: audit.boardAgeMs,
    });
    return null;
  }
  const closed = theoreticalClose(
    state.position,
    depth.price,
    state.exitIntent.theoreticalExitPrice,
    state.exitIntent.reason,
    "ask_depth_vwap_100",
    audit.boardAgeMs,
    state.exitIntent.retryCount,
  );
  actions.push({
    type: "exit",
    reason: closed.exitReason,
    exitPrice: closed.exitPrice,
    theoreticalExitPrice: closed.theoreticalExitPrice,
    priceSource: "ask_depth_vwap_100",
    exitIntentRetryCount: closed.exitIntentRetryCount,
    pnl: closed.pnl,
    pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
    realizedR: closed.realizedR,
  });
  state.position = null;
  state.exitIntent = null;
  return closed;
}

function createInitialPending(
  state: TaiyoAfternoonState,
  input: ForwardSourceEventInput,
): TaiyoAfternoonInitialPending | null {
  const metrics = calculateTaiyoAfternoonShortMetrics(state.candles, state.dayOpen, state.dayHigh);
  if (!metrics?.eligible) return null;
  const pending: TaiyoAfternoonInitialPending = {
    triggerSourceEventId: input.sourceEventId,
    triggerTime: input.candle.candleTime,
    triggerClose: input.candle.close,
    recentLow: metrics.recentLow,
    morningMovePct: metrics.morningMovePct,
    reversalPctFromHigh: metrics.reversalPctFromHigh,
    maSlope2Pct: metrics.maSlope2Pct,
    volumeRatio: metrics.volumeRatio,
  };
  state.initialPending = pending;
  return pending;
}

function applyTransition(
  stateBefore: TaiyoAfternoonState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
  variant: TaiyoAfternoonVariant,
): TaiyoAfternoonTransition {
  const state = normalizeTaiyoAfternoonState(stateBefore, variant, input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: TaiyoAfternoonResultType = "no_signal";
  let openedPosition: TaiyoAfternoonPosition | null = null;
  let closedPosition: TaiyoAfternoonClosedPosition | null = null;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < TAIYO_AFTERNOON_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: TAIYO_AFTERNOON_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.position) {
    if (variant === "depth_execution") {
      if (!state.exitIntent) {
        const detected = detectExitIntent(state.position, input);
        if (detected) {
          state.exitIntent = { ...detected, retryCount: 0 };
          actions.push({
            type: "exit_intent_latched",
            reason: detected.reason,
            theoreticalExitPrice: detected.theoreticalExitPrice,
            reasonImmutable: true,
          });
        }
      }
      if (state.exitIntent) {
        closedPosition = tryExecuteDepthExit(state, input, actions);
        resultType = closedPosition ? "exit" : "hold";
      } else {
        resultType = "hold";
      }
    } else {
      const detected = detectExitIntent(state.position, input);
      if (detected) {
        closedPosition = theoreticalClose(
          state.position,
          detected.theoreticalExitPrice,
          detected.theoreticalExitPrice,
          detected.reason,
          "completed_candle_or_risk_line",
          null,
          0,
        );
        state.position = null;
        resultType = "exit";
        actions.push({
          type: "exit",
          reason: closedPosition.exitReason,
          exitPrice: closedPosition.exitPrice,
          priceSource: "completed_candle_or_risk_line",
          pnl: closedPosition.pnl,
          pnlAfterAdverseExit: closedPosition.pnlAfterAdverseExit,
          realizedR: closedPosition.realizedR,
        });
      } else {
        resultType = "hold";
      }
    }
    return finalize(state, input, resultType, actions, null, closedPosition);
  }

  if (state.executionPending) {
    const pending = state.executionPending;
    state.executionPending = null;
    if (input.candle.candleTime > ENTRY_END_TIME) {
      resultType = "rejected";
      actions.push({
        type: "entry_rejected",
        reason: "execution_time_expired",
        originalSignalSourceEventId: pending.signalSourceEventId,
        dailySlotConsumed: false,
      });
    } else {
      const depth = calculateTaiyoAfternoonDepthVwap(input.board, "bid");
      const audit = boardAudit(input);
      const failureReason = boardFailureReason(input, audit, depth);
      const adverseMovePct = depth && pending.confirmationClose > 0
        ? (pending.confirmationClose - depth.price) / pending.confirmationClose * 100
        : null;
      const continuation = depth !== null && depth.price <= pending.confirmationClose;
      const originalLowMaintained = depth !== null && depth.price < pending.originalRecentLow;
      const adverseMoveAccepted = adverseMovePct !== null
        && adverseMovePct >= 0
        && adverseMovePct <= TAIYO_AFTERNOON_DEPTH_SPEC.entry.maximumAdverseMovePct;
      if (failureReason || !depth || !continuation || !originalLowMaintained || !adverseMoveAccepted) {
        resultType = "rejected";
        actions.push({
          type: "entry_rejected",
          reason: failureReason
            ?? (!continuation
              ? "breakdown_not_continued_at_bid_depth"
              : !originalLowMaintained
                ? "original_five_bar_low_not_maintained"
                : "adverse_entry_move_over_010pct"),
          bidDepthVwap: depth?.price ?? null,
          confirmationClose: pending.confirmationClose,
          originalRecentLow: pending.originalRecentLow,
          adverseMovePct,
          boardAgeMs: audit.boardAgeMs,
          dailySlotConsumed: false,
          rejectedCandidateSearch: "next_source_event_new_initial_only",
        });
      } else {
        openedPosition = openPosition({
          state,
          input,
          mode,
          pending,
          entryPrice: depth.price,
          executionProxyKind: "bid_depth_vwap_100",
          boardAgeMs: audit.boardAgeMs,
          adverseMovePct,
        });
        resultType = "entry";
        actions.push({
          type: "entry",
          side: "short",
          entryPrice: openedPosition.entryPrice,
          theoreticalSignalPrice: openedPosition.theoreticalSignalPrice,
          priceSource: "bid_depth_vwap_100",
          adverseMovePct,
          boardAgeMs: audit.boardAgeMs,
          shares: openedPosition.shares,
        });
      }
    }
    return finalize(state, input, resultType, actions, openedPosition, null);
  }

  if (state.initialPending) {
    const pending = state.initialPending;
    if (input.candle.candleTime <= pending.triggerTime) {
      return finalize(state, input, "pending", [{ type: "confirmation_waiting" }], null, null);
    }
    state.initialPending = null;
    const confirmationAllowed = input.candle.candleTime <= ENTRY_END_TIME
      && input.candle.close < pending.triggerClose
      && input.candle.close < input.candle.open;
    if (!confirmationAllowed) {
      return finalize(state, input, "rejected", [{
        type: "confirmation_rejected",
        reason: input.candle.candleTime > ENTRY_END_TIME ? "confirmation_time_expired" : "current_confirmation_failed",
        originalSignalSourceEventId: pending.triggerSourceEventId,
        sameCandleRedetectionAllowed: false,
        nextSourceEventSearchAllowed: true,
      }], null, null);
    }

    const executionPending: TaiyoAfternoonExecutionPending = {
      signalSourceEventId: pending.triggerSourceEventId,
      triggerSourceEventId: pending.triggerSourceEventId,
      confirmationSourceEventId: input.sourceEventId,
      triggerTime: pending.triggerTime,
      confirmationTime: input.candle.candleTime,
      confirmationClose: input.candle.close,
      originalRecentLow: pending.recentLow,
    };
    if (variant === "depth_execution") {
      state.executionPending = executionPending;
      return finalize(state, input, "pending", [{
        type: "execution_pending",
        confirmationClose: executionPending.confirmationClose,
        originalRecentLow: executionPending.originalRecentLow,
        executeOnNextSameSymbolSourceEvent: true,
      }], null, null);
    }

    openedPosition = openPosition({
      state,
      input,
      mode,
      pending: executionPending,
      entryPrice: input.candle.close,
      executionProxyKind: "confirmation_candle_close",
      boardAgeMs: null,
      adverseMovePct: null,
    });
    return finalize(state, input, "entry", [{
      type: "entry",
      side: "short",
      entryPrice: openedPosition.entryPrice,
      priceSource: "completed_confirmation_candle_close",
      shares: openedPosition.shares,
    }], openedPosition, null);
  }

  if (!state.dailySlotConsumed) {
    const pending = createInitialPending(state, input);
    if (pending) {
      resultType = "pending";
      actions.push({
        type: "initial_pending",
        side: "short",
        triggerClose: pending.triggerClose,
        recentLow: pending.recentLow,
        morningMovePct: pending.morningMovePct,
        reversalPctFromHigh: pending.reversalPctFromHigh,
        maSlope2Pct: pending.maSlope2Pct,
        volumeRatio: pending.volumeRatio,
      });
    }
  }
  return finalize(state, input, resultType, actions, openedPosition, closedPosition);
}

export function applyTaiyoAfternoonRr2Transition(
  stateBefore: TaiyoAfternoonState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): TaiyoAfternoonTransition {
  return applyTransition(stateBefore, input, mode, "rr2_exit");
}

export function applyTaiyoAfternoonDepthTransition(
  stateBefore: TaiyoAfternoonState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): TaiyoAfternoonTransition {
  return applyTransition(stateBefore, input, mode, "depth_execution");
}
