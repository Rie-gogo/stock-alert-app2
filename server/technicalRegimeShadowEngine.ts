import { randomUUID } from "node:crypto";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import {
  acquireRtForwardShadowStateLock,
  claimOrRetryRtForwardShadowEvent,
  closeRtForwardShadowTrade,
  failRtForwardShadowEvent,
  getRtDailyAuditMaterializationsForRange,
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
import {
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  TECHNICAL_REGIME_SHADOW_A_VERSIONS,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
  TEN_SYMBOL_SELECTOR_FEATURE_START_DATE,
  TEN_SYMBOL_SELECTOR_VERSION,
} from "./tenSymbolNextDaySelector";
import {
  TECHNICAL_REGIME_SHADOW_A_COLLECTION_START_DATE,
  TECHNICAL_REGIME_SHADOW_A_FORMAL_START_DATE,
  TECHNICAL_REGIME_SHADOW_A_LEARNING_CUTOFF_DATE,
  TECHNICAL_REGIME_SHADOW_A_MINIMUM_REWARD_RISK,
  applyTechnicalRegimeShadowTransition,
  buildTechnicalRegimePlan,
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

type TechnicalSymbol = keyof typeof TECHNICAL_REGIME_SHADOW_A_VERSIONS;
type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function strategyVersion(symbol: string) {
  return TECHNICAL_REGIME_SHADOW_A_VERSIONS[symbol as TechnicalSymbol];
}

async function ensureVersion(symbol: TechnicalSymbol) {
  const version = strategyVersion(symbol);
  if (ensuredVersions.has(version)) return;
  const identity = getRuntimeIdentity();
  const config = {
    symbol,
    strategyFamily: "technical_regime_shadow_a",
    featureSource: { component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, timing: "D-1_closed_only" },
    entry: { signalBasis: "completed_one_minute_candle", executionBasis: "next_same_symbol_source_event_directional_depth_vwap_100", maximumBoardAgeMs: 5_000, maximumAdverseEntryPct: 0.15 },
    exit: { stop: "frozen_technical_invalidation_level", target: "nearest_frozen_technical_resistance_or_support", sameCandlePriority: "stop_first", dayEndFlattenAtOrAfter: "15:20" },
    riskRewardPolicy: {
      mode: "dynamic_technical_levels",
      minimumRewardRisk: TECHNICAL_REGIME_SHADOW_A_MINIMUM_REWARD_RISK,
      exception: "user_approved_dynamic_technical_levels_2026-10-02",
      automaticAdoption: false,
    },
    collectionStartDate: TECHNICAL_REGIME_SHADOW_A_COLLECTION_START_DATE,
    formalEvaluationStartDate: TECHNICAL_REGIME_SHADOW_A_FORMAL_START_DATE,
    evaluationModes: MODES,
    eligibleForAdoption: true,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
  await upsertRtStrategyVersion({
    versionId: version,
    strategyId: `candidate-${symbol.toLowerCase()}-technical-regime-a`,
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: TECHNICAL_REGIME_SHADOW_A_LEARNING_CUTOFF_DATE,
    evaluationStartDate: TECHNICAL_REGIME_SHADOW_A_FORMAL_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: true,
    status: "monitoring",
    statusReason: "technical_regime_shadow_only_formal_gate_pending",
  });
  ensuredVersions.add(version);
}

async function queryFrozenPlan(symbol: TechnicalSymbol, tradeDate: string): Promise<TechnicalRegimePlan> {
  const rows = await getRtDailyAuditMaterializationsForRange({
    component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
    version: TEN_SYMBOL_SELECTOR_VERSION,
    fromDate: TEN_SYMBOL_SELECTOR_FEATURE_START_DATE,
    toDate: tradeDate,
  });
  const row = rows
    .filter(item => item.status === "complete" && item.tradeDate < tradeDate)
    .sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || b.id - a.id)[0];
  if (!row) return unavailableTechnicalRegimePlan(symbol, "no_complete_d_minus_1_feature_snapshot");
  const feature = object(object(row.resultJson).featuresBySymbol)[symbol];
  return buildTechnicalRegimePlan({ symbol, sourceTradeDate: row.tradeDate, featureWrapper: feature });
}

function loadFrozenPlan(symbol: TechnicalSymbol, tradeDate: string): Promise<TechnicalRegimePlan> {
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
  throw new Error(`technical_regime_shadow_state_lock_timeout:${version}:${mode}`);
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
  await updateRtForwardShadowEvent({
    strategyVersion: input.version,
    sourceEventId: input.source.sourceEventId,
    evaluationMode: input.mode,
    resultType: input.transition.resultType,
    decisionJson: {
      actions: input.transition.actions,
      purpose: "candidate",
      candidateVariant: "technical_regime_shadow_a",
      plan: input.transition.nextState.plan,
      signalQualityShares: input.mode === "signal_quality" ? 100 : null,
      automaticAdoption: false,
      orderInstructionCreated: false,
      normalTradeTableWritten: false,
      stateHashBefore: input.stateHashBefore,
    },
    stateHashAfter: input.stateHashAfter,
  });
}

async function processMode(source: ForwardSourceEventInput, symbol: TechnicalSymbol, mode: ForwardEvaluationMode) {
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
      decisionJson: { status: "claimed", purpose: "candidate", candidateVariant: "technical_regime_shadow_a" },
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
    return { mode, status: "processed" as const, resultType: transition.resultType, stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({ strategyVersion: version, sourceEventId: source.sourceEventId, evaluationMode: mode, errorDetail: String(error), stateHashBefore: initialHash });
    throw error;
  } finally {
    if (ownerToken) await releaseRtForwardShadowStateLock({ strategyVersion: version, evaluationMode: mode, ownerToken });
  }
}

export async function processTechnicalRegimeShadowSourceEvent(source: ForwardSourceEventInput) {
  if (!SYMBOLS.has(source.candle.symbol)) return { skipped: "non_ten_symbol" as const };
  const symbol = source.candle.symbol as TechnicalSymbol;
  if (source.candle.tradeDate < TECHNICAL_REGIME_SHADOW_A_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  await ensureVersion(symbol);
  const version = await getRtStrategyVersion(strategyVersion(symbol));
  if (version?.status === "stopped" || version?.status === "insufficient") {
    return { skipped: `strategy_${version.status}` as const, strategyVersion: strategyVersion(symbol) };
  }
  const evaluations = [];
  for (const mode of MODES) evaluations.push(await processMode(source, symbol, mode));
  return { skipped: false as const, symbol, strategyVersion: strategyVersion(symbol), evaluations };
}

export function replayTechnicalRegimeShadowDay(
  inputs: ForwardSourceEventInput[],
  plan: TechnicalRegimePlan,
  mode: ForwardEvaluationMode,
) {
  const tradeDate = inputs[0]?.candle.tradeDate ?? "";
  let state: TechnicalRegimeShadowState = normalizeTechnicalRegimeShadowState(null, tradeDate, plan);
  for (const source of inputs.filter(item => item.candle.symbol === plan.symbol)) {
    state = applyTechnicalRegimeShadowTransition(state, source, mode).nextState;
  }
  return { state, stateHash: sha256Stable(state) };
}

export function resetTechnicalRegimeShadowVersionCacheForTest() {
  ensuredVersions.clear();
  frozenPlanCache.clear();
}
