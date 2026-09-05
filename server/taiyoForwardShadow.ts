import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";
import {
  TAIYO_CANDIDATE_B_SPEC,
  calculateTaiyoCandidateBMetrics,
  evaluateTaiyoCandidateBConfirmation,
  getTaiyoCandidateBDayOpen,
  isTaiyoCandidateBConfirmationTime,
  isTaiyoCandidateBInitialTriggerTime,
  type TaiyoCandidateBCandle,
  type TaiyoCandidateBPending,
} from "./taiyoCandidateB";
import { calculateClockSafeBoardAge } from "./telExecutableConfirmDepth";

export const TAIYO_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-04";
export const TAIYO_FORWARD_COLLECTION_START_DATE = "2026-09-07";
export const TAIYO_FORWARD_FORMAL_START_DATE = "2026-09-08";

export const TAIYO_BOARD_DEMAND_SPEC = Object.freeze({
  symbol: "6976",
  routeId: "taiyoCandidateBLong",
  candidateKey: "6976_candidate_b_long_board_bpr130",
  entry: Object.freeze({
    sharedDetectionCore: "calculateTaiyoCandidateBMetrics_and_evaluateTaiyoCandidateBConfirmation",
    timing: "same_completed_confirmation_candle",
    price: "completed_confirmation_candle_close",
    minimumBoardPressureRatio: 1.3,
    largeAskWallMultiplier: 5,
    requireNoLargeAskWall: true,
    maximumClockSafeBoardAgeMs: 5_000,
    boardAgeBasis: "relay_packaging_plus_cloud_processing_same_clock_intervals",
    networkTransitMeasurement: "unavailable_cross_clock_not_subtracted",
    rejectionConsumesDailySlot: false,
    rejectedCandidateSearch: "next_candle_continue_search",
  }),
  exit: Object.freeze({
    slPct: 0.5,
    tpPct: 1.0,
    maxHoldingMinutes: 30,
    sameBarPriority: ["stop_loss", "take_profit", "time_exit"],
    stopGapFill: "adverse_open",
  }),
  orderInstructionConnection: false,
});

export const TAIYO_RR2_PROTECT_SPEC = Object.freeze({
  symbol: "6976",
  routeId: "taiyoCandidateBLong",
  candidateKey: "6976_candidate_b_long_rr2_protect",
  entry: Object.freeze({
    sharedDetectionCore: "calculateTaiyoCandidateBMetrics_and_evaluateTaiyoCandidateBConfirmation",
    timing: "same_completed_confirmation_candle",
    price: "completed_confirmation_candle_close",
  }),
  exit: Object.freeze({
    slPct: 0.8,
    tpPct: 1.6,
    profitProtectionTriggerPct: 0.24,
    profitProtectionFloorPct: 0.16,
    profitProtectionStarts: "next_source_event_after_arming",
    maxHoldingMinutes: 30,
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

export type TaiyoForwardVariant = "board_demand" | "rr2_protect";
export type TaiyoForwardResultType = "no_signal" | "pending" | "rejected" | "entry" | "hold" | "exit";

export type TaiyoForwardPosition = {
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
  executionProxyKind: "confirmation_candle_close";
  boardPressureRatio: number | null;
  largeAskWallRatio: number | null;
  boardAgeMs: number | null;
  profitProtectionArmedAtSourceEventId: string | null;
};

export type TaiyoForwardState = {
  version: 1;
  variant: TaiyoForwardVariant;
  tradeDate: string;
  candles: TaiyoCandidateBCandle[];
  dayOpen: number | null;
  pending: TaiyoCandidateBPending & { signalSourceEventId: string } | null;
  position: TaiyoForwardPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: TaiyoForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type TaiyoClosedPosition = {
  position: TaiyoForwardPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "profit_protection" | "time_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type TaiyoForwardTransition = {
  nextState: TaiyoForwardState;
  resultType: TaiyoForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: TaiyoForwardPosition | null;
  closedPosition: TaiyoClosedPosition | null;
};

export function createEmptyTaiyoForwardState(variant: TaiyoForwardVariant): TaiyoForwardState {
  return {
    version: 1,
    variant,
    tradeDate: "",
    candles: [],
    dayOpen: null,
    pending: null,
    position: null,
    dailySlotConsumed: false,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
  };
}

export function normalizeTaiyoForwardState(
  value: unknown,
  variant: TaiyoForwardVariant,
  tradeDate?: string,
): TaiyoForwardState {
  const raw = value && typeof value === "object" ? value as Partial<TaiyoForwardState> : {};
  let state: TaiyoForwardState = {
    version: 1,
    variant,
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-180) : [],
    dayOpen: typeof raw.dayOpen === "number" ? raw.dayOpen : null,
    pending: raw.pending ?? null,
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
  if (tradeDate && state.tradeDate !== tradeDate) {
    state = createEmptyTaiyoForwardState(variant);
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

function pnlFor(position: TaiyoForwardPosition, exitPrice: number): number {
  return Math.round((exitPrice - position.entryPrice) * position.shares);
}

function closedPosition(
  position: TaiyoForwardPosition,
  exitPrice: number,
  exitReason: TaiyoClosedPosition["exitReason"],
): TaiyoClosedPosition {
  const adversePrice = exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
  const risk = position.entryPrice * position.shares * position.slPct / 100;
  const pnl = pnlFor(position, exitPrice);
  return {
    position: { ...position },
    exitPrice,
    exitReason,
    pnl,
    pnlAfterAdverseExit: pnlFor(position, adversePrice),
    realizedR: risk > 0 ? pnl / risk : 0,
  };
}

function appendCandle(state: TaiyoForwardState, input: ForwardSourceEventInput) {
  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-180);
  state.dayOpen ??= getTaiyoCandidateBDayOpen(state.candles);
}

function finalize(
  state: TaiyoForwardState,
  input: ForwardSourceEventInput,
  resultType: TaiyoForwardResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: TaiyoForwardPosition | null,
  closed: TaiyoClosedPosition | null,
): TaiyoForwardTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition: closed };
}

type BoardDemandMetrics = {
  boardPressureRatio: number;
  totalBidQty: number;
  totalAskQty: number;
  largeAskWallDetected: boolean;
  largeAskWallRatio: number;
  largeAskWallPrice: number | null;
};

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLevels(value: unknown): Array<{ price: number; qty: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const price = finiteNumber(row.price ?? row.Price);
    const qty = finiteNumber(row.qty ?? row.Qty);
    return price > 0 && qty > 0 ? [{ price, qty }] : [];
  });
}

export function calculateTaiyoBoardDemandMetrics(board: unknown): BoardDemandMetrics | null {
  if (!board || typeof board !== "object") return null;
  const raw = board as Record<string, unknown>;
  const asks = normalizeLevels(raw.asks ?? raw.Asks);
  const bids = normalizeLevels(raw.bids ?? raw.Bids);
  const overSellQty = finiteNumber(raw.overSellQty ?? raw.OverSellQty);
  const underBuyQty = finiteNumber(raw.underBuyQty ?? raw.UnderBuyQty);
  const totalBidQty = bids.reduce((sum, item) => sum + item.qty, 0) + underBuyQty;
  const totalAskQty = asks.reduce((sum, item) => sum + item.qty, 0) + overSellQty;
  if (asks.length === 0 || bids.length === 0 || totalBidQty <= 0 || totalAskQty <= 0) return null;
  const averageAskQty = totalAskQty / asks.length;
  const largestAsk = asks.reduce((largest, item) => item.qty > largest.qty ? item : largest, asks[0]);
  const largeAskWallRatio = averageAskQty > 0 ? largestAsk.qty / averageAskQty : 0;
  const largeAskWallDetected = largeAskWallRatio >= TAIYO_BOARD_DEMAND_SPEC.entry.largeAskWallMultiplier;
  return {
    boardPressureRatio: totalBidQty / totalAskQty,
    totalBidQty,
    totalAskQty,
    largeAskWallDetected,
    largeAskWallRatio,
    largeAskWallPrice: largeAskWallDetected ? largestAsk.price : null,
  };
}

function createPending(state: TaiyoForwardState, input: ForwardSourceEventInput): TaiyoForwardState["pending"] {
  if (state.dayOpen === null || !isTaiyoCandidateBInitialTriggerTime(input.candle.candleTime)) return null;
  const metrics = calculateTaiyoCandidateBMetrics(state.candles, state.dayOpen);
  if (metrics?.side !== "long") return null;
  const pending: NonNullable<TaiyoForwardState["pending"]> = {
    side: "long",
    triggerClose: input.candle.close,
    triggerTime: input.candle.candleTime,
    triggerMaSlope2Pct: metrics.maSlope2Pct,
    triggerVolumeRatio: metrics.volumeRatio,
    triggerOpenMovePct: metrics.openMovePct,
    signalSourceEventId: input.sourceEventId,
  };
  state.pending = pending;
  return pending;
}

function openPosition(input: {
  state: TaiyoForwardState;
  source: ForwardSourceEventInput;
  mode: ForwardEvaluationMode;
  pending: TaiyoForwardState["pending"] & {};
  slPct: number;
  tpPct: number;
  boardMetrics: BoardDemandMetrics | null;
  boardAgeMs: number | null;
}) {
  const shares = sharesForMode(input.mode, input.source.candle.close);
  const position: TaiyoForwardPosition = {
    side: "long",
    signalSourceEventId: input.pending.signalSourceEventId,
    entrySourceEventId: input.source.sourceEventId,
    signalTime: input.pending.triggerTime,
    entryTime: input.source.candle.candleTime,
    theoreticalSignalPrice: input.source.candle.close,
    entryPrice: input.source.candle.close,
    shares,
    slPct: input.slPct,
    tpPct: input.tpPct,
    executionProxyKind: "confirmation_candle_close",
    boardPressureRatio: input.boardMetrics?.boardPressureRatio ?? null,
    largeAskWallRatio: input.boardMetrics?.largeAskWallRatio ?? null,
    boardAgeMs: input.boardAgeMs,
    profitProtectionArmedAtSourceEventId: null,
  };
  input.state.position = position;
  input.state.dailySlotConsumed = true;
  return position;
}

function standardExit(position: TaiyoForwardPosition, input: ForwardSourceEventInput) {
  const stopLine = position.entryPrice * (1 - position.slPct / 100);
  const targetLine = position.entryPrice * (1 + position.tpPct / 100);
  if (input.candle.low <= stopLine) return closedPosition(position, Math.min(input.candle.open, stopLine), "stop_loss");
  if (input.candle.high >= targetLine) return closedPosition(position, targetLine, "take_profit");
  if (input.candle.candleTime >= "11:27") return closedPosition(position, input.candle.close, "session_exit");
  if (minutesBetween(position.entryTime, input.candle.candleTime) >= TAIYO_BOARD_DEMAND_SPEC.exit.maxHoldingMinutes) {
    return closedPosition(position, input.candle.close, "time_exit");
  }
  return null;
}

/** 第1案: 現行LONG確認成立時の同時点板需給だけを追加する。 */
export function applyTaiyoBoardDemandTransition(
  stateBefore: TaiyoForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): TaiyoForwardTransition {
  const state = normalizeTaiyoForwardState(stateBefore, "board_demand", input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: TaiyoForwardResultType = "no_signal";
  let openedPosition: TaiyoForwardPosition | null = null;
  let closed: TaiyoClosedPosition | null = null;
  let allowCurrentCandleRedetection = true;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < TAIYO_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: TAIYO_FORWARD_COLLECTION_START_DATE,
    }], null, null);
  }

  if (state.position) {
    closed = standardExit(state.position, input);
    if (closed) {
      state.position = null;
      resultType = "exit";
      actions.push({ type: "exit", reason: closed.exitReason, exitPrice: closed.exitPrice, pnl: closed.pnl, pnlAfterAdverseExit: closed.pnlAfterAdverseExit, realizedR: closed.realizedR });
    } else resultType = "hold";
  } else if (state.pending) {
    const pending = state.pending;
    state.pending = null;
    if (!isTaiyoCandidateBConfirmationTime(input.candle.candleTime)) {
      resultType = "rejected";
      actions.push({ type: "confirmation_rejected", reason: "confirmation_time_expired", originalSignalSourceEventId: pending.signalSourceEventId });
    } else {
      const confirmation = evaluateTaiyoCandidateBConfirmation({ pending, candle: state.candles[state.candles.length - 1] });
      if (!confirmation.allowed) {
        resultType = "rejected";
        actions.push({ type: "confirmation_rejected", reason: "current_confirmation_failed", codes: confirmation.codes, originalSignalSourceEventId: pending.signalSourceEventId, sameCandleRedetectionAllowed: true });
      } else {
        allowCurrentCandleRedetection = false;
        const boardMetrics = calculateTaiyoBoardDemandMetrics(input.board);
        const boardAge = calculateClockSafeBoardAge(input.currentAudit);
        const boardObservedAtMs = input.currentAudit?.boardObservedAtMs ?? null;
        const relayAssembledAtMs = input.currentAudit?.relayAssembledAtMs ?? null;
        const boardSourceCausal = boardObservedAtMs !== null && relayAssembledAtMs !== null && boardObservedAtMs <= relayAssembledAtMs;
        const accepted = boardMetrics !== null
          && boardAge.timestampsAvailable
          && boardAge.causal
          && boardAge.fresh
          && boardSourceCausal
          && boardMetrics.boardPressureRatio >= TAIYO_BOARD_DEMAND_SPEC.entry.minimumBoardPressureRatio
          && !boardMetrics.largeAskWallDetected;
        if (!accepted) {
          resultType = "rejected";
          actions.push({
            type: "entry_rejected",
            reason: boardMetrics === null
              ? "board_snapshot_missing_or_incomplete"
              : !boardAge.timestampsAvailable || boardObservedAtMs === null
                ? "board_observed_or_decision_time_unavailable"
                : !boardAge.causal || !boardSourceCausal
                  ? "same_clock_interval_negative"
                  : !boardAge.fresh
                    ? "board_snapshot_stale_over_5000ms"
                    : boardMetrics.largeAskWallDetected
                      ? "large_ask_wall_detected"
                      : "board_pressure_ratio_below_130",
            originalSignalSourceEventId: pending.signalSourceEventId,
            boardMetrics,
            boardAgeMs: boardAge.boardAgeMs,
            relayPackagingMs: boardAge.relayPackagingMs,
            cloudProcessingMs: boardAge.cloudProcessingMs,
            networkTransitMeasurement: boardAge.networkTransitMeasurement,
            boardSourceCausal,
            dailySlotConsumed: false,
            rejectedCandidateSearch: "next_candle_continue_search",
          });
        } else {
          openedPosition = openPosition({
            state,
            source: input,
            mode,
            pending,
            slPct: TAIYO_BOARD_DEMAND_SPEC.exit.slPct,
            tpPct: TAIYO_BOARD_DEMAND_SPEC.exit.tpPct,
            boardMetrics,
            boardAgeMs: boardAge.boardAgeMs,
          });
          resultType = "entry";
          actions.push({ type: "entry", side: "long", entryPrice: openedPosition.entryPrice, priceSource: "completed_confirmation_candle_close", shares: openedPosition.shares, boardMetrics, boardAgeMs: boardAge.boardAgeMs });
        }
      }
    }
  }

  const detectedPending = !state.position && !state.pending && !state.dailySlotConsumed && allowCurrentCandleRedetection
    ? createPending(state, input)
    : null;
  if (detectedPending) {
    resultType = "pending";
    actions.push({ type: "pending", side: "long", triggerClose: detectedPending.triggerClose, metrics: detectedPending });
  }

  return finalize(state, input, resultType, actions, openedPosition, closed);
}

function rr2ProtectExit(position: TaiyoForwardPosition, input: ForwardSourceEventInput) {
  const stopLine = position.entryPrice * (1 - TAIYO_RR2_PROTECT_SPEC.exit.slPct / 100);
  const protectionLine = position.entryPrice * (1 + TAIYO_RR2_PROTECT_SPEC.exit.profitProtectionFloorPct / 100);
  const targetLine = position.entryPrice * (1 + TAIYO_RR2_PROTECT_SPEC.exit.tpPct / 100);
  if (input.candle.low <= stopLine) return closedPosition(position, Math.min(input.candle.open, stopLine), "stop_loss");
  if (position.profitProtectionArmedAtSourceEventId
    && position.profitProtectionArmedAtSourceEventId !== input.sourceEventId
    && input.candle.low <= protectionLine) {
    return closedPosition(position, Math.min(input.candle.open, protectionLine), "profit_protection");
  }
  if (input.candle.high >= targetLine) return closedPosition(position, targetLine, "take_profit");
  return null;
}

/** 第2案: 現行LONG入口を変えず、2Rと次足以降の利益保護だけを比較する。 */
export function applyTaiyoRr2ProtectTransition(
  stateBefore: TaiyoForwardState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): TaiyoForwardTransition {
  const state = normalizeTaiyoForwardState(stateBefore, "rr2_protect", input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: TaiyoForwardResultType = "no_signal";
  let openedPosition: TaiyoForwardPosition | null = null;
  let closed: TaiyoClosedPosition | null = null;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < TAIYO_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{ type: "not_collecting", stopped: state.stopped, collectionStartDate: TAIYO_FORWARD_COLLECTION_START_DATE }], null, null);
  }

  if (state.position) {
    closed = rr2ProtectExit(state.position, input);
    if (closed) {
      state.position = null;
      resultType = "exit";
      actions.push({ type: "exit", reason: closed.exitReason, exitPrice: closed.exitPrice, pnl: closed.pnl, pnlAfterAdverseExit: closed.pnlAfterAdverseExit, realizedR: closed.realizedR });
    } else {
      const position = state.position;
      const triggerLine = position.entryPrice * (1 + TAIYO_RR2_PROTECT_SPEC.exit.profitProtectionTriggerPct / 100);
      if (!position.profitProtectionArmedAtSourceEventId && input.candle.high >= triggerLine) {
        position.profitProtectionArmedAtSourceEventId = input.sourceEventId;
        actions.push({ type: "profit_protection_armed", triggerLine, effectiveFromNextSourceEvent: true });
      }
      if (input.candle.candleTime >= "11:27") {
        closed = closedPosition(position, input.candle.close, "session_exit");
      } else if (minutesBetween(position.entryTime, input.candle.candleTime) >= TAIYO_RR2_PROTECT_SPEC.exit.maxHoldingMinutes) {
        closed = closedPosition(position, input.candle.close, "time_exit");
      }
      if (closed) {
        state.position = null;
        resultType = "exit";
        actions.push({ type: "exit", reason: closed.exitReason, exitPrice: closed.exitPrice, pnl: closed.pnl, pnlAfterAdverseExit: closed.pnlAfterAdverseExit, realizedR: closed.realizedR });
      } else resultType = "hold";
    }
  } else if (state.pending) {
    const pending = state.pending;
    state.pending = null;
    if (!isTaiyoCandidateBConfirmationTime(input.candle.candleTime)) {
      resultType = "rejected";
      actions.push({ type: "confirmation_rejected", reason: "confirmation_time_expired", originalSignalSourceEventId: pending.signalSourceEventId });
    } else {
      const confirmation = evaluateTaiyoCandidateBConfirmation({ pending, candle: state.candles[state.candles.length - 1] });
      if (!confirmation.allowed) {
        resultType = "rejected";
        actions.push({ type: "confirmation_rejected", reason: "current_confirmation_failed", codes: confirmation.codes, originalSignalSourceEventId: pending.signalSourceEventId, sameCandleRedetectionAllowed: true });
      } else {
        openedPosition = openPosition({
          state,
          source: input,
          mode,
          pending,
          slPct: TAIYO_RR2_PROTECT_SPEC.exit.slPct,
          tpPct: TAIYO_RR2_PROTECT_SPEC.exit.tpPct,
          boardMetrics: null,
          boardAgeMs: null,
        });
        resultType = "entry";
        actions.push({ type: "entry", side: "long", entryPrice: openedPosition.entryPrice, priceSource: "completed_confirmation_candle_close", shares: openedPosition.shares });
      }
    }
  }

  const detectedPending = !state.position && !state.pending && !state.dailySlotConsumed
    ? createPending(state, input)
    : null;
  if (detectedPending) {
    resultType = "pending";
    actions.push({ type: "pending", side: "long", triggerClose: detectedPending.triggerClose, metrics: detectedPending });
  }

  return finalize(state, input, resultType, actions, openedPosition, closed);
}
