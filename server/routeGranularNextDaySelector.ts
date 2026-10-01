import type { RtDailyAuditMaterialization } from "../drizzle/schema";
import { getRtDailyAuditMaterialization, getRtDailyAuditMaterializationsForRange, getRtStrategyVersion, upsertRtDailyAuditMaterialization } from "./db";
import { nextTokyoEquityTradeDate } from "./kioxiaNextDaySelector";
import { ROUTE_GRANULAR_VARIANTS, type RouteGranularVariant } from "./routeGranularMonitoringRegistry";
import { ROUTE_GRANULAR_MONITORING_COMPONENT, ROUTE_GRANULAR_MONITORING_START_DATE, ROUTE_GRANULAR_MONITORING_VERSION, type RouteGranularDailyPlan, type RouteGranularDailySnapshot } from "./routeGranularMonitoringMaterializer";
import { sha256Stable } from "./runtimeIdentity";
import { TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, TEN_SYMBOL_SELECTOR_VERSION } from "./tenSymbolNextDaySelector";

export const ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT = "route_granular_next_day_selector";
export const ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT = "route_granular_next_day_selector_result";
export const ROUTE_GRANULAR_SELECTOR_VERSION = "route-granular-current-variants-v1";
export const ROUTE_GRANULAR_SELECTOR_CONFIG = Object.freeze({
  version: ROUTE_GRANULAR_SELECTOR_VERSION,
  variants: ROUTE_GRANULAR_VARIANTS,
  performanceInput: "closed_route_granular_daily_snapshots_only",
  fallback: ["full", "trend_volatility", "trend", "route_overall", "unavailable"],
  minimumCompleteFeatureDays: 20,
  minimumCompletedTrades: 10,
  shrinkage: { globalK: 20, routeK: 10, regimeK: 10 },
  automaticSelection: false,
  automaticAdoption: false,
  orderInstructionConnection: false,
  compositePlansSelectable: false,
  unclassifiedSelectable: false,
});
export const ROUTE_GRANULAR_SELECTOR_CONFIG_HASH = sha256Stable(ROUTE_GRANULAR_SELECTOR_CONFIG);

type Row = { tradeDate: string; status: string; resultJson: unknown };
type Value = Record<string, unknown>;
type Lifecycle = { lifecycle: string | null; purpose: string | null };
function object(value: unknown): Value { return value && typeof value === "object" && !Array.isArray(value) ? value as Value : {}; }
function finite(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function plan(snapshot: RouteGranularDailySnapshot | null, rowId: string): RouteGranularDailyPlan | null { return snapshot?.plans.find(item => item.rowId === rowId) ?? null; }
function snapshot(row: Row): RouteGranularDailySnapshot | null { const item = object(row.resultJson); return row.status === "complete" && item.ready === true && Array.isArray(item.plans) ? item as unknown as RouteGranularDailySnapshot : null; }
function feature(row: Row, symbol: string): Value {
  const features = object(object(row.resultJson).featuresBySymbol);
  return object(features[symbol]);
}
function isLifecycleEligible(item: RouteGranularVariant, lifecycles: Record<string, Lifecycle>) {
  if (item.lifecycleRequirement === "current_candidate_ledger") return { eligible: true, reason: null };
  if (item.lifecycleRequirement !== "monitoring_candidate" || !item.strategyVersion) return { eligible: false, reason: item.unavailableReason ?? "not_selectable" };
  const observed = lifecycles[item.strategyVersion];
  const eligible = observed?.lifecycle === "monitoring" && observed?.purpose === "candidate";
  return { eligible, reason: eligible ? null : "strategy_lifecycle_not_monitoring_candidate" };
}
function planSummary(item: RouteGranularDailyPlan | null) {
  const completed = Math.max(0, Math.trunc(finite(item?.completedTrades) ?? 0));
  const signals = Math.max(0, Math.trunc(finite(item?.signals) ?? 0));
  return { completed, signals, pnl: finite(item?.pnlPer100) ?? 0, wins: finite(item?.wins) ?? 0, losses: finite(item?.losses) ?? 0, draws: finite(item?.draws) ?? 0, grossProfit: finite(item?.grossProfitPer100) ?? 0, grossLoss: finite(item?.grossLossPer100) ?? 0, openTrades: finite(item?.openTrades) ?? 0 };
}

function scoreVariant(input: { variant: RouteGranularVariant; sourceTradeDate: string; cutoffFeature: Value; featureRows: Row[]; dailyRows: Row[]; lifecycles: Record<string, Lifecycle> }) {
  const lifecycle = isLifecycleEligible(input.variant, input.lifecycles);
  if (!lifecycle.eligible) return { ...input.variant, lifecycle: "unavailable", selectable: false, exclusionReasons: [lifecycle.reason], fallbackLevel: "unavailable", eligibleDays: 0, completedTrades: 0, expectedDailyPnlPer100: null };
  if (input.cutoffFeature.featureEligible !== true || input.cutoffFeature.provenanceStatus !== "verified") return { ...input.variant, lifecycle: "eligible", selectable: false, exclusionReasons: ["feature_or_provenance_unavailable"], fallbackLevel: "unavailable", eligibleDays: 0, completedTrades: 0, expectedDailyPnlPer100: null };
  const currentRegime = object(input.cutoffFeature.regime);
  const dailyByDate = new Map(input.dailyRows.map(row => [row.tradeDate, snapshot(row)]));
  const eligibleFeatureRows = input.featureRows.filter(row => row.status === "complete" && row.tradeDate < input.sourceTradeDate);
  const history = eligibleFeatureRows.map(row => ({ date: row.tradeDate, feature: feature(row, input.variant.symbol), plan: plan(dailyByDate.get(row.tradeDate) ?? null, input.variant.rowId) }))
    .filter(item => item.feature.featureEligible === true && item.feature.provenanceStatus === "verified");
  const completedHistory = history.filter(item => planSummary(item.plan).completed > 0);
  const levels = [
    { name: "full", rows: completedHistory.filter(item => object(item.feature.regime).full === currentRegime.full) },
    { name: "trend_volatility", rows: completedHistory.filter(item => object(item.feature.regime).trend === currentRegime.trend && object(item.feature.regime).volatility === currentRegime.volatility) },
    { name: "trend", rows: completedHistory.filter(item => object(item.feature.regime).trend === currentRegime.trend) },
    { name: "route_overall", rows: completedHistory },
  ];
  const chosen = levels.find(level => level.rows.length > 0) ?? { name: "unavailable", rows: [] as typeof completedHistory };
  const groupHistory = input.dailyRows.flatMap(row => snapshot(row)?.plans ?? []).filter(item => item.routeGroupId === input.variant.routeGroupId && item.symbol === input.variant.symbol).map(planSummary);
  const globalHistory = input.dailyRows.flatMap(row => snapshot(row)?.plans ?? []).map(planSummary);
  const sum = (rows: ReturnType<typeof planSummary>[]) => ({ trades: rows.reduce((n, item) => n + item.completed, 0), pnl: rows.reduce((n, item) => n + item.pnl, 0) });
  const global = sum(globalHistory); const route = sum(groupHistory); const sample = sum(chosen.rows.map(item => planSummary(item.plan)));
  const globalMean = global.trades ? global.pnl / global.trades : 0;
  const routeMean = route.trades ? (route.pnl + 10 * globalMean) / (route.trades + 10) : null;
  const posterior = routeMean === null ? null : chosen.name === "route_overall" ? routeMean : (sample.pnl + 10 * routeMean) / (sample.trades + 10);
  const signalDays = history.filter(item => planSummary(item.plan).signals > 0).length;
  const fireRate = (signalDays + 1) / (history.length + 2);
  const expected = posterior === null ? null : posterior * fireRate;
  const reasons = [
    ...(history.length < 20 ? ["fewer_than_20_complete_feature_days"] : []),
    ...(route.trades < 10 ? ["fewer_than_10_completed_trades"] : []),
    ...(posterior === null || posterior <= 0 ? ["non_positive_posterior_pnl"] : []),
    ...(expected === null || expected <= 0 ? ["non_positive_expected_daily_pnl"] : []),
  ];
  return { ...input.variant, lifecycle: "eligible", eligibleDays: history.length, completedTrades: route.trades, signalDays, posteriorPnlPer100: posterior, expectedDailyPnlPer100: expected, fallbackLevel: chosen.name, fallbackCompletedTrades: sample.trades, exclusionReasons: reasons, selectable: reasons.length === 0 };
}

/** Pure, cutoff-filtered, routeGroup-level immutable selection. */
export function buildRouteGranularSelectorSnapshot(input: { sourceTradeDate: string; feature: Row; featureRows: Row[]; dailyRows: Row[]; lifecycles: Record<string, Lifecycle>; watermark: unknown }) {
  const featureRows = input.featureRows.filter(row => row.tradeDate <= input.sourceTradeDate);
  const dailyRows = input.dailyRows.filter(row => row.tradeDate <= input.sourceTradeDate);
  const scores = ROUTE_GRANULAR_VARIANTS.map(variant => scoreVariant({ variant, sourceTradeDate: input.sourceTradeDate, cutoffFeature: feature(input.feature, variant.symbol), featureRows, dailyRows, lifecycles: input.lifecycles }));
  const routeGroups = Array.from(new Set(ROUTE_GRANULAR_VARIANTS.map(item => `${item.symbol}:${item.routeGroupId}`))).sort();
  const selections = routeGroups.map(key => {
    const [symbol, routeGroupId] = key.split(":");
    const currentFeature = feature(input.feature, symbol);
    const candidates = scores.filter(item => item.symbol === symbol && item.routeGroupId === routeGroupId && item.selectable)
      .sort((a, b) => Number(b.expectedDailyPnlPer100) - Number(a.expectedDailyPnlPer100));
    const chosen = candidates[0] ?? null;
    return { symbol, routeGroupId, featureEligible: currentFeature.featureEligible === true && currentFeature.provenanceStatus === "verified", regime: currentFeature.regime ?? { full: "unknown" }, selectedRowId: chosen?.rowId ?? null, selectedCanonicalLogic: chosen?.canonicalLogic ?? null, selectedStrategyVersion: chosen?.strategyVersion ?? null, decision: chosen ? "reference_only" : "no_selection", reason: chosen ? "monitoring_only_positive_route_score" : currentFeature.featureEligible !== true || currentFeature.provenanceStatus !== "verified" ? "feature_or_provenance_unavailable" : "all_variants_insufficient_or_non_positive" };
  });
  const featureResult = object(input.feature.resultJson);
  return {
    component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT, selectorVersion: ROUTE_GRANULAR_SELECTOR_VERSION, configHash: ROUTE_GRANULAR_SELECTOR_CONFIG_HASH,
    immutable: true, generatedAt: new Date().toISOString(), dataCutoff: input.sourceTradeDate, sourceTradeDate: input.sourceTradeDate,
    targetDate: nextTokyoEquityTradeDate(input.sourceTradeDate), watermark: input.watermark, featureInputHash: featureResult.inputHash ?? null,
    inputHash: sha256Stable({ configHash: ROUTE_GRANULAR_SELECTOR_CONFIG_HASH, dataCutoff: input.sourceTradeDate, featureHash: featureResult.inputHash, dailyRows: dailyRows.map(row => ({ tradeDate: row.tradeDate, hash: sha256Stable(row.resultJson) })), lifecycles: input.lifecycles, watermark: input.watermark }),
    variants: ROUTE_GRANULAR_VARIANTS, scores, selections, automaticSelection: false, automaticAdoption: false, orderInstructionConnection: false, formalPerformanceUse: false,
  };
}

function outcome(item: RouteGranularDailyPlan | null) {
  const values = planSummary(item);
  return { rowId: item?.rowId ?? null, canonicalLogic: item?.canonicalLogic ?? null, strategyVersion: item?.strategyVersion ?? null, outcome: values.completed > 0 ? "observed" : values.signals === 0 ? "no_signal" : values.openTrades > 0 ? "open_trade" : "no_completed_trade", ...values };
}
function boundedHistoryStartDate(tradeDate: string) {
  const utc = new Date(`${tradeDate}T00:00:00.000Z`);
  utc.setUTCDate(utc.getUTCDate() - 90);
  const result = utc.toISOString().slice(0, 10);
  return result < ROUTE_GRANULAR_MONITORING_START_DATE ? ROUTE_GRANULAR_MONITORING_START_DATE : result;
}
export function buildRouteGranularSelectorResult(input: { tradeDate: string; selectorSnapshot: Value | null; daily: Row | null }) {
  const daily = input.daily ? snapshot(input.daily) : null;
  const selectionByKey = new Map(Array.isArray(input.selectorSnapshot?.selections) ? input.selectorSnapshot.selections.map(value => { const item = object(value); return [`${item.symbol}:${item.routeGroupId}`, item]; }) : []);
  const groups = Array.from(new Set(ROUTE_GRANULAR_VARIANTS.map(item => `${item.symbol}:${item.routeGroupId}`))).sort();
  return {
    component: ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT, selectorVersion: ROUTE_GRANULAR_SELECTOR_VERSION, tradeDate: input.tradeDate, immutable: true, snapshotFound: Boolean(input.selectorSnapshot), formalPerformanceUse: false,
    results: groups.map(key => { const [symbol, routeGroupId] = key.split(":"); const choice = selectionByKey.get(key); const rows = (daily?.plans ?? []).filter(item => item.symbol === symbol && item.routeGroupId === routeGroupId).map(outcome); return { symbol, routeGroupId, decision: choice?.decision ?? "no_selection_snapshot", selectedRowId: choice?.selectedRowId ?? null, selected: choice?.selectedRowId ? rows.find(row => row.rowId === choice.selectedRowId) ?? null : null, variants: rows }; }),
    automaticSelection: false, automaticAdoption: false, orderInstructionConnection: false,
  };
}

export async function materializeRouteGranularSelectorForSourceDate(input: { sourceTradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number; watermark: unknown }) {
  const targetDate = nextTokyoEquityTradeDate(input.sourceTradeDate);
  const existing = await getRtDailyAuditMaterialization({ component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT, version: ROUTE_GRANULAR_SELECTOR_VERSION, tradeDate: targetDate });
  if (existing) return { created: false, targetDate, result: existing.resultJson };
  const versions = Array.from(new Set(ROUTE_GRANULAR_VARIANTS.flatMap(item => item.strategyVersion ? [item.strategyVersion] : []))).filter(version => version !== "current-10-symbol-candidates-v3-low-win-routes-shadow-only");
  const fromDate = boundedHistoryStartDate(input.sourceTradeDate);
  const [cutoffFeature, featureRows, dailyRows, ...lifecycleRows] = await Promise.all([
    getRtDailyAuditMaterialization({ component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, tradeDate: input.sourceTradeDate }),
    getRtDailyAuditMaterializationsForRange({ component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, version: TEN_SYMBOL_SELECTOR_VERSION, fromDate, toDate: input.sourceTradeDate }),
    getRtDailyAuditMaterializationsForRange({ component: ROUTE_GRANULAR_MONITORING_COMPONENT, version: ROUTE_GRANULAR_MONITORING_VERSION, fromDate, toDate: input.sourceTradeDate }),
    ...versions.map(version => getRtStrategyVersion(version)),
  ]);
  if (!cutoffFeature) throw new Error("route_granular_selector_feature_missing");
  const lifecycles: Record<string, Lifecycle> = {};
  for (const item of lifecycleRows) if (item) lifecycles[item.versionId] = { lifecycle: item.status, purpose: item.evaluationPurpose };
  const result = buildRouteGranularSelectorSnapshot({ sourceTradeDate: input.sourceTradeDate, feature: cutoffFeature as unknown as Row, featureRows: featureRows as unknown as Row[], dailyRows: dailyRows as unknown as Row[], lifecycles, watermark: input.watermark });
  await upsertRtDailyAuditMaterialization({ component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT, version: ROUTE_GRANULAR_SELECTOR_VERSION, tradeDate: targetDate, status: "complete", processedThroughEngineSequence: input.processedThroughEngineSequence, sourceDecisionCount: input.sourceDecisionCount, resultJson: result, lastError: null, generatedAt: new Date() });
  return { created: true, targetDate, result };
}
export async function materializeRouteGranularSelectorResultForDate(input: { tradeDate: string; sourceDecisionCount: number; processedThroughEngineSequence: number }) {
  const existing = await getRtDailyAuditMaterialization({ component: ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT, version: ROUTE_GRANULAR_SELECTOR_VERSION, tradeDate: input.tradeDate });
  if (existing) return { created: false, result: existing.resultJson };
  const [selectorSnapshot, daily] = await Promise.all([
    getRtDailyAuditMaterialization({ component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT, version: ROUTE_GRANULAR_SELECTOR_VERSION, tradeDate: input.tradeDate }),
    getRtDailyAuditMaterialization({ component: ROUTE_GRANULAR_MONITORING_COMPONENT, version: ROUTE_GRANULAR_MONITORING_VERSION, tradeDate: input.tradeDate }),
  ]);
  const result = buildRouteGranularSelectorResult({ tradeDate: input.tradeDate, selectorSnapshot: selectorSnapshot ? object(selectorSnapshot.resultJson) : null, daily: daily as unknown as Row | null });
  await upsertRtDailyAuditMaterialization({ component: ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT, version: ROUTE_GRANULAR_SELECTOR_VERSION, tradeDate: input.tradeDate, status: "complete", processedThroughEngineSequence: input.processedThroughEngineSequence, resultJson: result, lastError: null, generatedAt: new Date() });
  return { created: true, result };
}
export async function getRouteGranularSelectorDashboard(asOfDate: string) {
  const [snapshots, results] = await Promise.all([
    getRtDailyAuditMaterializationsForRange({ component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT, version: ROUTE_GRANULAR_SELECTOR_VERSION, fromDate: ROUTE_GRANULAR_MONITORING_START_DATE, toDate: asOfDate }),
    getRtDailyAuditMaterializationsForRange({ component: ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT, version: ROUTE_GRANULAR_SELECTOR_VERSION, fromDate: ROUTE_GRANULAR_MONITORING_START_DATE, toDate: asOfDate }),
  ]);
  return { selectorVersion: ROUTE_GRANULAR_SELECTOR_VERSION, configHash: ROUTE_GRANULAR_SELECTOR_CONFIG_HASH, variants: ROUTE_GRANULAR_VARIANTS, snapshots: snapshots.filter(row => row.status === "complete").map(row => row.resultJson), results: results.filter(row => row.status === "complete").map(row => row.resultJson), dataSource: "immutable_closed_route_granular_snapshots_only", automaticSelection: false, automaticAdoption: false, orderInstructionConnection: false };
}
