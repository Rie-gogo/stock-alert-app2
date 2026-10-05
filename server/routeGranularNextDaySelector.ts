import type { RtDailyAuditMaterialization } from "../drizzle/schema";
import { getRtDailyAuditMaterialization, getRtDailyAuditMaterializationsForRange, getRtStrategyVersion, upsertRtDailyAuditMaterialization } from "./db";
import { nextTokyoEquityTradeDate } from "./kioxiaNextDaySelector";
import { ROUTE_GRANULAR_VARIANTS, type RouteGranularVariant } from "./routeGranularMonitoringRegistry";
import { ROUTE_GRANULAR_MONITORING_COMPONENT, ROUTE_GRANULAR_MONITORING_START_DATE, ROUTE_GRANULAR_MONITORING_VERSION, type RouteGranularDailyPlan, type RouteGranularDailySnapshot } from "./routeGranularMonitoringMaterializer";
import { sha256Stable } from "./runtimeIdentity";
import { TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT, TEN_SYMBOL_SELECTOR_VERSION } from "./tenSymbolNextDaySelector";
import { buildTechnicalMarketRegimeTimeline, TECHNICAL_MARKET_REGIME_VERSION, type TechnicalMarketRegime } from "./technicalMarketRegime";

export const ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT = "route_granular_next_day_selector";
export const ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT = "route_granular_next_day_selector_result";
export const ROUTE_GRANULAR_SELECTOR_VERSION = "route-granular-technical-regime-authority-v4-market-context-candidates";
export const ROUTE_GRANULAR_SELECTOR_CONFIG = Object.freeze({
  version: ROUTE_GRANULAR_SELECTOR_VERSION,
  variants: ROUTE_GRANULAR_VARIANTS,
  performanceInput: "closed_route_granular_daily_snapshots_only",
  decisionAuthority: "technical_market_regime_conditional_route_performance_manual_review",
  technicalRegimeVersion: TECHNICAL_MARKET_REGIME_VERSION,
  causalAlignment: "D-1_closed_technical_features_to_D_route_outcomes",
  aggregatePlanTrendAuthority: false,
  recentTrendAuthority: false,
  recentTrendRole: "safety_gate_and_tiebreak_only",
  fallback: ["full", "trend_volatility", "trend", "unavailable"],
  minimumCompleteFeatureDays: 20,
  minimumCompletedTrades: 10,
  minimumRegimeCompletedTrades: 3,
  recentTrend: {
    recentTradingDays: 5,
    comparisonTradingDays: 5,
    minimumCompletedTradesPerWindow: 2,
    requirePositiveRecent5Pnl: true,
    requirePositiveRecent10Pnl: true,
    blockDeteriorating: true,
    rankingMetric: "technical_regime_expected_daily_pnl_then_recent10_average_pnl",
  },
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
function featureEligible(value: Value) {
  const provenance = String(value.provenanceStatus ?? "");
  return value.featureEligible === true && (provenance === "verified" || provenance === "provenance_present");
}
function featuresBySymbol(row: Row): Record<string, unknown> {
  return object(object(row.resultJson).featuresBySymbol);
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

type RouteHistoryRow = { date: string; plan: RouteGranularDailyPlan | null };
function windowMetrics(rows: RouteHistoryRow[], requestedTradingDays: number | "all") {
  const summaries = rows.map(item => planSummary(item.plan));
  const completedTrades = summaries.reduce((sum, item) => sum + item.completed, 0);
  const wins = summaries.reduce((sum, item) => sum + item.wins, 0);
  const losses = summaries.reduce((sum, item) => sum + item.losses, 0);
  const draws = summaries.reduce((sum, item) => sum + item.draws, 0);
  const pnlPer100 = summaries.reduce((sum, item) => sum + item.pnl, 0);
  const grossProfitPer100 = summaries.reduce((sum, item) => sum + item.grossProfit, 0);
  const grossLossPer100 = summaries.reduce((sum, item) => sum + item.grossLoss, 0);
  return {
    requestedTradingDays,
    includedTradingDays: rows.length,
    fromDate: rows[0]?.date ?? null,
    toDate: rows.at(-1)?.date ?? null,
    signals: summaries.reduce((sum, item) => sum + item.signals, 0),
    completedTrades,
    wins,
    losses,
    draws,
    pnlPer100,
    winRatePct: completedTrades > 0 ? wins / completedTrades * 100 : null,
    averagePnlPerTrade: completedTrades > 0 ? pnlPer100 / completedTrades : null,
    profitFactor: grossLossPer100 > 0 ? grossProfitPer100 / grossLossPer100 : wins > 0 ? null : 0,
  };
}

function buildRouteRecentTrend(history: RouteHistoryRow[]) {
  const recent5Rows = history.slice(-5);
  const previous5Rows = history.slice(-10, -5);
  const recent5 = windowMetrics(recent5Rows, 5);
  const previous5 = windowMetrics(previous5Rows, 5);
  const recent10 = windowMetrics(history.slice(-10), 10);
  const all = windowMetrics(history, "all");
  if (recent5.includedTradingDays < 5 || previous5.includedTradingDays < 5
    || recent5.completedTrades < 2 || previous5.completedTrades < 2
    || recent5.winRatePct === null || previous5.winRatePct === null
    || recent5.averagePnlPerTrade === null || previous5.averagePnlPerTrade === null) {
    return {
      status: "insufficient" as const,
      winRateDeltaPt: null,
      averagePnlDelta: null,
      windows: { recent5, previous5, recent10, all },
    };
  }
  const winRateDeltaPt = recent5.winRatePct - previous5.winRatePct;
  const averagePnlDelta = recent5.averagePnlPerTrade - previous5.averagePnlPerTrade;
  const status = winRateDeltaPt === 0 && averagePnlDelta === 0
    ? "stable" as const
    : winRateDeltaPt >= 0 && averagePnlDelta >= 0
      ? "improving" as const
      : winRateDeltaPt <= 0 && averagePnlDelta <= 0
        ? "deteriorating" as const
        : "mixed" as const;
  return { status, winRateDeltaPt, averagePnlDelta, windows: { recent5, previous5, recent10, all } };
}

type TechnicalTimeline = Record<string, Record<string, TechnicalMarketRegime>>;

/**
 * ①〜④の市場方向で絞り込むための候補資格。
 * 通常の経路別選択器が必要とするD-1テクニカル特徴量とは独立に、
 * lifecycleと保存済みの確定済み経路成績だけから作る。
 * 少数標本はprovisionalの監視候補であり、本採用には使わない。
 */
function buildMarketContextCandidate(input: {
  variant: RouteGranularVariant;
  sourceTradeDate: string;
  dailyRows: Row[];
  lifecycles: Record<string, Lifecycle>;
  catalogComplete: boolean;
}) {
  if (!input.catalogComplete) {
    return {
      marketContextEligible: false,
      marketContextEvidenceLevel: "unavailable" as const,
      marketContextExpectedDailyPnlPer100: null,
      marketContextRecent10AveragePnlPerTrade: null,
      marketContextCompletedTrades: 0,
      marketContextRecent10CompletedTrades: 0,
      marketContextExclusionReasons: ["route_catalog_incomplete_or_unresolved"],
    };
  }
  const lifecycle = isLifecycleEligible(input.variant, input.lifecycles);
  if (!lifecycle.eligible) {
    return {
      marketContextEligible: false,
      marketContextEvidenceLevel: "unavailable" as const,
      marketContextExpectedDailyPnlPer100: null,
      marketContextRecent10AveragePnlPerTrade: null,
      marketContextCompletedTrades: 0,
      marketContextRecent10CompletedTrades: 0,
      marketContextExclusionReasons: [lifecycle.reason],
    };
  }
  const history = input.dailyRows
    .filter(row => row.tradeDate <= input.sourceTradeDate && snapshot(row) !== null)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
    .map(row => ({ date: row.tradeDate, plan: plan(snapshot(row), input.variant.rowId) }));
  const trend = buildRouteRecentTrend(history);
  const all = trend.windows.all;
  const recent10 = trend.windows.recent10;
  const expectedDailyPnlPer100 = recent10.includedTradingDays > 0
    ? recent10.pnlPer100 / recent10.includedTradingDays
    : null;
  const recent10AveragePnlPerTrade = recent10.completedTrades > 0
    ? recent10.pnlPer100 / recent10.completedTrades
    : null;
  const exclusionReasons = [
    ...(all.completedTrades < 1 ? ["no_completed_route_trade"] : []),
    ...(recent10.completedTrades < 1 ? ["no_recent10_completed_route_trade"] : []),
    ...(all.pnlPer100 <= 0 ? ["non_positive_all_route_pnl"] : []),
    ...(recent10.pnlPer100 <= 0 ? ["non_positive_recent10_route_pnl"] : []),
    ...(expectedDailyPnlPer100 === null || expectedDailyPnlPer100 <= 0 ? ["non_positive_market_context_expected_daily_pnl"] : []),
  ];
  return {
    marketContextEligible: exclusionReasons.length === 0,
    marketContextEvidenceLevel: all.completedTrades >= 10 && recent10.completedTrades >= 2
      ? "established" as const
      : "provisional" as const,
    marketContextExpectedDailyPnlPer100: expectedDailyPnlPer100,
    marketContextRecent10AveragePnlPerTrade: recent10AveragePnlPerTrade,
    marketContextCompletedTrades: all.completedTrades,
    marketContextRecent10CompletedTrades: recent10.completedTrades,
    marketContextRecent10PnlPer100: recent10.pnlPer100,
    marketContextAllPnlPer100: all.pnlPer100,
    marketContextExclusionReasons: exclusionReasons,
  };
}

function scoreVariant(input: { variant: RouteGranularVariant; sourceTradeDate: string; cutoffFeature: Value; featureRows: Row[]; dailyRows: Row[]; lifecycles: Record<string, Lifecycle>; catalogComplete: boolean; technicalTimeline: TechnicalTimeline }) {
  const marketContextCandidate = buildMarketContextCandidate(input);
  if (!input.catalogComplete) return { ...input.variant, ...marketContextCandidate, lifecycle: "unavailable", selectable: false, exclusionReasons: ["route_catalog_incomplete_or_unresolved"], fallbackLevel: "unavailable", eligibleDays: 0, completedTrades: 0, expectedDailyPnlPer100: null };
  const lifecycle = isLifecycleEligible(input.variant, input.lifecycles);
  if (!lifecycle.eligible) return { ...input.variant, ...marketContextCandidate, lifecycle: "unavailable", selectable: false, exclusionReasons: [lifecycle.reason], fallbackLevel: "unavailable", eligibleDays: 0, completedTrades: 0, expectedDailyPnlPer100: null };
  if (!featureEligible(input.cutoffFeature)) return { ...input.variant, ...marketContextCandidate, lifecycle: "eligible", selectable: false, exclusionReasons: ["feature_or_provenance_unavailable"], fallbackLevel: "unavailable", eligibleDays: 0, completedTrades: 0, expectedDailyPnlPer100: null };
  const currentRegime = input.technicalTimeline[input.sourceTradeDate]?.[input.variant.symbol];
  if (!currentRegime?.eligible) return { ...input.variant, ...marketContextCandidate, lifecycle: "eligible", selectable: false, exclusionReasons: ["technical_regime_unavailable"], fallbackLevel: "unavailable", eligibleDays: 0, completedTrades: 0, expectedDailyPnlPer100: null, technicalRegime: currentRegime ?? null };
  const dailyByDate = new Map(input.dailyRows.map(row => [row.tradeDate, snapshot(row)]));
  const featureDates = input.featureRows
    .filter(row => row.status === "complete" && row.tradeDate <= input.sourceTradeDate)
    .map(row => row.tradeDate)
    .sort();
  const eligibleFeatureRows = input.featureRows
    .filter(row => row.status === "complete" && row.tradeDate < input.sourceTradeDate && featureEligible(feature(row, input.variant.symbol)))
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  // D-1閉場後の状態は、必ず次の保存営業日Dの結果と組み合わせる。同日結果を
  // 同日引け後featureへ結びつける先読みと、欠損日を飛び越えた誤対応を禁止する。
  const history = eligibleFeatureRows.flatMap(row => {
    const featureIndex = featureDates.indexOf(row.tradeDate);
    const outcomeDate = featureIndex >= 0 ? featureDates[featureIndex + 1] : null;
    const technicalRegime = input.technicalTimeline[row.tradeDate]?.[input.variant.symbol];
    const outcomeSnapshot = outcomeDate ? dailyByDate.get(outcomeDate) ?? null : null;
    if (!outcomeDate || !outcomeSnapshot || !technicalRegime?.eligible) return [];
    return [{ featureDate: row.tradeDate, outcomeDate, technicalRegime, plan: plan(outcomeSnapshot, input.variant.rowId) }];
  });
  // Recent performance is independent of the end-of-day regime feature. It must
  // include the latest closed sourceTradeDate; otherwise every decision lags by
  // one session. Only immutable, complete route snapshots are admitted here.
  const recentTrendHistory = input.dailyRows
    .filter(row => row.tradeDate <= input.sourceTradeDate && snapshot(row) !== null)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
    .map(row => ({ date: row.tradeDate, plan: plan(snapshot(row), input.variant.rowId) }));
  const recentTrend = buildRouteRecentTrend(recentTrendHistory);
  const completedHistory = history.filter(item => planSummary(item.plan).completed > 0);
  const levels = [
    { name: "full", rows: completedHistory.filter(item => item.technicalRegime.full === currentRegime.full) },
    { name: "trend_volatility", rows: completedHistory.filter(item => item.technicalRegime.trend === currentRegime.trend && item.technicalRegime.volatility === currentRegime.volatility) },
    { name: "trend", rows: completedHistory.filter(item => item.technicalRegime.trend === currentRegime.trend) },
  ];
  const chosen = levels.find(level => level.rows.reduce((sum, item) => sum + planSummary(item.plan).completed, 0) >= ROUTE_GRANULAR_SELECTOR_CONFIG.minimumRegimeCompletedTrades)
    ?? { name: "unavailable", rows: [] as typeof completedHistory };
  const groupHistory = input.dailyRows.flatMap(row => snapshot(row)?.plans ?? []).filter(item => item.routeGroupId === input.variant.routeGroupId && item.symbol === input.variant.symbol).map(planSummary);
  const globalHistory = input.dailyRows.flatMap(row => snapshot(row)?.plans ?? []).map(planSummary);
  const sum = (rows: ReturnType<typeof planSummary>[]) => ({ trades: rows.reduce((n, item) => n + item.completed, 0), pnl: rows.reduce((n, item) => n + item.pnl, 0) });
  const global = sum(globalHistory); const route = sum(groupHistory); const sample = sum(chosen.rows.map(item => planSummary(item.plan)));
  const variant = sum(history.map(item => planSummary(item.plan)));
  const globalMean = global.trades ? global.pnl / global.trades : 0;
  const routeMean = route.trades ? (route.pnl + 10 * globalMean) / (route.trades + 10) : null;
  const posterior = routeMean === null || chosen.name === "unavailable" ? null : (sample.pnl + 10 * routeMean) / (sample.trades + 10);
  const signalDays = history.filter(item => planSummary(item.plan).signals > 0).length;
  const fireRate = (signalDays + 1) / (history.length + 2);
  const expected = posterior === null ? null : posterior * fireRate;
  const directionAllowed = input.variant.direction !== "unknown" && currentRegime.allowedDirections.includes(input.variant.direction);
  const reasons = [
    ...(history.length < 20 ? ["fewer_than_20_complete_feature_days"] : []),
    ...(variant.trades < 10 ? ["fewer_than_10_variant_completed_trades"] : []),
    ...(recentTrend.windows.recent5.completedTrades < 2 ? ["fewer_than_2_recent5_completed_trades"] : []),
    ...(recentTrend.windows.previous5.completedTrades < 2 ? ["fewer_than_2_previous5_completed_trades"] : []),
    ...(recentTrend.windows.recent5.pnlPer100 <= 0 ? ["non_positive_recent5_pnl"] : []),
    ...(recentTrend.windows.recent10.pnlPer100 <= 0 ? ["non_positive_recent10_pnl"] : []),
    ...(recentTrend.status === "deteriorating" ? ["route_recent_trend_deteriorating"] : []),
    ...(chosen.name === "unavailable" ? ["fewer_than_3_technical_regime_completed_trades"] : []),
    ...(!directionAllowed ? ["direction_conflicts_with_technical_regime"] : []),
    ...(posterior === null || posterior <= 0 ? ["non_positive_posterior_pnl"] : []),
    ...(expected === null || expected <= 0 ? ["non_positive_expected_daily_pnl"] : []),
  ];
  return {
    ...input.variant,
    ...marketContextCandidate,
    lifecycle: "eligible",
    eligibleDays: history.length,
    completedTrades: variant.trades,
    routeGroupCompletedTrades: route.trades,
    signalDays,
    recentTrend,
    recentTrendRankingPnlPerTrade: recentTrend.windows.recent10.averagePnlPerTrade,
    technicalRegime: currentRegime,
    technicalRegimeMatch: { level: chosen.name, completedTrades: sample.trades, pnlPer100: sample.pnl, featureOutcomeAlignment: "D-1_to_D" },
    posteriorPnlPer100: posterior,
    expectedDailyPnlPer100: expected,
    fallbackLevel: chosen.name,
    fallbackCompletedTrades: sample.trades,
    exclusionReasons: reasons,
    selectable: reasons.length === 0,
  };
}

/** Pure, cutoff-filtered, routeGroup-level immutable selection. */
export function buildRouteGranularSelectorSnapshot(input: { sourceTradeDate: string; feature: Row; featureRows: Row[]; dailyRows: Row[]; lifecycles: Record<string, Lifecycle>; watermark: unknown }) {
  const featureRows = input.featureRows
    .filter(row => row.tradeDate <= input.sourceTradeDate)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const dailyRows = input.dailyRows
    .filter(row => row.tradeDate <= input.sourceTradeDate)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const cutoffDaily = dailyRows.find(row => row.tradeDate === input.sourceTradeDate);
  const catalogAudit = object(cutoffDaily ? object(cutoffDaily.resultJson).catalogAudit : null);
  const catalogComplete = catalogAudit.complete === true;
  const featureByDate = new Map(featureRows.map(row => [row.tradeDate, row]));
  featureByDate.set(input.feature.tradeDate, input.feature);
  const timelineFeatureRows = Array.from(featureByDate.values())
    .filter(row => row.status === "complete" && row.tradeDate <= input.sourceTradeDate)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const timelineRows = timelineFeatureRows.map(row => ({ tradeDate: row.tradeDate, featuresBySymbol: featuresBySymbol(row) }));
  const symbols = Array.from(new Set(ROUTE_GRANULAR_VARIANTS.map(item => item.symbol))).sort();
  const technicalTimeline = buildTechnicalMarketRegimeTimeline(timelineRows, symbols);
  const scores = ROUTE_GRANULAR_VARIANTS.map(variant => scoreVariant({ variant, sourceTradeDate: input.sourceTradeDate, cutoffFeature: feature(input.feature, variant.symbol), featureRows: timelineFeatureRows, dailyRows, lifecycles: input.lifecycles, catalogComplete, technicalTimeline }));
  const routeGroups = Array.from(new Set(ROUTE_GRANULAR_VARIANTS.map(item => `${item.symbol}:${item.routeGroupId}`))).sort();
  const selections = routeGroups.map(key => {
    const [symbol, routeGroupId] = key.split(":");
    const currentFeature = feature(input.feature, symbol);
    const technicalRegime = technicalTimeline[input.sourceTradeDate]?.[symbol] ?? null;
    const candidates = scores.filter(item => item.symbol === symbol && item.routeGroupId === routeGroupId && item.selectable)
      .sort((a, b) => {
        const technicalDifference = Number(b.expectedDailyPnlPer100) - Number(a.expectedDailyPnlPer100);
        return technicalDifference !== 0 ? technicalDifference : Number((b as Value).recentTrendRankingPnlPerTrade) - Number((a as Value).recentTrendRankingPnlPerTrade);
      });
    const chosen = candidates[0] ?? null;
    return { symbol, routeGroupId, featureEligible: featureEligible(currentFeature), technicalRegime, selectedRowId: chosen?.rowId ?? null, selectedCanonicalLogic: chosen?.canonicalLogic ?? null, selectedStrategyVersion: chosen?.strategyVersion ?? null, decision: chosen ? "reference_only" : "no_selection", reason: chosen ? "technical_regime_conditional_expected_value_reference_only" : !featureEligible(currentFeature) ? "feature_or_provenance_unavailable" : "all_route_variants_insufficient_or_technically_incompatible" };
  });
  const symbolSelections = symbols.map(symbol => {
    const technicalRegime = technicalTimeline[input.sourceTradeDate]?.[symbol] ?? null;
    const candidates = scores.filter(item => item.symbol === symbol && item.selectable).sort((a, b) => {
      const technicalDifference = Number(b.expectedDailyPnlPer100) - Number(a.expectedDailyPnlPer100);
      return technicalDifference !== 0 ? technicalDifference : Number((b as Value).recentTrendRankingPnlPerTrade) - Number((a as Value).recentTrendRankingPnlPerTrade);
    });
    const chosen = candidates[0] ?? null;
    return {
      symbol,
      technicalRegime,
      selectedRowId: chosen?.rowId ?? null,
      selectedRouteGroupId: chosen?.routeGroupId ?? null,
      selectedCanonicalLogic: chosen?.canonicalLogic ?? null,
      selectedStrategyVersion: chosen?.strategyVersion ?? null,
      expectedDailyPnlPer100: chosen?.expectedDailyPnlPer100 ?? null,
      decision: chosen ? "reference_only" : "no_selection",
      reason: chosen ? "best_technical_regime_conditional_route_reference_only" : technicalRegime?.eligible ? "no_eligible_route_for_technical_regime" : "technical_regime_unavailable",
    };
  });
  const featureResult = object(input.feature.resultJson);
  return {
    component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT, selectorVersion: ROUTE_GRANULAR_SELECTOR_VERSION, configHash: ROUTE_GRANULAR_SELECTOR_CONFIG_HASH,
    immutable: true, generatedAt: new Date().toISOString(), dataCutoff: input.sourceTradeDate, sourceTradeDate: input.sourceTradeDate,
    targetDate: nextTokyoEquityTradeDate(input.sourceTradeDate), watermark: input.watermark, featureInputHash: featureResult.inputHash ?? null,
    inputHash: sha256Stable({ configHash: ROUTE_GRANULAR_SELECTOR_CONFIG_HASH, dataCutoff: input.sourceTradeDate, featureHash: featureResult.inputHash, dailyRows: dailyRows.map(row => ({ tradeDate: row.tradeDate, hash: sha256Stable(row.resultJson) })), lifecycles: input.lifecycles, watermark: input.watermark }),
    variants: ROUTE_GRANULAR_VARIANTS, scores, selections, symbolSelections, technicalRegimeTimelineVersion: TECHNICAL_MARKET_REGIME_VERSION, causalAlignment: "D-1_closed_technical_features_to_D_route_outcomes", catalogAudit: catalogAudit.complete === true ? catalogAudit : { complete: false, ...catalogAudit }, decisionAuthority: "technical_market_regime_conditional_route_performance_manual_review", aggregatePlanTrendAuthority: false, recentTrendAuthority: false, automaticSelection: false, automaticAdoption: false, orderInstructionConnection: false, formalPerformanceUse: false,
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
  const symbolSelectionBySymbol = new Map(Array.isArray(input.selectorSnapshot?.symbolSelections) ? input.selectorSnapshot.symbolSelections.map(value => { const item = object(value); return [String(item.symbol), item]; }) : []);
  const groups = Array.from(new Set(ROUTE_GRANULAR_VARIANTS.map(item => `${item.symbol}:${item.routeGroupId}`))).sort();
  const symbols = Array.from(new Set(ROUTE_GRANULAR_VARIANTS.map(item => item.symbol))).sort();
  return {
    component: ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT, selectorVersion: ROUTE_GRANULAR_SELECTOR_VERSION, tradeDate: input.tradeDate, immutable: true, snapshotFound: Boolean(input.selectorSnapshot), formalPerformanceUse: false,
    results: groups.map(key => { const [symbol, routeGroupId] = key.split(":"); const choice = selectionByKey.get(key); const rows = (daily?.plans ?? []).filter(item => item.symbol === symbol && item.routeGroupId === routeGroupId).map(outcome); return { symbol, routeGroupId, decision: choice?.decision ?? "no_selection_snapshot", selectedRowId: choice?.selectedRowId ?? null, selected: choice?.selectedRowId ? rows.find(row => row.rowId === choice.selectedRowId) ?? null : null, variants: rows }; }),
    symbolResults: symbols.map(symbol => {
      const choice = symbolSelectionBySymbol.get(symbol);
      const rows = (daily?.plans ?? []).filter(item => item.symbol === symbol).map(outcome);
      return { symbol, decision: choice?.decision ?? "no_selection_snapshot", selectedRowId: choice?.selectedRowId ?? null, selected: choice?.selectedRowId ? rows.find(row => row.rowId === choice.selectedRowId) ?? null : null, variants: rows };
    }),
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
  return { selectorVersion: ROUTE_GRANULAR_SELECTOR_VERSION, configHash: ROUTE_GRANULAR_SELECTOR_CONFIG_HASH, variants: ROUTE_GRANULAR_VARIANTS, snapshots: snapshots.filter(row => row.status === "complete").map(row => row.resultJson), results: results.filter(row => row.status === "complete").map(row => row.resultJson), dataSource: "immutable_closed_route_granular_snapshots_only", decisionAuthority: "technical_market_regime_conditional_route_performance_manual_review", aggregatePlanTrendAuthority: false, recentTrendAuthority: false, automaticSelection: false, automaticAdoption: false, orderInstructionConnection: false };
}
