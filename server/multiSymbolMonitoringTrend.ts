import type { RtDailyAuditMaterialization } from "../drizzle/schema";
import {
  getClosedRtAuditTradeDates,
  getRtDailyAuditMaterializationsForRange,
} from "./db";
import {
  MULTI_SYMBOL_MONITORING_COMPONENT,
  MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
  MULTI_SYMBOL_MONITORING_START_DATE,
  type DailyMonitoringPlanSnapshot,
  type MultiSymbolMonitoringDailySnapshot,
} from "./multiSymbolMonitoringMaterializer";
import {
  MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS,
  TEN_MONITORED_SYMBOLS,
} from "./multiSymbolMonitoringRegistry";

export const MULTI_SYMBOL_MONITORING_TREND_VERSION = "monitoring-trend-10-symbols-snapshot-only-v1";

type TrendStatus = "improving" | "deteriorating" | "mixed" | "stable" | "insufficient";

export interface MultiSymbolMonitoringWindowMetrics {
  requestedTradingDays: number | "all";
  includedTradingDays: number;
  fromDate: string | null;
  toDate: string | null;
  signals: number;
  completedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  draws: number;
  winRatePct: number | null;
  pnlPer100: number;
  averagePnlPerTrade: number | null;
  profitFactor: number | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSnapshot(row: RtDailyAuditMaterialization): MultiSymbolMonitoringDailySnapshot | null {
  if (row.status !== "complete") return null;
  const value = record(row.resultJson);
  if (value.ready !== true || !Array.isArray(value.plans)) return null;
  return value as unknown as MultiSymbolMonitoringDailySnapshot;
}

function metricsForDates(input: {
  rowsByDate: Map<string, MultiSymbolMonitoringDailySnapshot>;
  planId: string;
  dates: string[];
  requestedTradingDays: number | "all";
}): MultiSymbolMonitoringWindowMetrics {
  const plans = input.dates.flatMap(date => {
    const snapshot = input.rowsByDate.get(date);
    return snapshot?.plans.filter(plan => plan.planId === input.planId) ?? [];
  });
  const signals = plans.reduce((sum, plan) => sum + finite(plan.signals), 0);
  const completedTrades = plans.reduce((sum, plan) => sum + finite(plan.completedTrades), 0);
  const wins = plans.reduce((sum, plan) => sum + finite(plan.wins), 0);
  const losses = plans.reduce((sum, plan) => sum + finite(plan.losses), 0);
  const draws = plans.reduce((sum, plan) => sum + finite(plan.draws), 0);
  const pnlPer100 = plans.reduce((sum, plan) => sum + finite(plan.pnlPer100), 0);
  const grossProfit = plans.reduce((sum, plan) => sum + finite(plan.grossProfitPer100), 0);
  const grossLoss = plans.reduce((sum, plan) => sum + finite(plan.grossLossPer100), 0);
  return {
    requestedTradingDays: input.requestedTradingDays,
    includedTradingDays: input.dates.length,
    fromDate: input.dates[0] ?? null,
    toDate: input.dates.at(-1) ?? null,
    signals,
    completedTrades,
    openTrades: plans.reduce((sum, plan) => sum + finite(plan.openTrades), 0),
    wins,
    losses,
    draws,
    winRatePct: completedTrades > 0 ? wins / completedTrades * 100 : null,
    pnlPer100,
    averagePnlPerTrade: completedTrades > 0 ? pnlPer100 / completedTrades : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : wins > 0 ? null : 0,
  };
}

function compareFiveDayWindows(
  recent: MultiSymbolMonitoringWindowMetrics,
  previous: MultiSymbolMonitoringWindowMetrics,
) {
  if (recent.includedTradingDays < 5 || previous.includedTradingDays < 5
    || recent.completedTrades < 2 || previous.completedTrades < 2
    || recent.winRatePct === null || previous.winRatePct === null
    || recent.averagePnlPerTrade === null || previous.averagePnlPerTrade === null) {
    return {
      status: "insufficient" as TrendStatus,
      recentWinRateDeltaPt: null,
      recentAveragePnlDelta: null,
      reason: "直近5日と前5日の両方で2件以上の決済が必要",
    };
  }
  const winDelta = recent.winRatePct - previous.winRatePct;
  const averageDelta = recent.averagePnlPerTrade - previous.averagePnlPerTrade;
  const status: TrendStatus = winDelta === 0 && averageDelta === 0
    ? "stable"
    : winDelta >= 0 && averageDelta >= 0
      ? "improving"
      : winDelta <= 0 && averageDelta <= 0
        ? "deteriorating"
        : "mixed";
  return {
    status,
    recentWinRateDeltaPt: winDelta,
    recentAveragePnlDelta: averageDelta,
    reason: "勝率と1取引平均損益を直近5日対前5日で比較",
  };
}

export function buildMultiSymbolMonitoringTrend(input: {
  asOfDate: string;
  closedTradeDates: string[];
  materializations: RtDailyAuditMaterialization[];
}) {
  const closedDates = Array.from(new Set(input.closedTradeDates))
    .filter(date => date >= MULTI_SYMBOL_MONITORING_START_DATE && date <= input.asOfDate)
    .sort();
  const rowsByDate = new Map<string, MultiSymbolMonitoringDailySnapshot>();
  for (const row of input.materializations) {
    const parsed = parseSnapshot(row);
    if (parsed && closedDates.includes(row.tradeDate)) rowsByDate.set(row.tradeDate, parsed);
  }
  const eligibleTradeDates = closedDates.filter(date => rowsByDate.has(date));
  const pendingClosedTradeDates = closedDates.filter(date => !rowsByDate.has(date));
  const lastDates = (count: number) => eligibleTradeDates.slice(-count);
  const previousFiveDates = eligibleTradeDates.slice(-10, -5);

  const planResults = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.map(definition => {
    const recent5 = metricsForDates({ rowsByDate, planId: definition.planId, dates: lastDates(5), requestedTradingDays: 5 });
    const previous5 = metricsForDates({ rowsByDate, planId: definition.planId, dates: previousFiveDates, requestedTradingDays: 5 });
    const recent10 = metricsForDates({ rowsByDate, planId: definition.planId, dates: lastDates(10), requestedTradingDays: 10 });
    const recent20 = metricsForDates({ rowsByDate, planId: definition.planId, dates: lastDates(20), requestedTradingDays: 20 });
    const all = metricsForDates({ rowsByDate, planId: definition.planId, dates: eligibleTradeDates, requestedTradingDays: "all" });
    return {
      ...definition,
      trend: compareFiveDayWindows(recent5, previous5),
      windows: { recent5, previous5, recent10, recent20, all },
      reviewStatus: eligibleTradeDates.length >= 20 && all.completedTrades >= 10
        ? "four_weeks_ten_trades_manual_review" as const
        : "preliminary" as const,
    };
  });

  return {
    managementVersion: MULTI_SYMBOL_MONITORING_TREND_VERSION,
    materializationVersion: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
    asOfDate: input.asOfDate,
    monitoringStartDate: MULTI_SYMBOL_MONITORING_START_DATE,
    eligibleTradeDates,
    pendingClosedTradeDates,
    latestCompletedTradeDate: eligibleTradeDates.at(-1) ?? null,
    automaticAdoption: false,
    automaticStopping: false,
    intradayExecutionChanged: false,
    dataSource: "closed_daily_materializations_only" as const,
    symbols: TEN_MONITORED_SYMBOLS.map(symbol => ({
      symbol,
      plans: planResults.filter(plan => plan.symbol === symbol),
    })),
  };
}

export async function getMultiSymbolMonitoringTrend(asOfDate: string) {
  const [closedTradeDates, materializations] = await Promise.all([
    getClosedRtAuditTradeDates({ fromDate: MULTI_SYMBOL_MONITORING_START_DATE, toDate: asOfDate }),
    getRtDailyAuditMaterializationsForRange({
      component: MULTI_SYMBOL_MONITORING_COMPONENT,
      version: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
      fromDate: MULTI_SYMBOL_MONITORING_START_DATE,
      toDate: asOfDate,
    }),
  ]);
  return buildMultiSymbolMonitoringTrend({ asOfDate, closedTradeDates, materializations });
}
