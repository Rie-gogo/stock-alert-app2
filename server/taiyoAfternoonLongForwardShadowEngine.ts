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
  TAIYO_AFTERNOON_LONG_RR2_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  TAIYO_AFTERNOON_LONG_COLLECTION_START_DATE,
  TAIYO_AFTERNOON_LONG_FORMAL_START_DATE,
  TAIYO_AFTERNOON_LONG_LEARNING_CUTOFF_DATE,
  TAIYO_AFTERNOON_LONG_RR2_SPEC,
  TAIYO_AFTERNOON_LONG_WINRATE_SPEC,
  applyTaiyoAfternoonLongRr2Transition,
  applyTaiyoAfternoonLongWinrateTransition,
  createEmptyTaiyoAfternoonLongState,
  normalizeTaiyoAfternoonLongState,
  type TaiyoAfternoonLongState,
  type TaiyoAfternoonLongTransition,
  type TaiyoAfternoonLongVariant,
} from "./taiyoAfternoonLongForwardShadow";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;

const DEFINITIONS = {
  rr2_10: {
    strategyVersion: TAIYO_AFTERNOON_LONG_RR2_VERSION,
    strategyId: "candidate-6976-afternoon-long-rr2-10",
    spec: TAIYO_AFTERNOON_LONG_RR2_SPEC,
    transition: applyTaiyoAfternoonLongRr2Transition,
    eligibleForAdoption: false,
    statusReason: "diagnostic_only_historical_execution_sensitivity_and_route_parity_required",
  },
  recovery_winrate: {
    strategyVersion: TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
    strategyId: "candidate-6976-afternoon-long-recovery-winrate",
    spec: TAIYO_AFTERNOON_LONG_WINRATE_SPEC,
    transition: applyTaiyoAfternoonLongWinrateTransition,
    eligibleForAdoption: true,
    statusReason: "formal_gate_pending_tp_below_2r_exception_and_route_parity_required",
  },
} as const;

const ensuredVersions = new Set<string>();

async function ensureVersion(variant: TaiyoAfternoonLongVariant) {
  const definition = DEFINITIONS[variant];
  if (ensuredVersions.has(definition.strategyVersion)) return;
  const identity = getRuntimeIdentity();
  const config = {
    ...definition.spec,
    collectionStartDate: TAIYO_AFTERNOON_LONG_COLLECTION_START_DATE,
    formalEvaluationStartDate: TAIYO_AFTERNOON_LONG_FORMAL_START_DATE,
    evaluationPolicy: FORWARD_EVALUATION_POLICY,
    evaluationModes: MODES,
    eligibleForAdoption: definition.eligibleForAdoption,
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
    learningCutoffDate: TAIYO_AFTERNOON_LONG_LEARNING_CUTOFF_DATE,
    evaluationStartDate: TAIYO_AFTERNOON_LONG_FORMAL_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: definition.eligibleForAdoption,
    status: "monitoring",
    statusReason: definition.statusReason,
  });
  ensuredVersions.add(definition.strategyVersion);
}

async function acquireWithWait(variant: TaiyoAfternoonLongVariant, sourceEventId: string, mode: ForwardEvaluationMode) {
  const strategyVersion = DEFINITIONS[variant].strategyVersion;
  const ownerToken = createForwardShadowLockOwnerToken({ strategyVersion, sourceEventId, evaluationMode: mode });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({ strategyVersion, evaluationMode: mode, ownerToken, leaseMs: 8_000 })) {
      return ownerToken;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`taiyo_afternoon_long_forward_state_lock_timeout:${variant}:${mode}`);
}

async function persistTransition(input: {
  variant: TaiyoAfternoonLongVariant;
  mode: ForwardEvaluationMode;
  source: ForwardSourceEventInput;
  transition: TaiyoAfternoonLongTransition;
  stateHashBefore: string;
  stateHashAfter: string;
}) {
  const definition = DEFINITIONS[input.variant];
  const { transition, source, mode } = input;
  await upsertRtForwardShadowState({
    strategyVersion: definition.strategyVersion,
    evaluationMode: mode,
    stateJson: transition.nextState,
    stateHash: input.stateHashAfter,
    lastSourceEventId: source.sourceEventId,
  });
  if (transition.openedPosition) {
    const position = transition.openedPosition;
    await insertRtForwardShadowTrade({
      strategyVersion: definition.strategyVersion,
      evaluationMode: mode,
      symbol: "6976",
      side: "long",
      entrySourceEventId: position.entrySourceEventId,
      entryTradeDate: position.entryTradeDate,
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
      strategyVersion: definition.strategyVersion,
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
    strategyVersion: definition.strategyVersion,
    sourceEventId: source.sourceEventId,
    evaluationMode: mode,
    resultType: transition.resultType,
    decisionJson: {
      actions: transition.actions,
      purpose: "candidate",
      candidateVariant: input.variant,
      eligibleForAdoption: definition.eligibleForAdoption,
      automaticAdoption: false,
      historicalSelectionRole: definition.spec.historicalRole,
      signalQualityShares: mode === "signal_quality" ? 100 : null,
      capitalScope: mode === "capital_constrained" ? "pilot_strategy_only" : "unlimited_signal_quality",
      orderInstructionCreated: false,
      normalTradeTableWritten: false,
      stateHashBefore: input.stateHashBefore,
    },
    stateHashAfter: input.stateHashAfter,
  });
}

async function processMode(source: ForwardSourceEventInput, variant: TaiyoAfternoonLongVariant, mode: ForwardEvaluationMode) {
  const definition = DEFINITIONS[variant];
  const initial = await getRtForwardShadowState({ strategyVersion: definition.strategyVersion, evaluationMode: mode });
  const normalized = normalizeTaiyoAfternoonLongState(initial?.stateJson, variant, source.candle.tradeDate);
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
      decisionJson: {
        status: "claimed",
        purpose: "candidate",
        candidateVariant: variant,
        eligibleForAdoption: definition.eligibleForAdoption,
      },
      stateHashBefore: initialHash,
      stateHashAfter: initialHash,
    },
  });
  if (claim !== "claimed") return { mode, status: claim };

  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(variant, source.sourceEventId, mode);
    const latest = await getRtForwardShadowState({ strategyVersion: definition.strategyVersion, evaluationMode: mode });
    const state = normalizeTaiyoAfternoonLongState(latest?.stateJson, variant, source.candle.tradeDate);
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

async function processVariant(source: ForwardSourceEventInput, variant: TaiyoAfternoonLongVariant) {
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

export async function processTaiyoAfternoonLongForwardShadowSourceEvent(source: ForwardSourceEventInput) {
  if (source.candle.symbol !== "6976") return { skipped: "non_6976_symbol" as const };
  if (source.candle.tradeDate < TAIYO_AFTERNOON_LONG_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  const evaluations: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const variant of ["rr2_10", "recovery_winrate"] as const) {
    try {
      evaluations.push(await processVariant(source, variant));
    } catch (error) {
      errors.push(`${variant}:${String(error)}`);
    }
  }
  if (errors.length > 0) throw new Error(`taiyo_afternoon_long_forward_shadow_partial_failure:${errors.join(" | ")}`);
  return { skipped: false as const, symbol: "6976", evaluations };
}

export function replayTaiyoAfternoonLongForwardShadowDay(
  inputs: ForwardSourceEventInput[],
  variant: TaiyoAfternoonLongVariant,
  mode: ForwardEvaluationMode,
) {
  let state = createEmptyTaiyoAfternoonLongState(variant);
  const transition = DEFINITIONS[variant].transition;
  for (const source of inputs.filter(item => item.candle.symbol === "6976")) {
    state = transition(state, source, mode).nextState;
  }
  return { state, stateHash: sha256Stable(state) };
}

type ReplaySourceEvent = {
  sourceEventId: string;
  status: string;
  resultAction: string | null;
  payloadJson: unknown;
};
type ReplayStoredEvent = {
  strategyVersion: string;
  sourceEventId: string;
  evaluationMode: ForwardEvaluationMode;
  resultType: string;
  stateHashBefore: string;
  stateHashAfter: string;
};

function parseReplayInput(event: ReplaySourceEvent): ForwardSourceEventInput | null {
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
  };
}

export function auditTaiyoAfternoonLongForwardShadowDay(
  sourceEvents: ReplaySourceEvent[],
  storedEvents: ReplayStoredEvent[],
  _decisionEvents: unknown[],
  variant: TaiyoAfternoonLongVariant,
) {
  const strategyVersion = DEFINITIONS[variant].strategyVersion;
  let replayedEvents = 0;
  let mismatches = 0;
  let invalidPayloads = 0;
  for (const mode of MODES) {
    let state = createEmptyTaiyoAfternoonLongState(variant);
    const stored = new Map(storedEvents
      .filter(event => event.strategyVersion === strategyVersion && event.evaluationMode === mode)
      .map(event => [event.sourceEventId, event]));
    for (const sourceEvent of sourceEvents) {
      if (sourceEvent.status !== "processed" || sourceEvent.resultAction === "correction_ignored") continue;
      const source = parseReplayInput(sourceEvent);
      if (!source) {
        if ((sourceEvent.payloadJson as Record<string, unknown> | null)?.symbol === "6976") invalidPayloads += 1;
        continue;
      }
      state = normalizeTaiyoAfternoonLongState(state, variant, source.candle.tradeDate);
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

export function resetTaiyoAfternoonLongForwardVersionCacheForTest() {
  ensuredVersions.clear();
}
