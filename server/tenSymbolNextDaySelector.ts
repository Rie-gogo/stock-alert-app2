import type { RtDailyAuditMaterialization, RtSourceEvent } from "../drizzle/schema";
import {
  getRtDailyAuditMaterialization,
  getRtDailyAuditMaterializationsForRange,
  getRtRealtimeDecisionStatsForDate,
  getRtSourceEventsForDateAndSymbol,
  getRtStrategyVersion,
  upsertRtDailyAuditMaterialization,
} from "./db";
import {
  buildKioxiaManifestV2,
  calculateKioxiaSelectorDailyFeature,
  classifyKioxiaSelectorRegime,
  nextTokyoEquityTradeDate,
} from "./kioxiaNextDaySelector";
import {
  MULTI_SYMBOL_MONITORING_COMPONENT,
  MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
  type MultiSymbolMonitoringDailySnapshot,
} from "./multiSymbolMonitoringMaterializer";
import { TEN_MONITORED_SYMBOLS } from "./multiSymbolMonitoringRegistry";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
} from "./currentSignalCandidateRegistry";
import {
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  DISCO_SHORT_RETEST_B_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  MURATA_DEEP_REVERSAL_LONG_VERSION,
  MURATA_MORNING_BREAKDOWN_SHORT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
  FORWARD_STRATEGY_VERSION,
  sha256Stable,
} from "./runtimeIdentity";

export const TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT = "ten_symbol_selector_feature";
export const TEN_SYMBOL_SELECTOR_SNAPSHOT_COMPONENT = "ten_symbol_next_day_selector";
export const TEN_SYMBOL_SELECTOR_RESULT_COMPONENT = "ten_symbol_next_day_selector_result";
export const TEN_SYMBOL_SELECTOR_VERSION = "ten-symbol-fixed-current-a-b-v1";
export const TEN_SYMBOL_SELECTOR_FEATURE_START_DATE = "2026-10-01";

export type SelectorSlot = Readonly<{
  symbol: string;
  slot: "Current" | "A" | "B";
  planId: string;
  label: string;
  origin: "current" | "forward_shadow" | "unavailable";
  canonicalLogic: string | null;
  strategyVersion: string | null;
  lifecycleRequirement: "current_candidate_ledger" | "monitoring_candidate" | "unavailable";
  unavailableReason: string | null;
}>;

const currentSlots: SelectorSlot[] = TEN_MONITORED_SYMBOLS.map(symbol => ({
  symbol,
  slot: "Current",
  planId: `current:${symbol}`,
  label: "Current（現行100株仮想）",
  origin: "current",
  canonicalLogic: `current-${symbol}-candidate-ledger`,
  strategyVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
  lifecycleRequirement: "current_candidate_ledger",
  unavailableReason: null,
}));

const candidateSlots: SelectorSlot[] = [
  { symbol: "285A", slot: "A", planId: `shadow:${KIOXIA_FORWARD_STRATEGY_VERSION}`, label: "A：確認型前場LONG", origin: "forward_shadow", canonicalLogic: "285a_confirmed_long_ma8_protection", strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "285A", slot: "B", planId: `shadow:${KIOXIA_ATR_FORWARD_STRATEGY_VERSION}`, label: "B：5経路ATR", origin: "forward_shadow", canonicalLogic: "285a_five_routes_atr036_route_daily_end", strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "3436", slot: "A", planId: `shadow:${SUMCO_VOLUME_110_VERSION}`, label: "A：出来高1.10倍", origin: "forward_shadow", canonicalLogic: "candidate-3436-volume110-time15", strategyVersion: SUMCO_VOLUME_110_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "3436", slot: "B", planId: `shadow:${SUMCO_TIME_15_VERSION}`, label: "B：15分時間決済", origin: "forward_shadow", canonicalLogic: "candidate-3436-current-entry-time15", strategyVersion: SUMCO_TIME_15_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "5803", slot: "A", planId: `shadow:${FUJIKURA_FORWARD_STRATEGY_VERSION}`, label: "A：安値反転LONG", origin: "forward_shadow", canonicalLogic: "5803_low_reversal_long_ab", strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "5803", slot: "B", planId: "unavailable:5803:B", label: "B：未登録", origin: "unavailable", canonicalLogic: null, strategyVersion: null, lifecycleRequirement: "unavailable", unavailableReason: "candidate-5803-morning-20bar-breakdown-short-depth-v1 is stopped and excluded" },
  { symbol: "6146", slot: "A", planId: `shadow:${DISCO_SHORT_EXECUTABLE_A_VERSION}`, label: "A：SHORT実行可能価格確認", origin: "forward_shadow", canonicalLogic: "candidate-6146-opening-short-executable-a", strategyVersion: DISCO_SHORT_EXECUTABLE_A_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "6146", slot: "B", planId: `shadow:${DISCO_SHORT_RETEST_B_VERSION}`, label: "B：SHORT再安値リテスト", origin: "forward_shadow", canonicalLogic: "candidate-6146-opening-short-retest-b", strategyVersion: DISCO_SHORT_RETEST_B_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "6526", slot: "A", planId: "unavailable:6526:A", label: "A：未登録", origin: "unavailable", canonicalLogic: null, strategyVersion: null, lifecycleRequirement: "unavailable", unavailableReason: "initial-strength diagnostic version is stopped and excluded" },
  { symbol: "6526", slot: "B", planId: `shadow:${SOCIONEXT_CONFIRM_STRENGTH_VERSION}`, label: "B：確認足強度", origin: "forward_shadow", canonicalLogic: "candidate-6526-confirm-strength-daily-stop", strategyVersion: SOCIONEXT_CONFIRM_STRENGTH_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "6857", slot: "A", planId: "unavailable:6857:A", label: "A：未登録", origin: "unavailable", canonicalLogic: null, strategyVersion: null, lifecycleRequirement: "unavailable", unavailableReason: "no active monitoring strategy version is registered" },
  { symbol: "6857", slot: "B", planId: "unavailable:6857:B", label: "B：未登録", origin: "unavailable", canonicalLogic: null, strategyVersion: null, lifecycleRequirement: "unavailable", unavailableReason: "no active monitoring strategy version is registered" },
  { symbol: "6976", slot: "A", planId: `shadow:${TAIYO_BOARD_DEMAND_VERSION}`, label: "A：板需要確認", origin: "forward_shadow", canonicalLogic: "candidate-6976-board-demand-bpr130", strategyVersion: TAIYO_BOARD_DEMAND_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "6976", slot: "B", planId: `shadow:${TAIYO_RR2_PROTECT_VERSION}`, label: "B：2R利益保護", origin: "forward_shadow", canonicalLogic: "candidate-6976-rr2-protect", strategyVersion: TAIYO_RR2_PROTECT_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "6981", slot: "A", planId: `shadow:${MURATA_DEEP_REVERSAL_LONG_VERSION}`, label: "A：深い下落後の確認反発LONG", origin: "forward_shadow", canonicalLogic: "candidate-6981-deep-reversal-long", strategyVersion: MURATA_DEEP_REVERSAL_LONG_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "6981", slot: "B", planId: `shadow:${MURATA_MORNING_BREAKDOWN_SHORT_VERSION}`, label: "B：前場20本安値更新SHORT", origin: "forward_shadow", canonicalLogic: "candidate-6981-morning-20bar-breakdown-short", strategyVersion: MURATA_MORNING_BREAKDOWN_SHORT_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "8035", slot: "A", planId: `shadow:${FORWARD_STRATEGY_VERSION}`, label: "A：始値方向ブレイク", origin: "forward_shadow", canonicalLogic: "8035_open_direction_breakout", strategyVersion: FORWARD_STRATEGY_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "8035", slot: "B", planId: `shadow:${TEL_EXECUTABLE_DEPTH_VERSION}`, label: "B：次イベント板depth", origin: "forward_shadow", canonicalLogic: "candidate-8035-executable-depth", strategyVersion: TEL_EXECUTABLE_DEPTH_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "9984", slot: "A", planId: `shadow:${SOFTBANK_DEPTH_CONFIRM_VERSION}`, label: "A：次イベント板確認", origin: "forward_shadow", canonicalLogic: "candidate-9984-breakout-depth-confirm", strategyVersion: SOFTBANK_DEPTH_CONFIRM_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
  { symbol: "9984", slot: "B", planId: `shadow:${SOFTBANK_RR2_PROTECT_VERSION}`, label: "B：2R利益保護", origin: "forward_shadow", canonicalLogic: "candidate-9984-breakout-rr2-protect", strategyVersion: SOFTBANK_RR2_PROTECT_VERSION, lifecycleRequirement: "monitoring_candidate", unavailableReason: null },
];

export const TEN_SYMBOL_SELECTOR_SLOTS: readonly SelectorSlot[] = Object.freeze([...currentSlots, ...candidateSlots]);
export const TEN_SYMBOL_SELECTOR_CONFIG = Object.freeze({
  version: TEN_SYMBOL_SELECTOR_VERSION,
  symbols: TEN_MONITORED_SYMBOLS,
  slots: TEN_SYMBOL_SELECTOR_SLOTS,
  featureContract: "285a-manifest-v2-causal-contract-reused-per-symbol",
  performanceInput: "closed_monitoring_trend_10_symbols_daily_snapshots_only",
  fallback: ["full", "trend_volatility", "trend", "route_overall", "unavailable"],
  minimumCompleteFeatureDays: 20,
  minimumCompletedTrades: 10,
  shrinkage: { globalK: 20, routeK: 10, regimeK: 10 },
  automaticSelection: false,
  automaticAdoption: false,
  orderInstructionConnection: false,
});
export const TEN_SYMBOL_SELECTOR_CONFIG_HASH = sha256Stable(TEN_SYMBOL_SELECTOR_CONFIG);

type RecordValue = Record<string, unknown>;
type FeatureRow = { tradeDate: string; status: string; resultJson: unknown };
type DailyRow = { tradeDate: string; status: string; resultJson: unknown };
type Lifecycle = { lifecycle: string | null; purpose: string | null };

function object(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function finite(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function dailySnapshot(row: DailyRow): MultiSymbolMonitoringDailySnapshot | null {
  const result = object(row.resultJson);
  return row.status === "complete" && result.ready === true && Array.isArray(result.plans)
    ? result as unknown as MultiSymbolMonitoringDailySnapshot
    : null;
}
function featureBySymbol(row: FeatureRow, symbol: string): RecordValue | null {
  const value = object(row.resultJson);
  const features = object(value.featuresBySymbol);
  return object(features[symbol]);
}
function planFor(snapshot: MultiSymbolMonitoringDailySnapshot | null, planId: string) {
  return snapshot?.plans.find(plan => plan.planId === planId) ?? null;
}
function completedTrades(plan: any) { return Math.max(0, Math.trunc(finite(plan?.completedTrades) ?? 0)); }
function planPnl(plan: any) { return finite(plan?.pnlPer100) ?? 0; }
function planSignals(plan: any) { return Math.max(0, Math.trunc(finite(plan?.signals) ?? 0)); }
function resolveLifecycle(slot: SelectorSlot, lifecycleByVersion: Record<string, Lifecycle>) {
  if (slot.lifecycleRequirement === "unavailable") return { eligible: false, reason: slot.unavailableReason ?? "unavailable" };
  if (slot.lifecycleRequirement === "current_candidate_ledger") return { eligible: true, reason: null };
  const observed = slot.strategyVersion ? lifecycleByVersion[slot.strategyVersion] : null;
  const eligible = observed?.lifecycle === "monitoring" && observed?.purpose === "candidate";
  return { eligible, reason: eligible ? null : "strategy_lifecycle_not_monitoring_candidate" };
}

/** One immutable, closed-date feature record for every monitored symbol. */
export function buildTenSymbolSelectorFeature(input: {
  tradeDate: string;
  eventsBySymbol: Record<string, RtSourceEvent[]>;
  causalityViolationsBySymbol: Record<string, number>;
  sourceDecisionCount: number;
  processedThroughEngineSequence: number;
  watermark: unknown;
  priorFeatures: FeatureRow[];
}) {
  const featuresBySymbol: Record<string, unknown> = {};
  for (const symbol of TEN_MONITORED_SYMBOLS) {
    const events = input.eventsBySymbol[symbol] ?? [];
    const manifest = buildKioxiaManifestV2({
      tradeDate: input.tradeDate,
      events,
      sourceDecisionCount: input.sourceDecisionCount,
      processedThroughEngineSequence: input.processedThroughEngineSequence,
      watermark: input.watermark,
      causalityViolationCount: input.causalityViolationsBySymbol[symbol] ?? 0,
    });
    const history = input.priorFeatures
      .filter(row => row.status === "complete" && row.tradeDate < input.tradeDate)
      .map(row => object(featureBySymbol(row, symbol)?.features));
    const feature = calculateKioxiaSelectorDailyFeature({ manifest, events, history });
    const eligibleHistory = input.priorFeatures
      .filter(row => row.status === "complete" && row.tradeDate < input.tradeDate)
      .map(row => featureBySymbol(row, symbol))
      .filter((row): row is RecordValue => row?.featureEligible === true)
      .map(row => object(row.features));
    const regime = feature.featureEligible === true
      ? classifyKioxiaSelectorRegime(feature, eligibleHistory)
      : { full: "unknown", trend: "unknown", volatility: "unknown", location: "unknown" };
    featuresBySymbol[symbol] = {
      symbol,
      manifest,
      manifestHash: sha256Stable(manifest),
      featureEligible: feature.featureEligible === true,
      features: feature,
      regime,
      provenanceStatus: manifest.provenanceStatus,
      reasonCodes: manifest.reasonCodes,
    };
  }
  const inputHash = sha256Stable({ tradeDate: input.tradeDate, watermark: input.watermark, sourceDecisionCount: input.sourceDecisionCount, processedThroughEngineSequence: input.processedThroughEngineSequence, featuresBySymbol });
  return {
    component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
    version: TEN_SYMBOL_SELECTOR_VERSION,
    tradeDate: input.tradeDate,
    immutable: true,
    generatedAt: new Date().toISOString(),
    inputHash,
    watermark: input.watermark,
    sourceDecisionCount: input.sourceDecisionCount,
    processedThroughEngineSequence: input.processedThroughEngineSequence,
    featuresBySymbol,
  };
}

function scopedPlans(input: { symbol: string; sourceFeature: RecordValue; featureRows: FeatureRow[]; dailyRows: DailyRow[]; slot: SelectorSlot }) {
  const sourceRegime = object(input.sourceFeature.regime);
  const history = input.featureRows
    .filter(row => row.status === "complete")
    .map(row => ({ row, feature: featureBySymbol(row, input.symbol) }))
    .filter((item): item is { row: FeatureRow; feature: RecordValue } => Boolean(item.feature?.featureEligible === true));
  const dailyByDate = new Map(input.dailyRows.map(row => [row.tradeDate, dailySnapshot(row)]));
  const candidates = history.map(item => ({
    tradeDate: item.row.tradeDate,
    regime: object(item.feature.regime),
    plan: planFor(dailyByDate.get(item.row.tradeDate) ?? null, input.slot.planId),
  }));
  const valid = candidates.filter(item => completedTrades(item.plan) > 0);
  const levels = [
    { name: "full", items: valid.filter(item => item.regime.full === sourceRegime.full) },
    { name: "trend_volatility", items: valid.filter(item => item.regime.trend === sourceRegime.trend && item.regime.volatility === sourceRegime.volatility) },
    { name: "trend", items: valid.filter(item => item.regime.trend === sourceRegime.trend) },
    { name: "route_overall", items: valid },
  ];
  return { eligibleDays: history.length, candidates, chosen: levels.find(level => level.items.length > 0) ?? { name: "unavailable", items: [] as typeof valid } };
}

function scoreSlot(input: { slot: SelectorSlot; sourceFeature: RecordValue; featureRows: FeatureRow[]; dailyRows: DailyRow[]; lifecycleByVersion: Record<string, Lifecycle> }) {
  const lifecycle = resolveLifecycle(input.slot, input.lifecycleByVersion);
  if (!lifecycle.eligible) return { ...input.slot, lifecycle: "unavailable", selectable: false, exclusionReasons: [lifecycle.reason], fallbackLevel: "unavailable", eligibleDays: 0, completedTrades: 0, signalDays: 0, expectedDailyPnlPer100: null };
  if (input.sourceFeature.featureEligible !== true) return { ...input.slot, lifecycle: "eligible", selectable: false, exclusionReasons: ["feature_or_provenance_unavailable"], fallbackLevel: "unavailable", eligibleDays: 0, completedTrades: 0, signalDays: 0, expectedDailyPnlPer100: null };
  const scoped = scopedPlans({ symbol: input.slot.symbol, sourceFeature: input.sourceFeature, featureRows: input.featureRows, dailyRows: input.dailyRows, slot: input.slot });
  const allPlans = input.dailyRows.flatMap(row => dailySnapshot(row)?.plans ?? []).filter(plan => completedTrades(plan) > 0);
  const globalTrades = allPlans.reduce((sum, plan) => sum + completedTrades(plan), 0);
  const globalMean = globalTrades ? allPlans.reduce((sum, plan) => sum + planPnl(plan), 0) / globalTrades : 0;
  const all = scoped.candidates.filter(item => item.plan);
  const totalTrades = all.reduce((sum, item) => sum + completedTrades(item.plan), 0);
  const totalPnl = all.reduce((sum, item) => sum + planPnl(item.plan), 0);
  const routePosterior = totalTrades ? (totalPnl + 10 * globalMean) / (totalTrades + 10) : null;
  const sampleTrades = scoped.chosen.items.reduce((sum, item) => sum + completedTrades(item.plan), 0);
  const samplePnl = scoped.chosen.items.reduce((sum, item) => sum + planPnl(item.plan), 0);
  const posteriorPnl = routePosterior === null ? null : scoped.chosen.name === "route_overall"
    ? routePosterior
    : (samplePnl + 10 * routePosterior) / (sampleTrades + 10);
  const signalDays = scoped.candidates.filter(item => planSignals(item.plan) > 0).length;
  const fireRate = (signalDays + 1) / (scoped.eligibleDays + 2);
  const expectedDailyPnlPer100 = posteriorPnl === null ? null : posteriorPnl * fireRate;
  const exclusionReasons = [
    ...(scoped.eligibleDays < 20 ? ["fewer_than_20_complete_feature_days"] : []),
    ...(totalTrades < 10 ? ["fewer_than_10_completed_trades"] : []),
    ...(posteriorPnl === null || posteriorPnl <= 0 ? ["non_positive_posterior_pnl"] : []),
    ...(expectedDailyPnlPer100 === null || expectedDailyPnlPer100 <= 0 ? ["non_positive_expected_daily_pnl"] : []),
  ];
  return {
    ...input.slot,
    lifecycle: "eligible",
    eligibleDays: scoped.eligibleDays,
    signalDays,
    completedTrades: totalTrades,
    posteriorFireRate: fireRate,
    globalMeanPnlPer100: globalMean,
    posteriorPnlPer100: posteriorPnl,
    expectedDailyPnlPer100,
    fallbackLevel: scoped.chosen.name,
    fallbackCompletedTrades: sampleTrades,
    exclusionReasons,
    selectable: exclusionReasons.length === 0,
  };
}

/** Pure builder: only feature and daily monitoring snapshots are admitted as input. */
export function buildTenSymbolSelectorSnapshot(input: {
  sourceTradeDate: string;
  feature: FeatureRow;
  featureRows: FeatureRow[];
  dailyRows: DailyRow[];
  lifecycleByVersion: Record<string, Lifecycle>;
  watermark: unknown;
}) {
  const featureResult = object(input.feature.resultJson);
  const featuresBySymbol = object(featureResult.featuresBySymbol);
  const featureRows = input.featureRows.filter(row => row.tradeDate <= input.sourceTradeDate);
  const dailyRows = input.dailyRows.filter(row => row.tradeDate <= input.sourceTradeDate);
  const scores = TEN_SYMBOL_SELECTOR_SLOTS.map(slot => scoreSlot({
    slot,
    sourceFeature: object(featuresBySymbol[slot.symbol]),
    featureRows,
    dailyRows,
    lifecycleByVersion: input.lifecycleByVersion,
  }));
  const selections = TEN_MONITORED_SYMBOLS.map(symbol => {
    const rows = scores.filter(score => score.symbol === symbol);
    const primary = rows.filter(score => score.selectable).sort((a, b) => Number(b.expectedDailyPnlPer100) - Number(a.expectedDailyPnlPer100))[0] ?? null;
    const source = object(featuresBySymbol[symbol]);
    return {
      symbol,
      featureEligible: source.featureEligible === true,
      regime: source.regime ?? { full: "unknown" },
      selectedPlanId: primary?.planId ?? null,
      selectedSlot: primary?.slot ?? null,
      decision: primary ? "reference_only" : "no_selection",
      reason: primary ? "monitoring_only_positive_snapshot_score" : source.featureEligible !== true ? "feature_or_provenance_unavailable" : "all_rows_insufficient_or_non_positive",
    };
  });
  const targetDate = nextTokyoEquityTradeDate(input.sourceTradeDate);
  const inputHash = sha256Stable({ configHash: TEN_SYMBOL_SELECTOR_CONFIG_HASH, sourceTradeDate: input.sourceTradeDate, featureHash: featureResult.inputHash, dailyRows: dailyRows.map(row => ({ tradeDate: row.tradeDate, resultHash: sha256Stable(row.resultJson) })), lifecycleByVersion: input.lifecycleByVersion, watermark: input.watermark });
  return {
    component: TEN_SYMBOL_SELECTOR_SNAPSHOT_COMPONENT,
    selectorVersion: TEN_SYMBOL_SELECTOR_VERSION,
    configHash: TEN_SYMBOL_SELECTOR_CONFIG_HASH,
    immutable: true,
    generatedAt: new Date().toISOString(),
    dataCutoff: input.sourceTradeDate,
    sourceTradeDate: input.sourceTradeDate,
    targetDate,
    inputHash,
    watermark: input.watermark,
    featureInputHash: featureResult.inputHash ?? null,
    slots: TEN_SYMBOL_SELECTOR_SLOTS,
    scores,
    selections,
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
    formalPerformanceUse: false,
  };
}

function planOutcome(plan: any) {
  if (!plan) return { outcome: "unavailable", signals: 0, completedTrades: 0, openTrades: 0, pnlPer100: 0, grossProfitPer100: 0, grossLossPer100: 0 };
  const completed = completedTrades(plan);
  const signals = planSignals(plan);
  return {
    outcome: completed > 0 ? "observed" : signals === 0 ? "no_signal" : (finite(plan.openTrades) ?? 0) > 0 ? "open_trade" : "no_completed_trade",
    signals,
    completedTrades: completed,
    openTrades: finite(plan.openTrades) ?? 0,
    wins: finite(plan.wins) ?? 0,
    losses: finite(plan.losses) ?? 0,
    draws: finite(plan.draws) ?? 0,
    pnlPer100: planPnl(plan),
    grossProfitPer100: finite(plan.grossProfitPer100) ?? 0,
    grossLossPer100: finite(plan.grossLossPer100) ?? 0,
  };
}

export function buildTenSymbolSelectorResult(input: { tradeDate: string; snapshot: RecordValue | null; daily: DailyRow | null }) {
  const daily = input.daily ? dailySnapshot(input.daily) : null;
  const selectionBySymbol = new Map(Array.isArray(input.snapshot?.selections) ? input.snapshot!.selections.map(value => [String(object(value).symbol), object(value)]) : []);
  const bySymbol = TEN_MONITORED_SYMBOLS.map(symbol => {
    const selection = selectionBySymbol.get(symbol) ?? null;
    const rows = TEN_SYMBOL_SELECTOR_SLOTS.filter(slot => slot.symbol === symbol).map(slot => ({
      slot: slot.slot,
      planId: slot.planId,
      label: slot.label,
      ...planOutcome(slot.origin === "unavailable" ? null : planFor(daily, slot.planId)),
    }));
    const selectedPlanId = selection?.selectedPlanId ? String(selection.selectedPlanId) : null;
    return {
      symbol,
      decision: selection?.decision ?? "no_selection_snapshot",
      selectedPlanId,
      selected: selectedPlanId ? rows.find(row => row.planId === selectedPlanId) ?? null : null,
      fixed: rows,
    };
  });
  return {
    component: TEN_SYMBOL_SELECTOR_RESULT_COMPONENT,
    selectorVersion: TEN_SYMBOL_SELECTOR_VERSION,
    tradeDate: input.tradeDate,
    immutable: true,
    snapshotFound: Boolean(input.snapshot),
    formalPerformanceUse: false,
    results: bySymbol,
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
}

function aggregateSelectorOutcomes(rawResults: unknown[]) {
  const selected: RecordValue[] = [];
  const current: RecordValue[] = [];
  let pairedCoverage = 0;
  let selectedCurrentPnlDelta = 0;
  for (const raw of rawResults) {
    for (const rawSymbol of Array.isArray(object(raw).results) ? object(raw).results as unknown[] : []) {
      const symbol = object(rawSymbol);
      const fixed = Array.isArray(symbol.fixed) ? symbol.fixed.map(object) : [];
      const currentRow = fixed.find(row => row.slot === "Current");
      const selectedRow = object(symbol.selected);
      if (currentRow?.outcome === "observed") current.push(currentRow);
      if (selectedRow.outcome === "observed") selected.push(selectedRow);
      if (currentRow?.outcome === "observed" && selectedRow.outcome === "observed") {
        pairedCoverage += 1;
        selectedCurrentPnlDelta += (finite(selectedRow.pnlPer100) ?? 0) - (finite(currentRow.pnlPer100) ?? 0);
      }
    }
  }
  const summary = (rows: RecordValue[]) => {
    const pnlPer100 = rows.reduce((sum, row) => sum + (finite(row.pnlPer100) ?? 0), 0);
    const wins = rows.reduce((sum, row) => sum + (finite(row.wins) ?? 0), 0);
    const losses = rows.reduce((sum, row) => sum + (finite(row.losses) ?? 0), 0);
    const completedTrades = rows.reduce((sum, row) => sum + (finite(row.completedTrades) ?? 0), 0);
    const grossProfit = rows.reduce((sum, row) => sum + (finite(row.grossProfitPer100) ?? 0), 0);
    const grossLoss = rows.reduce((sum, row) => sum + (finite(row.grossLossPer100) ?? 0), 0);
    let cumulative = 0; let peak = 0; let maxDrawdown = 0;
    for (const row of rows) { cumulative += finite(row.pnlPer100) ?? 0; peak = Math.max(peak, cumulative); maxDrawdown = Math.max(maxDrawdown, peak - cumulative); }
    return { coverage: rows.length, completedTrades, wins, losses, winRatePct: completedTrades ? wins / completedTrades * 100 : null, pnlPer100, profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0, maxDrawdownPer100: maxDrawdown, averageR: null, averageRReason: "cross-symbol risk-normalized R is unavailable in fixed daily monitoring snapshots" };
  };
  return { selected: summary(selected), current: summary(current), selectedCurrent: { pairedCoverage, pnlPer100Delta: selectedCurrentPnlDelta }, formalPerformanceUse: false, retrospectiveDiagnosticOnly: true };
}

export async function materializeTenSymbolSelectorFeatureForDate(input: { tradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number; watermark: unknown }) {
  const existing = await getRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: input.tradeDate });
  if (existing) return { created: false, result: existing.resultJson };
  const [stats, priorFeatures, ...sourceGroups] = await Promise.all([
    getRtRealtimeDecisionStatsForDate(input.tradeDate),
    getRtDailyAuditMaterializationsForRange({ component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, fromDate: TEN_SYMBOL_SELECTOR_FEATURE_START_DATE, toDate: input.tradeDate }),
    ...TEN_MONITORED_SYMBOLS.map(symbol => getRtSourceEventsForDateAndSymbol({ tradeDate: input.tradeDate, symbol })),
  ]);
  const eventsBySymbol = Object.fromEntries(TEN_MONITORED_SYMBOLS.map((symbol, index) => [symbol, sourceGroups[index] as RtSourceEvent[]]));
  const causalityViolationsBySymbol = Object.fromEntries(TEN_MONITORED_SYMBOLS.map(symbol => [symbol, stats.filter(item => item.symbol === symbol && item.causalityStatus === "violation").reduce((sum, item) => sum + item.eventCount, 0)]));
  const result = buildTenSymbolSelectorFeature({ ...input, eventsBySymbol, causalityViolationsBySymbol, priorFeatures: priorFeatures as FeatureRow[] });
  await upsertRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: input.tradeDate, status: "complete", processedThroughEngineSequence: input.processedThroughEngineSequence, sourceDecisionCount: input.sourceDecisionCount, resultJson: result, lastError: null, generatedAt: new Date() });
  return { created: true, result };
}

export async function materializeTenSymbolNextDaySelectorForSourceDate(input: { sourceTradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number; watermark: unknown }) {
  const targetDate = nextTokyoEquityTradeDate(input.sourceTradeDate);
  const existing = await getRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_SNAPSHOT_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: targetDate });
  if (existing) return { created: false, targetDate, result: existing.resultJson };
  const activeVersions = Array.from(new Set(TEN_SYMBOL_SELECTOR_SLOTS.flatMap(slot => slot.strategyVersion ? [slot.strategyVersion] : [])));
  const [feature, featureRows, dailyRows, ...versions] = await Promise.all([
    getRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: input.sourceTradeDate }),
    getRtDailyAuditMaterializationsForRange({ component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, fromDate: TEN_SYMBOL_SELECTOR_FEATURE_START_DATE, toDate: input.sourceTradeDate }),
    getRtDailyAuditMaterializationsForRange({ component: MULTI_SYMBOL_MONITORING_COMPONENT, version: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION, fromDate: TEN_SYMBOL_SELECTOR_FEATURE_START_DATE, toDate: input.sourceTradeDate }),
    ...activeVersions.filter(version => version !== CURRENT_SIGNAL_CANDIDATE_VERSION).map(version => getRtStrategyVersion(version)),
  ]);
  if (!feature) throw new Error("ten_symbol_selector_feature_missing");
  const lifecycleByVersion: Record<string, Lifecycle> = {};
  for (const version of versions) if (version) lifecycleByVersion[version.versionId] = { lifecycle: version.status, purpose: version.evaluationPurpose };
  const result = buildTenSymbolSelectorSnapshot({ sourceTradeDate: input.sourceTradeDate, feature: feature as unknown as FeatureRow, featureRows: featureRows as unknown as FeatureRow[], dailyRows: dailyRows as unknown as DailyRow[], lifecycleByVersion, watermark: input.watermark });
  await upsertRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_SNAPSHOT_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: targetDate, status: "complete", processedThroughEngineSequence: input.processedThroughEngineSequence, sourceDecisionCount: input.sourceDecisionCount, resultJson: result, lastError: null, generatedAt: new Date() });
  return { created: true, targetDate, result };
}

export async function materializeTenSymbolNextDaySelectorResultForDate(input: { tradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number }) {
  const existing = await getRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_RESULT_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: input.tradeDate });
  if (existing) return { created: false, result: existing.resultJson };
  const [snapshot, daily] = await Promise.all([
    getRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_SNAPSHOT_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: input.tradeDate }),
    getRtDailyAuditMaterialization({ component: MULTI_SYMBOL_MONITORING_COMPONENT, version: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION, tradeDate: input.tradeDate }),
  ]);
  const result = buildTenSymbolSelectorResult({ tradeDate: input.tradeDate, snapshot: snapshot ? object(snapshot.resultJson) : null, daily: daily as unknown as DailyRow | null });
  await upsertRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_RESULT_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: input.tradeDate, status: "complete", processedThroughEngineSequence: input.processedThroughEngineSequence, sourceDecisionCount: input.sourceDecisionCount, resultJson: result, lastError: null, generatedAt: new Date() });
  return { created: true, result };
}

export async function getTenSymbolNextDaySelectorDashboard(asOfDate: string) {
  const [snapshots, results] = await Promise.all([
    getRtDailyAuditMaterializationsForRange({ component: TEN_SYMBOL_SELECTOR_SNAPSHOT_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, fromDate: TEN_SYMBOL_SELECTOR_FEATURE_START_DATE, toDate: asOfDate }),
    getRtDailyAuditMaterializationsForRange({ component: TEN_SYMBOL_SELECTOR_RESULT_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, fromDate: TEN_SYMBOL_SELECTOR_FEATURE_START_DATE, toDate: asOfDate }),
  ]);
  const immutableResults = results.filter(row => row.status === "complete").map(row => row.resultJson);
  return {
    selectorVersion: TEN_SYMBOL_SELECTOR_VERSION,
    configHash: TEN_SYMBOL_SELECTOR_CONFIG_HASH,
    slots: TEN_SYMBOL_SELECTOR_SLOTS,
    snapshots: snapshots.filter(row => row.status === "complete").map(row => row.resultJson),
    results: immutableResults,
    aggregate: aggregateSelectorOutcomes(immutableResults),
    dataSource: "immutable_closed_daily_snapshots_only",
    automaticSelection: false,
    automaticAdoption: false,
    orderInstructionConnection: false,
  };
}
