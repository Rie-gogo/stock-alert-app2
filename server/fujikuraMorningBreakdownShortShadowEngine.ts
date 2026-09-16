import { randomUUID } from "node:crypto";
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
  FUJIKURA_MORNING_SHORT_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE,
  FUJIKURA_MORNING_SHORT_FORMAL_START_DATE,
  FUJIKURA_MORNING_SHORT_LEARNING_CUTOFF_DATE,
  FUJIKURA_MORNING_SHORT_SPEC,
  applyFujikuraMorningShortTransition,
  createEmptyFujikuraMorningShortState,
  normalizeFujikuraMorningShortState,
  type FujikuraMorningShortTransition,
} from "./fujikuraMorningBreakdownShortShadow";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
const ensuredVersions = new Set<string>();

async function ensureVersion() {
  if (ensuredVersions.has(FUJIKURA_MORNING_SHORT_VERSION)) return;
  const identity = getRuntimeIdentity();
  const config = {
    ...FUJIKURA_MORNING_SHORT_SPEC,
    collectionStartDate: FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE,
    formalEvaluationStartDate: FUJIKURA_MORNING_SHORT_FORMAL_START_DATE,
    evaluationPolicy: FORWARD_EVALUATION_POLICY,
    evaluationModes: MODES,
    eligibleForAdoption: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
  await upsertRtStrategyVersion({
    versionId: FUJIKURA_MORNING_SHORT_VERSION,
    strategyId: "candidate-5803-morning-20bar-breakdown-short-depth",
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: FUJIKURA_MORNING_SHORT_LEARNING_CUTOFF_DATE,
    evaluationStartDate: FUJIKURA_MORNING_SHORT_FORMAL_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason: "exploratory_shadow_slippage_gate_failed_manual_review_only",
  });
  ensuredVersions.add(FUJIKURA_MORNING_SHORT_VERSION);
}

async function acquireWithWait(sourceEventId: string, mode: ForwardEvaluationMode) {
  const ownerToken = createForwardShadowLockOwnerToken({
    strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
    sourceEventId,
    evaluationMode: mode,
  });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({
      strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
      evaluationMode: mode,
      ownerToken,
      leaseMs: 8_000,
    })) return ownerToken;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`fujikura_morning_short_state_lock_timeout:${mode}`);
}

async function persistTransition(input: {
  mode: ForwardEvaluationMode;
  source: ForwardSourceEventInput;
  transition: FujikuraMorningShortTransition;
  stateHashBefore: string;
  stateHashAfter: string;
}) {
  const { transition, source, mode } = input;
  await upsertRtForwardShadowState({
    strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
    evaluationMode: mode,
    stateJson: transition.nextState,
    stateHash: input.stateHashAfter,
    lastSourceEventId: source.sourceEventId,
  });
  if (transition.openedPosition) {
    const position = transition.openedPosition;
    await insertRtForwardShadowTrade({
      strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
      evaluationMode: mode,
      symbol: "5803",
      side: "short",
      entrySourceEventId: position.entrySourceEventId,
      entryTradeDate: source.candle.tradeDate,
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
      strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
      evaluationMode: mode,
      entrySourceEventId: closed.position.entrySourceEventId,
      exitSourceEventId: source.sourceEventId,
      exitTradeDate: source.candle.tradeDate,
      exitCandleTime: source.candle.candleTime,
      exitPrice: String(closed.exitPrice),
      exitReason: closed.exitReason,
      pnl: closed.pnl,
      pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
      realizedR: String(closed.realizedR),
    });
  }
  await updateRtForwardShadowEvent({
    strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
    sourceEventId: source.sourceEventId,
    evaluationMode: mode,
    resultType: transition.resultType,
    decisionJson: {
      actions: transition.actions,
      purpose: "diagnostic",
      candidateVariant: "morning_20bar_breakdown_short_depth",
      eligibleForAdoption: false,
      automaticAdoption: false,
      historicalSelectionRole: FUJIKURA_MORNING_SHORT_SPEC.historicalRole,
      historicalSelectionCaveat: FUJIKURA_MORNING_SHORT_SPEC.historicalSelection.caveat,
      signalQualityShares: mode === "signal_quality" ? 100 : null,
      capitalScope: mode === "capital_constrained" ? "pilot_strategy_only" : "unlimited_signal_quality",
      orderInstructionCreated: false,
      normalTradeTableWritten: false,
      stateHashBefore: input.stateHashBefore,
    },
    stateHashAfter: input.stateHashAfter,
  });
}

async function processMode(source: ForwardSourceEventInput, mode: ForwardEvaluationMode) {
  const initialState = await getRtForwardShadowState({
    strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
    evaluationMode: mode,
  });
  const normalized = normalizeFujikuraMorningShortState(initialState?.stateJson, source.candle.tradeDate);
  const initialHash = sha256Stable(normalized);
  const claim = await claimOrRetryRtForwardShadowEvent({
    claimToken: randomUUID(),
    leaseMs: 30_000,
    data: {
      strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      tradeDate: source.candle.tradeDate,
      symbol: source.candle.symbol,
      candleTime: source.candle.candleTime,
      resultType: "pending",
      decisionJson: {
        status: "claimed",
        purpose: "diagnostic",
        candidateVariant: "morning_20bar_breakdown_short_depth",
        eligibleForAdoption: false,
      },
      stateHashBefore: initialHash,
      stateHashAfter: initialHash,
    },
  });
  if (claim !== "claimed") return { mode, status: claim };

  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(source.sourceEventId, mode);
    const latest = await getRtForwardShadowState({
      strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
      evaluationMode: mode,
    });
    const state = normalizeFujikuraMorningShortState(latest?.stateJson, source.candle.tradeDate);
    const stateHashBefore = sha256Stable(state);
    const transition = applyFujikuraMorningShortTransition(state, source, mode);
    const stateHashAfter = sha256Stable(transition.nextState);
    await persistTransition({ mode, source, transition, stateHashBefore, stateHashAfter });
    return { mode, status: "processed" as const, resultType: transition.resultType, stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({
      strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      errorDetail: String(error),
      stateHashBefore: initialHash,
    });
    throw error;
  } finally {
    if (ownerToken) {
      await releaseRtForwardShadowStateLock({
        strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
        evaluationMode: mode,
        ownerToken,
      });
    }
  }
}

export async function processFujikuraMorningShortShadowSourceEvent(source: ForwardSourceEventInput) {
  if (source.candle.symbol !== "5803") return { skipped: "non_5803_symbol" as const };
  if (source.candle.tradeDate < FUJIKURA_MORNING_SHORT_COLLECTION_START_DATE) {
    return { skipped: "before_collection_start" as const };
  }
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) {
    return { skipped: "baseline_trading_logic_mismatch" as const };
  }
  await ensureVersion();
  const version = await getRtStrategyVersion(FUJIKURA_MORNING_SHORT_VERSION);
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: `strategy_${version.status}` as const, strategyVersion: FUJIKURA_MORNING_SHORT_VERSION };
  }
  const evaluations = [];
  for (const mode of MODES) evaluations.push(await processMode(source, mode));
  return { skipped: false as const, strategyVersion: FUJIKURA_MORNING_SHORT_VERSION, evaluations };
}

export function replayFujikuraMorningShortShadowDay(inputs: ForwardSourceEventInput[], mode: ForwardEvaluationMode) {
  let state = createEmptyFujikuraMorningShortState();
  for (const source of inputs.filter(item => item.candle.symbol === "5803")) {
    state = applyFujikuraMorningShortTransition(state, source, mode).nextState;
  }
  return { state, stateHash: sha256Stable(state) };
}

type ReplaySourceEvent = {
  sourceEventId: string;
  status: string;
  resultAction: string | null;
  payloadJson: unknown;
  relayReceivedAtMs?: number | null;
  relaySentAtMs?: number | null;
  cloudReceivedAtMs?: number | null;
};

type ReplayStoredEvent = {
  strategyVersion: string;
  sourceEventId: string;
  evaluationMode: ForwardEvaluationMode;
  resultType: string;
  stateHashBefore: string;
  stateHashAfter: string;
};

type ReplayDecisionEvent = {
  id: number;
  sourceEventId: string;
  resultType: string;
  routeId: string | null;
  marginUsedBefore: number | null;
  marginUsedAfter: number | null;
  stateHashBefore: string;
  stateHashAfter: string;
  causalityStatus: string;
  causalityReason: string | null;
  decisionStartedAtMs: number;
  decisionCompletedAtMs: number;
  resultJson?: unknown;
};

function replayBoardObservedAtMs(resultJson: unknown): number | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const availability = (resultJson as Record<string, unknown>).availabilityTimeline;
  if (!availability || typeof availability !== "object") return null;
  const value = Number((availability as Record<string, unknown>).boardObservedAtMs);
  return Number.isFinite(value) ? value : null;
}

function parseReplayInput(event: ReplaySourceEvent, decision: ReplayDecisionEvent | undefined): ForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== "5803"
    || typeof raw.tradeDate !== "string"
    || typeof raw.candleTime !== "string"
    || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => typeof value === "number")) return null;
  return {
    sourceEventId: event.sourceEventId,
    candle: {
      symbol: "5803",
      tradeDate: raw.tradeDate,
      candleTime: raw.candleTime,
      open: raw.open as number,
      high: raw.high as number,
      low: raw.low as number,
      close: raw.close as number,
      volume: raw.volume as number,
    },
    board: raw.board ?? null,
    currentAudit: decision ? {
      engineSequence: decision.id,
      resultType: decision.resultType,
      routeId: decision.routeId,
      marginUsedBefore: decision.marginUsedBefore ?? 0,
      marginUsedAfter: decision.marginUsedAfter ?? 0,
      stateHashBefore: decision.stateHashBefore,
      stateHashAfter: decision.stateHashAfter,
      causalityStatus: decision.causalityStatus,
      causalityReason: decision.causalityReason ?? "unavailable",
      boardObservedAtMs: replayBoardObservedAtMs(decision.resultJson),
      relayAssembledAtMs: event.relayReceivedAtMs ?? null,
      relaySentAtMs: event.relaySentAtMs ?? null,
      cloudReceivedAtMs: event.cloudReceivedAtMs ?? null,
      decisionStartedAtMs: decision.decisionStartedAtMs,
      decisionCompletedAtMs: decision.decisionCompletedAtMs,
    } : undefined,
  };
}

export function auditFujikuraMorningShortShadowDay(
  sourceEvents: ReplaySourceEvent[],
  storedEvents: ReplayStoredEvent[],
  decisionEvents: ReplayDecisionEvent[],
) {
  const decisionBySource = new Map(decisionEvents.map(event => [event.sourceEventId, event]));
  let replayedEvents = 0;
  let mismatches = 0;
  let invalidPayloads = 0;
  for (const mode of MODES) {
    let state = createEmptyFujikuraMorningShortState();
    const stored = new Map(storedEvents
      .filter(event => event.strategyVersion === FUJIKURA_MORNING_SHORT_VERSION && event.evaluationMode === mode)
      .map(event => [event.sourceEventId, event]));
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const source = parseReplayInput(sourceEvent, decisionBySource.get(sourceEvent.sourceEventId));
      if (!source) {
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === "5803") invalidPayloads += 1;
        continue;
      }
      state = normalizeFujikuraMorningShortState(state, source.candle.tradeDate);
      const stateHashBefore = sha256Stable(state);
      const transition = applyFujikuraMorningShortTransition(state, source, mode);
      const stateHashAfter = sha256Stable(transition.nextState);
      const saved = stored.get(source.sourceEventId);
      if (saved && (saved.resultType !== transition.resultType
        || saved.stateHashBefore !== stateHashBefore
        || saved.stateHashAfter !== stateHashAfter)) mismatches += 1;
      if (saved) replayedEvents += 1;
      state = transition.nextState;
    }
  }
  return { replayedEvents, mismatches, invalidPayloads };
}

export function resetFujikuraMorningShortVersionCacheForTest() {
  ensuredVersions.clear();
}
