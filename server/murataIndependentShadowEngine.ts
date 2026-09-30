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
  MURATA_DEEP_REVERSAL_LONG_VERSION,
  MURATA_MORNING_BREAKDOWN_SHORT_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  MURATA_FORWARD_COLLECTION_START_DATE,
  MURATA_FORWARD_FORMAL_START_DATE,
  MURATA_FORWARD_LEARNING_CUTOFF_DATE,
  MURATA_INDEPENDENT_SHADOW_SPECS,
  applyMurataIndependentShadowTransition,
  createEmptyMurataIndependentShadowState,
  normalizeMurataIndependentShadowState,
  type MurataIndependentShadowState,
  type MurataIndependentTransition,
  type MurataIndependentVariant,
} from "./murataIndependentShadow";

const MODE: ForwardEvaluationMode = "signal_quality";
const VARIANTS: ReadonlyArray<{ variant: MurataIndependentVariant; strategyVersion: string }> = [
  { variant: "deep_reversal_long", strategyVersion: MURATA_DEEP_REVERSAL_LONG_VERSION },
  { variant: "morning_breakdown_short", strategyVersion: MURATA_MORNING_BREAKDOWN_SHORT_VERSION },
];
const ensuredVersions = new Set<string>();

function definitionFor(variant: MurataIndependentVariant) {
  const definition = VARIANTS.find(item => item.variant === variant);
  if (!definition) throw new Error(`unknown_murata_variant:${variant}`);
  return definition;
}

async function ensureVersion(variant: MurataIndependentVariant) {
  const { strategyVersion } = definitionFor(variant);
  if (ensuredVersions.has(strategyVersion)) return;
  const identity = getRuntimeIdentity();
  const spec = MURATA_INDEPENDENT_SHADOW_SPECS[variant];
  const config = {
    ...spec,
    collectionStartDate: MURATA_FORWARD_COLLECTION_START_DATE,
    formalEvaluationStartDate: MURATA_FORWARD_FORMAL_START_DATE,
    evaluationMode: MODE,
    evaluationPolicy: FORWARD_EVALUATION_POLICY,
    strictHistoricalReplayStatus: MURATA_INDEPENDENT_SHADOW_SPECS.historicalSelectionStatus,
    eligibleForAdoption: false,
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
    capitalConstraint: "none_independent_100_share_shadow",
  };
  await upsertRtStrategyVersion({
    versionId: strategyVersion,
    strategyId: spec.canonicalLogic,
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: MURATA_FORWARD_LEARNING_CUTOFF_DATE,
    evaluationStartDate: MURATA_FORWARD_FORMAL_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason: "manual_review_only_four_weeks_and_ten_closed_trades_per_variant_required_no_automatic_adoption",
  });
  ensuredVersions.add(strategyVersion);
}

async function acquireWithWait(strategyVersion: string, sourceEventId: string) {
  const ownerToken = createForwardShadowLockOwnerToken({ strategyVersion, sourceEventId, evaluationMode: MODE });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({ strategyVersion, evaluationMode: MODE, ownerToken, leaseMs: 8_000 })) return ownerToken;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`murata_independent_shadow_state_lock_timeout:${strategyVersion}`);
}

async function persistTransition(input: {
  variant: MurataIndependentVariant;
  source: ForwardSourceEventInput;
  transition: MurataIndependentTransition;
  stateHashBefore: string;
  stateHashAfter: string;
}) {
  const { strategyVersion } = definitionFor(input.variant);
  const { transition, source } = input;
  await upsertRtForwardShadowState({
    strategyVersion,
    evaluationMode: MODE,
    stateJson: transition.nextState,
    stateHash: input.stateHashAfter,
    lastSourceEventId: source.sourceEventId,
  });
  if (transition.openedPosition) {
    const position = transition.openedPosition;
    await insertRtForwardShadowTrade({
      strategyVersion,
      evaluationMode: MODE,
      symbol: "6981",
      side: position.side,
      entrySourceEventId: position.entrySourceEventId,
      entryTradeDate: source.candle.tradeDate,
      signalCandleTime: position.signalTime,
      entryCandleTime: position.entryTime,
      theoreticalSignalPrice: String(position.theoreticalSignalPrice),
      entryPrice: String(position.entryPrice),
      shares: 100,
      slPct: String(position.slPct),
      tpPct: String(position.tpPct),
    });
  }
  if (transition.closedPosition) {
    const closed = transition.closedPosition;
    await closeRtForwardShadowTrade({
      strategyVersion,
      evaluationMode: MODE,
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
    evaluationMode: MODE,
    resultType: transition.resultType,
    decisionJson: {
      actions: transition.actions,
      purpose: "forward_monitoring_candidate",
      variant: input.variant,
      independentState: true,
      shares: 100,
      capitalConstraint: "not_applicable_no_891m_consumption",
      marginBlockEquivalent: "not_applicable_independent_signal_quality_shadow",
      eligibleForAdoption: false,
      automaticSelection: false,
      automaticAdoption: false,
      orderInstructionConnection: false,
      orderInstructionCreated: false,
      normalTradeTableWritten: false,
      stateHashBefore: input.stateHashBefore,
    },
    stateHashAfter: input.stateHashAfter,
  });
}

async function processVariant(source: ForwardSourceEventInput, variant: MurataIndependentVariant) {
  const { strategyVersion } = definitionFor(variant);
  const initialState = await getRtForwardShadowState({ strategyVersion, evaluationMode: MODE });
  const normalized = normalizeMurataIndependentShadowState(initialState?.stateJson, variant, source.candle.tradeDate);
  const initialHash = sha256Stable(normalized);
  const claim = await claimOrRetryRtForwardShadowEvent({
    claimToken: randomUUID(),
    leaseMs: 30_000,
    data: {
      strategyVersion,
      sourceEventId: source.sourceEventId,
      evaluationMode: MODE,
      tradeDate: source.candle.tradeDate,
      symbol: source.candle.symbol,
      candleTime: source.candle.candleTime,
      resultType: "pending",
      decisionJson: { status: "claimed", purpose: "forward_monitoring_candidate", variant, eligibleForAdoption: false },
      stateHashBefore: initialHash,
      stateHashAfter: initialHash,
    },
  });
  if (claim !== "claimed") return { variant, strategyVersion, status: claim };

  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(strategyVersion, source.sourceEventId);
    const latest = await getRtForwardShadowState({ strategyVersion, evaluationMode: MODE });
    const state = normalizeMurataIndependentShadowState(latest?.stateJson, variant, source.candle.tradeDate);
    const stateHashBefore = sha256Stable(state);
    const transition = applyMurataIndependentShadowTransition(variant, state, source);
    const stateHashAfter = sha256Stable(transition.nextState);
    await persistTransition({ variant, source, transition, stateHashBefore, stateHashAfter });
    return { variant, strategyVersion, status: "processed" as const, resultType: transition.resultType, stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({
      strategyVersion,
      sourceEventId: source.sourceEventId,
      evaluationMode: MODE,
      errorDetail: String(error),
      stateHashBefore: initialHash,
    });
    throw error;
  } finally {
    if (ownerToken) await releaseRtForwardShadowStateLock({ strategyVersion, evaluationMode: MODE, ownerToken });
  }
}

export async function processMurataIndependentShadowSourceEvent(source: ForwardSourceEventInput) {
  if (source.candle.symbol !== "6981") return { skipped: "non_6981_symbol" as const };
  if (source.candle.tradeDate < MURATA_FORWARD_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  for (const { variant } of VARIANTS) await ensureVersion(variant);
  const versions = await Promise.all(VARIANTS.map(({ strategyVersion }) => getRtStrategyVersion(strategyVersion)));
  const active = VARIANTS.filter((_, index) => versions[index]?.status !== "stopped" && versions[index]?.status !== "insufficient");
  const evaluations = [];
  for (const { variant } of active) evaluations.push(await processVariant(source, variant));
  return { skipped: false as const, strategyVersions: active.map(item => item.strategyVersion), evaluations };
}

export function replayMurataIndependentShadowDay(inputs: ForwardSourceEventInput[], variant: MurataIndependentVariant) {
  let state = createEmptyMurataIndependentShadowState(variant);
  for (const source of inputs.filter(item => item.candle.symbol === "6981")) {
    state = applyMurataIndependentShadowTransition(variant, state, source).nextState;
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

function boardObservedAt(resultJson: unknown): number | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const timeline = (resultJson as Record<string, unknown>).availabilityTimeline;
  const value = timeline && typeof timeline === "object"
    ? Number((timeline as Record<string, unknown>).boardObservedAtMs)
    : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function parseReplayInput(event: ReplaySourceEvent, decision?: ReplayDecisionEvent): ForwardSourceEventInput | null {
  if (!event.payloadJson || typeof event.payloadJson !== "object") return null;
  const raw = event.payloadJson as Record<string, unknown>;
  if (raw.symbol !== "6981" || typeof raw.tradeDate !== "string" || typeof raw.candleTime !== "string"
    || ![raw.open, raw.high, raw.low, raw.close, raw.volume].every(value => typeof value === "number")) return null;
  return {
    sourceEventId: event.sourceEventId,
    candle: {
      symbol: "6981",
      tradeDate: raw.tradeDate,
      candleTime: raw.candleTime,
      open: raw.open as number,
      high: raw.high as number,
      low: raw.low as number,
      close: raw.close as number,
      volume: raw.volume as number,
      provenance: raw.provenance ?? null,
    } as ForwardSourceEventInput["candle"],
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
      boardObservedAtMs: boardObservedAt(decision.resultJson),
      relayAssembledAtMs: event.relayReceivedAtMs ?? null,
      relaySentAtMs: event.relaySentAtMs ?? null,
      cloudReceivedAtMs: event.cloudReceivedAtMs ?? null,
      decisionStartedAtMs: decision.decisionStartedAtMs,
      decisionCompletedAtMs: decision.decisionCompletedAtMs,
    } : undefined,
  };
}

/** Replays the stored source/decision ledger only; no price substitution or live writes. */
export function auditMurataIndependentShadowDay(
  sourceEvents: ReplaySourceEvent[],
  storedEvents: ReplayStoredEvent[],
  decisionEvents: ReplayDecisionEvent[],
  variant: MurataIndependentVariant,
) {
  const { strategyVersion } = definitionFor(variant);
  const saved = new Map(storedEvents
    .filter(event => event.strategyVersion === strategyVersion && event.evaluationMode === MODE)
    .map(event => [event.sourceEventId, event]));
  const decisions = new Map(decisionEvents.map(event => [event.sourceEventId, event]));
  let state = createEmptyMurataIndependentShadowState(variant);
  let replayedEvents = 0;
  let mismatches = 0;
  let invalidPayloads = 0;
  for (const event of sourceEvents) {
    if (event.status !== "processed" || event.resultAction === "correction_ignored") continue;
    const source = parseReplayInput(event, decisions.get(event.sourceEventId));
    if (!source) {
      if ((event.payloadJson as Record<string, unknown> | null)?.symbol === "6981") invalidPayloads += 1;
      continue;
    }
    state = normalizeMurataIndependentShadowState(state, variant, source.candle.tradeDate);
    const stateHashBefore = sha256Stable(state);
    const transition = applyMurataIndependentShadowTransition(variant, state, source);
    const stateHashAfter = sha256Stable(transition.nextState);
    const persisted = saved.get(source.sourceEventId);
    if (persisted) {
      replayedEvents += 1;
      if (persisted.resultType !== transition.resultType || persisted.stateHashBefore !== stateHashBefore || persisted.stateHashAfter !== stateHashAfter) mismatches += 1;
    }
    state = transition.nextState;
  }
  return { replayedEvents, mismatches, invalidPayloads };
}

export function resetMurataIndependentShadowVersionCacheForTest() {
  ensuredVersions.clear();
}

export type { MurataIndependentShadowState };
