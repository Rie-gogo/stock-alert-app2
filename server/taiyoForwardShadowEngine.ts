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
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  TAIYO_BOARD_DEMAND_SPEC,
  TAIYO_FORWARD_COLLECTION_START_DATE,
  TAIYO_FORWARD_FORMAL_START_DATE,
  TAIYO_FORWARD_LEARNING_CUTOFF_DATE,
  TAIYO_RR2_PROTECT_SPEC,
  applyTaiyoBoardDemandTransition,
  applyTaiyoRr2ProtectTransition,
  createEmptyTaiyoForwardState,
  normalizeTaiyoForwardState,
  type TaiyoForwardState,
  type TaiyoForwardTransition,
} from "./taiyoForwardShadow";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
type Variant = TaiyoForwardState["variant"];

const DEFINITIONS = {
  board_demand: {
    strategyVersion: TAIYO_BOARD_DEMAND_VERSION,
    strategyId: "candidate-6976-board-demand-bpr130",
    spec: TAIYO_BOARD_DEMAND_SPEC,
    transition: applyTaiyoBoardDemandTransition,
  },
  rr2_protect: {
    strategyVersion: TAIYO_RR2_PROTECT_VERSION,
    strategyId: "candidate-6976-rr2-protect",
    spec: TAIYO_RR2_PROTECT_SPEC,
    transition: applyTaiyoRr2ProtectTransition,
  },
} as const;

const ensuredVersions = new Set<string>();

async function ensureVersion(variant: Variant) {
  const definition = DEFINITIONS[variant];
  if (ensuredVersions.has(definition.strategyVersion)) return;
  const identity = getRuntimeIdentity();
  const config = {
    ...definition.spec,
    collectionStartDate: TAIYO_FORWARD_COLLECTION_START_DATE,
    formalEvaluationStartDate: TAIYO_FORWARD_FORMAL_START_DATE,
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
    learningCutoffDate: TAIYO_FORWARD_LEARNING_CUTOFF_DATE,
    evaluationStartDate: TAIYO_FORWARD_FORMAL_START_DATE,
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
  throw new Error(`taiyo_forward_state_lock_timeout:${variant}:${mode}`);
}

async function persistTransition(input: {
  variant: Variant;
  mode: ForwardEvaluationMode;
  source: ForwardSourceEventInput;
  transition: TaiyoForwardTransition;
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
      symbol: "6976",
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
  const normalized = normalizeTaiyoForwardState(initialState?.stateJson, variant, source.candle.tradeDate);
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
    const state = normalizeTaiyoForwardState(latest?.stateJson, variant, source.candle.tradeDate);
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

export async function processTaiyoForwardShadowSourceEvent(source: ForwardSourceEventInput) {
  if (source.candle.symbol !== "6976") return { skipped: "non_6976_symbol" as const };
  if (source.candle.tradeDate < TAIYO_FORWARD_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  const evaluations: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const variant of ["board_demand", "rr2_protect"] as const) {
    try {
      evaluations.push(await processVariant(source, variant));
    } catch (error) {
      errors.push(`${variant}:${String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(`taiyo_forward_shadow_partial_failure:${errors.join(" | ")}`);
  return { skipped: false as const, symbol: "6976", evaluations };
}

export function replayTaiyoForwardShadowDay(
  inputs: ForwardSourceEventInput[],
  variant: Variant,
  mode: ForwardEvaluationMode,
) {
  let state = createEmptyTaiyoForwardState(variant);
  const transition = DEFINITIONS[variant].transition;
  for (const source of inputs.filter(item => item.candle.symbol === "6976")) {
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

function parseReplayInput(event: ReplaySourceEvent, decision: ReplayDecisionEvent | undefined): ForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== "6976"
    || typeof raw.tradeDate !== "string"
    || typeof raw.candleTime !== "string"
    || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => typeof value === "number")) return null;
  return {
    sourceEventId: event.sourceEventId,
    candle: {
      symbol: "6976",
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

export function auditTaiyoForwardShadowDay(
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
    let state = createEmptyTaiyoForwardState(variant);
    const stored = new Map(storedEvents
      .filter(event => event.strategyVersion === strategyVersion && event.evaluationMode === mode)
      .map(event => [event.sourceEventId, event]));
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const source = parseReplayInput(sourceEvent, decisionBySource.get(sourceEvent.sourceEventId));
      if (!source) {
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === "6976") invalidPayloads += 1;
        continue;
      }
      state = normalizeTaiyoForwardState(state, variant, source.candle.tradeDate);
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

export function resetTaiyoForwardVersionCacheForTest() {
  ensuredVersions.clear();
}
