import { randomUUID } from "node:crypto";
import {
  acquireRtForwardShadowStateLock,
  claimOrRetryRtForwardShadowEvent,
  closeRtForwardShadowTrade,
  failRtForwardShadowEvent,
  getRtForwardShadowEventsForDate,
  getRtSourceEventsForDate,
  getRtRealtimeDecisionEventsForDate,
  getRtStrategyVersion,
  getRtForwardShadowState,
  getRtForwardShadowTrades,
  insertRtForwardShadowTrade,
  releaseRtForwardShadowStateLock,
  updateRtStrategyVersionStatus,
  updateRtForwardShadowEvent,
  upsertRtForwardShadowState,
  upsertRtStrategyVersion,
} from "./db";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";
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
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  FUJIKURA_FORWARD_EVALUATION_START_DATE,
  FUJIKURA_FORWARD_LEARNING_CUTOFF_DATE,
  replayFujikuraForwardShadowDay,
} from "./fujikuraForwardShadowEngine";
import {
  KIOXIA_FORWARD_EVALUATION_START_DATE,
  KIOXIA_FORWARD_LEARNING_CUTOFF_DATE,
  replayKioxiaForwardShadowDay,
} from "./kioxiaForwardShadowEngine";
import {
  KIOXIA_ATR_FORWARD_EVALUATION_START_DATE,
  KIOXIA_ATR_FORWARD_LEARNING_CUTOFF_DATE,
  processKioxiaAtrForwardShadowSourceEvent,
  replayKioxiaAtrForwardShadowDay,
} from "./kioxiaAtrForwardShadowEngine";
import { compareTelCurrentParityForDate } from "./telParityComparison";
import {
  TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE,
  TEL_EXECUTABLE_CONFIRM_LEARNING_CUTOFF_DATE,
  TEL_EXECUTABLE_CONFIRM_VERSION,
} from "./telExecutableConfirm";
import { auditTelExecutableConfirmDay } from "./telExecutableConfirmEngine";
import {
  TEL_EXECUTABLE_DEPTH_EVALUATION_START_DATE,
  TEL_EXECUTABLE_DEPTH_LEARNING_CUTOFF_DATE,
  TEL_EXECUTABLE_DEPTH_VERSION,
} from "./telExecutableConfirmDepth";
import { auditTelExecutableConfirmDepthDay } from "./telExecutableConfirmDepthEngine";
import {
  buildActualReceiptPortfolioAuditForDate,
  buildAllCandidateMinutePortfolioForDate,
  buildAllCandidateReceiptPortfolioForDate,
  buildMinuteNormalizedPortfolioAuditForDate,
} from "./portfolioAudit";
import { buildDivergenceHypotheses, buildOutcomeLabelsForDate } from "./outcomeDivergenceAudit";

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
  currentAudit?: {
    engineSequence: number | null;
    resultType: string;
    routeId: string | null;
    marginUsedBefore: number;
    marginUsedAfter: number;
    stateHashBefore: string;
    stateHashAfter: string;
    causalityStatus: string;
    causalityReason: string;
    boardObservedAtMs: number | null;
    relayAssembledAtMs: number | null;
    cloudReceivedAtMs: number | null;
    decisionStartedAtMs: number;
    decisionCompletedAtMs: number;
  };
  /** 8035既存シャドーを内部再帰で一度だけ呼ぶための非永続フラグ。 */
  internalSkipTelParity?: boolean;
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
  lastResultType: ForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
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
    lastResultType: null,
    lastActions: [],
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
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
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

function executablePriceFromBoard(board: unknown): number | null {
  if (!board || typeof board !== "object") return null;
  const price = Number((board as { currentPrice?: unknown }).currentPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
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

async function waitForForwardStateLock(input: {
  strategyVersion: string;
  evaluationMode: ForwardEvaluationMode;
  ownerToken: string;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await acquireRtForwardShadowStateLock({ ...input, leaseMs: 5_000 })) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function ensureVersion(): Promise<void> {
  const identity = getRuntimeIdentity();
  const config = {
    symbol: FORWARD_SHADOW_SYMBOL,
    strategy: "8035_open_direction_breakout_causal_fill",
    sharedDetectionCore: "calculateTelOpenDirectionBreakoutMetrics",
    entry: "board_current_price_at_server_receipt_after_signal",
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
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
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
      state.pendingEntry = null;
      const executablePrice = executablePriceFromBoard(input.board);
      if (executablePrice === null) {
        actions.push({ type: "entry_rejected", reason: "executable_price_unavailable" });
        resultType = "rejected";
      } else {
        const shares = sharesForMode(mode, executablePrice);
        state.position = {
          side: pending.side,
          entrySourceEventId: input.sourceEventId,
          signalTime: pending.signalTime,
          entryTime: input.candle.candleTime,
          theoreticalSignalPrice: pending.theoreticalSignalPrice,
          entryPrice: executablePrice,
          shares,
          slPct: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.slPct,
          tpPct: TEL_OPEN_DIRECTION_BREAKOUT_SPEC.primary.tpPct,
        };
        openedPosition = { ...state.position };
        state.dailySlotConsumed = true;
        actions.push({
          type: "entry",
          side: state.position.side,
          theoreticalSignalPrice: state.position.theoreticalSignalPrice,
          executableEntryPrice: state.position.entryPrice,
          executionPriceSource: "board_current_price_at_server_receipt",
          shares,
        });
        resultType = "entry";
      }
    }

    if (state.position && !openedPosition) {
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
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

async function processMode(input: ForwardSourceEventInput, mode: ForwardEvaluationMode) {
  const lockToken = createForwardShadowLockOwnerToken({
    strategyVersion: FORWARD_STRATEGY_VERSION,
    sourceEventId: input.sourceEventId,
    evaluationMode: mode,
  });
  const locked = await waitForForwardStateLock({
    strategyVersion: FORWARD_STRATEGY_VERSION,
    evaluationMode: mode,
    ownerToken: lockToken,
  });
  if (!locked) throw new Error(`forward_shadow_state_lock_timeout:${FORWARD_STRATEGY_VERSION}:${mode}`);
  let stateHashBefore = sha256Stable(emptyState());
  try {
    const saved = await getRtForwardShadowState({ strategyVersion: FORWARD_STRATEGY_VERSION, evaluationMode: mode });
    const stateBefore = normalizeStateForEvent(saved?.stateJson, input);
    stateHashBefore = sha256Stable(stateBefore);
    const claim = await claimOrRetryRtForwardShadowEvent({
      claimToken: randomUUID(),
      data: {
        strategyVersion: FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        tradeDate: input.candle.tradeDate,
        symbol: input.candle.symbol,
        candleTime: input.candle.candleTime,
        resultType: "hold",
        decisionJson: { status: "processing", orderInstructionCreated: false },
        stateHashBefore,
        stateHashAfter: stateHashBefore,
      },
    });
    if (claim !== "claimed") return { duplicate: claim === "completed" as const, busy: claim === "busy" as const, mode };
    if (stateBefore.lastSourceEventId === input.sourceEventId && stateBefore.lastResultType) {
      await updateRtForwardShadowEvent({
        strategyVersion: FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        resultType: stateBefore.lastResultType,
        decisionJson: { actions: stateBefore.lastActions, recoveredFromCommittedState: true, orderInstructionCreated: false },
        stateHashAfter: stateHashBefore,
      });
      return { duplicate: false as const, recovered: true as const, mode, resultType: stateBefore.lastResultType };
    }
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
        executablePriceSource: "board_current_price_at_server_receipt",
        capitalScope: mode === "capital_constrained" ? "pilot_strategy_only" : "unlimited_100_shares",
        orderInstructionCreated: false,
      },
      stateHashAfter,
    });
    return { duplicate: false as const, mode, resultType: transition.resultType, actions: transition.actions };
  } catch (error) {
    try {
      await failRtForwardShadowEvent({
        strategyVersion: FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        errorDetail: String(error),
        stateHashBefore,
      });
    } catch (markError) {
      console.error("[ForwardShadow:8035] error状態保存にも失敗:", markError);
    }
    throw error;
  } finally {
    await releaseRtForwardShadowStateLock({
      strategyVersion: FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
      ownerToken: lockToken,
    });
  }
}

export async function processForwardShadowSourceEvent(input: ForwardSourceEventInput) {
  if (input.candle.symbol === "8035" && !input.internalSkipTelParity) {
    const { processTelCurrentParitySourceEvent } = await import("./telCurrentParityEngine");
    const { processTelExecutableConfirmSourceEvent } = await import("./telExecutableConfirmEngine");
    const { processTelExecutableConfirmDepthSourceEvent } = await import("./telExecutableConfirmDepthEngine");
    const evaluations: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (const evaluate of [
      () => processForwardShadowSourceEvent({ ...input, internalSkipTelParity: true }),
      () => processTelCurrentParitySourceEvent(input, input.currentAudit?.marginUsedBefore ?? 0),
      () => processTelExecutableConfirmSourceEvent(input),
      () => processTelExecutableConfirmDepthSourceEvent(input),
    ]) {
      try {
        evaluations.push(await evaluate());
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (errors.length > 0) {
      throw new Error(`tel_forward_shadow_partial_failure:${errors.join(" | ")}`);
    }
    return { skipped: false as const, symbol: "8035", evaluations };
  }
  if (input.candle.symbol === "285A") {
    const { processKioxiaForwardShadowSourceEvent } = await import("./kioxiaForwardShadowEngine");
    const evaluations: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (const evaluate of [processKioxiaForwardShadowSourceEvent, processKioxiaAtrForwardShadowSourceEvent]) {
      try {
        evaluations.push(await evaluate(input));
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (errors.length > 0) {
      throw new Error(`kioxia_forward_shadow_partial_failure:${errors.join(" | ")}`);
    }
    return { skipped: false as const, symbol: "285A", evaluations };
  }
  if (input.candle.symbol === "5803") {
    const { processFujikuraForwardShadowSourceEvent } = await import("./fujikuraForwardShadowEngine");
    return processFujikuraForwardShadowSourceEvent(input);
  }
  if (input.candle.symbol !== FORWARD_SHADOW_SYMBOL) return { skipped: "non_shadow_symbol" as const };
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

export function evaluateForwardDecision(
  metrics: ForwardTradeMetrics,
  asOfDate: string,
  evaluationStartDate = FORWARD_EVALUATION_START_DATE,
) {
  const days = calendarDaysInclusive(evaluationStartDate, asOfDate);
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
  const finalByTime = days >= FORWARD_EVALUATION_POLICY.calendarDaysForTimeDecision
    && metrics.closedTrades >= FORWARD_EVALUATION_POLICY.minimumSignalsForTimeDecision;
  if (finalByTime) {
    return passesCore
      ? { status: "eligible" as const, reason: "four_weeks_and_ten_signals_manual_review_required", days }
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

export async function getForwardShadowSummary(asOfDate: string, strategyVersion = FORWARD_STRATEGY_VERSION) {
  const trades = await getRtForwardShadowTrades(strategyVersion);
  const evaluationStartDate = strategyVersion === FUJIKURA_FORWARD_STRATEGY_VERSION
    ? FUJIKURA_FORWARD_EVALUATION_START_DATE
    : strategyVersion === KIOXIA_FORWARD_STRATEGY_VERSION
      ? KIOXIA_FORWARD_EVALUATION_START_DATE
      : strategyVersion === KIOXIA_ATR_FORWARD_STRATEGY_VERSION
        ? KIOXIA_ATR_FORWARD_EVALUATION_START_DATE
        : strategyVersion === TEL_EXECUTABLE_CONFIRM_VERSION
          ? TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE
          : strategyVersion === TEL_EXECUTABLE_DEPTH_VERSION
            ? TEL_EXECUTABLE_DEPTH_EVALUATION_START_DATE
          : FORWARD_EVALUATION_START_DATE;
  return FORWARD_EVALUATION_POLICY.evaluationModes.map(mode => {
    const modeTrades = trades.filter(trade => trade.evaluationMode === mode);
    const metrics = calculateForwardTradeMetrics(modeTrades);
    return {
      mode,
      metrics,
      decision: evaluateForwardDecision(metrics, asOfDate, evaluationStartDate),
      pilotOnly: mode === "capital_constrained",
    };
  });
}

interface ReplaySourceEvent {
  sourceEventId: string;
  status: string;
  resultAction: string | null;
  payloadJson: unknown;
}

interface ReplayStoredEvent {
  strategyVersion?: string;
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
      const stored = storedEvents.find(event => (event.strategyVersion === undefined || event.strategyVersion === FORWARD_STRATEGY_VERSION)
        && event.sourceEventId === sourceEvent.sourceEventId
        && event.evaluationMode === mode);
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
  let telParityAudit: Awaited<ReturnType<typeof compareTelCurrentParityForDate>> | { skipped: "error"; error: string };
  try {
    telParityAudit = await compareTelCurrentParityForDate(asOfDate);
  } catch (error) {
    telParityAudit = { skipped: "error", error: String(error) };
  }
  const [sourceEvents, shadowEvents] = await Promise.all([
    getRtSourceEventsForDate(asOfDate),
    getRtForwardShadowEventsForDate(asOfDate),
  ]);
  const [
    realtimeDecisionEvents,
    actualPortfolio,
    normalizedPortfolio,
    allCandidateReceiptPortfolio,
    allCandidateMinutePortfolio,
    outcomeLabels,
  ] = await Promise.all([
    getRtRealtimeDecisionEventsForDate(asOfDate),
    buildActualReceiptPortfolioAuditForDate(asOfDate),
    buildMinuteNormalizedPortfolioAuditForDate(asOfDate),
    buildAllCandidateReceiptPortfolioForDate(asOfDate),
    buildAllCandidateMinutePortfolioForDate(asOfDate),
    buildOutcomeLabelsForDate(asOfDate),
  ]);
  const divergence = await buildDivergenceHypotheses(asOfDate);
  const strategyDefinitions = [
    {
      versionId: FORWARD_STRATEGY_VERSION,
      symbol: "8035",
      title: "8035 始値方向ブレイク・因果的約定パイロット",
      startDate: FORWARD_EVALUATION_START_DATE,
      cutoffDate: FORWARD_LEARNING_CUTOFF_DATE,
      replay: () => replayForwardShadowDay(sourceEvents, shadowEvents),
      adoptionEligible: true,
      lifecycle: "active_candidate",
    },
    {
      versionId: FUJIKURA_FORWARD_STRATEGY_VERSION,
      symbol: "5803",
      title: "5803 安値反転LONG A＋B（BPR0.70・利益保護0.5→0.3）",
      startDate: FUJIKURA_FORWARD_EVALUATION_START_DATE,
      cutoffDate: FUJIKURA_FORWARD_LEARNING_CUTOFF_DATE,
      replay: () => replayFujikuraForwardShadowDay(sourceEvents, shadowEvents),
      adoptionEligible: true,
      lifecycle: "active_candidate",
    },
    {
      versionId: KIOXIA_FORWARD_STRATEGY_VERSION,
      symbol: "285A",
      title: "285A 確認型前場LONG・MA8失速確認付き利益保護",
      startDate: KIOXIA_FORWARD_EVALUATION_START_DATE,
      cutoffDate: KIOXIA_FORWARD_LEARNING_CUTOFF_DATE,
      replay: () => replayKioxiaForwardShadowDay(sourceEvents, shadowEvents),
      adoptionEligible: true,
      lifecycle: "active_candidate",
    },
    {
      versionId: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
      symbol: "285A",
      title: "285A 現行5経路・ATR7 0.36%未満の該当経路日次終了",
      startDate: KIOXIA_ATR_FORWARD_EVALUATION_START_DATE,
      cutoffDate: KIOXIA_ATR_FORWARD_LEARNING_CUTOFF_DATE,
      replay: () => replayKioxiaAtrForwardShadowDay(sourceEvents, shadowEvents),
      adoptionEligible: true,
      lifecycle: "active_candidate",
    },
    {
      versionId: TEL_EXECUTABLE_CONFIRM_VERSION,
      symbol: "8035",
      title: "8035 次イベント・ブレイク継続確認A案",
      startDate: TEL_EXECUTABLE_CONFIRM_EVALUATION_START_DATE,
      cutoffDate: TEL_EXECUTABLE_CONFIRM_LEARNING_CUTOFF_DATE,
      replay: () => auditTelExecutableConfirmDay(sourceEvents, shadowEvents),
      adoptionEligible: false,
      lifecycle: "superseded_stopped_audit_only",
    },
    {
      versionId: TEL_EXECUTABLE_DEPTH_VERSION,
      symbol: "8035",
      title: "8035 次イベント・side別板depth VWAP継続確認A案 v2",
      startDate: TEL_EXECUTABLE_DEPTH_EVALUATION_START_DATE,
      cutoffDate: TEL_EXECUTABLE_DEPTH_LEARNING_CUTOFF_DATE,
      replay: () => auditTelExecutableConfirmDepthDay(sourceEvents, shadowEvents),
      adoptionEligible: true,
      lifecycle: "active_candidate",
    },
  ] as const;
  const sections: string[] = [];
  for (const definition of strategyDefinitions) {
    const summaries = await getForwardShadowSummary(asOfDate, definition.versionId);
    const versionEvents = shadowEvents.filter(event => event.strategyVersion === definition.versionId);
    const replayAudit = definition.replay();
    let stateContinuityMismatches = 0;
    for (const mode of FORWARD_EVALUATION_POLICY.evaluationModes) {
      const modeEvents = versionEvents.filter(event => event.evaluationMode === mode).sort((a, b) => a.id - b.id);
      for (let index = 1; index < modeEvents.length; index += 1) {
        if (modeEvents[index].stateHashBefore !== modeEvents[index - 1].stateHashAfter) stateContinuityMismatches += 1;
      }
    }
    const signalQuality = summaries.find(item => item.mode === "signal_quality");
    if (signalQuality && definition.adoptionEligible) {
      await updateRtStrategyVersionStatus({
        versionId: definition.versionId,
        status: signalQuality.decision.status,
        statusReason: signalQuality.decision.reason,
      });
    } else if (!definition.adoptionEligible) {
      await updateRtStrategyVersionStatus({
        versionId: definition.versionId,
        status: "stopped",
        statusReason: definition.lifecycle,
      });
    }
    const lines = summaries.map(item => {
      const label = item.mode === "signal_quality"
        ? "100株・証拠金なし全発火"
        : `891万円上限・可変株数（${definition.symbol}単独パイロット。10銘柄統合判定には未使用）`;
      return [
        `  ${label}`,
        `    前向き完了: ${item.metrics.closedTrades}件（勝${item.metrics.wins}/負${item.metrics.losses}、勝率${item.metrics.winRatePct.toFixed(2)}%）`,
        `    損益: ${item.metrics.pnl >= 0 ? "+" : ""}${item.metrics.pnl.toLocaleString()}円 / 0.10%不利出口後: ${item.metrics.pnlAfterAdverseExit >= 0 ? "+" : ""}${item.metrics.pnlAfterAdverseExit.toLocaleString()}円`,
        `    PF: ${formatNullable(item.metrics.profitFactor)} / 期待値: ${item.metrics.expectedR.toFixed(3)}R / 実現平均利益÷平均損失: ${formatNullable(item.metrics.realizedPayoffRatio)}`,
        `    最大DD: ${item.metrics.maxDrawdown.toLocaleString()}円 / 最大連敗: ${item.metrics.maxConsecutiveLosses} / 判定: ${item.decision.status} (${item.decision.reason})`,
        `    一次判定まで: あと${Math.max(0, FORWARD_EVALUATION_POLICY.interimCalendarDays - item.decision.days)}日 / 20件到達時も継続判定のみ: あと${Math.max(0, FORWARD_EVALUATION_POLICY.minimumSignalsForEarlyDecision - item.metrics.closedTrades)}件`,
        `    4週間10件条件: あと${Math.max(0, FORWARD_EVALUATION_POLICY.calendarDaysForTimeDecision - item.decision.days)}日・あと${Math.max(0, FORWARD_EVALUATION_POLICY.minimumSignalsForTimeDecision - item.metrics.closedTrades)}件`,
      ].join("\n");
    });
    sections.push(`
	【${definition.title}】
	  戦略版: ${definition.versionId}
	  計測開始: ${definition.startDate}（学習終了: ${definition.cutoffDate}）
	  採用審査: ${definition.adoptionEligible ? "対象（自動採用・自動置換なし）" : "対象外（旧版停止・監査保持のみ）"}
	  注文接続: なし（strategyVersion別シャドーテーブルのみ）
  当日シャドー判断: ${versionEvents.length}件（error=${versionEvents.filter(event => event.resultType === "error").length}, 状態ハッシュ連続不一致=${stateContinuityMismatches}）
  当日固定版再生: ${replayAudit.replayedEvents}判断再生（実時との差=${replayAudit.mismatches}, 不正payload=${replayAudit.invalidPayloads}）
	${lines.join("\n")}`);
  }
  const activeEntrySymbols = new Set(identity.activeEntrySymbols);
  const targetSourceEvents = sourceEvents.filter(event => activeEntrySymbols.has(event.symbol));
  const targetRealtimeDecisionEvents = realtimeDecisionEvents.filter(event => activeEntrySymbols.has(event.symbol));
  const targetProcessedEvents = targetSourceEvents.filter(event => event.status === "processed").length;
  const auditJournalGap = Math.max(0, targetProcessedEvents - targetRealtimeDecisionEvents.length);
  return `
【未見データ前向きシャドー評価】
  build Git SHA: ${identity.buildGitSha ?? "未提供（売買ソース固定hashで照合）"}
  deployment version: ${identity.deploymentVersion ?? "unavailable"}
  deployment revision: ${identity.deploymentRevision ?? "unavailable"}
  売買ロジック基準SHA: ${identity.baselineStrategyGitSha}
  設定ハッシュ: ${identity.configHash}
  売買ロジックf6878060一致: ${identity.tradingLogicMatchesBaseline ? "OK" : "NG（計測停止要確認）"}
  対象銘柄: ${identity.activeEntrySymbols.join(",")}
  注文接続: なし（シャドーテーブルのみ）
  当日受信監査: ${sourceEvents.length}件（processed=${sourceEvents.filter(event => event.status === "processed").length}, failed=${sourceEvents.filter(event => event.status === "failed").length}, processing=${sourceEvents.filter(event => event.status === "processing").length}）
【8035 現行完全再現監査】
  戦略版: baseline-8035-current-parity-v1（比較専用・採用審査対象外）
  結果: ${telParityAudit.skipped === false
    ? `${telParityAudit.processed}件再生 / 一致${telParityAudit.matched} / 不一致${telParityAudit.mismatched} / 不正payload${telParityAudit.invalidPayloads}`
    : `未実行 (${telParityAudit.skipped}${"error" in telParityAudit ? `: ${telParityAudit.error}` : ""})`}
  最初の不一致: ${telParityAudit.skipped === false && telParityAudit.firstMismatch
    ? JSON.stringify(telParityAudit.firstMismatch)
    : "なし"}
  再起動位置変更監査: ${telParityAudit.skipped === false ? (telParityAudit.restartAudit.matched ? "一致" : "不一致") : "未実行"}
【現行 因果性Gate】
  現行10銘柄の判断台帳: 期待${targetProcessedEvents}件 / 保存${targetRealtimeDecisionEvents.length}件 / 欠損${auditJournalGap}件
  因果性: pass=${targetRealtimeDecisionEvents.filter(event => event.causalityStatus === "pass").length} / violation=${targetRealtimeDecisionEvents.filter(event => event.causalityStatus === "violation").length} / unverified=${targetRealtimeDecisionEvents.filter(event => event.causalityStatus === "unverified").length}
  価格名称: signal_reference / market_observed / executable_price_proxy / simulated_bar_fill（実約定価格はDRY_RUNのため取得なし）
【10銘柄・891万円 portfolio監査】
  実受信・実状態更新順: ${actualPortfolio.processed}判断 / 採用${actualPortfolio.accepted} / margin_block${actualPortfolio.marginBlocked} / 決済${actualPortfolio.closed} / 証拠金状態不一致${actualPortfolio.marginStateMismatches}
  同一分固定優先順位: ${normalizedPortfolio.candidateBatches}候補分 / 採用${normalizedPortfolio.accepted} / margin_block${normalizedPortfolio.marginBlocked} / blocker辺${normalizedPortfolio.blockEdges.length}
  旧診断版注意: 上記固定優先順位版は実採用＋margin_blockの局所診断であり、portfolio損益比較には使わない
  全candidate正式v2・engineSequence実受信順: 候補${allCandidateReceiptPortfolio.candidates} / 採用${allCandidateReceiptPortfolio.accepted} / margin_block${allCandidateReceiptPortfolio.marginBlocked} / 仮想決済${allCandidateReceiptPortfolio.closed} / 実現損益${allCandidateReceiptPortfolio.realizedPnl >= 0 ? "+" : ""}${allCandidateReceiptPortfolio.realizedPnl.toLocaleString()}円 / blocker辺${allCandidateReceiptPortfolio.blockEdges.length} / 比較適格=${allCandidateReceiptPortfolio.eligibleForPortfolioPnlComparison}
  全candidate正式v2・同一分exit先行＋固定銘柄優先: 候補${allCandidateMinutePortfolio.candidates} / 採用${allCandidateMinutePortfolio.accepted} / margin_block${allCandidateMinutePortfolio.marginBlocked} / 仮想決済${allCandidateMinutePortfolio.closed} / 実現損益${allCandidateMinutePortfolio.realizedPnl >= 0 ? "+" : ""}${allCandidateMinutePortfolio.realizedPnl.toLocaleString()}円 / blocker辺${allCandidateMinutePortfolio.blockEdges.length} / 比較適格=${allCandidateMinutePortfolio.eligibleForPortfolioPnlComparison}
  未完了仮想tradeが1件でもあれば比較適格=false。2版の損益を混同せず別versionで保存
【成績乖離原因分析】
  診断ラベル: ${outcomeLabels.labels}件（完了${outcomeLabels.completed} / 証拠金拒否${outcomeLabels.blocked}）
  原因候補: ${divergence.hypotheses.length}件（確信度highは未見シャドー再現まで禁止）
  MFE・MAE・1/3/5分後は診断専用。改善条件にはobservedAt <= decisionAtの特徴量だけ使用可
${sections.join("\n")}
`;
}
