import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { rtForwardShadowEvents, rtRealtimeDecisionEvents, rtShadowDispatchQueue, rtSourceEvents } from "../drizzle/schema";
import {
  BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V2_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V4_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V2_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V2_VERSIONS,
} from "./runtimeIdentity";

const FIXED_SESSION_MINUTES = [
  ...Array.from({ length: 150 }, (_, index) => 9 * 60 + index),
  ...Array.from({ length: 175 }, (_, index) => 12 * 60 + 30 + index),
];
const BOLLINGER_SYMBOLS = ["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"];
const ACTIVE_BOLLINGER_STRATEGY_VERSIONS = [
  ...Object.values(BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS),
  ...Object.values(BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V4_VERSIONS),
  ...Object.values(BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V2_VERSIONS),
  ...Object.values(BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V2_VERSIONS),
  ...Object.values(BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V2_VERSIONS),
] as string[];

function minuteToClock(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function validTime(value: string) {
  return /^\d{2}:\d{2}$/.test(value);
}

function parseActions(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const root = value as Record<string, unknown>;
  if (Array.isArray(root.actions)) return root.actions.filter(item => item && typeof item === "object") as Array<Record<string, unknown>>;
  if (root.decision && typeof root.decision === "object" && Array.isArray((root.decision as Record<string, unknown>).actions)) {
    return (root.decision as Record<string, unknown>).actions as Array<Record<string, unknown>>;
  }
  return [];
}

export async function getRelayBollingerDiagnosticsSnapshot(tradeDate: string) {
  const db = await getDb();
  if (!db) {
    return { available: false as const, tradeDate, reason: "database_unavailable" as const };
  }

  const [sources, decisions, queueRows, shadowRows, rejectedShadowRows, variantModeAggregateRows] = await Promise.all([
    db.select({
      symbol: rtSourceEvents.symbol,
      candleTime: rtSourceEvents.candleTime,
      sourceEventId: rtSourceEvents.sourceEventId,
      relayReceivedAtMs: rtSourceEvents.relayReceivedAtMs,
      cloudReceivedAtMs: rtSourceEvents.cloudReceivedAtMs,
      status: rtSourceEvents.status,
    }).from(rtSourceEvents).where(and(
      eq(rtSourceEvents.tradeDate, tradeDate),
      inArray(rtSourceEvents.symbol, BOLLINGER_SYMBOLS),
    )),
    db.select({
      resultType: rtRealtimeDecisionEvents.resultType,
    }).from(rtRealtimeDecisionEvents).where(eq(rtRealtimeDecisionEvents.tradeDate, tradeDate)),
    db.select({
      status: rtShadowDispatchQueue.status,
      attemptCount: rtShadowDispatchQueue.attemptCount,
      lastError: rtShadowDispatchQueue.lastError,
    }).from(rtShadowDispatchQueue).where(eq(rtShadowDispatchQueue.tradeDate, tradeDate)),
    db.select({
      strategyVersion: rtForwardShadowEvents.strategyVersion,
      evaluationMode: rtForwardShadowEvents.evaluationMode,
      resultType: rtForwardShadowEvents.resultType,
      lastError: rtForwardShadowEvents.lastError,
    }).from(rtForwardShadowEvents).where(and(
      eq(rtForwardShadowEvents.tradeDate, tradeDate),
      inArray(rtForwardShadowEvents.strategyVersion, ACTIVE_BOLLINGER_STRATEGY_VERSIONS),
    )),
    db.select({ decisionJson: rtForwardShadowEvents.decisionJson }).from(rtForwardShadowEvents).where(and(
      eq(rtForwardShadowEvents.tradeDate, tradeDate),
      eq(rtForwardShadowEvents.resultType, "rejected"),
      inArray(rtForwardShadowEvents.strategyVersion, ACTIVE_BOLLINGER_STRATEGY_VERSIONS),
    )),
    db.select({
      strategyVersion: rtForwardShadowEvents.strategyVersion,
      evaluationMode: rtForwardShadowEvents.evaluationMode,
      processedNoSignal: sql<number>`sum(case when ${rtForwardShadowEvents.resultType} = 'no_signal'
        and JSON_SEARCH(${rtForwardShadowEvents.decisionJson}, 'one', '%five_minute_sma_unavailable%') is null then 1 else 0 end)`,
      blockedFiveMinuteSma: sql<number>`sum(case when JSON_SEARCH(${rtForwardShadowEvents.decisionJson}, 'one', '%five_minute_sma_unavailable%') is not null then 1 else 0 end)`,
      blockedSmaSlope: sql<number>`sum(case when JSON_SEARCH(${rtForwardShadowEvents.decisionJson}, 'one', '%sma20_slope_%') is not null then 1 else 0 end)`,
      blockedBollingerWidth: sql<number>`sum(case when JSON_SEARCH(${rtForwardShadowEvents.decisionJson}, 'one', '%bollinger_width_%') is not null then 1 else 0 end)`,
      pendingNextCandle: sql<number>`sum(case when ${rtForwardShadowEvents.resultType} = 'pending' then 1 else 0 end)`,
      rejectedBoard: sql<number>`sum(case when ${rtForwardShadowEvents.resultType} = 'rejected'
        and (JSON_SEARCH(${rtForwardShadowEvents.decisionJson}, 'one', 'board_%') is not null
          or JSON_SEARCH(${rtForwardShadowEvents.decisionJson}, 'one', '%depth%') is not null) then 1 else 0 end)`,
      rejectedOther: sql<number>`sum(case when ${rtForwardShadowEvents.resultType} = 'rejected'
        and not (JSON_SEARCH(${rtForwardShadowEvents.decisionJson}, 'one', 'board_%') is not null
          or JSON_SEARCH(${rtForwardShadowEvents.decisionJson}, 'one', '%depth%') is not null) then 1 else 0 end)`,
      entry: sql<number>`sum(case when ${rtForwardShadowEvents.resultType} = 'entry' then 1 else 0 end)`,
      hold: sql<number>`sum(case when ${rtForwardShadowEvents.resultType} = 'hold' then 1 else 0 end)`,
      exit: sql<number>`sum(case when ${rtForwardShadowEvents.resultType} = 'exit' then 1 else 0 end)`,
      error: sql<number>`sum(case when ${rtForwardShadowEvents.resultType} = 'error' then 1 else 0 end)`,
      total: sql<number>`count(*)`,
    }).from(rtForwardShadowEvents).where(and(
      eq(rtForwardShadowEvents.tradeDate, tradeDate),
      inArray(rtForwardShadowEvents.strategyVersion, ACTIVE_BOLLINGER_STRATEGY_VERSIONS),
    )).groupBy(
      rtForwardShadowEvents.strategyVersion,
      rtForwardShadowEvents.evaluationMode,
    ),
  ]);

  const bySymbol = new Map<string, typeof sources>();
  for (const row of sources) {
    const bucket = bySymbol.get(row.symbol) ?? [];
    bucket.push(row);
    bySymbol.set(row.symbol, bucket);
  }
  const sourceSummary = BOLLINGER_SYMBOLS.map(symbol => [symbol, bySymbol.get(symbol) ?? []] as const).map(([symbol, rows]) => {
    const timeSet = new Set(rows.map(row => row.candleTime).filter(validTime));
    const received = rows
      .filter(row => row.relayReceivedAtMs !== null && row.cloudReceivedAtMs !== null)
      .map(row => Number(row.cloudReceivedAtMs) - Number(row.relayReceivedAtMs));
    const missing = FIXED_SESSION_MINUTES.filter(minute => !timeSet.has(minuteToClock(minute)));
    const gaps: string[] = [];
    let gapStart: number | null = null;
    let previous: number | null = null;
    for (const minute of missing) {
      if (gapStart === null || previous === null || minute !== previous + 1) {
        if (gapStart !== null && previous !== null) gaps.push(gapStart === previous ? minuteToClock(gapStart) : `${minuteToClock(gapStart)}–${minuteToClock(previous)}`);
        gapStart = minute;
      }
      previous = minute;
    }
    if (gapStart !== null && previous !== null) gaps.push(gapStart === previous ? minuteToClock(gapStart) : `${minuteToClock(gapStart)}–${minuteToClock(previous)}`);
    return {
      symbol,
      receivedEvents: rows.length,
      distinctMinutes: timeSet.size,
      firstCandleTime: Array.from(timeSet).sort()[0] ?? null,
      lastCandleTime: Array.from(timeSet).sort().at(-1) ?? null,
      missingFixedSessionMinutes: missing.length,
      missingRanges: gaps,
      processingFailed: rows.filter(row => row.status === "failed").length,
      averageRelayToCloudMs: received.length ? Math.round(received.reduce((sum, value) => sum + value, 0) / received.length) : null,
      maxRelayToCloudMs: received.length ? Math.max(...received) : null,
    };
  });

  const rejectionReasons = new Map<string, number>();
  for (const row of rejectedShadowRows) {
    for (const action of parseActions(row.decisionJson)) {
      if (action.type !== "entry_rejected") continue;
      const reason = typeof action.reason === "string" ? action.reason : "unclassified_rejection";
      rejectionReasons.set(reason, (rejectionReasons.get(reason) ?? 0) + 1);
    }
  }
  const resultCounts = new Map<string, number>();
  for (const row of shadowRows) {
    const key = `${row.evaluationMode}:${row.resultType}`;
    resultCounts.set(key, (resultCounts.get(key) ?? 0) + 1);
  }
  const decisionCounts = new Map<string, number>();
  for (const row of decisions) decisionCounts.set(row.resultType, (decisionCounts.get(row.resultType) ?? 0) + 1);
  const queueCounts = new Map<string, number>();
  for (const row of queueRows) queueCounts.set(row.status, (queueCounts.get(row.status) ?? 0) + 1);
  const variantModeStatus = variantModeAggregateRows.flatMap(row => {
    const statuses: Array<[string, number]> = [
      ["processed_no_signal", Number(row.processedNoSignal)],
      ["blocked_data:completed_5m_sma_unavailable", Number(row.blockedFiveMinuteSma)],
      ["rejected_filter:sma20_slope", Number(row.blockedSmaSlope)],
      ["rejected_filter:bollinger_width_5", Number(row.blockedBollingerWidth)],
      ["pending_next_candle", Number(row.pendingNextCandle)],
      ["rejected_board", Number(row.rejectedBoard)],
      ["rejected_other", Number(row.rejectedOther)],
      ["entry", Number(row.entry)],
      ["hold", Number(row.hold)],
      ["exit", Number(row.exit)],
      ["error", Number(row.error)],
    ];
    const processed = statuses.reduce((sum, [, count]) => sum + count, 0);
    const versionSymbol = /^candidate-([a-z0-9]+)-bollinger-directional-/.exec(row.strategyVersion)?.[1]?.toUpperCase();
    const expectedForVersion = versionSymbol
      ? (bySymbol.get(versionSymbol)?.length ?? 0)
      : 0;
    const notProcessed = Math.max(0, expectedForVersion - processed);
    if (notProcessed) statuses.push(["not_processed", notProcessed]);
    return statuses.filter(([, count]) => count > 0).map(([status, count]) => ({
      strategyVersion: row.strategyVersion,
      evaluationMode: row.evaluationMode,
      status,
      count,
    }));
  });

  return {
    available: true as const,
    tradeDate,
    refreshPolicy: "manual_only_snapshot_query" as const,
    source: {
      totalEvents: sources.length,
      symbols: sourceSummary,
      expectedFixedSessionMinutes: FIXED_SESSION_MINUTES.length,
    },
    realtimeDecisionResultCounts: Object.fromEntries(decisionCounts),
    shadow: {
      totalEvents: shadowRows.length,
      resultCounts: Object.fromEntries(resultCounts),
      variantModeStatus,
      errorEvents: shadowRows.filter(row => row.resultType === "error" || Boolean(row.lastError)).length,
      boardOrDepthRejectionReasons: Array.from(rejectionReasons.entries())
        .sort((left, right) => right[1] - left[1])
        .map(([reason, count]) => ({ reason, count })),
    },
    queue: {
      counts: Object.fromEntries(queueCounts),
      maxAttemptCount: queueRows.length ? Math.max(...queueRows.map(row => row.attemptCount)) : 0,
      errorCount: queueRows.filter(row => Boolean(row.lastError) || row.status === "error").length,
      backlogCount: queueRows.filter(row => row.status === "pending" || row.status === "processing").length,
    },
  };
}
