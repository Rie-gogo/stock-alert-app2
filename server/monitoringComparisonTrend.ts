import type {
  RtDailyAuditMaterialization,
  RtForwardShadowTrade,
  RtSignalCandidate,
  RtSignalCandidateTrade,
} from "../drizzle/schema";
import {
  getClosedRtAuditTradeDates,
  getRtDailyAuditMaterializationsForRange,
  getRtForwardShadowTrades,
  getRtSignalCandidatesForDateRange,
  getRtSignalCandidateTradesForDateRange,
} from "./db";
import {
  CURRENT_SIGNAL_CANDIDATE_VERSION,
  CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
} from "./currentSignalCandidateRegistry";
import {
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
} from "./runtimeIdentity";
import { PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE } from "./pausedCurrentRouteShadow";
import {
  MONITORING_COMPARISON_COMPONENT,
  MONITORING_COMPARISON_MATERIALIZATION_VERSION,
} from "./monitoringComparisonMaterializer";

export const KIOXIA_MONITORING_TREND_VERSION = "285a-current-shadow-rolling-trend-v1";
export const KIOXIA_MONITORING_START_DATE = PAUSED_CURRENT_ROUTE_SHADOW_EFFECTIVE_DATE;

type PlanId = "current_285a" | "shadow_a_confirmed_long" | "shadow_b_atr_routes";
type TrendStatus = "improving" | "deteriorating" | "mixed" | "stable" | "insufficient";

interface NormalizedTrade {
  tradeDate: string;
  pnlPer100: number | null;
  completed: boolean;
}

interface PlanInput {
  planId: PlanId;
  label: string;
  origin: "current" | "forward_shadow";
  strategyVersion: string;
  trades: NormalizedTrade[];
}

export interface MonitoringWindowMetrics {
  requestedTradingDays: number | "all";
  includedTradingDays: number;
  fromDate: string | null;
  toDate: string | null;
  signals: number;
  openedTrades: number;
  completedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  draws: number;
  winRatePct: number | null;
  pnlPer100: number;
  averagePnlPerTrade: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  sampleStatus: "no_trades" | "preliminary" | "ten_or_more";
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePer100(pnl: unknown, shares: unknown): number | null {
  const value = finite(pnl);
  const quantity = finite(shares);
  if (value === null || quantity === null || quantity <= 0) return null;
  return Math.round(value / quantity * 100 * 1_000_000) / 1_000_000;
}

function metricsForDates(input: {
  trades: NormalizedTrade[];
  signalDates: string[];
  dates: string[];
  requestedTradingDays: number | "all";
}): MonitoringWindowMetrics {
  const dateSet = new Set(input.dates);
  const trades = input.trades.filter(trade => dateSet.has(trade.tradeDate));
  const completed = trades.filter(trade => trade.completed && trade.pnlPer100 !== null);
  const pnl = completed.map(trade => trade.pnlPer100!);
  const wins = pnl.filter(value => value > 0);
  const losses = pnl.filter(value => value < 0);
  const draws = pnl.filter(value => value === 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of pnl) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  const totalPnl = pnl.reduce((sum, value) => sum + value, 0);
  return {
    requestedTradingDays: input.requestedTradingDays,
    includedTradingDays: input.dates.length,
    fromDate: input.dates[0] ?? null,
    toDate: input.dates.at(-1) ?? null,
    signals: input.signalDates.filter(date => dateSet.has(date)).length,
    openedTrades: trades.length,
    completedTrades: completed.length,
    openTrades: trades.length - completed.length,
    wins: wins.length,
    losses: losses.length,
    draws: draws.length,
    winRatePct: completed.length > 0 ? wins.length / completed.length * 100 : null,
    pnlPer100: totalPnl,
    averagePnlPerTrade: completed.length > 0 ? totalPnl / completed.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? null : 0,
    maxDrawdown,
    sampleStatus: completed.length === 0 ? "no_trades" : completed.length < 10 ? "preliminary" : "ten_or_more",
  };
}

function compareFiveDayWindows(recent: MonitoringWindowMetrics, previous: MonitoringWindowMetrics): {
  status: TrendStatus;
  recentWinRateDeltaPt: number | null;
  recentAveragePnlDelta: number | null;
  reason: string;
} {
  if (recent.includedTradingDays < 5 || previous.includedTradingDays < 5
    || recent.completedTrades < 2 || previous.completedTrades < 2
    || recent.winRatePct === null || previous.winRatePct === null
    || recent.averagePnlPerTrade === null || previous.averagePnlPerTrade === null) {
    return {
      status: "insufficient",
      recentWinRateDeltaPt: null,
      recentAveragePnlDelta: null,
      reason: "直近5日とその前5日の両方で2件以上の決済が必要",
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
    reason: "直近5日とその前5日の勝率・1取引平均損益を同時比較",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function strictEntryMetrics(input: {
  materializations: RtDailyAuditMaterialization[];
  strategyVersion: string;
  origin: "current_baseline" | "forward_shadow";
  dates: string[];
}) {
  const dateSet = new Set(input.dates);
  const entries = input.materializations.flatMap(row => {
    if (row.status !== "complete" || !dateSet.has(row.tradeDate)) return [];
    const value = record(row.resultJson).entries;
    return Array.isArray(value) ? value.map(record) : [];
  }).filter(entry => entry.strategyVersion === input.strategyVersion
    && entry.origin === input.origin
    && (input.origin !== "current_baseline" || entry.sourceDisposition !== "shadow_only"));
  const filled = entries.filter(entry => record(entry.resolution).status === "filled").length;
  const unfillable = entries.filter(entry => record(entry.resolution).status === "unfillable").length;
  const gaps = entries.map(entry => finite(entry.adverseEntryGapPct)).filter((value): value is number => value !== null);
  return {
    signals: entries.length,
    filled,
    unfillable,
    fillRatePct: entries.length > 0 ? filled / entries.length * 100 : null,
    averageAdverseEntryGapPct: gaps.length > 0 ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null,
  };
}

export function buildKioxiaMonitoringTrend(input: {
  asOfDate: string;
  eligibleTradeDates: string[];
  candidates: RtSignalCandidate[];
  candidateTrades: RtSignalCandidateTrade[];
  shadowATrades: RtForwardShadowTrade[];
  shadowBTrades: RtForwardShadowTrade[];
  comparisonMaterializations: RtDailyAuditMaterialization[];
}) {
  const eligibleTradeDates = Array.from(new Set(input.eligibleTradeDates))
    .filter(date => date >= KIOXIA_MONITORING_START_DATE && date <= input.asOfDate)
    .sort();
  const eligibleSet = new Set(eligibleTradeDates);
  const candidateTradeById = new Map(input.candidateTrades.map(trade => [trade.candidateId, trade]));
  const activeCandidates = input.candidates.filter(candidate => candidate.symbol === "285A"
    && candidate.realtimeDecision !== "shadow_only"
    && eligibleSet.has(candidate.tradeDate));
  const currentTrades = activeCandidates.flatMap(candidate => {
    const trade = candidateTradeById.get(candidate.id);
    if (!trade) return [];
    return [{
      tradeDate: trade.tradeDate,
      pnlPer100: normalizePer100(trade.pnl, trade.shares),
      completed: trade.completed,
    }];
  });
  const normalizeShadow = (trades: RtForwardShadowTrade[]) => trades
    .filter(trade => trade.symbol === "285A"
      && trade.evaluationMode === "signal_quality"
      && eligibleSet.has(trade.entryTradeDate))
    .map(trade => ({
      tradeDate: trade.entryTradeDate,
      pnlPer100: normalizePer100(trade.pnl, trade.shares),
      completed: trade.pnl !== null && trade.exitTradeDate !== null,
    }));

  const plans: PlanInput[] = [
    {
      planId: "current_285a",
      label: "現行285A（稼働経路・証拠金ブロック含む）",
      origin: "current",
      strategyVersion: `baseline:${CURRENT_SIGNAL_CANDIDATE_VERSION}`,
      trades: currentTrades,
    },
    {
      planId: "shadow_a_confirmed_long",
      label: "A案：確認型前場LONG・MA8失速保護",
      origin: "forward_shadow",
      strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
      trades: normalizeShadow(input.shadowATrades),
    },
    {
      planId: "shadow_b_atr_routes",
      label: "B案：現行5経路・ATR0.36%",
      origin: "forward_shadow",
      strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
      trades: normalizeShadow(input.shadowBTrades),
    },
  ];
  const lastDates = (count: number) => eligibleTradeDates.slice(-count);
  const previousFiveDates = eligibleTradeDates.slice(-10, -5);
  const result = plans.map(plan => {
    const signalDates = plan.planId === "current_285a"
      ? activeCandidates.map(candidate => candidate.tradeDate)
      : plan.trades.map(trade => trade.tradeDate);
    const recent5 = metricsForDates({ trades: plan.trades, signalDates, dates: lastDates(5), requestedTradingDays: 5 });
    const previous5 = metricsForDates({ trades: plan.trades, signalDates, dates: previousFiveDates, requestedTradingDays: 5 });
    const recent10 = metricsForDates({ trades: plan.trades, signalDates, dates: lastDates(10), requestedTradingDays: 10 });
    const recent20 = metricsForDates({ trades: plan.trades, signalDates, dates: lastDates(20), requestedTradingDays: 20 });
    const all = metricsForDates({ trades: plan.trades, signalDates, dates: eligibleTradeDates, requestedTradingDays: "all" });
    return {
      planId: plan.planId,
      label: plan.label,
      origin: plan.origin,
      strategyVersion: plan.strategyVersion,
      trend: compareFiveDayWindows(recent5, previous5),
      windows: { recent5, previous5, recent10, recent20, all },
      strictExecution: {
        recent5: strictEntryMetrics({
          materializations: input.comparisonMaterializations,
          strategyVersion: plan.strategyVersion,
          origin: plan.origin === "current" ? "current_baseline" : "forward_shadow",
          dates: lastDates(5),
        }),
        all: strictEntryMetrics({
          materializations: input.comparisonMaterializations,
          strategyVersion: plan.strategyVersion,
          origin: plan.origin === "current" ? "current_baseline" : "forward_shadow",
          dates: eligibleTradeDates,
        }),
      },
    };
  });
  result.sort((left, right) =>
    (right.windows.recent10.winRatePct ?? -1) - (left.windows.recent10.winRatePct ?? -1)
    || right.windows.recent10.pnlPer100 - left.windows.recent10.pnlPer100
    || left.planId.localeCompare(right.planId));
  return {
    managementVersion: KIOXIA_MONITORING_TREND_VERSION,
    asOfDate: input.asOfDate,
    monitoringStartDate: KIOXIA_MONITORING_START_DATE,
    eligibleTradeDates,
    excludedOpenOrIncompleteDates: true,
    rankingBasis: "recent10_win_rate_then_pnl",
    automaticAdoption: false,
    existingTradingAndShadowExecutionChanged: false,
    outcomeBasis: "saved_signal_quality_trade_outcomes_normalized_to_100_shares",
    strictExecutionBasis: MONITORING_COMPARISON_MATERIALIZATION_VERSION,
    plans: result,
  };
}

export async function getKioxiaMonitoringTrend(asOfDate: string) {
  const fromDate = KIOXIA_MONITORING_START_DATE;
  const [
    eligibleTradeDates,
    candidates,
    candidateTrades,
    shadowATrades,
    shadowBTrades,
    comparisonMaterializations,
  ] = await Promise.all([
    getClosedRtAuditTradeDates({ fromDate, toDate: asOfDate }),
    getRtSignalCandidatesForDateRange({
      candidateVersion: CURRENT_SIGNAL_CANDIDATE_VERSION,
      fromDate,
      toDate: asOfDate,
    }),
    getRtSignalCandidateTradesForDateRange({
      virtualEngineVersion: CURRENT_SIGNAL_VIRTUAL_ENGINE_VERSION,
      fromDate,
      toDate: asOfDate,
    }),
    getRtForwardShadowTrades(KIOXIA_FORWARD_STRATEGY_VERSION),
    getRtForwardShadowTrades(KIOXIA_ATR_FORWARD_STRATEGY_VERSION),
    getRtDailyAuditMaterializationsForRange({
      component: MONITORING_COMPARISON_COMPONENT,
      version: MONITORING_COMPARISON_MATERIALIZATION_VERSION,
      fromDate,
      toDate: asOfDate,
    }),
  ]);
  return buildKioxiaMonitoringTrend({
    asOfDate,
    eligibleTradeDates,
    candidates,
    candidateTrades,
    shadowATrades,
    shadowBTrades,
    comparisonMaterializations,
  });
}
