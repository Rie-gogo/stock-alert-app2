import {
  claimRtForwardShadowEvent,
  closeRtForwardShadowTrade,
  getRtForwardShadowEventsForDate,
  getRtSourceEventsForDate,
  getRtStrategyVersion,
  getRtForwardShadowState,
  getRtForwardShadowTrades,
  insertRtForwardShadowTrade,
  updateRtStrategyVersionStatus,
  updateRtForwardShadowEvent,
  upsertRtForwardShadowState,
  upsertRtStrategyVersion,
} from "./db";
import {
  TEL_OPEN_DIRECTION_BREAKOUT_SPEC,
  calculateTelOpenDirectionBreakoutMetrics,
  isTelOpenDirectionBreakoutEntryTime,
  type TelOpenDirectionBreakoutCandle,
} from "./telOpenDirectionBreakout";
import {
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  FORWARD_STRATEGY_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";

export const FORWARD_LEARNING_CUTOFF_DATE = "2026-09-02";
export const FORWARD_EVALUATION_START_DATE = "2026-09-03";
export const FORWARD_SHADOW_SYMBOL = "8035";

export type ForwardEvaluationMode = "signal_quality" | "capital_constrained";

export interface ForwardSourceCandle {
  symbol: string;
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ForwardSourceEventInput {
  sourceEventId: string;
  candle: ForwardSourceCandle;
  board: unknown | null;
}

interface PendingEntry {
  side: "long" | "short";
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  metrics: Record<string, number | boolean>;
}

interface ForwardPosition {
  side: "long" | "short";
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  shares: number;
  slPct: number;
  tpPct: number;
}

export interface ForwardShadowState {
  tradeDate: string;
  candles: TelOpenDirectionBreakoutCandle[];
  pendingEntry: PendingEntry | null;
  position: ForwardPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
}

export interface ForwardTradeMetrics {
  closedTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  pnl: number;
  pnlAfterAdverseExit: number;
  profitFactor: number | null;
  expectedR: number;
  averageWin: number;
  averageLoss: number;
  realizedPayoffRatio: number | null;
  maxDrawdown: number;
  maxConsecutiveLosses: number;
  cumulativeR: number;
  maximumLossToMedianWin: number | null;
}

function emptyState(): ForwardShadowState {
  return {
    tradeDate: "",
    candles: [],
    pendingEntry: null,
    position: null,
    dailySlotConsumed: false,
    stopped: false,
    lastSourceEventId: null,
  };
}

function parseState(value: unknown): ForwardShadowState {
  if (!value || typeof value !== "object") return emptyState();
  const raw = value as Partial<ForwardShadowState>;
  return {
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-64) : [],
    pendingEntry: raw.pendingEntry ?? null,
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
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

export function calculateForwardExitForTest(position: ForwardPosition, candle: ForwardSourceCandle): {
  price: number;
  reason: "stop_loss" | "take_profit" | "time_exit" | "session_exit";
} | null {
  const stopLine = position.side === "long"
    ? position.entryPrice * (1 - position.slPct / 100)
    : position.entryPrice * (1 + position.slPct / 100);
  const tpLine = position.side === "long"
    ? position.entryPrice * (1 + position.tpPct / 100)
    : position.entryPrice * (1 - position.tpPct / 100);

  // 同一足でTP/SL双方へ到達した場合も、最初にSLを確定する。
  if (position.side === "long" && candle.low <= stopLine) {
    return { price: Math.min(candle.open, stopLine), reason: "stop_loss" };
  }
  if (position.side === "short" && candle.high >= stopLine) {
    return { price: Math.max(candle.open, stopLine), reason: "stop_loss" };
  }
  if (position.side === "long" && candle.high >= tpLine) {
    return { price: tpLine, reason: "take_profit" };
  }
  if (position.side === "short" && candle.low <= tpLine) {
    return { price: tpLine, reason: "take_profit" };
  }
  if (candle.candleTime >= "11:27") {
    return { price: candle.close, reason: "session_exit" };
  }
  if (minutesBetween(position.entryTime, candle.candleTime) >= TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.maxHoldingMinutes) {
    return { price: candle.close, reason: "time_exit" };
  }
  return null;
}

function pnlFor(position: ForwardPosition, exitPrice: number): number {
  const raw = position.side === "long"
    ? (exitPrice - position.entryPrice) * position.shares
    : (position.entryPrice - exitPrice) * position.shares;
  return Math.round(raw);
}

function adverseExitPrice(position: ForwardPosition, exitPrice: number): number {
  const pct = FORWARD_EVALUATION_POLICY.adverseExitPct / 100;
  return position.side === "long" ? exitPrice * (1 - pct) : exitPrice * (1 + pct);
}

function riskYen(position: ForwardPosition): number {
  return position.entryPrice * position.shares * position.slPct / 100;
}

async function ensureVersion(): Promise<void> {
  const identity = getRuntimeIdentity();
  const config = {
    symbol: FORWARD_SHADOW_SYMBOL,
    strategy: "8035_open_direction_breakout_causal_fill",
    sharedDetectionCore: "calculateTelOpenDirectionBreakoutMetrics",
    entry: "next_completed_candle_open",
    sameBarPriority: "stop_loss_first",
    stopGapFill: "adverse_open",
    primary: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary,
    policy: FORWARD_EVALUATION_POLICY,
    capitalScope: "pilot_strategy_only_until_all_strategies_are_migrated",
    orderInstructionConnection: false,
  };
  await upsertRtStrategyVersion({
    versionId: FORWARD_STRATEGY_VERSION,
    strategyId: "8035_open_direction_breakout",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: FORWARD_LEARNING_CUTOFF_DATE,
    evaluationStartDate: FORWARD_EVALUATION_START_DATE,
    status: "monitoring",
    statusReason: "minimum_14_calendar_days_and_forward_signals_not_reached",
  });
}

type ForwardResultType = "no_signal" | "pending" | "entry" | "hold" | "exit" | "rejected" | "error";

interface ForwardTransition {
  nextState: ForwardShadowState;
  resultType: ForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: ForwardPosition | null;
  closedPosition: {
    position: ForwardPosition;
    exitPrice: number;
    exitReason: string;
    pnl: number;
    pnlAfterAdverseExit: number;
    realizedR: number;
  } | null;
}

function normalizeStateForEvent(rawState: unknown, input: ForwardSourceEventInput): ForwardShadowState {
  let state = parseState(rawState);
  if (state.tradeDate !== input.candle.tradeDate) {
    state = emptyState();
    state.tradeDate = input.candle.tradeDate;
  }
  return state;
}

/** 実時・Vitest・16時保存足再生が共有する副作用なしの状態遷移コア。 */
export function applyForwardShadowTransition(
  stateBefore: ForwardShadowState,
  input: ForwardSourceEventInput,
  mode: ForwardEvaluationMode,
): ForwardTransition {
  const state = parseState(stateBefore);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: ForwardResultType = "no_signal";
  let openedPosition: ForwardPosition | null = null;
  let closedPosition: ForwardTransition["closedPosition"] = null;

  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-64);

  if (state.stopped || input.candle.tradeDate < FORWARD_EVALUATION_START_DATE) {
    resultType = "rejected";
    actions.push({ type: "not_collecting", stopped: state.stopped, evaluationStartDate: FORWARD_EVALUATION_START_DATE });
  } else {
    if (state.pendingEntry && !state.position && !state.dailySlotConsumed) {
      const pending = state.pendingEntry;
      const shares = sharesForMode(mode, input.candle.open);
      state.position = {
        side: pending.side,
        entrySourceEventId: input.sourceEventId,
        signalTime: pending.signalTime,
        entryTime: input.candle.candleTime,
        theoreticalSignalPrice: pending.theoreticalSignalPrice,
        entryPrice: input.candle.open,
        shares,
        slPct: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.slPct,
        tpPct: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.tpPct,
      };
      openedPosition = { ...state.position };
      state.pendingEntry = null;
      state.dailySlotConsumed = true;
      actions.push({
        type: "entry",
        side: state.position.side,
        theoreticalSignalPrice: state.position.theoreticalSignalPrice,
        executableEntryPrice: state.position.entryPrice,
        shares,
      });
      resultType = "entry";
    }

    if (state.position) {
      const exit = calculateForwardExitForTest(state.position, input.candle);
      if (exit) {
        const position = { ...state.position };
        const pnl = pnlFor(position, exit.price);
        const pnlAfterAdverseExit = pnlFor(position, adverseExitPrice(position, exit.price));
        const realizedR = riskYen(position) > 0 ? pnl / riskYen(position) : 0;
        closedPosition = { position, exitPrice: exit.price, exitReason: exit.reason, pnl, pnlAfterAdverseExit, realizedR };
        actions.push({ type: "exit", reason: exit.reason, exitPrice: exit.price, pnl, pnlAfterAdverseExit, realizedR });
        state.position = null;
        resultType = "exit";
      } else if (resultType === "no_signal") {
        resultType = "hold";
      }
    }

    if (!state.position && !state.pendingEntry && !state.dailySlotConsumed && isTelOpenDirectionBreakoutEntryTime(input.candle.candleTime)) {
      const metrics = calculateTelOpenDirectionBreakoutMetrics(state.candles);
      const side = metrics?.longEligible ? "long" : metrics?.shortEligible ? "short" : null;
      if (metrics && side) {
        state.pendingEntry = {
          side,
          signalSourceEventId: input.sourceEventId,
          signalTime: input.candle.candleTime,
          theoreticalSignalPrice: input.candle.close,
          metrics: {
            maSlope2Pct: metrics.maSlope2Pct,
            volumeRatio: metrics.volumeRatio,
            openGainPct: metrics.openGainPct,
            closeBreaksHigh: metrics.closeBreaksHigh,
            closeBreaksLow: metrics.closeBreaksLow,
          },
        };
        actions.push({ type: "pending", side, theoreticalSignalPrice: input.candle.close, metrics: state.pendingEntry.metrics });
        if (resultType === "no_signal") resultType = "pending";
      }
    }
  }

  state.lastSourceEventId = input.sourceEventId;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

async function processMode(input: ForwardSourceEventInput, mode: ForwardEvaluationMode) {
  const saved = await getRtForwardShadowState({ strategyVersion: FORWARD_STRATEGY_VERSION, evaluationMode: mode });
  const stateBefore = normalizeStateForEvent(saved?.stateJson, input);
  const stateHashBefore = sha256Stable(stateBefore);
  const claimed = await claimRtForwardShadowEvent({
    strategyVersion: FORWARD_STRATEGY_VERSION,
    sourceEventId: input.sourceEventId,
    evaluationMode: mode,
    tradeDate: input.candle.tradeDate,
    symbol: input.candle.symbol,
    candleTime: input.candle.candleTime,
    resultType: "hold",
    decisionJson: { status: "processing" },
    stateHashBefore,
    stateHashAfter: stateHashBefore,
  });
  if (!claimed) return { duplicate: true as const, mode };

  try {
    const transition = applyForwardShadowTransition(stateBefore, input, mode);
    if (transition.openedPosition) {
      const position = transition.openedPosition;
      await insertRtForwardShadowTrade({
        strategyVersion: FORWARD_STRATEGY_VERSION,
        evaluationMode: mode,
        symbol: input.candle.symbol,
        side: position.side,
        entrySourceEventId: position.entrySourceEventId,
        entryTradeDate: input.candle.tradeDate,
        signalCandleTime: position.signalTime,
        entryCandleTime: position.entryTime,
        theoreticalSignalPrice: position.theoreticalSignalPrice.toFixed(4),
        entryPrice: position.entryPrice.toFixed(4),
        shares: position.shares,
        slPct: position.slPct.toFixed(4),
        tpPct: position.tpPct.toFixed(4),
        exitSourceEventId: null,
        exitTradeDate: null,
        exitCandleTime: null,
        exitPrice: null,
        exitReason: null,
        pnl: null,
        pnlAfterAdverseExit: null,
        realizedR: null,
      });
    }
    if (transition.closedPosition) {
      const closed = transition.closedPosition;
      await closeRtForwardShadowTrade({
        strategyVersion: FORWARD_STRATEGY_VERSION,
        evaluationMode: mode,
        entrySourceEventId: closed.position.entrySourceEventId,
        exitSourceEventId: input.sourceEventId,
        exitTradeDate: input.candle.tradeDate,
        exitCandleTime: input.candle.candleTime,
        exitPrice: closed.exitPrice.toFixed(4),
        exitReason: closed.exitReason,
        pnl: closed.pnl,
        pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
        realizedR: closed.realizedR.toFixed(6),
      });
    }
    const stateHashAfter = sha256Stable(transition.nextState);
    await upsertRtForwardShadowState({
      strategyVersion: FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
      stateJson: transition.nextState,
      stateHash: stateHashAfter,
      lastSourceEventId: input.sourceEventId,
    });
    await updateRtForwardShadowEvent({
      strategyVersion: FORWARD_STRATEGY_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      resultType: transition.resultType,
      decisionJson: {
        actions: transition.actions,
        boardPresent: input.board !== null,
        capitalScope: mode === "capital_constrained" ? "pilot_strategy_only" : "unlimited_100_shares",
        orderInstructionCreated: false,
      },
      stateHashAfter,
    });
    return { duplicate: false as const, mode, resultType: transition.resultType, actions: transition.actions };
  } catch (error) {
    await updateRtForwardShadowEvent({
      strategyVersion: FORWARD_STRATEGY_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      resultType: "error",
      decisionJson: { error: String(error), orderInstructionCreated: false },
      stateHashAfter: stateHashBefore,
    });
    throw error;
  }
}

export async function processForwardShadowSourceEvent(input: ForwardSourceEventInput) {
  if (input.candle.symbol !== FORWARD_SHADOW_SYMBOL) return { skipped: "non_pilot_symbol" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) {
    console.error("[ForwardShadow] f6878060売買ロジック固定ハッシュ不一致のため計測停止");
    return { skipped: "baseline_trading_logic_mismatch" as const };
  }
  await ensureVersion();
  const version = await getRtStrategyVersion(FORWARD_STRATEGY_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: "strategy_version_stopped" as const, status: version.status, reason: version.statusReason };
  }
  const results = [];
  for (const mode of FORWARD_EVALUATION_POLICY.evaluationModes) {
    results.push(await processMode(input, mode));
  }
  return { skipped: false as const, results };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function calculateForwardTradeMetrics(trades: Array<{
  pnl: number | null;
  pnlAfterAdverseExit: number | null;
  realizedR: string | null;
}>): ForwardTradeMetrics {
  const closed = trades.filter(trade => trade.pnl !== null);
  const pnlValues = closed.map(trade => trade.pnl ?? 0);
  const wins = pnlValues.filter(value => value > 0);
  const losses = pnlValues.filter(value => value <= 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveLosses = 0;
  for (const value of pnlValues) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    if (value <= 0) {
      consecutiveLosses += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }
  const realizedRValues = closed.map(trade => Number(trade.realizedR ?? 0));
  const averageWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const averageLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const medianWin = median(wins);
  const maximumLoss = losses.length > 0 ? Math.max(...losses.map(value => Math.abs(value))) : 0;
  return {
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length > 0 ? wins.length / closed.length * 100 : 0,
    pnl: pnlValues.reduce((sum, value) => sum + value, 0),
    pnlAfterAdverseExit: closed.reduce((sum, trade) => sum + (trade.pnlAfterAdverseExit ?? 0), 0),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? null : 0,
    expectedR: realizedRValues.length > 0 ? realizedRValues.reduce((sum, value) => sum + value, 0) / realizedRValues.length : 0,
    averageWin,
    averageLoss,
    realizedPayoffRatio: averageLoss > 0 ? averageWin / averageLoss : wins.length > 0 ? null : 0,
    maxDrawdown,
    maxConsecutiveLosses,
    cumulativeR: realizedRValues.reduce((sum, value) => sum + value, 0),
    maximumLossToMedianWin: medianWin > 0 ? maximumLoss / medianWin : maximumLoss > 0 ? null : 0,
  };
}

function calendarDaysInclusive(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 86_400_000) + 1);
}

export function evaluateForwardDecision(metrics: ForwardTradeMetrics, asOfDate: string) {
  const days = calendarDaysInclusive(FORWARD_EVALUATION_START_DATE, asOfDate);
  if (metrics.maxConsecutiveLosses >= FORWARD_EVALUATION_POLICY.maximumConsecutiveLosses
    || metrics.cumulativeR <= -FORWARD_EVALUATION_POLICY.maximumCumulativeLossR) {
    return { status: "stopped" as const, reason: "safety_stop", days };
  }
  if (days < FORWARD_EVALUATION_POLICY.interimCalendarDays) {
    return { status: "monitoring" as const, reason: "before_two_week_interim", days };
  }
  const passesCore = metrics.closedTrades > 0
    && metrics.winRatePct >= FORWARD_EVALUATION_POLICY.minimumObservedWinRatePct
    && metrics.pnl > 0
    && (metrics.profitFactor === null || metrics.profitFactor >= FORWARD_EVALUATION_POLICY.minimumProfitFactor)
    && metrics.expectedR >= FORWARD_EVALUATION_POLICY.minimumExpectedR
    && metrics.pnlAfterAdverseExit > 0;
  const finalBySignals = days >= FORWARD_EVALUATION_POLICY.minimumCalendarDaysForSignalCountDecision
    && metrics.closedTrades >= FORWARD_EVALUATION_POLICY.minimumSignalsForEarlyDecision;
  const finalByTime = days >= FORWARD_EVALUATION_POLICY.calendarDaysForTimeDecision
    && metrics.closedTrades >= FORWARD_EVALUATION_POLICY.minimumSignalsForTimeDecision;
  if (finalBySignals || finalByTime) {
    return passesCore
      ? { status: "eligible" as const, reason: finalBySignals ? "two_weeks_and_twenty_signals" : "four_weeks_and_ten_signals", days }
      : { status: "stopped" as const, reason: "final_thresholds_not_met", days };
  }
  if (days >= FORWARD_EVALUATION_POLICY.maximumCalendarDays) {
    return { status: "insufficient" as const, reason: "fewer_than_ten_signals_after_eight_weeks", days };
  }
  const interimGood = metrics.closedTrades < 5
    || (metrics.winRatePct >= 60 && metrics.pnl > 0 && (metrics.profitFactor === null || metrics.profitFactor >= 1.1));
  return interimGood
    ? { status: "interim_continue" as const, reason: metrics.closedTrades < 5 ? "interim_sample_insufficient" : "interim_thresholds_met", days }
    : { status: "stopped" as const, reason: "two_week_interim_thresholds_not_met", days };
}

export async function getForwardShadowSummary(asOfDate: string) {
  const trades = await getRtForwardShadowTrades(FORWARD_STRATEGY_VERSION);
  return FORWARD_EVALUATION_POLICY.evaluationModes.map(mode => {
    const modeTrades = trades.filter(trade => trade.evaluationMode === mode);
    const metrics = calculateForwardTradeMetrics(modeTrades);
    return { mode, metrics, decision: evaluateForwardDecision(metrics, asOfDate), pilotOnly: mode === "capital_constrained" };
  });
}

interface ReplaySourceEvent {
  sourceEventId: string;
  status: string;
  resultAction: string | null;
  payloadJson: unknown;
}

interface ReplayStoredEvent {
  sourceEventId: string;
  evaluationMode: ForwardEvaluationMode;
  resultType: string;
  stateHashBefore: string;
  stateHashAfter: string;
}

function parseReplayInput(event: ReplaySourceEvent): ForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== FORWARD_SHADOW_SYMBOL
    || typeof raw.tradeDate !== "string"
    || typeof raw.candleTime !== "string"
    || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => typeof value === "number")) {
    return null;
  }
  return {
    sourceEventId: event.sourceEventId,
    candle: {
      symbol: raw.symbol,
      tradeDate: raw.tradeDate,
      candleTime: raw.candleTime,
      open: raw.open as number,
      high: raw.high as number,
      low: raw.low as number,
      close: raw.close as number,
      volume: raw.volume as number,
    },
    board: raw.board ?? null,
  };
}

/** 当日生イベントを同じ純粋コアへ再投入し、実時保存結果と完全照合する。DB更新は行わない。 */
export function replayForwardShadowDay(
  sourceEvents: ReplaySourceEvent[],
  storedEvents: ReplayStoredEvent[],
) {
  let mismatches = 0;
  let invalidPayloads = 0;
  let replayedEvents = 0;
  const details: Array<Record<string, unknown>> = [];
  for (const mode of FORWARD_EVALUATION_POLICY.evaluationModes) {
    let state = emptyState();
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const input = parseReplayInput(sourceEvent);
      if (!input) {
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === FORWARD_SHADOW_SYMBOL) {
          invalidPayloads += 1;
        }
        continue;
      }
      state = normalizeStateForEvent(state, input);
      const stateHashBefore = sha256Stable(state);
      const transition = applyForwardShadowTransition(state, input, mode);
      const stateHashAfter = sha256Stable(transition.nextState);
      replayedEvents += 1;
      const stored = storedEvents.find(event => event.sourceEventId === sourceEvent.sourceEventId && event.evaluationMode === mode);
      const matched = Boolean(stored)
        && stored?.resultType === transition.resultType
        && stored?.stateHashBefore === stateHashBefore
        && stored?.stateHashAfter === stateHashAfter;
      if (!matched) {
        mismatches += 1;
        details.push({
          mode,
          sourceEventId: sourceEvent.sourceEventId,
          expectedResultType: transition.resultType,
          storedResultType: stored?.resultType ?? null,
          expectedStateHashBefore: stateHashBefore,
          storedStateHashBefore: stored?.stateHashBefore ?? null,
          expectedStateHashAfter: stateHashAfter,
          storedStateHashAfter: stored?.stateHashAfter ?? null,
        });
      }
      state = transition.nextState;
    }
  }
  return { replayedEvents, mismatches, invalidPayloads, details };
}

function formatNullable(value: number | null, digits = 2): string {
  return value === null ? "∞（損失なし）" : value.toFixed(digits);
}

export async function formatForwardShadowDryRunReport(asOfDate: string): Promise<string> {
  const identity = getRuntimeIdentity();
  const summaries = await getForwardShadowSummary(asOfDate);
  const [sourceEvents, shadowEvents] = await Promise.all([
    getRtSourceEventsForDate(asOfDate),
    getRtForwardShadowEventsForDate(asOfDate),
  ]);
  const replayAudit = replayForwardShadowDay(sourceEvents, shadowEvents);
  let stateContinuityMismatches = 0;
  for (const mode of FORWARD_EVALUATION_POLICY.evaluationModes) {
    const modeEvents = shadowEvents
      .filter(event => event.strategyVersion === FORWARD_STRATEGY_VERSION && event.evaluationMode === mode)
      .sort((a, b) => a.id - b.id);
    for (let index = 1; index < modeEvents.length; index += 1) {
      if (modeEvents[index].stateHashBefore !== modeEvents[index - 1].stateHashAfter) {
        stateContinuityMismatches += 1;
      }
    }
  }
  const signalQuality = summaries.find(item => item.mode === "signal_quality");
  if (signalQuality) {
    await updateRtStrategyVersionStatus({
      versionId: FORWARD_STRATEGY_VERSION,
      status: signalQuality.decision.status,
      statusReason: signalQuality.decision.reason,
    });
  }
  const lines = summaries.map(item => {
    const label = item.mode === "signal_quality"
      ? "100株・証拠金なし全発火"
      : "891万円上限・可変株数（8035単独パイロット。10銘柄統合判定には未使用）";
    return [
      `  ${label}`,
      `    前向き完了: ${item.metrics.closedTrades}件（勝${item.metrics.wins}/負${item.metrics.losses}、勝率${item.metrics.winRatePct.toFixed(2)}%）`,
      `    損益: ${item.metrics.pnl >= 0 ? "+" : ""}${item.metrics.pnl.toLocaleString()}円 / 0.10%不利出口後: ${item.metrics.pnlAfterAdverseExit >= 0 ? "+" : ""}${item.metrics.pnlAfterAdverseExit.toLocaleString()}円`,
      `    PF: ${formatNullable(item.metrics.profitFactor)} / 期待値: ${item.metrics.expectedR.toFixed(3)}R / 実現平均利益÷平均損失: ${formatNullable(item.metrics.realizedPayoffRatio)}`,
      `    最大DD: ${item.metrics.maxDrawdown.toLocaleString()}円 / 最大連敗: ${item.metrics.maxConsecutiveLosses} / 判定: ${item.decision.status} (${item.decision.reason})`,
      `    一次判定まで: あと${Math.max(0, FORWARD_EVALUATION_POLICY.interimCalendarDays - item.decision.days)}日 / 20件まで: あと${Math.max(0, FORWARD_EVALUATION_POLICY.minimumSignalsForEarlyDecision - item.metrics.closedTrades)}件`,
      `    4週間10件条件: あと${Math.max(0, FORWARD_EVALUATION_POLICY.calendarDaysForTimeDecision - item.decision.days)}日・あと${Math.max(0, FORWARD_EVALUATION_POLICY.minimumSignalsForTimeDecision - item.metrics.closedTrades)}件`,
    ].join("\n");
  });
  return `
【未見データ前向きシャドー評価】
  戦略版: ${FORWARD_STRATEGY_VERSION}
  計測開始: ${FORWARD_EVALUATION_START_DATE}（学習終了: ${FORWARD_LEARNING_CUTOFF_DATE}）
  build Git SHA: ${identity.buildGitSha}
  売買ロジック基準SHA: ${identity.baselineStrategyGitSha}
  設定ハッシュ: ${identity.configHash}
  売買ロジックf6878060一致: ${identity.tradingLogicMatchesBaseline ? "OK" : "NG（計測停止要確認）"}
  対象銘柄: ${identity.activeEntrySymbols.join(",")}
  注文接続: なし（シャドーテーブルのみ）
  当日受信監査: ${sourceEvents.length}件（processed=${sourceEvents.filter(event => event.status === "processed").length}, failed=${sourceEvents.filter(event => event.status === "failed").length}, processing=${sourceEvents.filter(event => event.status === "processing").length}）
  当日シャドー判断: ${shadowEvents.length}件（error=${shadowEvents.filter(event => event.resultType === "error").length}, 状態ハッシュ連続不一致=${stateContinuityMismatches}）
  当日固定版再生: ${replayAudit.replayedEvents}判断再生（実時との差=${replayAudit.mismatches}, 不正payload=${replayAudit.invalidPayloads}）
${lines.join("\n")}
`;
}
