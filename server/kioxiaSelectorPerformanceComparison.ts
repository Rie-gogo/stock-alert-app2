export const KIOXIA_SELECTOR_PERFORMANCE_VERSION = "285a-selector-vs-fixed-v1";

export const KIOXIA_SELECTOR_PERFORMANCE_GATE = Object.freeze({
  minimumEvaluationDays: 20,
  minimumSelectorCompletedTrades: 10,
  confidenceLevel: 0.95,
  comparisonUnit: "paired_trade_date_daily_R",
});

type DailyMetrics = {
  signalCount: number;
  openTrades: number;
  completedTrades: number;
  wins: number;
  losses: number;
  draws: number;
  totalR: number;
  grossProfitR: number;
  grossLossR: number;
  outcome: string;
};

type FixedOutcome = {
  key: string;
  label: string;
  signalQuality: DailyMetrics;
  capitalConstrained: DailyMetrics;
};

type SelectorDailyResult = {
  tradeDate: string;
  snapshotFound: boolean;
  evaluationReady?: boolean;
  selectorOutcome?: {
    key: string;
    label: string;
    signalQuality: DailyMetrics;
    capitalConstrained: DailyMetrics;
  };
  fixedRouteOutcomes?: FixedOutcome[];
  fixedPlanOutcomes?: FixedOutcome[];
};

type EvaluationMode = "signalQuality" | "capitalConstrained";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function metrics(value: unknown): DailyMetrics {
  const row = record(value);
  return {
    signalCount: finite(row.signalCount),
    openTrades: finite(row.openTrades),
    completedTrades: finite(row.completedTrades),
    wins: finite(row.wins),
    losses: finite(row.losses),
    draws: finite(row.draws),
    totalR: finite(row.totalR),
    grossProfitR: finite(row.grossProfitR),
    grossLossR: finite(row.grossLossR),
    outcome: String(row.outcome ?? "no_signal"),
  };
}

function sampleStandardDeviation(values: number[]) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function aggregateDaily(values: DailyMetrics[]) {
  const totalR = values.reduce((sum, value) => sum + value.totalR, 0);
  const grossProfitR = values.reduce((sum, value) => sum + value.grossProfitR, 0);
  const grossLossR = values.reduce((sum, value) => sum + value.grossLossR, 0);
  const completedTrades = values.reduce((sum, value) => sum + value.completedTrades, 0);
  const wins = values.reduce((sum, value) => sum + value.wins, 0);
  const losses = values.reduce((sum, value) => sum + value.losses, 0);
  const draws = values.reduce((sum, value) => sum + value.draws, 0);
  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  for (const value of values) {
    cumulativeR += value.totalR;
    peakR = Math.max(peakR, cumulativeR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);
  }
  return {
    evaluationDays: values.length,
    signalDays: values.filter(value => value.signalCount > 0).length,
    noSignalDays: values.filter(value => value.signalCount === 0).length,
    completedTrades,
    openTrades: values.reduce((sum, value) => sum + value.openTrades, 0),
    wins,
    losses,
    draws,
    winRatePct: completedTrades ? wins / completedTrades * 100 : null,
    totalR,
    meanDailyR: values.length ? totalR / values.length : null,
    averageTradeR: completedTrades ? totalR / completedTrades : null,
    profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : grossProfitR > 0 ? null : 0,
    maxDrawdownR,
  };
}

function pairedDifference(selector: DailyMetrics[], fixed: DailyMetrics[]) {
  const differences = selector.map((value, index) => value.totalR - (fixed[index]?.totalR ?? 0));
  if (!differences.length) return { days: 0, meanDailyDeltaR: null, ci95LowerR: null, ci95UpperR: null };
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const standardDeviation = sampleStandardDeviation(differences);
  if (standardDeviation === null) return { days: differences.length, meanDailyDeltaR: mean, ci95LowerR: null, ci95UpperR: null };
  const margin = 1.96 * standardDeviation / Math.sqrt(differences.length);
  return { days: differences.length, meanDailyDeltaR: mean, ci95LowerR: mean - margin, ci95UpperR: mean + margin };
}

function fixedSeries(days: SelectorDailyResult[], field: "fixedRouteOutcomes" | "fixedPlanOutcomes", mode: EvaluationMode) {
  const registry = new Map<string, { key: string; label: string }>();
  for (const day of days) {
    for (const item of day[field] ?? []) registry.set(item.key, { key: item.key, label: item.label });
  }
  return Array.from(registry.values()).map(item => ({
    ...item,
    daily: days.map(day => {
      const found = (day[field] ?? []).find(value => value.key === item.key);
      return metrics(found?.[mode]);
    }),
  }));
}

function modeComparison(days: SelectorDailyResult[], mode: EvaluationMode) {
  const selectorDaily = days.map(day => metrics(day.selectorOutcome?.[mode]));
  const selector = aggregateDaily(selectorDaily);
  const routes = fixedSeries(days, "fixedRouteOutcomes", mode).map(item => ({
    key: item.key,
    label: item.label,
    metrics: aggregateDaily(item.daily),
    pairedVsSelector: pairedDifference(selectorDaily, item.daily),
  }));
  const plans = fixedSeries(days, "fixedPlanOutcomes", mode).map(item => ({
    key: item.key,
    label: item.label,
    metrics: aggregateDaily(item.daily),
    pairedVsSelector: pairedDifference(selectorDaily, item.daily),
  }));
  const byMeanDailyR = <T extends { metrics: { meanDailyR: number | null } }>(a: T, b: T) =>
    finite(b.metrics.meanDailyR, Number.NEGATIVE_INFINITY) - finite(a.metrics.meanDailyR, Number.NEGATIVE_INFINITY);
  const bestFixedRoute = [...routes].sort(byMeanDailyR)[0] ?? null;
  const bestFixedPlan = [...plans].sort(byMeanDailyR)[0] ?? null;
  const benchmark = bestFixedPlan ?? bestFixedRoute;
  const ready = days.length >= KIOXIA_SELECTOR_PERFORMANCE_GATE.minimumEvaluationDays
    && selector.completedTrades >= KIOXIA_SELECTOR_PERFORMANCE_GATE.minimumSelectorCompletedTrades;
  const interval = benchmark?.pairedVsSelector ?? null;
  const verdict = !ready
    ? "insufficient_data"
    : interval?.ci95LowerR !== null && interval.ci95LowerR > 0
      ? "selector_outperformed_fixed"
      : interval?.ci95UpperR !== null && interval.ci95UpperR < 0
        ? "selector_underperformed_fixed"
        : "inconclusive";
  return {
    ready,
    verdict,
    remainingEvaluationDays: Math.max(0, KIOXIA_SELECTOR_PERFORMANCE_GATE.minimumEvaluationDays - days.length),
    remainingSelectorCompletedTrades: Math.max(0, KIOXIA_SELECTOR_PERFORMANCE_GATE.minimumSelectorCompletedTrades - selector.completedTrades),
    selector,
    bestFixedPlan,
    bestFixedRoute,
    fixedPlans: plans,
    fixedRoutes: routes,
  };
}

/**
 * Uses only immutable next-day results. Warm-up days are deliberately excluded;
 * once evaluationReady becomes true, no-trade days remain in the paired sample as 0R.
 */
export function buildKioxiaSelectorPerformanceComparison(rawResults: unknown[]) {
  const eligibleDays = rawResults
    .map(value => record(value) as unknown as SelectorDailyResult)
    .filter(day => day.snapshotFound === true && day.evaluationReady === true && typeof day.tradeDate === "string")
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const signalQuality = modeComparison(eligibleDays, "signalQuality");
  const capitalConstrained = modeComparison(eligibleDays, "capitalConstrained");
  const verdict = signalQuality.verdict === "selector_outperformed_fixed" && capitalConstrained.verdict === "selector_outperformed_fixed"
    ? "selector_outperformed_fixed_in_both_modes"
    : signalQuality.verdict === "selector_underperformed_fixed" || capitalConstrained.verdict === "selector_underperformed_fixed"
      ? "selector_underperformed_fixed_in_at_least_one_mode"
      : signalQuality.verdict === "insufficient_data" || capitalConstrained.verdict === "insufficient_data"
        ? "insufficient_data"
        : "inconclusive";
  return {
    evaluationVersion: KIOXIA_SELECTOR_PERFORMANCE_VERSION,
    gate: KIOXIA_SELECTOR_PERFORMANCE_GATE,
    evaluationDates: eligibleDays.map(day => day.tradeDate),
    evaluationDays: eligibleDays.length,
    verdict,
    signalQuality,
    capitalConstrained,
    formalPerformanceUse: false,
    automaticAdoption: false,
  };
}
