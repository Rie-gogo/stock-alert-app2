import { randomUUID } from "node:crypto";
import {
  acquireRtForwardShadowStateLock,
  claimOrRetryRtForwardShadowEvent,
  closeRtForwardShadowTrade,
  failRtForwardShadowEvent,
  getRtForwardShadowState,
  getRtStrategyVersion,
  insertRtForwardShadowTrade,
  releaseRtForwardShadowStateLock,
  updateRtForwardShadowEvent,
  upsertRtForwardShadowState,
  upsertRtStrategyVersion,
} from "./db";
import {
  FUJIKURA_FORWARD_SHADOW_SPEC,
  calculateFujikuraTriggerMetrics,
  confirmFujikuraPending,
  type FujikuraForwardCandle,
} from "./fujikuraForwardShadow";
import {
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";

export const FUJIKURA_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-02";
export const FUJIKURA_FORWARD_EVALUATION_START_DATE = "2026-09-03";

export type FujikuraForwardEvaluationMode = "signal_quality" | "capital_constrained";

export interface FujikuraForwardSourceEventInput {
  sourceEventId: string;
  candle: {
    symbol: string;
    tradeDate: string;
    candleTime: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  board: unknown | null;
}

interface FujikuraPendingEntry {
  triggerClose: number;
  signalSourceEventId: string;
  signalTime: string;
  theoreticalSignalPrice: number;
  metrics: Record<string, number | boolean>;
}

interface FujikuraPosition {
  side: "long";
  entrySourceEventId: string;
  signalTime: string;
  entryTime: string;
  theoreticalSignalPrice: number;
  entryPrice: number;
  shares: number;
  slPct: number;
  tpPct: number;
  profitProtectionArmedAtSourceEventId: string | null;
}

export interface FujikuraForwardShadowState {
  tradeDate: string;
  candles: FujikuraForwardCandle[];
  pendingEntry: FujikuraPendingEntry | null;
  position: FujikuraPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: FujikuraForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
}

export type FujikuraForwardResultType = "no_signal" | "pending" | "entry" | "hold" | "exit" | "rejected" | "error";

interface ClosedPosition {
  position: FujikuraPosition;
  exitPrice: number;
  exitReason: string;
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
}

export interface FujikuraForwardTransition {
  nextState: FujikuraForwardShadowState;
  resultType: FujikuraForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: FujikuraPosition | null;
  closedPosition: ClosedPosition | null;
}

function emptyState(): FujikuraForwardShadowState {
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

export function parseFujikuraForwardState(value: unknown): FujikuraForwardShadowState {
  if (!value || typeof value !== "object") return emptyState();
  const raw = value as Partial<FujikuraForwardShadowState>;
  return {
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-96) : [],
    pendingEntry: raw.pendingEntry ?? null,
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
}

function normalizeState(value: unknown, input: FujikuraForwardSourceEventInput): FujikuraForwardShadowState {
  let state = parseFujikuraForwardState(value);
  if (state.tradeDate !== input.candle.tradeDate) {
    state = emptyState();
    state.tradeDate = input.candle.tradeDate;
  }
  return state;
}

function sharesForMode(mode: FujikuraForwardEvaluationMode, price: number): number {
  if (mode === "signal_quality") return 100;
  const rawShares = Math.floor((3_000_000 * 0.9) / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function pnlFor(position: FujikuraPosition, exitPrice: number): number {
  return Math.round((exitPrice - position.entryPrice) * position.shares);
}

function adverseExitPrice(exitPrice: number): number {
  return exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
}

function riskYen(position: FujikuraPosition): number {
  return position.entryPrice * position.shares * position.slPct / 100;
}

async function waitForFujikuraStateLock(input: {
  strategyVersion: string;
  evaluationMode: FujikuraForwardEvaluationMode;
  ownerToken: string;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await acquireRtForwardShadowStateLock({ ...input, leaseMs: 5_000 })) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

export function calculateFujikuraExitForTest(
  position: FujikuraPosition,
  candle: FujikuraForwardSourceEventInput["candle"],
  sourceEventId: string,
): { price: number; reason: "stop_loss" | "take_profit" | "profit_protection" | "session_exit" } | null {
  const stopLine = position.entryPrice * (1 - position.slPct / 100);
  const tpLine = position.entryPrice * (1 + position.tpPct / 100);
  const protectionFloor = position.entryPrice * (1 + FUJIKURA_FORWARD_SHADOW_SPEC.exit.profitProtectionFloorPct / 100);

  if (candle.low <= stopLine) return { price: Math.min(candle.open, stopLine), reason: "stop_loss" };
  if (position.profitProtectionArmedAtSourceEventId
    && position.profitProtectionArmedAtSourceEventId !== sourceEventId
    && candle.low <= protectionFloor) {
    return { price: Math.min(candle.open, protectionFloor), reason: "profit_protection" };
  }
  if (candle.high >= tpLine) return { price: tpLine, reason: "take_profit" };
  if (candle.candleTime >= FUJIKURA_FORWARD_SHADOW_SPEC.exit.amSessionExitTime && candle.candleTime < "11:30") {
    return { price: candle.close, reason: "session_exit" };
  }
  if (candle.candleTime >= FUJIKURA_FORWARD_SHADOW_SPEC.exit.marketExitTime) {
    return { price: candle.close, reason: "session_exit" };
  }
  return null;
}

/** 実時・Vitest・16時再生が共有する5803専用の副作用なし状態遷移。 */
export function applyFujikuraForwardTransition(
  stateBefore: FujikuraForwardShadowState,
  input: FujikuraForwardSourceEventInput,
  mode: FujikuraForwardEvaluationMode,
): FujikuraForwardTransition {
  const state = parseFujikuraForwardState(stateBefore);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: FujikuraForwardResultType = "no_signal";
  let openedPosition: FujikuraPosition | null = null;
  let closedPosition: ClosedPosition | null = null;

  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-96);

  if (state.stopped || input.candle.tradeDate < FUJIKURA_FORWARD_EVALUATION_START_DATE) {
    resultType = "rejected";
    actions.push({ type: "not_collecting", stopped: state.stopped, evaluationStartDate: FUJIKURA_FORWARD_EVALUATION_START_DATE });
  } else if (state.position) {
    const exit = calculateFujikuraExitForTest(state.position, input.candle, input.sourceEventId);
    if (exit) {
      const position = { ...state.position };
      const pnl = pnlFor(position, exit.price);
      const pnlAfterAdverseExit = pnlFor(position, adverseExitPrice(exit.price));
      const realizedR = riskYen(position) > 0 ? pnl / riskYen(position) : 0;
      closedPosition = { position, exitPrice: exit.price, exitReason: exit.reason, pnl, pnlAfterAdverseExit, realizedR };
      actions.push({ type: "exit", reason: exit.reason, exitPrice: exit.price, pnl, pnlAfterAdverseExit, realizedR });
      state.position = null;
      resultType = "exit";
    } else {
      const triggerLine = state.position.entryPrice * (1 + FUJIKURA_FORWARD_SHADOW_SPEC.exit.profitProtectionTriggerPct / 100);
      if (!state.position.profitProtectionArmedAtSourceEventId && input.candle.high >= triggerLine) {
        state.position.profitProtectionArmedAtSourceEventId = input.sourceEventId;
        actions.push({ type: "profit_protection_armed", triggerLine });
      }
      resultType = "hold";
    }
  } else if (state.pendingEntry && !state.dailySlotConsumed) {
    const pending = state.pendingEntry;
    state.pendingEntry = null;
    const confirmation = confirmFujikuraPending({
      triggerClose: pending.triggerClose,
      confirmationCandle: state.candles[state.candles.length - 1],
      board: input.board,
    });
    if (confirmation.accepted && confirmation.executablePrice !== null) {
      const shares = sharesForMode(mode, confirmation.executablePrice);
      state.position = {
        side: "long",
        entrySourceEventId: input.sourceEventId,
        signalTime: pending.signalTime,
        entryTime: input.candle.candleTime,
        theoreticalSignalPrice: input.candle.close,
        entryPrice: confirmation.executablePrice,
        shares,
        slPct: FUJIKURA_FORWARD_SHADOW_SPEC.exit.slPct,
        tpPct: FUJIKURA_FORWARD_SHADOW_SPEC.exit.tpPct,
        profitProtectionArmedAtSourceEventId: null,
      };
      openedPosition = { ...state.position };
      state.dailySlotConsumed = true;
      actions.push({
        type: "entry",
        side: "long",
        theoreticalSignalPrice: input.candle.close,
        executableEntryPrice: confirmation.executablePrice,
        executionPriceSource: "board_current_price_at_server_receipt",
        buyPressureRatio: confirmation.buyPressureRatio,
        shares,
      });
      resultType = "entry";
    } else {
      actions.push({ type: "confirmation_rejected", reason: confirmation.reason, buyPressureRatio: confirmation.buyPressureRatio });
      resultType = "rejected";
    }
  } else if (!state.dailySlotConsumed) {
    const metrics = calculateFujikuraTriggerMetrics(state.candles);
    if (metrics?.eligible) {
      state.pendingEntry = {
        triggerClose: input.candle.close,
        signalSourceEventId: input.sourceEventId,
        signalTime: input.candle.candleTime,
        theoreticalSignalPrice: input.candle.close,
        metrics: {
          dayLowDropPct: metrics.dayLowDropPct,
          reboundFromDayLowPct: metrics.reboundFromDayLowPct,
          maSlope2Pct: metrics.maSlope2Pct,
          volumeRatio: metrics.volumeRatio,
          recentHigh: metrics.recentHigh,
        },
      };
      actions.push({ type: "pending", side: "long", theoreticalSignalPrice: input.candle.close, metrics: state.pendingEntry.metrics });
      resultType = "pending";
    }
  }

  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

export async function ensureFujikuraForwardVersion(): Promise<void> {
  const identity = getRuntimeIdentity();
  const config = {
    symbol: FUJIKURA_FORWARD_SHADOW_SPEC.symbol,
    strategy: "5803_low_reversal_long_bpr070_profit_protection_050_030",
    strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
    sharedDetectionCore: "calculateFujikuraTriggerMetrics+confirmFujikuraPending",
    executableEntryPrice: "board_current_price_at_server_receipt",
    orderInstructionConnection: false,
    capitalScope: "pilot_strategy_only_until_all_strategies_are_migrated",
    spec: FUJIKURA_FORWARD_SHADOW_SPEC,
    policy: FORWARD_EVALUATION_POLICY,
  };
  await upsertRtStrategyVersion({
    versionId: FUJIKURA_FORWARD_STRATEGY_VERSION,
    strategyId: "5803_low_reversal_long_ab",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: FUJIKURA_FORWARD_LEARNING_CUTOFF_DATE,
    evaluationStartDate: FUJIKURA_FORWARD_EVALUATION_START_DATE,
    status: "monitoring",
    statusReason: "minimum_14_calendar_days_and_forward_signals_not_reached",
  });
}

async function processMode(input: FujikuraForwardSourceEventInput, mode: FujikuraForwardEvaluationMode) {
  const lockToken = `${input.sourceEventId}:${mode}:${randomUUID()}`;
  const locked = await waitForFujikuraStateLock({
    strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
    evaluationMode: mode,
    ownerToken: lockToken,
  });
  if (!locked) throw new Error(`forward_shadow_state_lock_timeout:${FUJIKURA_FORWARD_STRATEGY_VERSION}:${mode}`);

  let stateHashBefore = sha256Stable(emptyState());
  try {
    const saved = await getRtForwardShadowState({ strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION, evaluationMode: mode });
    const stateBefore = normalizeState(saved?.stateJson, input);
    stateHashBefore = sha256Stable(stateBefore);
    const claimToken = randomUUID();
    const claim = await claimOrRetryRtForwardShadowEvent({
      claimToken,
      data: {
        strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
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
        strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        resultType: stateBefore.lastResultType,
        decisionJson: { actions: stateBefore.lastActions, recoveredFromCommittedState: true, orderInstructionCreated: false },
        stateHashAfter: stateHashBefore,
      });
      return { duplicate: false as const, recovered: true as const, mode, resultType: stateBefore.lastResultType };
    }

    const transition = applyFujikuraForwardTransition(stateBefore, input, mode);
    if (transition.openedPosition) {
      const position = transition.openedPosition;
      await insertRtForwardShadowTrade({
        strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
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
        strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
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
      strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
      stateJson: transition.nextState,
      stateHash: stateHashAfter,
      lastSourceEventId: input.sourceEventId,
    });
    await updateRtForwardShadowEvent({
      strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
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
    return { duplicate: false as const, busy: false as const, mode, resultType: transition.resultType, actions: transition.actions };
  } catch (error) {
    try {
      await failRtForwardShadowEvent({
        strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        errorDetail: String(error),
        stateHashBefore,
      });
    } catch (markError) {
      console.error("[ForwardShadow:5803] error状態保存にも失敗:", markError);
    }
    throw error;
  } finally {
    await releaseRtForwardShadowStateLock({
      strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
      ownerToken: lockToken,
    });
  }
}

export async function processFujikuraForwardShadowSourceEvent(input: FujikuraForwardSourceEventInput) {
  if (input.candle.symbol !== FUJIKURA_FORWARD_SHADOW_SPEC.symbol) return { skipped: "non_fujikura_symbol" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  await ensureFujikuraForwardVersion();
  const version = await getRtStrategyVersion(FUJIKURA_FORWARD_STRATEGY_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: "strategy_version_stopped" as const, status: version.status, reason: version.statusReason };
  }
  const results = [];
  for (const mode of FORWARD_EVALUATION_POLICY.evaluationModes) results.push(await processMode(input, mode));
  return { skipped: false as const, strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION, results };
}

interface FujikuraReplaySourceEvent {
  sourceEventId: string;
  status: string;
  resultAction: string | null;
  payloadJson: unknown;
}

interface FujikuraReplayStoredEvent {
  strategyVersion: string;
  sourceEventId: string;
  evaluationMode: FujikuraForwardEvaluationMode;
  resultType: string;
  stateHashBefore: string;
  stateHashAfter: string;
}

function parseReplayInput(event: FujikuraReplaySourceEvent): FujikuraForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== FUJIKURA_FORWARD_SHADOW_SPEC.symbol
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

/** 当日生イベントを5803の同じ純粋コアへ再投入し、実時保存結果と完全照合する。 */
export function replayFujikuraForwardShadowDay(
  sourceEvents: FujikuraReplaySourceEvent[],
  storedEvents: FujikuraReplayStoredEvent[],
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
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === FUJIKURA_FORWARD_SHADOW_SPEC.symbol) invalidPayloads += 1;
        continue;
      }
      state = normalizeState(state, input);
      const stateHashBefore = sha256Stable(state);
      const transition = applyFujikuraForwardTransition(state, input, mode);
      const stateHashAfter = sha256Stable(transition.nextState);
      replayedEvents += 1;
      const stored = storedEvents.find(event => event.strategyVersion === FUJIKURA_FORWARD_STRATEGY_VERSION
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
