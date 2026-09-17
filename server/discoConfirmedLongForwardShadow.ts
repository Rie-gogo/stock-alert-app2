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
import { FORWARD_EVALUATION_POLICY } from "./runtimeIdentity";

export const DISCO_LONG_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-17";
export const DISCO_LONG_FORWARD_COLLECTION_START_DATE = "2026-09-18";
export const DISCO_LONG_FORWARD_FORMAL_START_DATE = "2026-09-18";

const COMMON_ENTRY = Object.freeze({
  startTime: "09:45",
  endTime: "11:10",
  minimumWarmupBars: 21,
  lookback: 10,
  maPeriod: 8,
  minimumMaSlopePct: 0.02,
  minimumVolumeRatio: 1.2,
  atrPeriod: 7,
  minimumAtrPct: 0.12,
});

const COMMON_EXIT = Object.freeze({
  slPct: 0.5,
  tpPct: 1.8,
  boardEarlyExit: true,
  boardEarlyExitMinimumProfitPct: 0.05,
  signalReversalExit: true,
  sessionExitTime: "11:27",
});

export const DISCO_LONG_PROFIT_PROTECTION_A_SPEC = Object.freeze({
  symbol: "6146",
  routeId: "discoConfirmedBreakLong",
  candidateKey: "6146_confirmed_long_a_profit_protection_050_025",
  role: "exit_structure_candidate",
  historicalRole: "forward_unseen_candidate_no_historical_performance_claim",
  entry: Object.freeze({
    ...COMMON_ENTRY,
    timing: "completed_signal_candle",
    price: "completed_signal_candle_close",
    sharedWithCurrentRoute: true,
  }),
  exit: Object.freeze({
    ...COMMON_EXIT,
    profitProtectionTriggerPct: 0.50,
    profitProtectionFloorPct: 0.25,
    profitProtectionStarts: "next_source_event_after_arming",
    sameBarPriority: [
      "session_exit",
      "stop_loss",
      "previously_armed_profit_protection",
      "take_profit",
      "signal_reversal",
      "board_early_exit",
    ],
  }),
  eligibleForAdoption: true,
  automaticAdoption: false,
  orderInstructionConnection: false,
});

export const DISCO_LONG_PRIOR_THREE_B_SPEC = Object.freeze({
  symbol: "6146",
  routeId: "discoConfirmedBreakLong",
  candidateKey: "6146_confirmed_long_b_prior_three_candle_guard",
  role: "entry_quality_candidate",
  historicalRole: "forward_unseen_candidate_no_historical_performance_claim",
  entry: Object.freeze({
    ...COMMON_ENTRY,
    timing: "completed_signal_candle",
    price: "completed_signal_candle_close",
    sharedWithCurrentRoute: true,
    priorCandleCount: 3,
    rejectWhen: ["all_three_bullish", "two_or_more_bearish"],
    rejectionConsumesDailySlot: true,
    rejectedCandidateSearch: "end_for_trade_date",
  }),
  exit: Object.freeze({
    ...COMMON_EXIT,
    sameBarPriority: [
      "session_exit",
      "stop_loss",
      "take_profit",
      "signal_reversal",
      "board_early_exit",
    ],
  }),
  eligibleForAdoption: true,
  automaticAdoption: false,
  orderInstructionConnection: false,
});

export type DiscoLongVariant = "profit_protection_a" | "prior_three_b";
export type DiscoLongResultType = "no_signal" | "rejected" | "entry" | "hold" | "exit";

export type DiscoLongCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type DiscoLongEntryMetrics = {
  breakoutLevel: number;
  vwap: number;
  maSlopePct: number;
  volumeRatio: number;
  atrPct: number | null;
  eligibleBeforeAtr: boolean;
  eligible: boolean;
};

export type DiscoLongPosition = {
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
  executionProxyKind: "completed_signal_candle_close";
  breakoutLevel: number;
  profitProtectionArmedAtSourceEventId: string | null;
};

export type DiscoLongState = {
  version: 1;
  variant: DiscoLongVariant;
  tradeDate: string;
  candles: DiscoLongCandle[];
  position: DiscoLongPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: DiscoLongResultType | null;
  lastActions: Array<Record<string, unknown>>;
};

export type DiscoLongClosedPosition = {
  position: DiscoLongPosition;
  exitPrice: number;
  exitReason: "stop_loss" | "take_profit" | "profit_protection" | "signal_reversal" | "board_early_exit" | "session_exit";
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
};

export type DiscoLongTransition = {
  nextState: DiscoLongState;
  resultType: DiscoLongResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: DiscoLongPosition | null;
  closedPosition: DiscoLongClosedPosition | null;
};

export function createEmptyDiscoLongState(variant: DiscoLongVariant): DiscoLongState {
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

export function normalizeDiscoLongState(
  value: unknown,
  variant: DiscoLongVariant,
  tradeDate?: string,
): DiscoLongState {
  const raw = value && typeof value === "object" ? value as Partial<DiscoLongState> : {};
  let state: DiscoLongState = {
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
    state = createEmptyDiscoLongState(variant);
    state.tradeDate = tradeDate;
  }
  return state;
}

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sharesForMode(mode: ForwardEvaluationMode, price: number): number {
  if (mode === "signal_quality") return 100;
  const rawShares = Math.floor((3_000_000 * 0.9) / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function appendCandle(state: DiscoLongState, input: ForwardSourceEventInput) {
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

export function calculateDiscoLongEntryMetrics(candles: DiscoLongCandle[]): DiscoLongEntryMetrics | null {
  if (candles.length < COMMON_ENTRY.minimumWarmupBars) return null;
  const candle = candles.at(-1)!;
  const prior = candles.slice(-1 - COMMON_ENTRY.lookback, -1);
  if (prior.length < COMMON_ENTRY.lookback) return null;
  const priorTwenty = candles.slice(-21, -1);
  const currentMa = average(candles.slice(-COMMON_ENTRY.maPeriod).map(item => item.close));
  const previousMa = average(candles.slice(-COMMON_ENTRY.maPeriod - 1, -1).map(item => item.close));
  const maSlopePct = previousMa > 0 ? (currentMa - previousMa) / previousMa * 100 : 0;
  const averageVolume = average(priorTwenty.map(item => item.volume));
  const volumeRatio = averageVolume > 0 ? candle.volume / averageVolume : 0;
  const breakoutLevel = Math.max(...prior.map(item => item.high));
  const cumulativeVolume = candles.reduce((sum, item) => sum + item.volume, 0);
  const cumulativePriceVolume = candles.reduce(
    (sum, item) => sum + ((item.high + item.low + item.close) / 3) * item.volume,
    0,
  );
  const vwap = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : candle.close;
  const atr = calcATR(
    candles.map(item => item.high),
    candles.map(item => item.low),
    candles.map(item => item.close),
    COMMON_ENTRY.atrPeriod,
  ).at(-1);
  const atrPct = atr !== null && atr !== undefined && candle.close > 0 ? atr / candle.close * 100 : null;
  const eligibleBeforeAtr = candle.time >= COMMON_ENTRY.startTime
    && candle.time <= COMMON_ENTRY.endTime
    && candle.close > breakoutLevel
    && candle.close > vwap
    && maSlopePct >= COMMON_ENTRY.minimumMaSlopePct
    && volumeRatio >= COMMON_ENTRY.minimumVolumeRatio;
  const eligible = eligibleBeforeAtr && (atrPct === null || atrPct >= COMMON_ENTRY.minimumAtrPct);
  return { breakoutLevel, vwap, maSlopePct, volumeRatio, atrPct, eligibleBeforeAtr, eligible };
}

function priorThreePattern(candles: DiscoLongCandle[]) {
  const prior = candles.slice(-4, -1);
  const bullish = prior.filter(candle => candle.close > candle.open).length;
  const bearish = prior.filter(candle => candle.close < candle.open).length;
  const doji = prior.length - bullish - bearish;
  const rejectionReason = bullish === 3
    ? "all_three_bullish"
    : bearish >= 2
      ? "two_or_more_bearish"
      : null;
  return { available: prior.length === 3, bullish, bearish, doji, rejectionReason };
}

function currentRawSignal(candles: DiscoLongCandle[]) {
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
    if (signals.some(signal => signal.type === "board_sell_pressure")) return "sell_pressure";
    if (signals.some(signal => signal.type === "large_ask_wall")) return "large_sell_wall";
  } catch {
    // 不完全な板payloadは現行と同じく早期利確なしとして扱う。
  }
  return "neutral";
}

function closePosition(
  position: DiscoLongPosition,
  exitPrice: number,
  exitReason: DiscoLongClosedPosition["exitReason"],
): DiscoLongClosedPosition {
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

function calculateExit(
  position: DiscoLongPosition,
  state: DiscoLongState,
  input: ForwardSourceEventInput,
): DiscoLongClosedPosition | null {
  if (input.candle.candleTime >= COMMON_EXIT.sessionExitTime) {
    return closePosition(position, input.candle.close, "session_exit");
  }
  const stopLine = position.entryPrice * (1 - position.slPct / 100);
  if (input.candle.low <= stopLine) return closePosition(position, stopLine, "stop_loss");

  if (state.variant === "profit_protection_a") {
    const protectionLine = position.entryPrice
      * (1 + DISCO_LONG_PROFIT_PROTECTION_A_SPEC.exit.profitProtectionFloorPct / 100);
    const armedBefore = position.profitProtectionArmedAtSourceEventId !== null
      && position.profitProtectionArmedAtSourceEventId !== input.sourceEventId;
    if (armedBefore && input.candle.low <= protectionLine) {
      return closePosition(position, Math.min(input.candle.open, protectionLine), "profit_protection");
    }
  }

  const targetLine = position.entryPrice * (1 + position.tpPct / 100);
  if (input.candle.high >= targetLine) return closePosition(position, targetLine, "take_profit");

  const rawSignal = currentRawSignal(state.candles);
  if (rawSignal?.type === "sell") return closePosition(position, input.candle.close, "signal_reversal");

  const pnlPct = (input.candle.close - position.entryPrice) / position.entryPrice * 100;
  const boardSignal = boardExitSignal(input);
  if (pnlPct >= COMMON_EXIT.boardEarlyExitMinimumProfitPct
    && (boardSignal === "sell_pressure" || boardSignal === "large_sell_wall")) {
    return closePosition(position, input.candle.close, "board_early_exit");
  }
  return null;
}

function armProtection(position: DiscoLongPosition, input: ForwardSourceEventInput) {
  if (position.profitProtectionArmedAtSourceEventId !== null) return false;
  const triggerLine = position.entryPrice
    * (1 + DISCO_LONG_PROFIT_PROTECTION_A_SPEC.exit.profitProtectionTriggerPct / 100);
  if (input.candle.high < triggerLine) return false;
  position.profitProtectionArmedAtSourceEventId = input.sourceEventId;
  return true;
}

function finalize(
  state: DiscoLongState,
  input: ForwardSourceEventInput,
  resultType: DiscoLongResultType,
  actions: Array<Record<string, unknown>>,
  openedPosition: DiscoLongPosition | null,
  closedPosition: DiscoLongClosedPosition | null,
): DiscoLongTransition {
  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

export function applyDiscoLongTransition(
  stateBefore: DiscoLongState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
  variant: DiscoLongVariant,
): DiscoLongTransition {
  const state = normalizeDiscoLongState(stateBefore, variant, input.candle.tradeDate);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: DiscoLongResultType = "no_signal";
  let openedPosition: DiscoLongPosition | null = null;
  let closedPosition: DiscoLongClosedPosition | null = null;
  appendCandle(state, input);

  if (state.stopped || input.candle.tradeDate < DISCO_LONG_FORWARD_COLLECTION_START_DATE) {
    return finalize(state, input, "rejected", [{
      type: "not_collecting",
      stopped: state.stopped,
      collectionStartDate: DISCO_LONG_FORWARD_COLLECTION_START_DATE,
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
      if (variant === "profit_protection_a" && armProtection(state.position, input)) {
        actions.push({
          type: "profit_protection_armed",
          triggerPct: DISCO_LONG_PROFIT_PROTECTION_A_SPEC.exit.profitProtectionTriggerPct,
          floorPct: DISCO_LONG_PROFIT_PROTECTION_A_SPEC.exit.profitProtectionFloorPct,
          effectiveFromNextSourceEvent: true,
        });
      }
      resultType = "hold";
    }
  } else if (!state.dailySlotConsumed) {
    const metrics = calculateDiscoLongEntryMetrics(state.candles);
    if (metrics?.eligibleBeforeAtr && !metrics.eligible) {
      resultType = "rejected";
      actions.push({
        type: "entry_rejected",
        reason: "atr_below_012pct",
        atrPct: metrics.atrPct,
        dailySlotConsumed: false,
        nextCandleSearchAllowed: true,
      });
    } else if (metrics?.eligible) {
      if (variant === "prior_three_b") {
        const pattern = priorThreePattern(state.candles);
        if (pattern.rejectionReason) {
          state.dailySlotConsumed = true;
          resultType = "rejected";
          actions.push({
            type: "prior_three_filter_rejected",
            reason: pattern.rejectionReason,
            bullish: pattern.bullish,
            bearish: pattern.bearish,
            doji: pattern.doji,
            dailySlotConsumed: true,
            nextCandleSearchAllowed: false,
          });
          return finalize(state, input, resultType, actions, null, null);
        }
      }
      const shares = sharesForMode(mode, input.candle.close);
      openedPosition = {
        side: "long",
        signalSourceEventId: input.sourceEventId,
        entrySourceEventId: input.sourceEventId,
        signalTime: input.candle.candleTime,
        entryTime: input.candle.candleTime,
        theoreticalSignalPrice: input.candle.close,
        entryPrice: input.candle.close,
        shares,
        slPct: COMMON_EXIT.slPct,
        tpPct: COMMON_EXIT.tpPct,
        executionProxyKind: "completed_signal_candle_close",
        breakoutLevel: metrics.breakoutLevel,
        profitProtectionArmedAtSourceEventId: null,
      };
      state.position = openedPosition;
      state.dailySlotConsumed = true;
      resultType = "entry";
      actions.push({
        type: "entry",
        variant,
        side: "long",
        entryPrice: openedPosition.entryPrice,
        priceSource: openedPosition.executionProxyKind,
        shares,
        metrics,
        priorThreePattern: variant === "prior_three_b" ? priorThreePattern(state.candles) : null,
      });
    }
  }

  return finalize(state, input, resultType, actions, openedPosition, closedPosition);
}

export function applyDiscoLongProfitProtectionATransition(
  stateBefore: DiscoLongState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
) {
  return applyDiscoLongTransition(stateBefore, input, mode, "profit_protection_a");
}

export function applyDiscoLongPriorThreeBTransition(
  stateBefore: DiscoLongState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
) {
  return applyDiscoLongTransition(stateBefore, input, mode, "prior_three_b");
}
