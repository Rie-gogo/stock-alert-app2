import { randomUUID } from "node:crypto";
import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import {
  acquireRtForwardShadowStateLock,
  claimOrRetryRtForwardShadowEvent,
  closeRtForwardShadowTrade,
  failRtForwardShadowEvent,
  getLatestRtPremarketContextSnapshot,
  getRtForwardShadowState,
  getRtStrategyVersion,
  insertRtForwardShadowTrade,
  releaseRtForwardShadowStateLock,
  updateRtForwardShadowEvent,
  updateRtStrategyVersionStatus,
  upsertRtForwardShadowState,
  upsertRtStrategyVersion,
} from "./db";
import { createForwardShadowLockOwnerToken } from "./forwardShadowLock";
import { TEN_MONITORED_SYMBOLS } from "./multiSymbolMonitoringRegistry";
import {
  BASELINE_STRATEGY_GIT_SHA,
  BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS,
  BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS,
  BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS,
  FORWARD_EVALUATION_POLICY,
  RETIRED_TECHNICAL_A_OBSERVATION_V2_VERSIONS,
  RETIRED_TECHNICAL_REGIME_SHADOW_A_VERSIONS,
  getRuntimeIdentity,
  sha256Stable,
} from "./runtimeIdentity";
import {
  BOLLINGER_DIRECTIONAL_COLLECTION_START_DATE,
  BOLLINGER_DIRECTIONAL_DAY_END,
  BOLLINGER_DIRECTIONAL_ENTRY_END,
  BOLLINGER_DIRECTIONAL_ENTRY_START,
  BOLLINGER_DIRECTIONAL_FORMAL_START_DATE,
  BOLLINGER_DIRECTIONAL_LEARNING_CUTOFF_DATE,
  BOLLINGER_DIRECTIONAL_MAX_BOARD_AGE_MS,
  BOLLINGER_DIRECTIONAL_PERIOD,
  BOLLINGER_DIRECTIONAL_SIGMA,
  BOLLINGER_DIRECTIONAL_STOP_COOLDOWN_MINUTES,
  BOLLINGER_DIRECTIONAL_STOP_PCT,
  applyBollingerDirectionalTransition,
  buildBollingerDirectionalPlan,
  normalizeBollingerDirectionalState,
  type BollingerDirectionalPlan,
  type BollingerDirectionalState,
  type BollingerDirectionalTransition,
  type BollingerDirectionalVariant,
} from "./bollingerDirectionalShadow";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
const VARIANTS: readonly BollingerDirectionalVariant[] = ["fixed_stop_140_cooldown_30"];
const SYMBOLS = new Set<string>(TEN_MONITORED_SYMBOLS);
const ensuredVersions = new Set<string>();
const frozenPlanCache = new Map<string, Promise<BollingerDirectionalPlan>>();
let retiredSupersededVersions = false;

type BollingerSymbol = keyof typeof BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS;

export function bollingerDirectionalStrategyVersion(symbol: BollingerSymbol, _variant: BollingerDirectionalVariant) {
  return BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS[symbol];
}

async function retireSupersededVersions() {
  if (retiredSupersededVersions) return;
  const historicalVersions = [
    ...Object.values(RETIRED_TECHNICAL_REGIME_SHADOW_A_VERSIONS),
    ...Object.values(RETIRED_TECHNICAL_A_OBSERVATION_V2_VERSIONS),
    ...Object.values(BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS),
    ...Object.values(BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS),
  ];
  for (const versionId of historicalVersions) {
    const row = await getRtStrategyVersion(versionId);
    if (row && row.status !== "stopped") {
      await updateRtStrategyVersionStatus({
        versionId,
        status: "stopped",
        statusReason: "retired_replaced_by_bollinger_fixed_stop140_cooldown30_shadow_2026_10_06",
      });
    }
  }
  retiredSupersededVersions = true;
}

async function ensureVersion(symbol: BollingerSymbol, variant: BollingerDirectionalVariant) {
  const version = bollingerDirectionalStrategyVersion(symbol, variant);
  if (ensuredVersions.has(version)) return;
  const identity = getRuntimeIdentity();
  const config = {
    symbol,
    strategyFamily: "bollinger_directional_shadow",
    variant,
    premarketDirection: {
      source: "rt_premarket_context_snapshots_1_to_3",
      frozenForTradeDate: true,
      upStates: ["strong_up", "up"],
      downStates: ["strong_down", "down"],
      waitStates: ["mixed", "unavailable"],
    },
    entry: {
      candle: "completed_one_minute",
      bollinger: { period: BOLLINGER_DIRECTIONAL_PERIOD, sigma: BOLLINGER_DIRECTIONAL_SIGMA, populationStandardDeviation: true, priorCompletedCandlesOnly: true },
      long: "lower_2sigma_touch_then_next_bullish_candle",
      short: "upper_2sigma_touch_then_next_bearish_candle",
      execution: "confirmation_event_directional_depth_vwap_100",
      maximumBoardAgeMs: BOLLINGER_DIRECTIONAL_MAX_BOARD_AGE_MS,
      entryWindow: [BOLLINGER_DIRECTIONAL_ENTRY_START, BOLLINGER_DIRECTIONAL_ENTRY_END],
      multipleSequentialTradesPerDay: true,
    },
    exit: {
      target: "opposite_2sigma_frozen_at_entry_from_prior_completed_20_closes",
      stop: { type: "fixed_pct", pct: BOLLINGER_DIRECTIONAL_STOP_PCT },
      sameCandlePriority: "stop_first",
      sameSymbolReentryCooldownMinutesAfterStop: BOLLINGER_DIRECTIONAL_STOP_COOLDOWN_MINUTES,
      dayEndFlattenAtOrAfter: BOLLINGER_DIRECTIONAL_DAY_END,
    },
    riskRewardPolicy: {
      mode: "fixed_entry_bollinger_opposite_band",
      exception: "user_approved_bollinger_directional_shadow_2026-10-06",
      automaticAdoption: false,
    },
    comparisonR: { denominatorPct: BOLLINGER_DIRECTIONAL_STOP_PCT, appliesToFixedStopVariant: true },
    collectionStartDate: BOLLINGER_DIRECTIONAL_COLLECTION_START_DATE,
    formalEvaluationStartDate: BOLLINGER_DIRECTIONAL_FORMAL_START_DATE,
    evaluationModes: MODES,
    eligibleForAdoption: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
  await upsertRtStrategyVersion({
    versionId: version,
    strategyId: `${symbol.toLowerCase()}-bollinger-${variant}`,
    baselineGitSha: BASELINE_STRATEGY_GIT_SHA,
    buildGitSha: identity.buildGitSha ?? identity.runtimeBuildIdentifier,
    sourceTreeHash: identity.sourceTreeHash,
    configHash: sha256Stable(config),
    configJson: config,
    learningCutoffDate: BOLLINGER_DIRECTIONAL_LEARNING_CUTOFF_DATE,
    evaluationStartDate: BOLLINGER_DIRECTIONAL_FORMAL_START_DATE,
    evaluationPurpose: "candidate",
    eligibleForAdoption: false,
    status: "monitoring",
    statusReason: "bollinger_directional_fixed_stop140_cooldown30_shadow_manual_review_only",
  });
  ensuredVersions.add(version);
}

async function queryFrozenPlan(tradeDate: string): Promise<BollingerDirectionalPlan> {
  const snapshot = await getLatestRtPremarketContextSnapshot({ tradeDate, usableOnly: false });
  return buildBollingerDirectionalPlan({ tradeDate, snapshot });
}

function loadFrozenPlan(tradeDate: string): Promise<BollingerDirectionalPlan> {
  const cached = frozenPlanCache.get(tradeDate);
  if (cached) return cached;
  const pending = queryFrozenPlan(tradeDate).catch(error => {
    frozenPlanCache.delete(tradeDate);
    throw error;
  });
  frozenPlanCache.set(tradeDate, pending);
  return pending;
}

function existingPlan(value: unknown, tradeDate: string): BollingerDirectionalPlan | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<BollingerDirectionalState>;
  if (state.tradeDate !== tradeDate || !state.plan || state.plan.tradeDate !== tradeDate) return null;
  return state.plan;
}

async function acquireWithWait(version: string, sourceEventId: string, mode: ForwardEvaluationMode) {
  const ownerToken = createForwardShadowLockOwnerToken({ strategyVersion: version, sourceEventId, evaluationMode: mode });
  const deadline = Date.now() + 6_000;
  do {
    if (await acquireRtForwardShadowStateLock({ strategyVersion: version, evaluationMode: mode, ownerToken, leaseMs: 8_000 })) return ownerToken;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`bollinger_directional_shadow_state_lock_timeout:${version}:${mode}`);
}

async function persistTransition(input: {
  version: string;
  variant: BollingerDirectionalVariant;
  mode: ForwardEvaluationMode;
  source: ForwardSourceEventInput;
  transition: BollingerDirectionalTransition;
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
      candidateVariant: `bollinger_directional_${input.variant}`,
      plan: input.transition.nextState.plan,
      eligibleForAdoption: false,
      automaticAdoption: false,
      orderInstructionCreated: false,
      normalTradeTableWritten: false,
      stateHashBefore: input.stateHashBefore,
    },
    stateHashAfter: input.stateHashAfter,
  });
}

async function processMode(
  source: ForwardSourceEventInput,
  symbol: BollingerSymbol,
  variant: BollingerDirectionalVariant,
  mode: ForwardEvaluationMode,
) {
  const version = bollingerDirectionalStrategyVersion(symbol, variant);
  const initialRow = await getRtForwardShadowState({ strategyVersion: version, evaluationMode: mode });
  const plan = existingPlan(initialRow?.stateJson, source.candle.tradeDate) ?? await loadFrozenPlan(source.candle.tradeDate);
  const initialState = normalizeBollingerDirectionalState(initialRow?.stateJson, plan, variant);
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
      decisionJson: { status: "claimed", purpose: "candidate", candidateVariant: `bollinger_directional_${variant}`, eligibleForAdoption: false },
      stateHashBefore: initialHash,
      stateHashAfter: initialHash,
    },
  });
  if (claim !== "claimed") return { variant, mode, status: claim };

  let ownerToken: string | null = null;
  try {
    ownerToken = await acquireWithWait(version, source.sourceEventId, mode);
    const latest = await getRtForwardShadowState({ strategyVersion: version, evaluationMode: mode });
    const latestPlan = existingPlan(latest?.stateJson, source.candle.tradeDate) ?? plan;
    const state = normalizeBollingerDirectionalState(latest?.stateJson, latestPlan, variant);
    const stateHashBefore = sha256Stable(state);
    const transition = applyBollingerDirectionalTransition(state, source, mode);
    const stateHashAfter = sha256Stable(transition.nextState);
    await persistTransition({ version, variant, mode, source, transition, stateHashBefore, stateHashAfter });
    return { variant, mode, status: "processed" as const, resultType: transition.resultType, stateHashAfter };
  } catch (error) {
    await failRtForwardShadowEvent({ strategyVersion: version, sourceEventId: source.sourceEventId, evaluationMode: mode, errorDetail: String(error), stateHashBefore: initialHash });
    throw error;
  } finally {
    if (ownerToken) await releaseRtForwardShadowStateLock({ strategyVersion: version, evaluationMode: mode, ownerToken });
  }
}

export async function processBollingerDirectionalShadowSourceEvent(source: ForwardSourceEventInput) {
  if (!SYMBOLS.has(source.candle.symbol)) return { skipped: "non_ten_symbol" as const };
  if (source.candle.tradeDate < BOLLINGER_DIRECTIONAL_COLLECTION_START_DATE) return { skipped: "before_collection_start" as const };
  if (!getRuntimeIdentity().tradingLogicMatchesBaseline) return { skipped: "baseline_trading_logic_mismatch" as const };
  const symbol = source.candle.symbol as BollingerSymbol;
  await retireSupersededVersions();
  const evaluations = [];
  for (const variant of VARIANTS) {
    await ensureVersion(symbol, variant);
    const versionId = bollingerDirectionalStrategyVersion(symbol, variant);
    const version = await getRtStrategyVersion(versionId);
    if (version?.status === "stopped" || version?.status === "insufficient") {
      evaluations.push({ variant, skipped: `strategy_${version.status}` as const, strategyVersion: versionId });
      continue;
    }
    for (const mode of MODES) evaluations.push(await processMode(source, symbol, variant, mode));
  }
  return { skipped: false as const, symbol, evaluations };
}

export function replayBollingerDirectionalShadowDay(input: {
  sources: ForwardSourceEventInput[];
  plan: BollingerDirectionalPlan;
  variant: BollingerDirectionalVariant;
  mode: ForwardEvaluationMode;
}) {
  let state = createReplayState(input.plan, input.variant);
  const transitions: BollingerDirectionalTransition[] = [];
  for (const source of input.sources) {
    const transition = applyBollingerDirectionalTransition(state, source, input.mode);
    transitions.push(transition);
    state = transition.nextState;
  }
  return { state, transitions, stateHash: sha256Stable(state) };
}

function createReplayState(plan: BollingerDirectionalPlan, variant: BollingerDirectionalVariant) {
  return normalizeBollingerDirectionalState(null, plan, variant);
}

export function resetBollingerDirectionalShadowCachesForTest() {
  ensuredVersions.clear();
  frozenPlanCache.clear();
  retiredSupersededVersions = false;
}
