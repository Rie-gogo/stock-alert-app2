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
  RETIRED_BOLLINGER_DIRECTIONAL_FIXED_STOP_140_V1_VERSIONS,
  BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V2_VERSIONS,
  RETIRED_BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V1_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V4_VERSIONS,
  RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V3_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V2_VERSIONS,
  RETIRED_BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V1_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V2_VERSIONS,
  RETIRED_BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V1_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_GAP_060_VERSIONS,
  BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS,
  RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_VERSIONS,
  RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI14_GAP_060_VERSIONS,
  RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI22LONG_GAP_060_VERSIONS,
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
  bollingerDirectionalVariantConfig,
  buildBollingerIntradaySmaDirectionPlan,
  buildBollingerDirectionalPlan,
  normalizeBollingerDirectionalState,
  type BollingerDirectionalPlan,
  type BollingerDirectionalState,
  type BollingerDirectionalTransition,
  type BollingerDirectionalVariant,
} from "./bollingerDirectionalShadow";

const MODES: readonly ForwardEvaluationMode[] = FORWARD_EVALUATION_POLICY.evaluationModes;
const VARIANTS: readonly BollingerDirectionalVariant[] = [
  "fixed_stop_140_cooldown_30",
  "fixed_stop_140_cooldown_30_sma20_dynamic_gap060_v3",
  "fixed_stop_140_cooldown_30_sma20_slope_gap060",
  "fixed_stop_140_cooldown_30_sma20_slope_bbwidth5_gap060",
  "fixed_stop_140_cooldown_30_sma10_slope_gap050",
];
const SYMBOLS = new Set<string>(TEN_MONITORED_SYMBOLS);
const ensuredVersions = new Set<string>();
const frozenPlanCache = new Map<string, Promise<BollingerDirectionalPlan>>();
let retiredSupersededVersions = false;

type BollingerSymbol = keyof typeof BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS;

export function bollingerDirectionalStrategyVersion(symbol: BollingerSymbol, variant: BollingerDirectionalVariant) {
  if (variant === "fixed_stop_140_cooldown_30_sma20_gap060") return BOLLINGER_DIRECTIONAL_SMA20_GAP_060_VERSIONS[symbol];
  if (variant === "fixed_stop_140_cooldown_30_sma20_dynamic_gap060") return RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_VERSIONS[symbol];
  if (variant === "fixed_stop_140_cooldown_30_sma20_dynamic_gap060_v3") return BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V4_VERSIONS[symbol];
  if (variant === "fixed_stop_140_cooldown_30_sma20_slope_gap060") return BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V2_VERSIONS[symbol];
  if (variant === "fixed_stop_140_cooldown_30_sma20_slope_bbwidth5_gap060") return BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V2_VERSIONS[symbol];
  if (variant === "fixed_stop_140_cooldown_30_sma10_slope_gap050") return BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V2_VERSIONS[symbol];
  return BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS[symbol];
}

export function bollingerDirectionalLifecycleStrategyId(symbol: BollingerSymbol, variant: BollingerDirectionalVariant): string {
  // rt_strategy_versions.strategy_id は64文字。versionIdは完全なまま監査に残す。
  return variant === "fixed_stop_140_cooldown_30_sma20_dynamic_gap060_v3"
    ? `${symbol.toLowerCase()}-bb-sma20-dynamic-v4`
    : variant === "fixed_stop_140_cooldown_30_sma20_slope_gap060"
    ? `${symbol.toLowerCase()}-bb-sma20-slope-a-v2`
    : variant === "fixed_stop_140_cooldown_30_sma20_slope_bbwidth5_gap060"
    ? `${symbol.toLowerCase()}-bb-sma20-slope-width-b-v2`
    : variant === "fixed_stop_140_cooldown_30_sma10_slope_gap050"
    ? `${symbol.toLowerCase()}-bb-sma10-slope-v2`
    : `${symbol.toLowerCase()}-bb-fixed-stop-v2`;
}

async function retireSupersededVersions() {
  if (retiredSupersededVersions) return;
  const historicalVersions: string[] = [
    ...(Object.values(RETIRED_TECHNICAL_REGIME_SHADOW_A_VERSIONS) as string[]),
    ...(Object.values(RETIRED_TECHNICAL_A_OBSERVATION_V2_VERSIONS) as string[]),
    ...(Object.values(BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS) as string[]),
    ...(Object.values(BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS) as string[]),
    ...(Object.values(BOLLINGER_DIRECTIONAL_SMA20_GAP_060_VERSIONS) as string[]),
    ...(Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_VERSIONS) as string[]),
    ...(Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI14_GAP_060_VERSIONS) as string[]),
    ...(Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI22LONG_GAP_060_VERSIONS) as string[]),
    ...(Object.values(RETIRED_BOLLINGER_DIRECTIONAL_FIXED_STOP_140_V1_VERSIONS) as string[]),
    ...(Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V3_VERSIONS) as string[]),
    ...(Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V1_VERSIONS) as string[]),
    ...(Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V1_VERSIONS) as string[]),
    ...(Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V1_VERSIONS) as string[]),
  ];
  for (const versionId of historicalVersions) {
    const row = await getRtStrategyVersion(versionId);
    if (row && row.status !== "stopped") {
      const isRetiredSma20 = (Object.values(BOLLINGER_DIRECTIONAL_SMA20_GAP_060_VERSIONS) as readonly string[]).includes(versionId);
      const isRetiredDynamicSma20 = (Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_VERSIONS) as readonly string[]).includes(versionId);
      const isRetiredRsi14 = (Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI14_GAP_060_VERSIONS) as readonly string[]).includes(versionId);
      const isRetiredRsi22Long = (Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI22LONG_GAP_060_VERSIONS) as readonly string[]).includes(versionId);
      const sourceTimeFreshnessRetiredVersions: string[] = [
        ...Object.values(RETIRED_BOLLINGER_DIRECTIONAL_FIXED_STOP_140_V1_VERSIONS),
        ...Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V3_VERSIONS),
        ...Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V1_VERSIONS),
        ...Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V1_VERSIONS),
        ...Object.values(RETIRED_BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V1_VERSIONS),
      ];
      const isSourceTimeFreshnessRetirement = sourceTimeFreshnessRetiredVersions.includes(versionId);
      await updateRtStrategyVersionStatus({
        versionId,
        status: "stopped",
        statusReason: isSourceTimeFreshnessRetirement
          ? "retired_replaced_by_source_time_board_freshness_fix_2026_10_09"
          : isRetiredRsi22Long
          ? "retired_replaced_by_sma20_direction_slope_variants_without_rsi_2026_10_08"
          : isRetiredRsi14
          ? "retired_replaced_by_intraday_sma20_rsi22long_alternative_shadow_2026_10_07"
          : isRetiredDynamicSma20
          ? "retired_replaced_by_intraday_sma20_rsi14_long_alternative_shadow_2026_10_07"
          : isRetiredSma20
          ? "retired_replaced_by_intraday_sma20_direction_shadow_2026_10_07"
          : "retired_replaced_by_bollinger_fixed_stop140_cooldown30_shadow_2026_10_06",
      });
    }
  }
  retiredSupersededVersions = true;
}

async function ensureVersion(symbol: BollingerSymbol, variant: BollingerDirectionalVariant) {
  const version = bollingerDirectionalStrategyVersion(symbol, variant);
  if (ensuredVersions.has(version)) return;
  const identity = getRuntimeIdentity();
  const variantConfig = bollingerDirectionalVariantConfig(variant);
  const strategyId = bollingerDirectionalLifecycleStrategyId(symbol, variant);
  const config = {
    symbol,
    strategyFamily: "bollinger_directional_shadow",
    variant,
    directionSelection: variantConfig.directionSource === "intraday_sma"
      ? {
        source: "same_day_completed_five_minute_sma20",
        premarketInputsUsed: false,
        resetForEachTradeDate: true,
        long: "touch_candle_close_above_sma20_and_lower_2sigma_touch",
        short: "touch_candle_close_below_sma20_and_upper_2sigma_touch",
        incompleteFiveMinuteBars: "fail_closed",
      }
      : {
        source: "rt_premarket_context_snapshots_1_to_3",
        premarketInputsUsed: true,
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
      boardAgeAcceptanceBasis: "board_observed_to_relay_assembled_same_clock",
      sourceBoardAgeField: "sourceBoardAgeMs",
      deliveryBoardAgeAuditField: "deliveryBoardAgeMs",
      deliveryBoardAgeUse: "audit_only_not_entry_acceptance",
      entryWindow: [BOLLINGER_DIRECTIONAL_ENTRY_START, BOLLINGER_DIRECTIONAL_ENTRY_END],
      multipleSequentialTradesPerDay: true,
      movingAverageFilter: variantConfig.movingAveragePeriod === null ? null : {
        timeframeMinutes: variantConfig.movingAverageTimeframeMinutes,
        period: variantConfig.movingAveragePeriod,
        priceRelation: "touch_candle_close_directionally_beyond_sma",
        requireDirectionalSlope: variantConfig.requireDirectionalSlope,
        requireNonOpposingSlope: variantConfig.requireNonOpposingSlope,
        completedBarsOnly: true,
        requireAllFiveOneMinuteCandles: variantConfig.requireCompleteFiveMinuteBars,
      },
      bollingerWidthGate: variantConfig.requireNonExpandingBollingerWidth5 ? {
        basis: "prior_completed_one_minute_candles_only",
        lookbackBars: 5,
        condition: "current_width_lte_width_five_bars_ago",
        unavailable: "fail_closed",
      } : null,
      minimumFixedTargetDistancePct: variantConfig.minimumTargetDistancePct,
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
    strategyId,
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
    statusReason: `bollinger_directional_${variant}_shadow_manual_review_only`,
  });
  ensuredVersions.add(version);
}

/**
 * リリース時の明示的なlifecycle整備用。source eventやshadow event/tradeを作らず、
 * 旧版を停止し、現行5案×10銘柄の監視用strategy versionだけを冪等登録する。
 */
export async function registerBollingerDirectionalShadowLifecycle(): Promise<void> {
  await retireSupersededVersions();
  for (const symbol of TEN_MONITORED_SYMBOLS as readonly BollingerSymbol[]) {
    for (const variant of VARIANTS) await ensureVersion(symbol, variant);
  }
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
  const plan = existingPlan(initialRow?.stateJson, source.candle.tradeDate)
    ?? (bollingerDirectionalVariantConfig(variant).directionSource === "intraday_sma"
      ? buildBollingerIntradaySmaDirectionPlan(source.candle.tradeDate)
      : await loadFrozenPlan(source.candle.tradeDate));
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
    const versionId = bollingerDirectionalStrategyVersion(symbol, variant);
    try {
      await ensureVersion(symbol, variant);
      const version = await getRtStrategyVersion(versionId);
      if (version?.status === "stopped" || version?.status === "insufficient") {
        evaluations.push({ variant, skipped: `strategy_${version.status}` as const, strategyVersion: versionId });
        continue;
      }
      for (const mode of MODES) {
        try {
          evaluations.push(await processMode(source, symbol, variant, mode));
        } catch (error) {
          // processModeはclaim済みならfailRtForwardShadowEventへversion/mode/sourceEventId/errorを保存する。
          console.error("[BollingerDirectionalShadow] variant/mode isolated failure", { variant, mode, strategyVersion: versionId, sourceEventId: source.sourceEventId, error: String(error) });
          evaluations.push({ variant, mode, strategyVersion: versionId, skipped: "isolated_mode_error" as const, error: String(error) });
        }
      }
    } catch (error) {
      // version登録失敗も後続variantを止めない。DB停止時には保存不能なのでsourceを成功扱いにせず明示的に返す。
      console.error("[BollingerDirectionalShadow] variant isolated registration failure", { variant, strategyVersion: versionId, sourceEventId: source.sourceEventId, error: String(error) });
      evaluations.push({ variant, strategyVersion: versionId, skipped: "isolated_variant_registration_error" as const, error: String(error) });
    }
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
