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
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";
import {
  KIOXIA_FORWARD_SHADOW_SPEC,
  calculateKioxiaForwardBoardMetrics,
  calculateKioxiaForwardEntryMetrics,
  calculateKioxiaForwardMaSlope2Pct,
} from "./kioxiaForwardShadow";
import type { KioxiaConfirmedMorningLongCandle } from "./kioxiaConfirmedMorningLong";
import {
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";

export const KIOXIA_FORWARD_LEARNING_CUTOFF_DATE = "2026-09-03";
export const KIOXIA_FORWARD_EVALUATION_START_DATE = "2026-09-04";

export type KioxiaForwardEvaluationMode = "signal_quality" | "capital_constrained";
export type KioxiaForwardResultType = "no_signal" | "entry" | "hold" | "exit" | "rejected" | "error";

export interface KioxiaForwardSourceEventInput {
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

interface KioxiaForwardPosition {
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

export interface KioxiaForwardShadowState {
  tradeDate: string;
  candles: KioxiaConfirmedMorningLongCandle[];
  position: KioxiaForwardPosition | null;
  dailySlotConsumed: boolean;
  stopped: boolean;
  lastSourceEventId: string | null;
  lastResultType: KioxiaForwardResultType | null;
  lastActions: Array<Record<string, unknown>>;
}

interface ClosedPosition {
  position: KioxiaForwardPosition;
  exitPrice: number;
  exitReason: string;
  pnl: number;
  pnlAfterAdverseExit: number;
  realizedR: number;
}

export interface KioxiaForwardTransition {
  nextState: KioxiaForwardShadowState;
  resultType: KioxiaForwardResultType;
  actions: Array<Record<string, unknown>>;
  openedPosition: KioxiaForwardPosition | null;
  closedPosition: ClosedPosition | null;
}

function emptyState(): KioxiaForwardShadowState {
  return {
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

export function parseKioxiaForwardState(value: unknown): KioxiaForwardShadowState {
  if (!value || typeof value !== "object") return emptyState();
  const raw = value as Partial<KioxiaForwardShadowState>;
  return {
    tradeDate: typeof raw.tradeDate === "string" ? raw.tradeDate : "",
    // 09:00始値を11:20まで保持するため、前場全体を収容する。
    candles: Array.isArray(raw.candles) ? raw.candles.slice(-180) : [],
    position: raw.position ?? null,
    dailySlotConsumed: raw.dailySlotConsumed === true,
    stopped: raw.stopped === true,
    lastSourceEventId: typeof raw.lastSourceEventId === "string" ? raw.lastSourceEventId : null,
    lastResultType: raw.lastResultType ?? null,
    lastActions: Array.isArray(raw.lastActions) ? raw.lastActions : [],
  };
}

function normalizeState(value: unknown, input: KioxiaForwardSourceEventInput): KioxiaForwardShadowState {
  let state = parseKioxiaForwardState(value);
  if (state.tradeDate !== input.candle.tradeDate) {
    state = emptyState();
    state.tradeDate = input.candle.tradeDate;
  }
  return state;
}

function sharesForMode(mode: KioxiaForwardEvaluationMode, price: number): number {
  if (mode === "signal_quality") return 100;
  const rawShares = Math.floor((3_000_000 * 0.9) / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

function pnlFor(position: KioxiaForwardPosition, exitPrice: number): number {
  return Math.round((exitPrice - position.entryPrice) * position.shares);
}

function adverseExitPrice(exitPrice: number): number {
  return exitPrice * (1 - FORWARD_EVALUATION_POLICY.adverseExitPct / 100);
}

function riskYen(position: KioxiaForwardPosition): number {
  return position.entryPrice * position.shares * position.slPct / 100;
}

async function waitForKioxiaStateLock(input: {
  strategyVersion: string;
  evaluationMode: KioxiaForwardEvaluationMode;
  ownerToken: string;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await acquireRtForwardShadowStateLock({ ...input, leaseMs: 5_000 })) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

export function calculateKioxiaForwardExitForTest(
  position: KioxiaForwardPosition,
  candles: readonly KioxiaConfirmedMorningLongCandle[],
  candle: KioxiaForwardSourceEventInput["candle"],
  board: unknown,
  sourceEventId: string,
): {
  price: number | null;
  reason: "stop_loss" | "take_profit" | "ma8_momentum_protection" | "session_exit";
  maSlope2Pct?: number;
  rejectionReason?: "executable_price_unavailable";
} | null {
  const stopLine = position.entryPrice * (1 - position.slPct / 100);
  const tpLine = position.entryPrice * (1 + position.tpPct / 100);

  // TP/SLが同じ足で成立した場合もSLを最優先する。
  if (candle.low <= stopLine) return { price: Math.min(candle.open, stopLine), reason: "stop_loss" };
  if (candle.high >= tpLine) return { price: tpLine, reason: "take_profit" };

  const maSlope2Pct = calculateKioxiaForwardMaSlope2Pct(candles);
  const profitPct = position.entryPrice > 0 ? (candle.close - position.entryPrice) / position.entryPrice * 100 : 0;
  if (position.profitProtectionArmedAtSourceEventId
    && position.profitProtectionArmedAtSourceEventId !== sourceEventId
    && profitPct <= KIOXIA_FORWARD_SHADOW_SPEC.exit.profitProtectionFloorPct
    && maSlope2Pct !== null
    && maSlope2Pct <= KIOXIA_FORWARD_SHADOW_SPEC.exit.maxMaSlope2Pct) {
    const executablePrice = calculateKioxiaForwardBoardMetrics(board).executablePrice;
    if (executablePrice !== null) return { price: executablePrice, reason: "ma8_momentum_protection", maSlope2Pct };
    if (candle.candleTime < KIOXIA_FORWARD_SHADOW_SPEC.exit.amSessionExitTime) {
      return {
        price: null,
        reason: "ma8_momentum_protection",
        maSlope2Pct,
        rejectionReason: "executable_price_unavailable",
      };
    }
  }
  if (candle.candleTime >= KIOXIA_FORWARD_SHADOW_SPEC.exit.amSessionExitTime) {
    return { price: candle.close, reason: "session_exit" };
  }
  return null;
}

/** 実時・Vitest・16時再生が共有する285A専用の副作用なし状態遷移。 */
export function applyKioxiaForwardTransition(
  stateBefore: KioxiaForwardShadowState,
  input: KioxiaForwardSourceEventInput,
  mode: KioxiaForwardEvaluationMode,
): KioxiaForwardTransition {
  const state = parseKioxiaForwardState(stateBefore);
  const actions: Array<Record<string, unknown>> = [];
  let resultType: KioxiaForwardResultType = "no_signal";
  let openedPosition: KioxiaForwardPosition | null = null;
  let closedPosition: ClosedPosition | null = null;

  state.candles.push({
    time: input.candle.candleTime,
    open: input.candle.open,
    high: input.candle.high,
    low: input.candle.low,
    close: input.candle.close,
    volume: input.candle.volume,
  });
  state.candles = state.candles.slice(-180);

  if (state.stopped || input.candle.tradeDate < KIOXIA_FORWARD_EVALUATION_START_DATE) {
    resultType = "rejected";
    actions.push({ type: "not_collecting", stopped: state.stopped, evaluationStartDate: KIOXIA_FORWARD_EVALUATION_START_DATE });
  } else if (state.position) {
    const exit = calculateKioxiaForwardExitForTest(state.position, state.candles, input.candle, input.board, input.sourceEventId);
    if (exit && exit.price !== null) {
      const position = { ...state.position };
      const pnl = pnlFor(position, exit.price);
      const pnlAfterAdverseExit = pnlFor(position, adverseExitPrice(exit.price));
      const realizedR = riskYen(position) > 0 ? pnl / riskYen(position) : 0;
      closedPosition = { position, exitPrice: exit.price, exitReason: exit.reason, pnl, pnlAfterAdverseExit, realizedR };
      actions.push({ type: "exit", reason: exit.reason, exitPrice: exit.price, pnl, pnlAfterAdverseExit, realizedR, maSlope2Pct: exit.maSlope2Pct });
      state.position = null;
      resultType = "exit";
    } else if (exit) {
      actions.push({
        type: "exit_rejected",
        reason: exit.rejectionReason,
        intendedExitReason: exit.reason,
        maSlope2Pct: exit.maSlope2Pct,
      });
      resultType = "rejected";
    } else {
      const triggerLine = state.position.entryPrice * (1 + KIOXIA_FORWARD_SHADOW_SPEC.exit.profitProtectionTriggerPct / 100);
      if (!state.position.profitProtectionArmedAtSourceEventId && input.candle.high >= triggerLine) {
        state.position.profitProtectionArmedAtSourceEventId = input.sourceEventId;
        actions.push({ type: "profit_protection_armed", triggerLine });
      }
      resultType = "hold";
    }
  } else if (!state.dailySlotConsumed) {
    const metrics = calculateKioxiaForwardEntryMetrics(state.candles);
    if (metrics?.eligible) {
      if (!metrics.atrAccepted) {
        actions.push({ type: "entry_rejected", reason: "atr_block", atrPct: metrics.atrPct });
        resultType = "rejected";
      } else {
        const executablePrice = calculateKioxiaForwardBoardMetrics(input.board).executablePrice;
        if (executablePrice === null) {
          actions.push({ type: "entry_rejected", reason: "executable_price_unavailable" });
          resultType = "rejected";
        } else {
          const shares = sharesForMode(mode, executablePrice);
          state.position = {
            side: "long",
            entrySourceEventId: input.sourceEventId,
            signalTime: input.candle.candleTime,
            entryTime: input.candle.candleTime,
            theoreticalSignalPrice: input.candle.close,
            entryPrice: executablePrice,
            shares,
            slPct: KIOXIA_FORWARD_SHADOW_SPEC.exit.slPct,
            tpPct: KIOXIA_FORWARD_SHADOW_SPEC.exit.tpPct,
            profitProtectionArmedAtSourceEventId: null,
          };
          openedPosition = { ...state.position };
          state.dailySlotConsumed = true;
          actions.push({
            type: "entry",
            side: "long",
            theoreticalSignalPrice: input.candle.close,
            executableEntryPrice: executablePrice,
            executionPriceSource: KIOXIA_FORWARD_SHADOW_SPEC.entry.executablePriceSource,
            bodyPct: metrics.bodyPct,
            maSlope2Pct: metrics.maSlope2Pct,
            volumeRatio: metrics.volumeRatio,
            openGainPct: metrics.openGainPct,
            atrPct: metrics.atrPct,
            shares,
          });
          resultType = "entry";
        }
      }
    }
  }

  state.lastSourceEventId = input.sourceEventId;
  state.lastResultType = resultType;
  state.lastActions = actions;
  return { nextState: state, resultType, actions, openedPosition, closedPosition };
}

export async function ensureKioxiaForwardVersion(): Promise<void> {
  const identity = getRuntimeIdentity();
  const config = {
    symbol: KIOXIA_FORWARD_SHADOW_SPEC.symbol,
    candidateKey: "285a_confirmed_morning_long_ma8_momentum_protection",
    strategy: "285a_confirmed_morning_long_ma8_momentum_protection_060_030_slope_minus005",
    strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
    sharedDetectionCore: "calculateKioxiaConfirmedMorningLongMetrics",
    executableEntryPrice: "board_current_price_at_server_receipt",
    executableMomentumExitPrice: "board_current_price_at_server_receipt",
    orderInstructionConnection: false,
    capitalScope: "pilot_strategy_only_until_all_strategies_are_migrated",
    spec: KIOXIA_FORWARD_SHADOW_SPEC,
    policy: FORWARD_EVALUATION_POLICY,
  };
  await upsertRtStrategyVersion({
    versionId: KIOXIA_FORWARD_STRATEGY_VERSION,
    strategyId: "285a_confirmed_long_ma8_protection",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: KIOXIA_FORWARD_LEARNING_CUTOFF_DATE,
    evaluationStartDate: KIOXIA_FORWARD_EVALUATION_START_DATE,
    status: "monitoring",
    statusReason: "minimum_14_calendar_days_and_forward_signals_not_reached",
  });
}

async function processMode(input: KioxiaForwardSourceEventInput, mode: KioxiaForwardEvaluationMode) {
  const lockToken = createForwardShadowLockOwnerToken({
    strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
    sourceEventId: input.sourceEventId,
    evaluationMode: mode,
  });
  const locked = await waitForKioxiaStateLock({
    strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
    evaluationMode: mode,
    ownerToken: lockToken,
  });
  if (!locked) throw new Error(`forward_shadow_state_lock_timeout:${KIOXIA_FORWARD_STRATEGY_VERSION}:${mode}`);

  let stateHashBefore = sha256Stable(emptyState());
  try {
    const saved = await getRtForwardShadowState({ strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, evaluationMode: mode });
    const stateBefore = normalizeState(saved?.stateJson, input);
    stateHashBefore = sha256Stable(stateBefore);
    const claim = await claimOrRetryRtForwardShadowEvent({
      claimToken: randomUUID(),
      data: {
        strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
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
        strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        resultType: stateBefore.lastResultType,
        decisionJson: { actions: stateBefore.lastActions, recoveredFromCommittedState: true, orderInstructionCreated: false },
        stateHashAfter: stateHashBefore,
      });
      return { duplicate: false as const, recovered: true as const, mode, resultType: stateBefore.lastResultType };
    }

    const transition = applyKioxiaForwardTransition(stateBefore, input, mode);
    if (transition.openedPosition) {
      const position = transition.openedPosition;
      await insertRtForwardShadowTrade({
        strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
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
        strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
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
      strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
      stateJson: transition.nextState,
      stateHash: stateHashAfter,
      lastSourceEventId: input.sourceEventId,
    });
    await updateRtForwardShadowEvent({
      strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
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
        strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        errorDetail: String(error),
        stateHashBefore,
      });
    } catch (markError) {
      console.error("[ForwardShadow:285A] error状態保存にも失敗:", markError);
    }
    throw error;
  } finally {
    await releaseRtForwardShadowStateLock({
      strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
      ownerToken: lockToken,
    });
  }
}

export async function processKioxiaForwardShadowSourceEvent(input: KioxiaForwardSourceEventInput) {
  if (input.candle.symbol !== KIOXIA_FORWARD_SHADOW_SPEC.symbol) return { skipped: "non_kioxia_symbol" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  await ensureKioxiaForwardVersion();
  const version = await getRtStrategyVersion(KIOXIA_FORWARD_STRATEGY_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: "strategy_version_stopped" as const, status: version.status, reason: version.statusReason };
  }
  const results = [];
  for (const mode of FORWARD_EVALUATION_POLICY.evaluationModes) results.push(await processMode(input, mode));
  return { skipped: false as const, strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, results };
}

interface KioxiaReplaySourceEvent {
  sourceEventId: string;
  status: string;
  resultAction: string | null;
  payloadJson: unknown;
}

interface KioxiaReplayStoredEvent {
  strategyVersion: string;
  sourceEventId: string;
  evaluationMode: KioxiaForwardEvaluationMode;
  resultType: string;
  stateHashBefore: string;
  stateHashAfter: string;
}

function parseReplayInput(event: KioxiaReplaySourceEvent): KioxiaForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== KIOXIA_FORWARD_SHADOW_SPEC.symbol
    || typeof raw.tradeDate !== "string"
    || typeof raw.candleTime !== "string"
    || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => typeof value === "number")) return null;
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

/** 当日生イベントを285Aの同じ純粋コアへ再投入し、実時保存結果と完全照合する。 */
export function replayKioxiaForwardShadowDay(
  sourceEvents: KioxiaReplaySourceEvent[],
  storedEvents: KioxiaReplayStoredEvent[],
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
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === KIOXIA_FORWARD_SHADOW_SPEC.symbol) invalidPayloads += 1;
        continue;
      }
      state = normalizeState(state, input);
      const stateHashBefore = sha256Stable(state);
      const transition = applyKioxiaForwardTransition(state, input, mode);
      const stateHashAfter = sha256Stable(transition.nextState);
      replayedEvents += 1;
      const stored = storedEvents.find(event => event.strategyVersion === KIOXIA_FORWARD_STRATEGY_VERSION
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
