import { randomUUID } from "node:crypto";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import {
  acquireRtForwardShadowStateLock,
  claimOrRetryRtForwardShadowEvent,
  closeRtForwardShadowTrade,
  failRtForwardShadowEvent,
  getRtDailyAuditMaterialization,
  getRtForwardShadowState,
  getRtStrategyVersion,
  insertRtForwardShadowTrade,
  releaseRtForwardShadowStateLock,
  updateRtForwardShadowEvent,
  upsertRtForwardShadowState,
  upsertRtStrategyVersion,
} from "./db";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";
import { TEN_MONITORED_SYMBOLS } from "./multiSymbolMonitoringRegistry";
import { BASELINE_STRATEGY_GIT_SHA, FORWARD_EVALUATION_POLICY, getRuntimeIdentity, sha256Stable } from "./runtimeIdentity";
import {
  TECHNICAL_A_OBSERVATION_V2_COLLECTION_START_DATE,
  TECHNICAL_A_OBSERVATION_V2_CONFIG_HASH,
  TECHNICAL_A_OBSERVATION_V2_FORMAL_START_DATE,
  TECHNICAL_A_OBSERVATION_V2_LEARNING_CUTOFF_DATE,
  TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT,
  TECHNICAL_A_OBSERVATION_V2_VERSION,
  TECHNICAL_A_OBSERVATION_V2_VERSIONS,
  technicalAObservationV2NearMiss,
} from "./technicalAObservationV2";
import {
  applyTechnicalRegimeShadowTransition,
  normalizeTechnicalRegimeShadowState,
  unavailableTechnicalRegimePlan,
  type TechnicalRegimePlan,
  type TechnicalRegimeShadowState,
  type TechnicalRegimeTransition,
} from "./technicalRegimeShadow";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
const SYMBOLS = new Set<string>(TEN_MONITORED_SYMBOLS);
const ensuredVersions = new Set<string>();
const frozenPlanCache = new Map<string, Promise<TechnicalRegimePlan>>();

type ObservationSymbol = keyof typeof TECHNICAL_A_OBSERVATION_V2_VERSIONS;
type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function strategyVersion(symbol: string): string {
  const version = TECHNICAL_A_OBSERVATION_V2_VERSIONS[symbol as ObservationSymbol];
  if (!version) throw new Error(`technical_a_observation_v2_unknown_symbol:${symbol}`);
  return version;
}

async function ensureVersion(symbol: ObservationSymbol) {
  const version = strategyVersion(symbol);
  if (ensuredVersions.has(version)) return;
  const identity = getRuntimeIdentity();
  const config = {
    symbol,
    strategyFamily: "technical_a_observation_v2",
    observationOnly: true,
    featureSource: { component: TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT, version: TECHNICAL_A_OBSERVATION_V2_VERSION, timing: "D-1_closed_only" },
    historicalSourceTier: "legacy_reference_bootstrap_or_verified_relay",
    entry: { signalBasis: "completed_one_minute_candle", executionBasis: "next_same_symbol_source_event_directional_depth_vwap_100", maximumBoardAgeMs: 5_000, maximumAdverseEntryPct: 0.15 },
    exit: { stop: "frozen_technical_invalidation_level", target: "nearest_frozen_technical_resistance_or_support", sameCandlePriority: "stop_first", dayEndFlattenAtOrAfter: "15:20" },
    collectionStartDate: TECHNICAL_A_OBSERVATION_V2_COLLECTION_START_DATE,
    formalEvaluationStartDate: TECHNICAL_A_OBSERVATION_V2_FORMAL_START_DATE,
    evaluationModes: MODES,
    formalPerformanceUse: false,
    eligibleForAdoption: false,
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
    normalTradeTableWritten: false,
  };
  await upsertRtStrategyVersion({
    versionId: version,
    strategyId: `observation-${symbol.toLowerCase()}-technical-a-v2`,
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable({ config, v2ConfigHash: TECHNICAL_A_OBSERVATION_V2_CONFIG_HASH }),
    configJson: config,
    learningCutoffDate: TECHNICAL_A_OBSERVATION_V2_LEARNING_CUTOFF_DATE,
    evaluationStartDate: TECHNICAL_A_OBSERVATION_V2_FORMAL_START_DATE,
    evaluationPurpose: "parity_only",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason: "technical_a_observation_v2_non_adoptable_formal_gate_pending",
  });
  ensuredVersions.add(version);
}

async function queryFrozenPlan(symbol: ObservationSymbol, tradeDate: string): Promise<TechnicalRegimePlan> {
  const row = await getRtDailyAuditMaterialization({
    component: TECHNICAL_A_OBSERVATION_V2_PLAN_COMPONENT,
    version: TECHNICAL_A_OBSERVATION_V2_VERSION,
    tradeDate,
  });
  const wrapper = object(object(row?.resultJson).plansBySymbol)[symbol];
  const plan = object(wrapper).plan;
  if (!row || row.status !== "complete" || object(row.resultJson).dataCutoff === undefined || typeof object(plan).kind !== "string") {
    return unavailableTechnicalRegimePlan(symbol, "no_complete_v2_d_minus_1_plan_snapshot");
  }
  return plan as unknown as TechnicalRegimePlan;
}

function loadFrozenPlan(symbol: ObservationSymbol, tradeDate: string): Promise<TechnicalRegimePlan> {
  const key = `${symbol}:${tradeDate}`;
  const cached = frozenPlanCache.get(key);
  if (cached) return cached;
  const pending = queryFrozenPlan(symbol, tradeDate).catch(error => {
    frozenPlanCache.delete(key);
    throw error;
  });
  frozenPlanCache.set(key, pending);
  return pending;
}

function existingPlan(value: unknown, tradeDate: string, symbol: string): TechnicalRegimePlan | null {
  const raw = object(value);
  const plan = object(raw.plan);
  if (raw.tradeDate !== tradeDate || plan.symbol !== symbol || typeof plan.kind !== "string") return null;
  return plan as unknown as TechnicalRegimePlan;
}

async function acquireWithWait(version: string, sourceEventId: string, mode: ForwardEvaluationMode) {
  const ownerToken = createForwardShadowLockOwnerToken({ strategyVersion: version, sourceEventId, evaluationMode: mode });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({ strategyVersion: version, evaluationMode: mode, ownerToken, leaseMs: 8_000 })) return ownerToken;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`technical_a_observation_v2_state_lock_timeout:${version}:${mode}`);
}

function statusForTransition(plan: TechnicalRegimePlan, transition: TechnicalRegimeTransition) {
  if (plan.reasonCodes.includes("data_blocked")) return "data_blocked";
  if (transition.closedPosition) return "closed";
  if (transition.openedPosition) return "entered";
  if (transition.resultType === "rejected") return "signal_rejected";
  return "plan_ready_no_signal";
}

async function persistTransition(input: {
  version: string;
  mode: ForwardEvaluationMode;
  source: ForwardSourceEventInput;
  transition: TechnicalRegimeTransition;
  stateHashBefore: string;
  stateHashAfter: string;
}) {
  await upsertRtForwardShadowState({
    strategyVersion: input.version,
    evaluationMode: input.mode,
    stateJson: input.transition.nextState,
    stateHash: input.stateHashAfter,
    lastSourceEventId: input.source.sourceEventId,
  });
  if (input.transition.openedPosition) {
    const position = input.transition.openedPosition;
    await insertRtForwardShadowTrade({
      strategyVersion: input.version,
      evaluationMode: input.mode,
      symbol: input.source.candle.symbol,
      side: position.side,
      entrySourceEventId: position.entrySourceEventId,
      entryTradeDate: input.source.candle.tradeDate,
      signalCandleTime: position.signalTime,
      entryCandleTime: position.entryTime,
      theoreticalSignalPrice: String(position.theoreticalSignalPrice),
      entryPrice: String(position.entryPrice),
      shares: position.shares,
      slPct: String(position.slPct),
      tpPct: String(position.tpPct),
    });
  }
  if (input.transition.closedPosition) {
    const closed = input.transition.closedPosition;
    await closeRtForwardShadowTrade({
      strategyVersion: input.version,
      evaluationMode: input.mode,
      entrySourceEventId: closed.position.entrySourceEventId,
      exitSourceEventId: input.source.sourceEventId,
      exitTradeDate: input.source.candle.tradeDate,
      exitCandleTime: input.source.candle.candleTime,
      exitPrice: String(closed.exitPrice),
      exitReason: closed.exitReason,
      pnl: closed.pnl,
      pnlAfterAdverseExit: closed.pnlAfterAdverseExit,
      realizedR: String(closed.realizedR),
    });
  }
  const observationStatus = statusForTransition(input.transition.nextState.plan, input.transition);
  const lastAction = input.transition.actions.at(-1) ?? null;
  await updateRtForwardShadowEvent({
    strategyVersion: input.version,
    sourceEventId: input.source.sourceEventId,
    evaluationMode: input.mode,
    resultType: input.transition.resultType,
    decisionJson: {
      purpose: "parity_only",
      candidateVariant: "technical_a_observation_v2",
      observationStatus,
      actions: input.transition.actions,
      nearMiss: observationStatus === "plan_ready_no_signal"
        ? technicalAObservationV2NearMiss(input.transition.nextState)
        : observationStatus === "signal_rejected"
          ? { ...object(lastAction), requiredRewardRisk: 1.2, boardFreshnessMaximumMs: 5_000 }
          : null,
      plan: input.transition.nextState.plan,
      sourceTier: input.transition.nextState.plan.reasonCodes.includes("legacy_reference_bootstrap") ? "legacy_reference_bootstrap" : "verified_or_unavailable",
      signalQualityShares: input.mode === "signal_quality" ? 100 : null,
      formalPerformanceUse: false,
      automaticSelection: false,
      automaticAdoption: false,
      orderInstructionCreated: false,
      normalTradeTableWritten: false,
      stateHashBefore: input.stateHashBefore,
    },
    stateHashAfter: input.stateHashAfter,
  });
}

async function processMode(source: ForwardSourceEventInput, symbol: ObservationSymbol, mode: ForwardEvaluationMode) {
  const version = strategyVersion(symbol);
  const initialRow = await getRtForwardShadowState({ strategyVersion: version, evaluationMode: mode });
  const plan = existingPlan(initialRow?.stateJson, source.candle.tradeDate, symbol) ?? await loadFrozenPlan(symbol, source.candle.tradeDate);
  const initialState = normalizeTechnicalRegimeShadowState(initialRow?.stateJson, source.candle.tradeDate, plan);
  const initialHash = sha256Stable(initialState);
  const claim = await claimOrRetryRtForwardShadowEvent({
    claimToken: randomUUID(),
    leaseMs: 30_000,
    data: {
      strategyVersion: version,
      sourceEventId: source.sourceEventId,
      evaluationMode: mode,
      tradeDate: source.candle.tradeDate,
      symbol,
      candleTime: source.candle.candleTime,
      resultType: "pending",
      decisionJson: { status: "claimed", purpose: "parity_only", candidateVariant: "technical_a_observation_v2" },
      stateHashBefore: initialHash,
      stateHashAfter: initialHash,
    },
  });
  if (claim !== "claimed") return { mode, status: claim };
  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(version, source.sourceEventId, mode);
    const latest = await getRtForwardShadowState({ strategyVersion: version, evaluationMode: mode });
    const latestPlan = existingPlan(latest?.stateJson, source.candle.tradeDate, symbol) ?? plan;
    const state = normalizeTechnicalRegimeShadowState(latest?.stateJson, source.candle.tradeDate, latestPlan);
    const stateHashBefore = sha256Stable(state);
    const transition = applyTechnicalRegimeShadowTransition(state, source, mode);
    const stateHashAfter = sha256Stable(transition.nextState);
    await persistTransition({ version, mode, source, transition, stateHashBefore, stateHashAfter });
    return { mode, status: "processed" as const, resultType: transition.resultType, observationStatus: statusForTransition(latestPlan, transition), stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({ strategyVersion: version, sourceEventId: source.sourceEventId, evaluationMode: mode, errorDetail: String(error), stateHashBefore: initialHash });
    throw error;
  } finally {
    if (ownerToken) await releaseRtForwardShadowStateLock({ strategyVersion: version, evaluationMode: mode, ownerToken });
  }
}

/** Isolated forward observer. It only starts on the declared collection date. */
export async function processTechnicalAObservationV2SourceEvent(source: ForwardSourceEventInput) {
  if (!SYMBOLS.has(source.candle.symbol)) return { skipped: "non_ten_symbol" as const };
  if (source.candle.tradeDate < TECHNICAL_A_OBSERVATION_V2_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  const symbol = source.candle.symbol as ObservationSymbol;
  await ensureVersion(symbol);
  const version = await getRtStrategyVersion(strategyVersion(symbol));
  if (version?.status === "stopped" || version?.status === "insufficient") return { skipped: `strategy_${version.status}` as const, strategyVersion: strategyVersion(symbol) };
  const evaluations = [];
  for (const mode of MODES) evaluations.push(await processMode(source, symbol, mode));
  return { skipped: false as const, symbol, strategyVersion: strategyVersion(symbol), evaluations };
}

export function replayTechnicalAObservationV2State(input: {
  inputs: ForwardSourceEventInput[];
  plan: TechnicalRegimePlan;
  mode: ForwardEvaluationMode;
}) {
  const tradeDate = input.inputs[0]?.candle.tradeDate ?? "";
  let state: TechnicalRegimeShadowState = normalizeTechnicalRegimeShadowState(null, tradeDate, input.plan);
  for (const source of input.inputs.filter(item => item.candle.symbol === input.plan.symbol)) {
    state = applyTechnicalRegimeShadowTransition(state, source, input.mode).nextState;
  }
  return { state, stateHash: sha256Stable(state) };
}

export function resetTechnicalAObservationV2VersionCacheForTest() {
  ensuredVersions.clear();
  frozenPlanCache.clear();
}
