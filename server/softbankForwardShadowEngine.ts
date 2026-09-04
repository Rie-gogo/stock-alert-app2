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
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  SOFTBANK_DEPTH_CONFIRM_SPEC,
  SOFTBANK_FORWARD_COLLECTION_START_DATE,
  SOFTBANK_FORWARD_FORMAL_START_DATE,
  SOFTBANK_FORWARD_LEARNING_CUTOFF_DATE,
  SOFTBANK_RR2_PROTECT_SPEC,
  applySoftbankDepthConfirmTransition,
  applySoftbankRr2ProtectTransition,
  createEmptySoftbankForwardState,
  normalizeSoftbankForwardState,
  type SoftbankForwardState,
  type SoftbankForwardTransition,
} from "./softbankForwardShadow";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
type Variant = SoftbankForwardState["variant"];

const DEFINITIONS = {
  depth_confirm: {
    strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION,
    strategyId: "candidate-9984-breakout-depth-confirm",
    spec: SOFTBANK_DEPTH_CONFIRM_SPEC,
    transition: applySoftbankDepthConfirmTransition,
  },
  rr2_protect: {
    strategyVersion: SOFTBANK_RR2_PROTECT_VERSION,
    strategyId: "candidate-9984-breakout-rr2-protect",
    spec: SOFTBANK_RR2_PROTECT_SPEC,
    transition: applySoftbankRr2ProtectTransition,
  },
} as const;

const ensuredVersions = new Set<string>();

async function ensureVersion(variant: Variant) {
  const definition = DEFINITIONS[variant];
  if (ensuredVersions.has(definition.strategyVersion)) return;
  const identity = getRuntimeIdentity();
  const config = {
    ...definition.spec,
    collectionStartDate: SOFTBANK_FORWARD_COLLECTION_START_DATE,
    formalEvaluationStartDate: SOFTBANK_FORWARD_FORMAL_START_DATE,
    evaluationPolicy: FORWARD_EVALUATION_POLICY,
    evaluationModes: MODES,
    eligibleForAdoption: true,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
  await upsertRtStrategyVersion({
    versionId: definition.strategyVersion,
    strategyId: definition.strategyId,
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: SOFTBANK_FORWARD_LEARNING_CUTOFF_DATE,
    evaluationStartDate: SOFTBANK_FORWARD_FORMAL_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: true,
    status: "monitoring",
    statusReason: "formal_evaluation_gate_pending_and_route_parity_required",
  });
  ensuredVersions.add(definition.strategyVersion);
}

async function acquireWithWait(variant: Variant, sourceEventId: string, mode: ForwardEvaluationMode) {
  const strategyVersion = DEFINITIONS[variant].strategyVersion;
  const ownerToken = createForwardShadowLockOwnerToken({ strategyVersion, sourceEventId, evaluationMode: mode });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({
      strategyVersion,
      evaluationMode: mode,
      ownerToken,
      leaseMs: 8_000,
    })) return ownerToken;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`softbank_forward_state_lock_timeout:${variant}:${mode}`);
}

async function persistTransition(input: {
  variant: Variant;
  mode: ForwardEvaluationMode;
  source: ForwardSourceEventInput;
  transition: SoftbankForwardTransition;
  stateHashBefore: string;
  stateHashAfter: string;
}) {
  const { strategyVersion } = DEFINITIONS[input.variant];
  const { transition, source, mode } = input;
  await upsertRtForwardShadowState({
    strategyVersion,
    evaluationMode: mode,
    stateJson: transition.nextState,
    stateHash: input.stateHashAfter,
    lastSourceEventId: source.sourceEventId,
  });
  if (transition.openedPosition) {
    const position = transition.openedPosition;
    await insertRtForwardShadowTrade({
      strategyVersion,
      evaluationMode: mode,
      symbol: "9984",
      side: "long",
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
      strategyVersion,
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
    strategyVersion,
    sourceEventId: source.sourceEventId,
    evaluationMode: mode,
    resultType: transition.resultType,
    decisionJson: {
      actions: transition.actions,
      purpose: "candidate",
      candidateVariant: input.variant,
      eligibleForAdoption: true,
      automaticAdoption: false,
      signalQualityShares: mode === "signal_quality" ? 100 : null,
      capitalScope: mode === "capital_constrained" ? "pilot_strategy_only" : "unlimited_signal_quality",
      orderInstructionCreated: false,
      normalTradeTableWritten: false,
      stateHashBefore: input.stateHashBefore,
    },
    stateHashAfter: input.stateHashAfter,
  });
}

async function processMode(source: ForwardSourceEventInput, variant: Variant, mode: ForwardEvaluationMode) {
  const definition = DEFINITIONS[variant];
  const initialState = await getRtForwardShadowState({ strategyVersion: definition.strategyVersion, evaluationMode: mode });
  const normalized = normalizeSoftbankForwardState(initialState?.stateJson, variant, source.candle.tradeDate);
  const initialHash = sha256Stable(normalized);
  const claim = await claimOrRetryRtForwardShadowEvent({
    claimToken: randomUUID(),
    leaseMs: 30_000,
    data: {
      strategyVersion: definition.strategyVersion,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      tradeDate: source.candle.tradeDate,
      symbol: source.candle.symbol,
      candleTime: source.candle.candleTime,
      resultType: "pending",
      decisionJson: { status: "claimed", purpose: "candidate", candidateVariant: variant },
      stateHashBefore: initialHash,
      stateHashAfter: initialHash,
    },
  });
  if (claim !== "claimed") return { mode, status: claim };

  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(variant, source.sourceEventId, mode);
    const latest = await getRtForwardShadowState({ strategyVersion: definition.strategyVersion, evaluationMode: mode });
    const state = normalizeSoftbankForwardState(latest?.stateJson, variant, source.candle.tradeDate);
    const stateHashBefore = sha256Stable(state);
    const transition = definition.transition(state, source, mode);
    const stateHashAfter = sha256Stable(transition.nextState);
    await persistTransition({ variant, mode, source, transition, stateHashBefore, stateHashAfter });
    return { mode, status: "processed" as const, resultType: transition.resultType, stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({
      strategyVersion: definition.strategyVersion,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      errorDetail: String(error),
      stateHashBefore: initialHash,
    });
    throw error;
  } finally {
    if (ownerToken) {
      await releaseRtForwardShadowStateLock({
        strategyVersion: definition.strategyVersion,
        evaluationMode: mode,
        ownerToken,
      });
    }
  }
}

async function processVariant(source: ForwardSourceEventInput, variant: Variant) {
  const definition = DEFINITIONS[variant];
  await ensureVersion(variant);
  const version = await getRtStrategyVersion(definition.strategyVersion);
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: `strategy_${version.status}` as const, strategyVersion: definition.strategyVersion };
  }
  const evaluations = [];
  for (const mode of MODES) evaluations.push(await processMode(source, variant, mode));
  return { skipped: false as const, strategyVersion: definition.strategyVersion, evaluations };
}

export async function processSoftbankForwardShadowSourceEvent(source: ForwardSourceEventInput) {
  if (source.candle.symbol !== "9984") return { skipped: "non_9984_symbol" as const };
  if (source.candle.tradeDate < SOFTBANK_FORWARD_COLLECTION_START_DATE) {
    return { skipped: "before_collection_start" as const };
  }
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) {
    return { skipped: "baseline_trading_logic_mismatch" as const };
  }
  const evaluations: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const variant of ["depth_confirm", "rr2_protect"] as const) {
    try {
      evaluations.push(await processVariant(source, variant));
    } catch (error) {
      errors.push(`${variant}:${String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(`softbank_forward_shadow_partial_failure:${errors.join(" | ")}`);
  return { skipped: false as const, symbol: "9984", evaluations };
}

export function replaySoftbankForwardShadowDay(
  inputs: ForwardSourceEventInput[],
  variant: Variant,
  mode: ForwardEvaluationMode,
) {
  let state = createEmptySoftbankForwardState(variant);
  const transition = DEFINITIONS[variant].transition;
  for (const source of inputs.filter(item => item.candle.symbol === "9984")) {
    state = transition(state, source, mode).nextState;
  }
  return { state, stateHash: sha256Stable(state) };
}

type ReplaySourceEvent = {
  id?: number;
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

function boardObservedAtMs(resultJson: unknown): number | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const availability = (resultJson as Record<string, unknown>).availabilityTimeline;
  if (!availability || typeof availability !== "object") return null;
  const value = Number((availability as Record<string, unknown>).boardObservedAtMs);
  return Number.isFinite(value) ? value : null;
}

function parseReplayInput(
  event: ReplaySourceEvent,
  decision: ReplayDecisionEvent | undefined,
): ForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== "9984"
    || typeof raw.tradeDate !== "string"
    || typeof raw.candleTime !== "string"
    || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => typeof value === "number")) return null;
  return {
    sourceEventId: event.sourceEventId,
    candle: {
      symbol: "9984",
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
      boardObservedAtMs: boardObservedAtMs(decision.resultJson),
      relayAssembledAtMs: event.relayReceivedAtMs ?? null,
      relaySentAtMs: event.relaySentAtMs ?? null,
      cloudReceivedAtMs: event.cloudReceivedAtMs ?? null,
      decisionStartedAtMs: decision.decisionStartedAtMs,
      decisionCompletedAtMs: decision.decisionCompletedAtMs,
    } : undefined,
  };
}

export function auditSoftbankForwardShadowDay(
  sourceEvents: ReplaySourceEvent[],
  storedEvents: ReplayStoredEvent[],
  decisionEvents: ReplayDecisionEvent[],
  variant: Variant,
) {
  const strategyVersion = DEFINITIONS[variant].strategyVersion;
  const decisionBySource = new Map(decisionEvents.map(event => [event.sourceEventId, event]));
  let replayedEvents = 0;
  let mismatches = 0;
  let invalidPayloads = 0;
  for (const mode of MODES) {
    let state = createEmptySoftbankForwardState(variant);
    const stored = new Map(storedEvents
      .filter(event => event.strategyVersion === strategyVersion && event.evaluationMode === mode)
      .map(event => [event.sourceEventId, event]));
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const source = parseReplayInput(sourceEvent, decisionBySource.get(sourceEvent.sourceEventId));
      if (!source) {
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === "9984") invalidPayloads += 1;
        continue;
      }
      state = normalizeSoftbankForwardState(state, variant, source.candle.tradeDate);
      const stateHashBefore = sha256Stable(state);
      const transition = DEFINITIONS[variant].transition(state, source, mode);
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

export function resetSoftbankForwardVersionCacheForTest() {
  ensuredVersions.clear();
}
