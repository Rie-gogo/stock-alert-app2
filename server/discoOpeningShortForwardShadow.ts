import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { analyzeOrderBook, type KabuOrderBook } from "./kabuStation";
import { calcATR } from "./intradayRegime";
import {
  calcBollinger,
  calcMA,
  calcRSI,
  detectSignals,
  type CandleWithSignal,
} from "./routers/stockData";
import { calculateClockSafeBoardAge, calculateDepthVwap } from "./telExecutableConfirmDepth";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";

export const DISCO_SHORT_LEARNING_CUTOFF_DATE = "2026-09-10";
export const DISCO_SHORT_COLLECTION_START_DATE = "2026-09-11";
export const DISCO_SHORT_FORMAL_START_DATE = "2026-09-11";

const COMMON_ENTRY = Object.freeze({
  startTime: "09:30",
  endTime: "10:45",
  minimumWarmupBars: 30,
  lookback: 10,
  maPeriod: 8,
  maxOpenGainPct: -1.0,
  maxMaSlopePct: 0,
  minVolumeRatio: 0.8,
  atrPeriod: 7,
  minAtrPct: 0.12,
});

const COMMON_EXIT = Object.freeze({
  slPct: 0.5,
  tpPct: 2.0,
  profitProtectionTriggerPct: 0.8,
  profitProtectionFloorPct: 0.7,
  profitProtectionStarts: "next_source_event_after_arming",
  sessionExitTime: "11:27",
  signalReversalExit: true,
  boardEarlyExit: true,
  boardEarlyExitMinProfitPct: 0.05,
  sameBarPriority: [
    "stop_loss",
    "previously_armed_profit_protection",
    "take_profit",
    "signal_reversal",
    "board_early_exit",
    "session_exit",
  ],
});

export const DISCO_SHORT_BASELINE_SPEC = Object.freeze({
  symbol: "6146",
  routeId: "discoOpeningBreakShort",
  candidateKey: "6146_opening_short_paused_current_baseline",
  role: "paused_current_route_shadow_baseline",
  historicalRole: "paused_current_route_comparison_only",
  entry: Object.freeze({
    ...COMMON_ENTRY,
    timing: "completed_signal_candle",
    price: "completed_signal_candle_close",
    rejectionConsumesDailySlot: false,
  }),
  exit: COMMON_EXIT,
  eligibleForAdoption: false,
  automaticAdoption: false,
  orderInstructionConnection: false,
});

export const DISCO_SHORT_EXECUTABLE_SPEC = Object.freeze({
  symbol: "6146",
  routeId: "discoOpeningBreakShort",
  candidateKey: "6146_opening_short_a_next_event_bid_depth",
  role: "entry_execution_quality_candidate",
  historicalRole: "forward_unseen_candidate_no_historical_performance_claim",
  entry: Object.freeze({
    ...COMMON_ENTRY,
    timing: "next_6146_source_event_after_signal",
    price: "bid_depth_vwap_for_evaluation_shares",
    executionDepthShares: "signal_quality_100_or_capital_constrained_planned_shares",
    maximumAdverseEntryPct: 0.10,
    maximumClockSafeBoardAgeMs: 5_000,
    requireExecutablePriceBelowOriginalBreakoutLevel: true,
    rejectedCandidateSearch: "discard_original_signal_and_continue_next_candle",
    rejectionConsumesDailySlot: false,
  }),
  exit: COMMON_EXIT,
  eligibleForAdoption: true,
  automaticAdoption: false,
  orderInstructionConnection: false,
});

export const DISCO_SHORT_RETEST_SPEC = Object.freeze({
  symbol: "6146",
  routeId: "discoOpeningBreakShort",
  candidateKey: "6146_opening_short_b_failed_retest_rebreak",
  role: "price_structure_confirmation_candidate",
  historicalRole: "forward_unseen_candidate_no_historical_performance_claim",
  entry: Object.freeze({
    ...COMMON_ENTRY,
    trigger: "current_10_bar_close_breakdown",
    retestWindowMinutes: 5,
    retestNearBrokenLevelPct: 0.10,
    retestMustCloseBelowBrokenLevel: true,
    rebreakWindowMinutes: 5,
    rebreak: "bearish_close_below_trigger_and_retest_lows",
    executionTiming: "next_6146_source_event_after_rebreak_confirmation",
    price: "bid_depth_vwap_for_evaluation_shares",
    executionDepthShares: "signal_quality_100_or_capital_constrained_planned_shares",
    maximumAdverseEntryPct: 0.10,
    maximumClockSafeBoardAgeMs: 5_000,
    requireExecutablePriceBelowRebreakLevel: true,
    rejectionConsumesDailySlot: false,
    rejectedCandidateSearch: "discard_structure_and_continue_next_candle",
  }),
  exit: COMMON_EXIT,
  eligibleForAdoption: true,
  automaticAdoption: false,
  orderInstructionConnection: false,
});

export type DiscoShortVariant = "paused_baseline" | "executable_a" | "retest_b";
export type DiscoShortResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

export type DiscoShortCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type TriggerMetrics = {
  breakoutLevel: number;
  openGainPct: number;
  maSlopePct: number;
  volumeRatio: number;
  atrPct: number | null;
  eligibleBeforeAtr: boolean;
  eligible: boolean;
};

type PendingExecutable = {
  kind: "executable";
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  breakoutLevel: number;
  metrics: TriggerMetrics;
};

type PendingRetest = {
  kind: "retest";
  phase: "awaiting_retest" | "awaiting_rebreak" | "awaiting_execution";
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  breakoutLevel: number;
  triggerLow: number;
  metrics: TriggerMetrics;
  retestSourceEventId: string | null;
  retestTime: string | null;
  retestLow: number | null;
  rebreakSourceEventId: string | null;
  rebreakTime: string | null;
  rebreakClose: number | null;
  rebreakLevel: number | null;
};

export type DiscoShortPending = PendingExecutable | PendingRetest;

export type DiscoShortPosition = {
  side: "short";
  signalSourceEventId: string;
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  shares: number;
  slPct: number;
  tpPct: number;
  executionProxyKind: "signal_candle_close" | "bid_depth_vwap";
  breakoutLevel: number;
  profitProtectionArmedAtSourceEventId: string | null;
};

export type DiscoShortState = {
  version: 1;
  variant: DiscoShortVariant;
  tradeDate: string;
  candles: DiscoShortCandle[];
  pending: DiscoShortPending | null;
  position: DiscoShortPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: DiscoShortResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type DiscoShortClosedPosition = {
  position: DiscoShortPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "profit_protection" | "signal_reversal" | "board_early_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type DiscoShortTransition = {
  nextState: DiscoShortState;
  resultType: DiscoShortResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: DiscoShortPosition | null;
  closedPosition: DiscoShortClosedPosition | null;
};

export function createEmptyDiscoShortState(variant: DiscoShortVariant): DiscoShortState {
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

export function normalizeDiscoShortState(
  value: unknown,
  variant: DiscoShortVariant,
  tradeDate?: string,
): DiscoShortState {
  const raw = value && typeof value === "object" ? value as Partial<DiscoShortState> : {};
  let state: DiscoShortState = {
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
    state = createEmptyDiscoShortState(variant);
    state.tradeDate = tradeDate;
  }
  return state;
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

function evaluateShortExecution(input: {
  source: ForwardSourceEventInput;
  mode: ForwardEvaluationMode;
  theoreticalPrice: number;
  breakoutLevel: number;
  maximumAdverseEntryPct: number;
}) {
  // まず最良気配に相当する100株VWAPだけを読み、評価方式の予定株数を決める。
  // その後、必ずその予定株数すべてを消費したdepth VWAPで約定可否と損益を評価する。
  const sizingDepth = calculateDepthVwap({ board: input.source.board, side: "short", shares: 100 });
  const shares = sizingDepth ? sharesForMode(input.mode, sizingDepth.price) : null;
  const depth = shares === null
    ? null
    : calculateDepthVwap({ board: input.source.board, side: "short", shares });
  const executablePrice = depth?.price ?? null;
  const clockAge = calculateClockSafeBoardAge(input.source.currentAudit);
  const boardObservedAtMs = input.source.currentAudit?.boardObservedAtMs ?? null;
  const relayAssembledAtMs = input.source.currentAudit?.relayAssembledAtMs ?? null;
  const boardSourceCausal = boardObservedAtMs !== null
    && relayAssembledAtMs !== null
    && boardObservedAtMs <= relayAssembledAtMs;
  const adverseEntryPct = executablePrice === null
    ? null
    : (input.theoreticalPrice - executablePrice) / input.theoreticalPrice * 100;
  const breakoutMaintained = executablePrice !== null && executablePrice < input.breakoutLevel;
  const adverseAllowed = adverseEntryPct !== null
    && adverseEntryPct <= input.maximumAdverseEntryPct;
  const accepted = clockAge.timestampsAvailable
    && clockAge.causal
    && clockAge.fresh
    && boardSourceCausal
    && shares !== null
    && executablePrice !== null
    && breakoutMaintained
    && adverseAllowed;
  const rejectionReason = accepted
    ? null
    : !clockAge.timestampsAvailable
      ? "board_observed_or_decision_time_unavailable"
      : !clockAge.causal || !boardSourceCausal
        ? "board_source_not_causal"
        : !clockAge.fresh
          ? "board_snapshot_stale_over_5000ms"
          : executablePrice === null || shares === null
            ? "insufficient_bid_depth_for_evaluation_shares"
            : !breakoutMaintained
              ? "breakout_not_maintained_at_next_event"
              : "adverse_entry_gap_over_010pct";
  return {
    accepted,
    rejectionReason,
    shares,
    depth,
    executablePrice,
    clockAge,
    boardSourceCausal,
    adverseEntryPct,
    breakoutMaintained,
  };
}

function appendCandle(state: DiscoShortState, input: ForwardSourceEventInput) {
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

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function calculateDiscoShortTriggerMetrics(candles: DiscoShortCandle[]): TriggerMetrics | null {
  if (candles.length < COMMON_ENTRY.minimumWarmupBars) return null;
  const candle = candles[candles.length - 1];
  const prior = candles.slice(candles.length - 1 - COMMON_ENTRY.lookback, candles.length - 1);
  const priorTwenty = candles.slice(candles.length - 21, candles.length - 1);
  const currentMa = average(candles.slice(-COMMON_ENTRY.maPeriod).map(item => item.close));
  const previousMa = average(candles.slice(-COMMON_ENTRY.maPeriod - 1, -1).map(item => item.close));
  const maSlopePct = previousMa > 0 ? (currentMa - previousMa) / previousMa * 100 : 0;
  const avgVolume = average(priorTwenty.map(item => item.volume));
  const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 0;
  const dayOpen = candles[0]?.open ?? candle.open;
  const openGainPct = dayOpen > 0 ? (candle.close - dayOpen) / dayOpen * 100 : 0;
  const breakoutLevel = Math.min(...prior.map(item => item.low));
  const atr = calcATR(
    candles.map(item => item.high),
    candles.map(item => item.low),
    candles.map(item => item.close),
    COMMON_ENTRY.atrPeriod,
  ).at(-1);
  const atrPct = atr !== null && atr !== undefined && candle.close > 0 ? atr / candle.close * 100 : null;
  const eligibleBeforeAtr = openGainPct <= COMMON_ENTRY.maxOpenGainPct
    && candle.close < breakoutLevel
    && maSlopePct <= COMMON_ENTRY.maxMaSlopePct
    && volumeRatio >= COMMON_ENTRY.minVolumeRatio;
  const eligible = eligibleBeforeAtr && (atrPct === null || atrPct >= COMMON_ENTRY.minAtrPct);
  return { breakoutLevel, openGainPct, maSlopePct, volumeRatio, atrPct, eligibleBeforeAtr, eligible };
}

function currentRawSignal(candles: DiscoShortCandle[]) {
  const rows: CandleWithSignal[] = candles.map((candle, index) => ({
    time: `2000-01-01T${candle.time}:00`,
    dayKey: "2000-01-01",
    timestamp: index,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    ma5: null,
    ma25: null,
    rsi: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
  }));
  const closes = rows.map(row => row.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20);
  rows.forEach((row, index) => {
    row.ma5 = ma5[index];
    row.ma25 = ma25[index];
    row.rsi = rsi[index];
    row.bbUpper = bb.upper[index];
    row.bbMiddle = bb.middle[index];
    row.bbLower = bb.lower[index];
  });
  return detectSignals(rows).at(-1)?.signal ?? null;
}

function boardExitSignal(input: ForwardSourceEventInput): string {
  if (!input.board || typeof input.board !== "object") return "neutral";
  const raw = input.board as Record<string, unknown>;
  try {
    const signals = analyzeOrderBook({
      ...(raw as unknown as Omit<KabuOrderBook, "symbol" | "receivedAt">),
      symbol: "6146",
      receivedAt: 0,
    });
    if (signals.some(signal => signal.type === "board_buy_pressure")) return "buy_pressure";
    if (signals.some(signal => signal.type === "board_sell_pressure")) return "sell_pressure";
    if (signals.some(signal => signal.type === "large_bid_wall")) return "large_buy_wall";
    if (signals.some(signal => signal.type === "large_ask_wall")) return "large_sell_wall";
    if (signals.some(signal => signal.type === "market_order_surge")) return "market_surge";
  } catch {
    // 不完全な板payloadは中立として扱い、入口Aだけがdepth不足で拒否する。
  }
  return "neutral";
}

function closePosition(
  position: DiscoShortPosition,
  exitPrice: number,
  exitReason: DiscoShortClosedPosition["exitReason"],
): DiscoShortClosedPosition {
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

function calculateExit(
  position: DiscoShortPosition,
  state: DiscoShortState,
  input: ForwardSourceEventInput,
): DiscoShortClosedPosition | null {
  const stopLine = position.entryPrice * (1 + position.slPct / 100);
  if (input.candle.high >= stopLine) return closePosition(position, stopLine, "stop_loss");

  const targetLine = position.entryPrice * (1 - position.tpPct / 100);
  const protectLine = position.entryPrice * (1 - COMMON_EXIT.profitProtectionFloorPct / 100);
  const armedBefore = position.profitProtectionArmedAtSourceEventId !== null
    && position.profitProtectionArmedAtSourceEventId !== input.sourceEventId;
  if (armedBefore && input.candle.high >= protectLine) {
    return closePosition(position, Math.max(input.candle.open, protectLine), "profit_protection");
  }
  if (input.candle.low <= targetLine) return closePosition(position, targetLine, "take_profit");

  const rawSignal = currentRawSignal(state.candles);
  if (rawSignal?.type === "buy") return closePosition(position, input.candle.close, "signal_reversal");

  const pnlPct = (position.entryPrice - input.candle.close) / position.entryPrice * 100;
  const boardSignal = boardExitSignal(input);
  if (pnlPct >= COMMON_EXIT.boardEarlyExitMinProfitPct
    && (boardSignal === "buy_pressure" || boardSignal === "large_buy_wall")) {
    return closePosition(position, input.candle.close, "board_early_exit");
  }

  if (input.candle.candleTime >= COMMON_EXIT.sessionExitTime) {
    return closePosition(position, input.candle.close, "session_exit");
  }
  return null;
}

function armProtection(position: DiscoShortPosition, input: ForwardSourceEventInput) {
  if (position.profitProtectionArmedAtSourceEventId !== null) return;
  const triggerLine = position.entryPrice * (1 - COMMON_EXIT.profitProtectionTriggerPct / 100);
  if (input.candle.low <= triggerLine) position.profitProtectionArmedAtSourceEventId = input.sourceEventId;
}

function createPosition(input: {
  source: ForwardSourceEventInput;
  mode: ForwardEvaluationMode;
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  shares: number;
  breakoutLevel: number;
  executionProxyKind: DiscoShortPosition["executionProxyKind"];
}): DiscoShortPosition {
  return {
    side: "short",
    signalSourceEventId: input.signalSourceEventId,
    entrySourceEventId: input.source.sourceEventId,
    signalTime: input.signalTime,
    entryTime: input.source.candle.candleTime,
    theoreticalSignalPrice: input.theoreticalSignalPrice,
    entryPrice: input.entryPrice,
    shares: input.shares,
    slPct: COMMON_EXIT.slPct,
    tpPct: COMMON_EXIT.tpPct,
    executionProxyKind: input.executionProxyKind,
    breakoutLevel: input.breakoutLevel,
    profitProtectionArmedAtSourceEventId: null,
  };
}

function finalize(
  state: DiscoShortState,
  input: ForwardSourceEventInput,
  resultType: DiscoShortResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: DiscoShortPosition | null,
  closedPosition: DiscoShortClosedPosition | null,
): DiscoShortTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

export function applyDiscoShortTransition(
  stateBefore: DiscoShortState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
  variant: DiscoShortVariant,
): DiscoShortTransition {
  const state = normalizeDiscoShortState(stateBefore, variant, input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: DiscoShortResultType = "no_signal";
  let openedPosition: DiscoShortPosition | null = null;
  let closedPosition: DiscoShortClosedPosition | null = null;
  let skipSignalDetection = false;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < DISCO_SHORT_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: DISCO_SHORT_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.position) {
    closedPosition = calculateExit(state.position, state, input);
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
      armProtection(state.position, input);
      resultType = "hold";
    }
  }

  if (!state.position && !state.dailySlotConsumed && state.pending?.kind === "executable") {
    const pending = state.pending;
    state.pending = null;
    skipSignalDetection = true;
    const execution = evaluateShortExecution({
      source: input,
      mode,
      theoreticalPrice: pending.theoreticalSignalPrice,
      breakoutLevel: pending.breakoutLevel,
      maximumAdverseEntryPct: DISCO_SHORT_EXECUTABLE_SPEC.entry.maximumAdverseEntryPct,
    });
    if (execution.accepted) {
      state.position = createPosition({
        source: input,
        mode,
        signalSourceEventId: pending.signalSourceEventId,
        signalTime: pending.signalTime,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        entryPrice: execution.executablePrice!,
        shares: execution.shares!,
        breakoutLevel: pending.breakoutLevel,
        executionProxyKind: "bid_depth_vwap",
      });
      openedPosition = { ...state.position };
      state.dailySlotConsumed = true;
      resultType = "entry";
      actions.push({
        type: "entry",
        variant,
        executablePrice: execution.executablePrice,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        breakoutLevel: pending.breakoutLevel,
        adverseEntryPct: execution.adverseEntryPct,
        boardAgeMs: execution.clockAge.boardAgeMs,
        boardSourceCausal: execution.boardSourceCausal,
        executionDepthShares: execution.shares,
        depth: execution.depth,
      });
    } else {
      resultType = "rejected";
      actions.push({
        type: "entry_rejected",
        variant,
        reason: execution.rejectionReason,
        originalSignalSourceEventId: pending.signalSourceEventId,
        executablePrice: execution.executablePrice,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        breakoutLevel: pending.breakoutLevel,
        adverseEntryPct: execution.adverseEntryPct,
        boardAgeMs: execution.clockAge.boardAgeMs,
        boardSourceCausal: execution.boardSourceCausal,
        executionDepthShares: execution.shares,
        depth: execution.depth,
        dailySlotConsumed: false,
      });
    }
  }

  if (!state.position && !state.dailySlotConsumed && state.pending?.kind === "retest") {
    const pending = state.pending;
    if (pending.phase === "awaiting_retest") {
      const elapsed = minutesBetween(pending.signalTime, input.candle.candleTime);
      const reclaimed = input.candle.close >= pending.breakoutLevel;
      const timedOut = elapsed > DISCO_SHORT_RETEST_SPEC.entry.retestWindowMinutes;
      const nearLevel = input.candle.high >= pending.breakoutLevel
        * (1 - DISCO_SHORT_RETEST_SPEC.entry.retestNearBrokenLevelPct / 100);
      if (reclaimed || timedOut) {
        state.pending = null;
        resultType = "rejected";
        actions.push({
          type: "retest_rejected",
          reason: reclaimed ? "broken_level_reclaimed" : "retest_timeout",
          originalSignalSourceEventId: pending.signalSourceEventId,
          dailySlotConsumed: false,
        });
      } else if (nearLevel && input.candle.close < pending.breakoutLevel) {
        pending.phase = "awaiting_rebreak";
        pending.retestSourceEventId = input.sourceEventId;
        pending.retestTime = input.candle.candleTime;
        pending.retestLow = input.candle.low;
        resultType = "pending";
        skipSignalDetection = true;
        actions.push({
          type: "failed_retest_confirmed",
          originalSignalSourceEventId: pending.signalSourceEventId,
          breakoutLevel: pending.breakoutLevel,
          retestHigh: input.candle.high,
          retestLow: input.candle.low,
          retestClose: input.candle.close,
        });
      } else {
        resultType = "pending";
        skipSignalDetection = true;
      }
    } else if (pending.phase === "awaiting_rebreak") {
      const elapsed = minutesBetween(pending.retestTime!, input.candle.candleTime);
      const reclaimed = input.candle.close >= pending.breakoutLevel;
      const timedOut = elapsed > DISCO_SHORT_RETEST_SPEC.entry.rebreakWindowMinutes;
      const rebreakLevel = Math.min(pending.triggerLow, pending.retestLow!);
      const rebreak = input.candle.close < rebreakLevel && input.candle.close < input.candle.open;
      if (rebreak) {
        const metrics = calculateDiscoShortTriggerMetrics(state.candles);
        const atrEligible = metrics?.atrPct === null || metrics?.atrPct === undefined
          || metrics.atrPct >= COMMON_ENTRY.minAtrPct;
        if (atrEligible) {
          pending.phase = "awaiting_execution";
          pending.rebreakSourceEventId = input.sourceEventId;
          pending.rebreakTime = input.candle.candleTime;
          pending.rebreakClose = input.candle.close;
          pending.rebreakLevel = rebreakLevel;
          resultType = "pending";
          skipSignalDetection = true;
          actions.push({
            type: "rebreak_execution_pending",
            variant,
            originalSignalSourceEventId: pending.signalSourceEventId,
            retestSourceEventId: pending.retestSourceEventId,
            rebreakSourceEventId: input.sourceEventId,
            rebreakLevel,
            rebreakClose: input.candle.close,
            atrPct: metrics?.atrPct ?? null,
          });
        } else {
          state.pending = null;
          resultType = "rejected";
          actions.push({ type: "entry_rejected", reason: "atr_below_012pct", dailySlotConsumed: false });
        }
      } else if (reclaimed || timedOut) {
        state.pending = null;
        resultType = "rejected";
        actions.push({
          type: "rebreak_rejected",
          reason: reclaimed ? "broken_level_reclaimed" : "rebreak_timeout",
          originalSignalSourceEventId: pending.signalSourceEventId,
          dailySlotConsumed: false,
        });
      } else {
        resultType = "pending";
        skipSignalDetection = true;
      }
    } else {
      const execution = evaluateShortExecution({
        source: input,
        mode,
        theoreticalPrice: pending.rebreakClose!,
        breakoutLevel: pending.rebreakLevel!,
        maximumAdverseEntryPct: DISCO_SHORT_RETEST_SPEC.entry.maximumAdverseEntryPct,
      });
      state.pending = null;
      skipSignalDetection = true;
      if (execution.accepted) {
        state.position = createPosition({
          source: input,
          mode,
          signalSourceEventId: pending.signalSourceEventId,
          signalTime: pending.rebreakTime!,
          theoreticalSignalPrice: pending.rebreakClose!,
          entryPrice: execution.executablePrice!,
          shares: execution.shares!,
          breakoutLevel: pending.rebreakLevel!,
          executionProxyKind: "bid_depth_vwap",
        });
        openedPosition = { ...state.position };
        state.dailySlotConsumed = true;
        resultType = "entry";
        actions.push({
          type: "entry",
          variant,
          originalSignalSourceEventId: pending.signalSourceEventId,
          retestSourceEventId: pending.retestSourceEventId,
          rebreakSourceEventId: pending.rebreakSourceEventId,
          executionSourceEventId: input.sourceEventId,
          rebreakLevel: pending.rebreakLevel,
          theoreticalRebreakPrice: pending.rebreakClose,
          executablePrice: execution.executablePrice,
          adverseEntryPct: execution.adverseEntryPct,
          boardAgeMs: execution.clockAge.boardAgeMs,
          boardSourceCausal: execution.boardSourceCausal,
          executionDepthShares: execution.shares,
          depth: execution.depth,
        });
      } else {
        resultType = "rejected";
        actions.push({
          type: "entry_rejected",
          variant,
          reason: execution.rejectionReason,
          originalSignalSourceEventId: pending.signalSourceEventId,
          rebreakSourceEventId: pending.rebreakSourceEventId,
          executionSourceEventId: input.sourceEventId,
          rebreakLevel: pending.rebreakLevel,
          theoreticalRebreakPrice: pending.rebreakClose,
          executablePrice: execution.executablePrice,
          adverseEntryPct: execution.adverseEntryPct,
          boardAgeMs: execution.clockAge.boardAgeMs,
          boardSourceCausal: execution.boardSourceCausal,
          executionDepthShares: execution.shares,
          depth: execution.depth,
          dailySlotConsumed: false,
        });
      }
    }
  }

  if (!state.position
    && !state.pending
    && !state.dailySlotConsumed
    && !skipSignalDetection
    && input.candle.candleTime >= COMMON_ENTRY.startTime
    && input.candle.candleTime <= COMMON_ENTRY.endTime) {
    const metrics = calculateDiscoShortTriggerMetrics(state.candles);
    if (metrics?.eligibleBeforeAtr && !metrics.eligible) {
      resultType = "rejected";
      actions.push({
        type: "entry_rejected",
        reason: "atr_below_012pct",
        atrPct: metrics.atrPct,
        dailySlotConsumed: false,
      });
    } else if (metrics?.eligible) {
      if (variant === "paused_baseline") {
        state.position = createPosition({
          source: input,
          mode,
          signalSourceEventId: input.sourceEventId,
          signalTime: input.candle.candleTime,
          theoreticalSignalPrice: input.candle.close,
          entryPrice: input.candle.close,
          shares: sharesForMode(mode, input.candle.close),
          breakoutLevel: metrics.breakoutLevel,
          executionProxyKind: "signal_candle_close",
        });
        openedPosition = { ...state.position };
        state.dailySlotConsumed = true;
        resultType = "entry";
        actions.push({ type: "entry", variant, entryPrice: input.candle.close, metrics });
      } else if (variant === "executable_a") {
        state.pending = {
          kind: "executable",
          signalSourceEventId: input.sourceEventId,
          signalTime: input.candle.candleTime,
          theoreticalSignalPrice: input.candle.close,
          breakoutLevel: metrics.breakoutLevel,
          metrics,
        };
        resultType = "pending";
        actions.push({ type: "next_event_depth_pending", variant, metrics });
      } else {
        state.pending = {
          kind: "retest",
          phase: "awaiting_retest",
          signalSourceEventId: input.sourceEventId,
          signalTime: input.candle.candleTime,
          theoreticalSignalPrice: input.candle.close,
          breakoutLevel: metrics.breakoutLevel,
          triggerLow: input.candle.low,
          metrics,
          retestSourceEventId: null,
          retestTime: null,
          retestLow: null,
          rebreakSourceEventId: null,
          rebreakTime: null,
          rebreakClose: null,
          rebreakLevel: null,
        };
        resultType = "pending";
        actions.push({ type: "failed_retest_pending", variant, metrics, triggerLow: input.candle.low });
      }
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closedPosition);
}

export function applyDiscoPausedBaselineTransition(
  state: DiscoShortState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
) {
  return applyDiscoShortTransition(state, input, mode, "paused_baseline");
}

export function applyDiscoExecutableATransition(
  state: DiscoShortState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
) {
  return applyDiscoShortTransition(state, input, mode, "executable_a");
}

export function applyDiscoRetestBTransition(
  state: DiscoShortState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
) {
  return applyDiscoShortTransition(state, input, mode, "retest_b");
}
