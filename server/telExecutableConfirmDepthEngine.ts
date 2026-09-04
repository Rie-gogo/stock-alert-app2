import { randomUUID } from "crypto";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
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
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  TEL_EXECUTABLE_DEPTH_EVALUATION_START_DATE,
  TEL_EXECUTABLE_DEPTH_LEARNING_CUTOFF_DATE,
  TEL_EXECUTABLE_DEPTH_SPEC,
  TEL_EXECUTABLE_DEPTH_VERSION,
  applyTelExecutableConfirmTransition,
  createEmptyTelExecutableConfirmState,
  normalizeTelExecutableConfirmState,
  type TelExecutableConfirmState,
} from "./telExecutableConfirmDepth";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
let versionEnsured = false;

async function ensureVersion() {
  if (versionEnsured) return;
  const identity = getRuntimeIdentity();
  await upsertRtStrategyVersion({
    versionId: TEL_EXECUTABLE_DEPTH_VERSION,
    strategyId: "candidate-8035-executable-depth",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(TEL_EXECUTABLE_DEPTH_SPEC),
    configJson: TEL_EXECUTABLE_DEPTH_SPEC,
    learningCutoffDate: TEL_EXECUTABLE_DEPTH_LEARNING_CUTOFF_DATE,
    evaluationStartDate: TEL_EXECUTABLE_DEPTH_EVALUATION_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: true,
    status: "monitoring",
    statusReason: "minimum_14_calendar_days_and_forward_signals_not_reached",
  });
  versionEnsured = true;
}

async function acquireWithWait(sourceEventId: string, mode: ForwardEvaluationMode) {
  const ownerToken = createForwardShadowLockOwnerToken({
    strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
    sourceEventId,
    evaluationMode: mode,
  });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({
      strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
      evaluationMode: mode,
      ownerToken,
      leaseMs: 8_000,
    })) return ownerToken;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`tel_executable_depth_state_lock_timeout:${mode}`);
}

async function processMode(input: ForwardSourceEventInput, mode: ForwardEvaluationMode) {
  const initialState = await getRtForwardShadowState({
    strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
    evaluationMode: mode,
  });
  const stateBefore = normalizeTelExecutableConfirmState(initialState?.stateJson, input.candle.tradeDate);
  const initialHash = sha256Stable(stateBefore);
  const claim = await claimOrRetryRtForwardShadowEvent({
    claimToken: randomUUID(),
    leaseMs: 30_000,
    data: {
      strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      tradeDate: input.candle.tradeDate,
      symbol: input.candle.symbol,
      candleTime: input.candle.candleTime,
      resultType: "pending",
      decisionJson: { status: "claimed", purpose: "candidate" },
      stateHashBefore: initialHash,
      stateHashAfter: initialHash,
    },
  });
  if (claim !== "claimed") return { mode, status: claim };

  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(input.sourceEventId, mode);
    const latest = await getRtForwardShadowState({
      strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
      evaluationMode: mode,
    });
    const state = normalizeTelExecutableConfirmState(latest?.stateJson, input.candle.tradeDate);
    const stateHashBefore = sha256Stable(state);
    const transition = applyTelExecutableConfirmTransition(state, input, mode);
    const stateHashAfter = sha256Stable(transition.nextState);
    await upsertRtForwardShadowState({
      strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
      evaluationMode: mode,
      stateJson: transition.nextState,
      stateHash: stateHashAfter,
      lastSourceEventId: input.sourceEventId,
    });
    if (transition.openedPosition) {
      const position = transition.openedPosition;
      await insertRtForwardShadowTrade({
        strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
        evaluationMode: mode,
        symbol: "8035",
        side: position.side,
        entrySourceEventId: position.entrySourceEventId,
        entryTradeDate: input.candle.tradeDate,
        signalCandleTime: position.signalTime,
        entryCandleTime: position.entryTime,
        theoreticalSignalPrice: String(position.theoreticalSignalPrice),
        entryPrice: String(position.entryPrice),
        shares: position.shares,
        slPct: String(position.slPct),
        tpPct: String(position.tpPct),
      });
    }
    if (transition.closedPosition) {
      const closed = transition.closedPosition;
      await closeRtForwardShadowTrade({
        strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
        evaluationMode: mode,
        entrySourceEventId: closed.position.entrySourceEventId,
        exitSourceEventId: input.sourceEventId,
        exitTradeDate: input.candle.tradeDate,
        exitCandleTime: input.candle.candleTime,
        exitPrice: String(closed.exitPrice),
        exitReason: closed.exitReason,
        pnl: closed.pnl,
        pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
        realizedR: String(closed.realizedR),
      });
    }
    await updateRtForwardShadowEvent({
      strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      resultType: transition.resultType,
      decisionJson: {
        actions: transition.actions,
        purpose: "candidate",
        eligibleForAdoption: true,
        automaticAdoption: false,
        signalQualityShares: mode === "signal_quality" ? 100 : null,
        capitalScope: mode === "capital_constrained" ? "pilot_strategy_only" : "unlimited_signal_quality",
        stateHashBefore,
      },
      stateHashAfter,
    });
    return { mode, status: "processed" as const, resultType: transition.resultType, stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({
      strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: mode,
      errorDetail: String(error),
      stateHashBefore: initialHash,
    });
    throw error;
  } finally {
    if (ownerToken) {
      await releaseRtForwardShadowStateLock({
        strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION,
        evaluationMode: mode,
        ownerToken,
      });
    }
  }
}

export async function processTelExecutableConfirmDepthSourceEvent(input: ForwardSourceEventInput) {
  if (input.candle.symbol !== "8035") return { skipped: "non_8035_symbol" as const };
  if (input.candle.tradeDate < TEL_EXECUTABLE_DEPTH_EVALUATION_START_DATE) {
    return { skipped: "before_evaluation_start" as const };
  }
  const identity = getRuntimeIdentity();
  if (!identity.tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  await ensureVersion();
  const version = await getRtStrategyVersion(TEL_EXECUTABLE_DEPTH_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: `strategy_${version.status}` as const };
  }
  const evaluations = [];
  for (const mode of MODES) evaluations.push(await processMode(input, mode));
  return { skipped: false as const, strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION, evaluations };
}

export function replayTelExecutableConfirmDepthDay(inputs: ForwardSourceEventInput[], mode: ForwardEvaluationMode) {
  let state = createEmptyTelExecutableConfirmState();
  for (const input of inputs.filter(item => item.candle.symbol === "8035")) {
    state = applyTelExecutableConfirmTransition(state, input, mode).nextState;
  }
  return { state, stateHash: sha256Stable(state) };
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
  evaluationMode: ForwardEvaluationMode;
  resultType: string;
  stateHashBefore: string;
  stateHashAfter: string;
}

function parseReplayInput(event: ReplaySourceEvent): ForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== "8035"
    || typeof raw.tradeDate !== "string"
    || typeof raw.candleTime !== "string"
    || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => typeof value === "number")) return null;
  return {
    sourceEventId: event.sourceEventId,
    candle: {
      symbol: "8035",
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

export function auditTelExecutableConfirmDepthDay(sourceEvents: ReplaySourceEvent[], storedEvents: ReplayStoredEvent[]) {
  let replayedEvents = 0;
  let mismatches = 0;
  let invalidPayloads = 0;
  for (const mode of MODES) {
    let state = createEmptyTelExecutableConfirmState();
    const stored = new Map(storedEvents
      .filter(event => event.strategyVersion === TEL_EXECUTABLE_DEPTH_VERSION && event.evaluationMode === mode)
      .map(event => [event.sourceEventId, event]));
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const input = parseReplayInput(sourceEvent);
      if (!input) {
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === "8035") invalidPayloads += 1;
        continue;
      }
      state = normalizeTelExecutableConfirmState(state, input.candle.tradeDate);
      const stateHashBefore = sha256Stable(state);
      const transition = applyTelExecutableConfirmTransition(state, input, mode);
      const stateHashAfter = sha256Stable(transition.nextState);
      const saved = stored.get(input.sourceEventId);
      if (saved && (saved.resultType !== transition.resultType
        || saved.stateHashBefore !== stateHashBefore
        || saved.stateHashAfter !== stateHashAfter)) mismatches += 1;
      if (saved) replayedEvents += 1;
      state = transition.nextState;
    }
  }
  return { replayedEvents, mismatches, invalidPayloads };
}

export function resetTelExecutableConfirmDepthVersionCacheForTest() {
  versionEnsured = false;
}
