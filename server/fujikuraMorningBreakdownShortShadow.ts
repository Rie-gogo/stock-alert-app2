import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";
import { calculateClockSafeBoardAge, calculateDepthVwap } from "./telExecutableConfirmDepth";

export const FUJIKURA_MORNING_SHORT_LEARNING_CUTOFF_DATE = "2026-09-15";
export const FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE = "2026-09-17";
export const FUJIKURA_MORNING_SHORT_FORMAL_START_DATE = "2026-09-17";

export const FUJIKURA_MORNING_SHORT_SPEC = Object.freeze({
  symbol: "5803",
  routeId: "fujikuraMorning20BarBreakdownShort",
  candidateKey: "5803_morning_20bar_breakdown_short_next_event_depth",
  role: "exploratory_entry_execution_quality_shadow",
  historicalRole: "historically_selected_forward_unseen_candidate",
  entry: Object.freeze({
    startTime: "09:45",
    endTime: "11:27",
    minimumWarmupBars: 21,
    lowLookback: 20,
    maPeriod: 8,
    maxMaSlope2Pct: -0.02,
    minVolumeRatio: 0.9,
    minDrawdownFromDayHighPct: 1.2,
    maxBuyPressureRatio: 0.8,
    rejectedBoardSignal: "buy_pressure",
    signalTiming: "completed_signal_candle",
    executionTiming: "next_5803_source_event",
    executionPrice: "bid_depth_vwap_for_evaluation_shares",
    maximumAdverseEntryPct: 0.10,
    maximumClockSafeBoardAgeMs: 5_000,
    maximumNextEventDelayMinutes: 2,
    requireExecutablePriceBelowOriginalBreakoutLevel: true,
    rejectionConsumesDailySlot: false,
    rejectedCandidateSearch: "discard_original_signal_and_continue_next_candle",
  }),
  exit: Object.freeze({
    slPct: 0.7,
    tpPct: 1.5,
    maxHoldingMinutes: 10,
    sessionExitTime: "11:27",
    sameBarPriority: ["stop_loss", "take_profit", "session_exit", "time_exit"],
    stopGapFill: "adverse_open",
  }),
  historicalSelection: Object.freeze({
    allSignals: 42,
    allWins: 32,
    allWinRatePct: 76.19,
    last10Signals: 8,
    last10Wins: 8,
    caveat: "failed_round_trip_friction_gate_and_recent_source_coverage_incomplete",
  }),
  dryRunOnly: true,
  eligibleForAdoption: false,
  automaticAdoption: false,
  orderInstructionConnection: false,
});

export type FujikuraMorningShortResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

export type FujikuraMorningShortCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type FujikuraMorningShortMetrics = {
  breakoutLevel: number;
  dayHigh: number;
  drawdownFromDayHighPct: number;
  maSlope2Pct: number;
  volumeRatio: number;
  buyPressureRatio: number | null;
  boardSignal: string | null;
  priceEligible: boolean;
  boardEligible: boolean;
  eligible: boolean;
};

type PendingEntry = {
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  breakoutLevel: number;
  metrics: FujikuraMorningShortMetrics;
};

export type FujikuraMorningShortPosition = {
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
  breakoutLevel: number;
  adverseEntryPct: number;
  executionProxyKind: "bid_depth_vwap";
};

export type FujikuraMorningShortState = {
  version: 1;
  tradeDate: string;
  candles: FujikuraMorningShortCandle[];
  pending: PendingEntry | null;
  position: FujikuraMorningShortPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: FujikuraMorningShortResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type FujikuraMorningShortClosedPosition = {
  position: FujikuraMorningShortPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "time_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type FujikuraMorningShortTransition = {
  nextState: FujikuraMorningShortState;
  resultType: FujikuraMorningShortResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: FujikuraMorningShortPosition | null;
  closedPosition: FujikuraMorningShortClosedPosition | null;
};

export function createEmptyFujikuraMorningShortState(): FujikuraMorningShortState {
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

export function normalizeFujikuraMorningShortState(value: unknown, tradeDate?: string): FujikuraMorningShortState {
  const raw = value && typeof value === "object" ? value as Partial<FujikuraMorningShortState> : {};
  let state: FujikuraMorningShortState = {
    version: 1,
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
    state = createEmptyFujikuraMorningShortState();
    state.tradeDate = tradeDate;
  }
  return state;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function boardMetrics(board: unknown): { buyPressureRatio: number | null; boardSignal: string | null } {
  if (!board || typeof board !== "object") return { buyPressureRatio: null, boardSignal: null };
  const raw = board as Record<string, unknown>;
  const direct = Number(raw.buyPressureRatio);
  if (Number.isFinite(direct)) {
    return { buyPressureRatio: direct, boardSignal: typeof raw.signal === "string" ? raw.signal : null };
  }
  const quantity = (key: "asks" | "bids") => (Array.isArray(raw[key]) ? raw[key] as Array<Record<string, unknown>> : [])
    .reduce((sum, level) => sum + Math.max(0, Number(level.qty) || 0), 0);
  const asks = quantity("asks") + Math.max(0, Number(raw.overSellQty) || 0);
  const bids = quantity("bids") + Math.max(0, Number(raw.underBuyQty) || 0);
  return {
    buyPressureRatio: asks > 0 ? bids / asks : null,
    boardSignal: typeof raw.signal === "string" ? raw.signal : null,
  };
}

export function calculateFujikuraMorningShortMetrics(
  candles: FujikuraMorningShortCandle[],
  board: unknown,
): FujikuraMorningShortMetrics | null {
  const spec = FUJIKURA_MORNING_SHORT_SPEC.entry;
  if (candles.length < spec.minimumWarmupBars) return null;
  const candle = candles.at(-1)!;
  const prior = candles.slice(-1 - spec.lowLookback, -1);
  const priorTwenty = candles.slice(-21, -1);
  const currentMa = average(candles.slice(-spec.maPeriod).map(item => item.close));
  const maTwoBarsAgo = average(candles.slice(-spec.maPeriod - 2, -2).map(item => item.close));
  const maSlope2Pct = maTwoBarsAgo > 0 ? (currentMa / maTwoBarsAgo - 1) * 100 : 0;
  const averageVolume = average(priorTwenty.map(item => item.volume));
  const volumeRatio = averageVolume > 0 ? candle.volume / averageVolume : 0;
  const dayHigh = Math.max(...candles.map(item => item.high));
  const drawdownFromDayHighPct = dayHigh > 0 ? (candle.close / dayHigh - 1) * 100 : 0;
  const breakoutLevel = Math.min(...prior.map(item => item.low));
  const boardValue = boardMetrics(board);
  const priceEligible = candle.close < breakoutLevel
    && candle.close < candle.open
    && maSlope2Pct <= spec.maxMaSlope2Pct
    && volumeRatio >= spec.minVolumeRatio
    && drawdownFromDayHighPct <= -spec.minDrawdownFromDayHighPct;
  const boardEligible = boardValue.buyPressureRatio !== null
    && boardValue.buyPressureRatio <= spec.maxBuyPressureRatio
    && boardValue.boardSignal !== spec.rejectedBoardSignal;
  return {
    breakoutLevel,
    dayHigh,
    drawdownFromDayHighPct,
    maSlope2Pct,
    volumeRatio,
    buyPressureRatio: boardValue.buyPressureRatio,
    boardSignal: boardValue.boardSignal,
    priceEligible,
    boardEligible,
    eligible: priceEligible && boardEligible,
  };
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

function boardIsCausalAndFresh(input: ForwardSourceEventInput) {
  const age = calculateClockSafeBoardAge(input.currentAudit);
  const observed = input.currentAudit?.boardObservedAtMs ?? null;
  const assembled = input.currentAudit?.relayAssembledAtMs ?? null;
  const sourceCausal = observed !== null && assembled !== null && observed <= assembled;
  return { age, sourceCausal, accepted: age.timestampsAvailable && age.causal && age.fresh && sourceCausal };
}

function evaluateExecution(input: {
  source: ForwardSourceEventInput;
  mode: ForwardEvaluationMode;
  pending: PendingEntry;
}) {
  const timing = boardIsCausalAndFresh(input.source);
  const sizingDepth = calculateDepthVwap({ board: input.source.board, side: "short", shares: 100 });
  const shares = sizingDepth ? sharesForMode(input.mode, sizingDepth.price) : null;
  const depth = shares === null ? null : calculateDepthVwap({ board: input.source.board, side: "short", shares });
  const executablePrice = depth?.price ?? null;
  const adverseEntryPct = executablePrice === null
    ? null
    : (input.pending.theoreticalSignalPrice - executablePrice) / input.pending.theoreticalSignalPrice * 100;
  const breakoutMaintained = executablePrice !== null && executablePrice < input.pending.breakoutLevel;
  const delayMinutes = minutesBetween(input.pending.signalTime, input.source.candle.candleTime);
  const nextEventTimely = delayMinutes > 0
    && delayMinutes <= FUJIKURA_MORNING_SHORT_SPEC.entry.maximumNextEventDelayMinutes;
  const adverseAllowed = adverseEntryPct !== null
    && adverseEntryPct <= FUJIKURA_MORNING_SHORT_SPEC.entry.maximumAdverseEntryPct;
  const accepted = timing.accepted && shares !== null && executablePrice !== null
    && breakoutMaintained && adverseAllowed && nextEventTimely;
  const rejectionReason = accepted
    ? null
    : !nextEventTimely
      ? "next_source_event_missing_or_late"
      : !timing.age.timestampsAvailable
        ? "board_observed_or_decision_time_unavailable"
        : !timing.age.causal || !timing.sourceCausal
          ? "board_source_not_causal"
          : !timing.age.fresh
            ? "board_snapshot_stale_over_5000ms"
            : executablePrice === null || shares === null
              ? "insufficient_bid_depth_for_evaluation_shares"
              : !breakoutMaintained
                ? "breakout_not_maintained_at_next_event"
                : "adverse_entry_gap_over_010pct";
  // timing.acceptedは板時刻だけの判定なので、総合acceptedを後勝ちにして上書きを防ぐ。
  return { ...timing, accepted, rejectionReason, shares, depth, executablePrice, adverseEntryPct, breakoutMaintained, delayMinutes };
}

function appendCandle(state: FujikuraMorningShortState, input: ForwardSourceEventInput) {
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

function closePosition(
  position: FujikuraMorningShortPosition,
  exitPrice: number,
  exitReason: FujikuraMorningShortClosedPosition["exitReason"],
): FujikuraMorningShortClosedPosition {
  const pnl = Math.round((position.entryPrice - exitPrice) * position.shares);
  const adversePrice = exitPrice * (1 + FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const pnlAfterAdverseExit = Math.round((position.entryPrice - adversePrice) * position.shares);
  const risk = position.entryPrice * position.shares * position.slPct / 100;
  return { position: { ...position }, exitPrice, exitReason, pnl, pnlAfterAdverseExit, realizedR: risk > 0 ? pnl / risk : 0 };
}

function calculateExit(position: FujikuraMorningShortPosition, input: ForwardSourceEventInput) {
  const stopLine = position.entryPrice * (1 + position.slPct / 100);
  if (input.candle.high >= stopLine) return closePosition(position, Math.max(input.candle.open, stopLine), "stop_loss");
  const targetLine = position.entryPrice * (1 - position.tpPct / 100);
  if (input.candle.low <= targetLine) return closePosition(position, targetLine, "take_profit");
  if (input.candle.candleTime >= FUJIKURA_MORNING_SHORT_SPEC.exit.sessionExitTime) {
    return closePosition(position, input.candle.close, "session_exit");
  }
  if (minutesBetween(position.entryTime, input.candle.candleTime) >= FUJIKURA_MORNING_SHORT_SPEC.exit.maxHoldingMinutes) {
    return closePosition(position, input.candle.close, "time_exit");
  }
  return null;
}

function finalize(
  state: FujikuraMorningShortState,
  input: ForwardSourceEventInput,
  resultType: FujikuraMorningShortResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: FujikuraMorningShortPosition | null,
  closedPosition: FujikuraMorningShortClosedPosition | null,
): FujikuraMorningShortTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

export function applyFujikuraMorningShortTransition(
  stateBefore: FujikuraMorningShortState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): FujikuraMorningShortTransition {
  const state = normalizeFujikuraMorningShortState(stateBefore, input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: FujikuraMorningShortResultType = "no_signal";
  let openedPosition: FujikuraMorningShortPosition | null = null;
  let closedPosition: FujikuraMorningShortClosedPosition | null = null;
  let skipSignalDetection = false;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE,
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
  }

  if (!state.position && !state.dailySlotConsumed && state.pending) {
    const pending = state.pending;
    state.pending = null;
    skipSignalDetection = true;
    const execution = evaluateExecution({ source: input, mode, pending });
    if (execution.accepted) {
      state.position = {
        side: "short",
        signalSourceEventId: pending.signalSourceEventId,
        entrySourceEventId: input.sourceEventId,
        signalTime: pending.signalTime,
        entryTime: input.candle.candleTime,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        entryPrice: execution.executablePrice!,
        shares: execution.shares!,
        slPct: FUJIKURA_MORNING_SHORT_SPEC.exit.slPct,
        tpPct: FUJIKURA_MORNING_SHORT_SPEC.exit.tpPct,
        breakoutLevel: pending.breakoutLevel,
        adverseEntryPct: execution.adverseEntryPct!,
        executionProxyKind: "bid_depth_vwap",
      };
      openedPosition = { ...state.position };
      state.dailySlotConsumed = true;
      resultType = "entry";
      actions.push({
        type: "entry",
        signalSourceEventId: pending.signalSourceEventId,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        executablePrice: execution.executablePrice,
        breakoutLevel: pending.breakoutLevel,
        adverseEntryPct: execution.adverseEntryPct,
        boardAgeMs: execution.age.boardAgeMs,
        boardSourceCausal: execution.sourceCausal,
        delayMinutes: execution.delayMinutes,
        depth: execution.depth,
        overlappingCurrentRouteId: input.currentAudit?.routeId ?? null,
      });
    } else {
      resultType = "rejected";
      actions.push({
        type: "entry_rejected",
        reason: execution.rejectionReason,
        signalSourceEventId: pending.signalSourceEventId,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        executablePrice: execution.executablePrice,
        breakoutLevel: pending.breakoutLevel,
        adverseEntryPct: execution.adverseEntryPct,
        boardAgeMs: execution.age.boardAgeMs,
        boardSourceCausal: execution.sourceCausal,
        delayMinutes: execution.delayMinutes,
        dailySlotConsumed: false,
      });
    }
  }

  const candleTime = input.candle.candleTime;
  if (!state.position && !state.pending && !state.dailySlotConsumed && !skipSignalDetection
    && candleTime >= FUJIKURA_MORNING_SHORT_SPEC.entry.startTime
    && candleTime <= FUJIKURA_MORNING_SHORT_SPEC.entry.endTime) {
    const metrics = calculateFujikuraMorningShortMetrics(state.candles, input.board);
    if (metrics?.priceEligible && !metrics.boardEligible) {
      resultType = "rejected";
      actions.push({
        type: "signal_board_rejected",
        reason: metrics.buyPressureRatio === null
          ? "buy_pressure_ratio_unavailable"
          : metrics.boardSignal === FUJIKURA_MORNING_SHORT_SPEC.entry.rejectedBoardSignal
            ? "buy_pressure_signal"
            : "buy_pressure_ratio_above_080",
        metrics,
        dailySlotConsumed: false,
      });
    } else if (metrics?.eligible) {
      const timing = boardIsCausalAndFresh(input);
      if (!timing.accepted) {
        resultType = "rejected";
        actions.push({
          type: "signal_board_rejected",
          reason: !timing.age.timestampsAvailable
            ? "signal_board_timestamps_unavailable"
            : !timing.age.causal || !timing.sourceCausal
              ? "signal_board_not_causal"
              : "signal_board_stale_over_5000ms",
          metrics,
          boardAgeMs: timing.age.boardAgeMs,
          dailySlotConsumed: false,
        });
      } else {
        state.pending = {
          signalSourceEventId: input.sourceEventId,
          signalTime: candleTime,
          theoreticalSignalPrice: input.candle.close,
          breakoutLevel: metrics.breakoutLevel,
          metrics,
        };
        resultType = "pending";
        actions.push({
          type: "next_event_depth_pending",
          metrics,
          theoreticalSignalPrice: input.candle.close,
          overlappingCurrentRouteId: input.currentAudit?.routeId ?? null,
        });
      }
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closedPosition);
}
