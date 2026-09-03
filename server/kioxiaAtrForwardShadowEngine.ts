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
  KIOXIA_ATR_FORWARD_SHADOW_SPEC,
  applyKioxiaAtrForwardTransition,
  emptyKioxiaAtrForwardState,
  parseKioxiaAtrForwardState,
  type KioxiaAtrForwardEvaluationMode,
  type KioxiaAtrForwardResultType,
  type KioxiaAtrForwardShadowState,
  type KioxiaAtrForwardSourceEventInput,
} from "./kioxiaAtrForwardShadow";
import {
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";

export const KIOXIA_ATR_FORWARD_LEARNING_CUTOFF_DATE = KIOXIA_ATR_FORWARD_SHADOW_SPEC.learningCutoffDate;
export const KIOXIA_ATR_FORWARD_EVALUATION_START_DATE = KIOXIA_ATR_FORWARD_SHADOW_SPEC.evaluationStartDate;

async function waitForStateLock(input: {
  strategyVersion: string;
  evaluationMode: KioxiaAtrForwardEvaluationMode;
  ownerToken: string;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await acquireRtForwardShadowStateLock({ ...input, leaseMs: 5_000 })) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

export async function ensureKioxiaAtrForwardVersion(): Promise<void> {
  const identity = getRuntimeIdentity();
  const config = {
    symbol: KIOXIA_ATR_FORWARD_SHADOW_SPEC.symbol,
    candidateKey: KIOXIA_ATR_FORWARD_SHADOW_SPEC.candidateKey,
    strategy: "285a_current_five_routes_atr036_end_only_triggered_route_for_day",
    strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
    baselineEntryRoutes: [
      "confirmed_morning_long",
      "reversal_long",
      "reversal_short",
      "trend_short",
      "safe_cb_short",
    ],
    executableEntryPrice: KIOXIA_ATR_FORWARD_SHADOW_SPEC.entry.executablePriceSource,
    orderInstructionConnection: false,
    currentTradeTableConnection: false,
    capitalScope: "pilot_strategy_only_until_all_strategies_are_migrated",
    spec: KIOXIA_ATR_FORWARD_SHADOW_SPEC,
    policy: FORWARD_EVALUATION_POLICY,
  };
  await upsertRtStrategyVersion({
    versionId: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
    strategyId: "285a_five_routes_atr036_route_daily_end",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: KIOXIA_ATR_FORWARD_LEARNING_CUTOFF_DATE,
    evaluationStartDate: KIOXIA_ATR_FORWARD_EVALUATION_START_DATE,
    status: "monitoring",
    statusReason: "minimum_14_calendar_days_and_forward_signals_not_reached",
  });
}

async function processMode(input: KioxiaAtrForwardSourceEventInput, mode: KioxiaAtrForwardEvaluationMode) {
  const lockToken = createForwardShadowLockOwnerToken({
    strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
    sourceEventId: input.sourceEventId,
    evaluationMode: mode,
  });
  const locked = await waitForStateLock({
    strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
    evaluationMode: mode,
    ownerToken: lockToken,
  });
  if (!locked) throw new Error(`forward_shadow_state_lock_timeout:${KIOXIA_ATR_FORWARD_STRATEGY_VERSION}:${mode}`);

  let stateHashBefore = sha256Stable(emptyKioxiaAtrForwardState());
  try {
    const saved = await getRtForwardShadowState({
      strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
    });
    const stateBefore = (() => {
      let state = parseKioxiaAtrForwardState(saved?.stateJson);
      if (state.tradeDate !== input.candle.tradeDate) {
        state = emptyKioxiaAtrForwardState();
        state.tradeDate = input.candle.tradeDate;
      }
      return state;
    })();
    stateHashBefore = sha256Stable(stateBefore);
    const claim = await claimOrRetryRtForwardShadowEvent({
      claimToken: randomUUID(),
      data: {
        strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
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
        strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        resultType: stateBefore.lastResultType,
        decisionJson: {
          actions: stateBefore.lastActions,
          recoveredFromCommittedState: true,
          orderInstructionCreated: false,
        },
        stateHashAfter: stateHashBefore,
      });
      return { duplicate: false as const, recovered: true as const, mode, resultType: stateBefore.lastResultType };
    }

    const transition = applyKioxiaAtrForwardTransition(stateBefore, input, mode);
    if (transition.openedPosition) {
      const position = transition.openedPosition;
      await insertRtForwardShadowTrade({
        strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
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
        strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
        evaluationMode: mode,
        entrySourceEventId: closed.position.entrySourceEventId,
        exitSourceEventId: input.sourceEventId,
        exitTradeDate: input.candle.tradeDate,
        exitCandleTime: input.candle.candleTime,
        exitPrice: closed.exitPrice.toFixed(4),
        exitReason: `${closed.position.route}:${closed.exitReason}`,
        pnl: closed.pnl,
        pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
        realizedR: closed.realizedR.toFixed(6),
      });
    }

    const stateHashAfter = sha256Stable(transition.nextState);
    await upsertRtForwardShadowState({
      strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
      stateJson: transition.nextState,
      stateHash: stateHashAfter,
      lastSourceEventId: input.sourceEventId,
    });
    await updateRtForwardShadowEvent({
      strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      resultType: transition.resultType,
      decisionJson: {
        actions: transition.actions,
        boardPresent: input.board !== null,
        executablePriceSource: KIOXIA_ATR_FORWARD_SHADOW_SPEC.entry.executablePriceSource,
        capitalScope: mode === "capital_constrained" ? "pilot_strategy_only" : "unlimited_100_shares",
        orderInstructionCreated: false,
      },
      stateHashAfter,
    });
    return {
      duplicate: false as const,
      busy: false as const,
      mode,
      resultType: transition.resultType,
      actions: transition.actions,
    };
  } catch (error) {
    try {
      await failRtForwardShadowEvent({
        strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
        sourceEventId: input.sourceEventId,
        evaluationMode: mode,
        errorDetail: String(error),
        stateHashBefore,
      });
    } catch (markError) {
      console.error("[ForwardShadow:285A:ATR036] error状態保存にも失敗:", markError);
    }
    throw error;
  } finally {
    await releaseRtForwardShadowStateLock({
      strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
      evaluationMode: mode,
      ownerToken: lockToken,
    });
  }
}

export async function processKioxiaAtrForwardShadowSourceEvent(input: KioxiaAtrForwardSourceEventInput) {
  if (input.candle.symbol !== KIOXIA_ATR_FORWARD_SHADOW_SPEC.symbol) return { skipped: "non_kioxia_symbol" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  await ensureKioxiaAtrForwardVersion();
  const version = await getRtStrategyVersion(KIOXIA_ATR_FORWARD_STRATEGY_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: "strategy_version_stopped" as const, status: version.status, reason: version.statusReason };
  }
  const results = [];
  for (const mode of FORWARD_EVALUATION_POLICY.evaluationModes) results.push(await processMode(input, mode));
  return { skipped: false as const, strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, results };
}

interface ReplaySourceEvent {
  sourceEventId: string;
  status: string;
  resultAction: string | null;
  payloadJson: unknown;
}

interface ReplayStoredEvent {
  strategyVersion: string;
  sourceEventId: string;
  evaluationMode: KioxiaAtrForwardEvaluationMode;
  resultType: string;
  stateHashBefore: string;
  stateHashAfter: string;
}

function parseReplayInput(event: ReplaySourceEvent): KioxiaAtrForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== KIOXIA_ATR_FORWARD_SHADOW_SPEC.symbol
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

/** 当日生イベントを第2候補の同じ純粋コアへ再投入し、実時保存結果と完全照合する。 */
export function replayKioxiaAtrForwardShadowDay(
  sourceEvents: ReplaySourceEvent[],
  storedEvents: ReplayStoredEvent[],
) {
  let mismatches = 0;
  let invalidPayloads = 0;
  let replayedEvents = 0;
  const details: Array<Record<string, unknown>> = [];
  for (const mode of FORWARD_EVALUATION_POLICY.evaluationModes) {
    let state: KioxiaAtrForwardShadowState = emptyKioxiaAtrForwardState();
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const input = parseReplayInput(sourceEvent);
      if (!input) {
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === KIOXIA_ATR_FORWARD_SHADOW_SPEC.symbol) invalidPayloads += 1;
        continue;
      }
      if (state.tradeDate !== input.candle.tradeDate) {
        state = emptyKioxiaAtrForwardState();
        state.tradeDate = input.candle.tradeDate;
      }
      const stateHashBefore = sha256Stable(state);
      const transition = applyKioxiaAtrForwardTransition(state, input, mode);
      const stateHashAfter = sha256Stable(transition.nextState);
      replayedEvents += 1;
      const stored = storedEvents.find(event => event.strategyVersion === KIOXIA_ATR_FORWARD_STRATEGY_VERSION
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
