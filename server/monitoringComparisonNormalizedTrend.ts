import type { RtDailyAuditMaterialization } from "../drizzle/schema";
import { getClosedRtAuditTradeDates, getRtDailyAuditMaterializationsForRange } from "./db";
import {
  KIOXIA_MONITORING_START_DATE,
  type MonitoringWindowMetrics,
} from "./monitoringComparisonTrend";
import {
  MONITORING_COMPARISON_COMPONENT,
  MONITORING_COMPARISON_MATERIALIZATION_VERSION,
  type MonitoringComparisonMaterializedEntry,
} from "./monitoringComparisonMaterializer";

export const KIOXIA_NORMALIZED_COMPARISON_TREND_VERSION = "285a-route-normalized-snapshot-trend-v1";

type TableKind = "intrinsic" | "normalized" | "entryQuality";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEntries(row: RtDailyAuditMaterialization): MonitoringComparisonMaterializedEntry[] {
  if (row.status !== "complete") return [];
  const value = record(row.resultJson);
  if (value.materializationVersion !== MONITORING_COMPARISON_MATERIALIZATION_VERSION) return [];
  const entries = value.entries;
  return Array.isArray(entries) ? entries as MonitoringComparisonMaterializedEntry[] : [];
}

function metricsFor(input: {
  rows: MonitoringComparisonMaterializedEntry[];
  dates: string[];
  kind: TableKind;
  requestedTradingDays: number | "all";
}): MonitoringWindowMetrics & { filled: number; unfillable: number; candidates: number; rejected: number; marginBlocked: number; accepted: number; open: number } {
  const dateSet = new Set(input.dates);
  const rows = input.rows.filter(row => dateSet.has(row.tradeDate));
  const candidates = rows.filter(row => row.sourceDisposition !== "shadow_only").length;
  const rejected = rows.filter(row => row.sourceDisposition === "rejected").length;
  const accepted = rows.filter(row => row.sourceDisposition === "accepted").length;
  const marginBlocked = rows.filter(row => row.sourceDisposition === "margin_block").length;
  const values = input.kind === "intrinsic"
    ? rows.map(row => ({ pnl: row.intrinsic.pnlPer100, completed: row.intrinsic.completed, status: row.intrinsic.status }))
    : input.kind === "normalized"
      ? rows.map(row => ({ pnl: row.normalized.pnlPer100, completed: row.normalized.status === "filled", status: row.normalized.status }))
      : [];
  const completed = values.filter(value => value.completed && value.pnl !== null);
  const pnl = completed.map(value => value.pnl!);
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
    signals: candidates,
    openedTrades: values.filter(value => value.status !== "not_applicable" && value.status !== "not_linked").length,
    completedTrades: completed.length,
    openTrades: values.filter(value => value.status === "open").length,
    wins: wins.length,
    losses: losses.length,
    draws: draws.length,
    winRatePct: completed.length ? wins.length / completed.length * 100 : null,
    pnlPer100: totalPnl,
    averagePnlPerTrade: completed.length ? totalPnl / completed.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : wins.length ? null : 0,
    maxDrawdown,
    sampleStatus: completed.length === 0 ? "no_trades" : completed.length < 10 ? "preliminary" : "ten_or_more",
    filled: input.kind === "normalized" ? rows.filter(row => row.normalized.status === "filled").length : completed.length,
    unfillable: input.kind === "normalized" ? rows.filter(row => row.normalized.status === "unfillable_entry" || row.normalized.status === "unfillable_exit").length : 0,
    candidates,
    rejected,
    marginBlocked,
    accepted,
    open: values.filter(value => value.status === "open").length,
  };
}

function entryQualityFor(input: { rows: MonitoringComparisonMaterializedEntry[]; dates: string[] }) {
  const dateSet = new Set(input.dates);
  const labels = input.rows.filter(row => dateSet.has(row.tradeDate)).flatMap(row => {
    const quality = record(row.entryQuality);
    const raw = record(quality.labels);
    return Object.entries(raw).map(([minutes, value]) => ({ minutes, value: record(value) }));
  });
  const result: Record<string, { available: number; avgMfePct: number | null; avgMaePct: number | null; avgReturnPct: number | null }> = {};
  for (const minutes of ["1", "3", "5", "10", "15", "30", "45"]) {
    const rows = labels.filter(label => label.minutes === minutes && label.value.status === "available");
    const average = (field: string) => {
      const values = rows.map(row => finite(row.value[field])).filter((value): value is number => value !== null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    result[minutes] = { available: rows.length, avgMfePct: average("mfePct"), avgMaePct: average("maePct"), avgReturnPct: average("fixedReturnPct") };
  }
  return result;
}

export function buildKioxiaNormalizedComparisonTrend(input: {
  asOfDate: string;
  closedTradeDates: string[];
  materializations: RtDailyAuditMaterialization[];
}) {
  const closedDates = Array.from(new Set(input.closedTradeDates))
    .filter(date => date >= KIOXIA_MONITORING_START_DATE && date <= input.asOfDate)
    .sort();
  const entriesByDate = new Map<string, MonitoringComparisonMaterializedEntry[]>();
  for (const row of input.materializations) {
    const entries = parseEntries(row);
    if (entries.length || (row.status === "complete" && closedDates.includes(row.tradeDate))) entriesByDate.set(row.tradeDate, entries);
  }
  const eligibleTradeDates = closedDates.filter(date => entriesByDate.has(date));
  const pendingClosedTradeDates = closedDates.filter(date => !entriesByDate.has(date));
  const rows = eligibleTradeDates.flatMap(date => entriesByDate.get(date) ?? [])
    .filter(row => row.symbol === "285A" && row.includeInRouteComparison);
  const plans = Array.from(new Set(rows.map(row => `${row.origin}:${row.strategyVersion}:${row.routeId}:${row.side}`))).sort().map(key => {
    const planRows = rows.filter(row => `${row.origin}:${row.strategyVersion}:${row.routeId}:${row.side}` === key);
    const lastDates = (count: number) => eligibleTradeDates.slice(-count);
    const windows = (kind: TableKind) => ({
      recent5: metricsFor({ rows: planRows, dates: lastDates(5), kind, requestedTradingDays: 5 }),
      recent10: metricsFor({ rows: planRows, dates: lastDates(10), kind, requestedTradingDays: 10 }),
      recent20: metricsFor({ rows: planRows, dates: lastDates(20), kind, requestedTradingDays: 20 }),
      all: metricsFor({ rows: planRows, dates: eligibleTradeDates, kind, requestedTradingDays: "all" }),
    });
    return {
      origin: planRows[0]!.origin,
      strategyVersion: planRows[0]!.strategyVersion,
      routeId: planRows[0]!.routeId,
      side: planRows[0]!.side,
      sourceDispositionTotals: {
        accepted: planRows.filter(row => row.sourceDisposition === "accepted").length,
        marginBlock: planRows.filter(row => row.sourceDisposition === "margin_block").length,
        shadowOnly: planRows.filter(row => row.sourceDisposition === "shadow_only").length,
        entry: planRows.filter(row => row.sourceDisposition === "entry").length,
        rejected: planRows.filter(row => row.sourceDisposition === "rejected").length,
        entryConditionRejected: planRows.filter(row => row.rejectionStage === "entry_condition_rejected").length,
        routeEnded: planRows.filter(row => row.rejectionStage === "route_ended").length,
      },
      intrinsic: windows("intrinsic"),
      normalized: windows("normalized"),
      entryQuality: entryQualityFor({ rows: planRows, dates: eligibleTradeDates }),
      reviewStatus: eligibleTradeDates.length >= 20 && windows("normalized").all.completedTrades >= 10
        ? "four_weeks_ten_trades_manual_review" as const
        : "preliminary" as const,
    };
  });
  return {
    managementVersion: KIOXIA_NORMALIZED_COMPARISON_TREND_VERSION,
    materializationVersion: MONITORING_COMPARISON_MATERIALIZATION_VERSION,
    asOfDate: input.asOfDate,
    monitoringStartDate: KIOXIA_MONITORING_START_DATE,
    eligibleTradeDates,
    pendingClosedTradeDates,
    dataSource: "closed_daily_materializations_only" as const,
    automaticSelection: false,
    automaticStopping: false,
    automaticAdoption: false,
    entryQualityDisclosure: "MFE_MAE_and_fixed_horizon_labels_are_diagnostic_only",
    plans,
  };
}

export async function getKioxiaNormalizedComparisonTrend(asOfDate: string) {
  const [closedTradeDates, materializations] = await Promise.all([
    getClosedRtAuditTradeDates({ fromDate: KIOXIA_MONITORING_START_DATE, toDate: asOfDate }),
    getRtDailyAuditMaterializationsForRange({
      component: MONITORING_COMPARISON_COMPONENT,
      version: MONITORING_COMPARISON_MATERIALIZATION_VERSION,
      fromDate: KIOXIA_MONITORING_START_DATE,
      toDate: asOfDate,
    }),
  ]);
  return buildKioxiaNormalizedComparisonTrend({ asOfDate, closedTradeDates, materializations });
}
