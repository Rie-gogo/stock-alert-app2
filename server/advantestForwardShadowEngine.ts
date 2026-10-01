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
  ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION,
  ADVANTEST_SHORT_BODY008_DEPTH_VERSION,
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  ADVANTEST_CONTINUATION_LONG_DEPTH_SPEC,
  ADVANTEST_FORWARD_COLLECTION_START_DATE,
  ADVANTEST_FORWARD_FORMAL_START_DATE,
  ADVANTEST_FORWARD_LEARNING_CUTOFF_DATE,
  ADVANTEST_SHORT_BODY008_DEPTH_SPEC,
  applyAdvantestForwardTransition,
  createEmptyAdvantestForwardState,
  normalizeAdvantestForwardState,
  type AdvantestForwardState,
  type AdvantestForwardTransition,
  type AdvantestForwardVariant,
} from "./advantestForwardShadow";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;

const DEFINITIONS = {
  short_body008_depth: {
    strategyVersion: ADVANTEST_SHORT_BODY008_DEPTH_VERSION,
    strategyId: "candidate-6857-short-body008-depth",
    spec: ADVANTEST_SHORT_BODY008_DEPTH_SPEC,
  },
  confirmed_continuation_depth: {
    strategyVersion: ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION,
    strategyId: "candidate-6857-confirmed-continuation-depth",
    spec: ADVANTEST_CONTINUATION_LONG_DEPTH_SPEC,
  },
} as const;

const ensuredVersions = new Set<string>();

async function ensureVersion(variant: AdvantestForwardVariant) {
  const definition = DEFINITIONS[variant];
  if (ensuredVersions.has(definition.strategyVersion)) return;
  const identity = getRuntimeIdentity();
  const config = {
    ...definition.spec,
    collectionStartDate: ADVANTEST_FORWARD_COLLECTION_START_DATE,
    formalEvaluationStartDate: ADVANTEST_FORWARD_FORMAL_START_DATE,
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
    learningCutoffDate: ADVANTEST_FORWARD_LEARNING_CUTOFF_DATE,
    evaluationStartDate: ADVANTEST_FORWARD_FORMAL_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: true,
    status: "monitoring",
    statusReason: "formal_evaluation_gate_pending_and_route_parity_required",
  });
  ensuredVersions.add(definition.strategyVersion);
}

async function acquireWithWait(variant: AdvantestForwardVariant, sourceEventId: string, mode: ForwardEvaluationMode) {
  const strategyVersion = DEFINITIONS[variant].strategyVersion;
  const ownerToken = createForwardShadowLockOwnerToken({ strategyVersion, sourceEventId, evaluationMode: mode });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({ strategyVersion, evaluationMode: mode, ownerToken, leaseMs: 8_000 })) {
      return ownerToken;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`advantest_forward_state_lock_timeout:${variant}:${mode}`);
}

async function persistTransition(input: {
  variant: AdvantestForwardVariant;
  mode: ForwardEvaluationMode;
  source: ForwardSourceEventInput;
  transition: AdvantestForwardTransition;
  stateHashBefore: string;
  stateHashAfter: string;
}) {
  const strategyVersion = DEFINITIONS[input.variant].strategyVersion;
  const { source, transition, mode } = input;
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
      symbol: "6857",
      side: position.side,
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

async function processMode(source: ForwardSourceEventInput, variant: AdvantestForwardVariant, mode: ForwardEvaluationMode) {
  const definition = DEFINITIONS[variant];
  const initial = await getRtForwardShadowState({ strategyVersion: definition.strategyVersion, evaluationMode: mode });
  const normalized = normalizeAdvantestForwardState(initial?.stateJson, variant, source.candle.tradeDate);
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
    const state = normalizeAdvantestForwardState(latest?.stateJson, variant, source.candle.tradeDate);
    const stateHashBefore = sha256Stable(state);
    const transition = applyAdvantestForwardTransition(state, source, mode);
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

async function processVariant(source: ForwardSourceEventInput, variant: AdvantestForwardVariant) {
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

export async function processAdvantestForwardShadowSourceEvent(source: ForwardSourceEventInput) {
  if (source.candle.symbol !== "6857") return { skipped: "non_6857_symbol" as const };
  if (source.candle.tradeDate < ADVANTEST_FORWARD_COLLECTION_START_DATE) {
    return { skipped: "before_collection_start" as const };
  }
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) {
    return { skipped: "baseline_trading_logic_mismatch" as const };
  }
  const evaluations: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const variant of ["short_body008_depth", "confirmed_continuation_depth"] as const) {
    try {
      evaluations.push(await processVariant(source, variant));
    } catch (error) {
      errors.push(`${variant}:${String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(`advantest_forward_shadow_partial_failure:${errors.join(" | ")}`);
  return { skipped: false as const, symbol: "6857", evaluations };
}

export function replayAdvantestForwardShadowDay(
  inputs: ForwardSourceEventInput[],
  variant: AdvantestForwardVariant,
  mode: ForwardEvaluationMode,
) {
  let state = createEmptyAdvantestForwardState(variant);
  for (const source of inputs.filter(item => item.candle.symbol === "6857")) {
    state = applyAdvantestForwardTransition(state, source, mode).nextState;
  }
  return { state, stateHash: sha256Stable(state) };
}

export function resetAdvantestForwardVersionCacheForTest() {
  ensuredVersions.clear();
}
