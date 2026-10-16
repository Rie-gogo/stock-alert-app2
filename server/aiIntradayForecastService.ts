import {
  aiPositionManagementPlanSchema,
  aiPositionId,
  type AiPositionManagementPlan,
} from "./aiPositionManagement";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  rtAiIntradayForecastSnapshots,
  rtAiDailyForecastSnapshots,
  rtAiDailyForecastRevisions,
  rtCandles,
  rtForwardShadowEvents,
  rtForwardShadowTrades,
  rtMarketContextEvents,
  rtShadowDispatchQueue,
  rtSourceEvents,
  type InsertRtAiIntradayForecastSnapshot,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  AI_DAILY_FORECAST_SYMBOLS,
  buildAiDailyForecastInput,
  getLatestAiDailyForecastSnapshot,
  validateAiDailyForecastOutput,
  type AiDailyForecastInput,
  type AiDailyForecastOutput,
  type AiDailyForecastSymbol,
} from "./aiDailyForecastService";
import {
  AI_DAILY_FORECAST_VERSIONS,
  RETIRED_AI_ADAPTIVE_FORECAST_V2_VERSIONS,
  RETIRED_AI_DAILY_FORECAST_V1_VERSIONS,
  RETIRED_AI_FORECAST_LEARNING_V3_VERSIONS,
  RETIRED_AI_FORECAST_LEARNING_V4_VERSIONS,
  RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS,
  sha256Stable,
} from "./runtimeIdentity";
import {
  buildLearningApplicationAudit,
  type LearningApplicationAudit,
} from "./aiForecastLearningAudit";
import { scheduleForwardShadowDispatchDrain } from "./forwardShadowSequence";

export const AI_INTRADAY_FORECAST_VERSION =
  "ai-intraday-forecast-v3-v6-morning15-afternoon30";
export const AI_INTRADAY_CHECKPOINTS = [
  "09:15",
  "09:30",
  "09:45",
  "10:00",
  "10:15",
  "10:30",
  "10:45",
  "11:00",
  "11:15",
  "11:30",
  "12:35",
  "13:00",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
] as const;
export type AiIntradayCheckpoint = (typeof AI_INTRADAY_CHECKPOINTS)[number];
export type AiIntradayCheckpointMaterialization = {
  status: "complete" | "pending" | "terminal_error";
  reasonCode:
    | "ai_intraday_materialization_complete"
    | "ai_intraday_materialization_pending"
    | "ai_intraday_materialization_terminal";
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
  cutoffCandleTime: string;
  source: {
    count: number;
    processed: number;
    processing: number;
    failed: number;
    latestCandleTime: string | null;
  };
  shadow: {
    count: number;
    processed: number;
    pending: number;
    processing: number;
    error: number;
    latestProcessedCandleTime: string | null;
  };
};
type Candle = {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const checkpointSpec: Record<
  AiIntradayCheckpoint,
  { cutoff: string; effectiveFrom: string; validUntil: string }
> = {
  "09:15": { cutoff: "09:14", effectiveFrom: "09:15", validUntil: "09:29" },
  "09:30": { cutoff: "09:29", effectiveFrom: "09:30", validUntil: "09:44" },
  "09:45": { cutoff: "09:44", effectiveFrom: "09:45", validUntil: "09:59" },
  "10:00": { cutoff: "09:59", effectiveFrom: "10:00", validUntil: "10:14" },
  "10:15": { cutoff: "10:14", effectiveFrom: "10:15", validUntil: "10:29" },
  "10:30": { cutoff: "10:29", effectiveFrom: "10:30", validUntil: "10:44" },
  "10:45": { cutoff: "10:44", effectiveFrom: "10:45", validUntil: "10:59" },
  "11:00": { cutoff: "10:59", effectiveFrom: "11:00", validUntil: "11:14" },
  "11:15": { cutoff: "11:14", effectiveFrom: "11:15", validUntil: "11:29" },
  "11:30": { cutoff: "11:29", effectiveFrom: "11:30", validUntil: "12:34" },
  "12:35": { cutoff: "12:34", effectiveFrom: "12:35", validUntil: "12:59" },
  "13:00": { cutoff: "12:59", effectiveFrom: "13:00", validUntil: "13:29" },
  "13:30": { cutoff: "13:29", effectiveFrom: "13:30", validUntil: "13:59" },
  "14:00": { cutoff: "13:59", effectiveFrom: "14:00", validUntil: "14:29" },
  "14:30": { cutoff: "14:29", effectiveFrom: "14:30", validUntil: "14:59" },
  "15:00": { cutoff: "14:59", effectiveFrom: "15:00", validUntil: "15:19" },
};

/**
 * Runtime consumers use the same validity window as ingest.  Returning a copy
 * prevents a shadow evaluator from mutating the canonical checkpoint contract.
 */
export function getAiIntradayCheckpointSpec(checkpoint: string) {
  if (!AI_INTRADAY_CHECKPOINTS.includes(checkpoint as AiIntradayCheckpoint))
    return null;
  return { ...checkpointSpec[checkpoint as AiIntradayCheckpoint] };
}

const finite = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const round = (value: number | null, digits = 6) =>
  value === null ? null : Number(value.toFixed(digits));
const minute = (time: string) => {
  const [hour, min] = time.split(":").map(Number);
  return hour * 60 + min;
};
const time = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const jstDateTime = (epochMs: number) => {
  const value = new Date(epochMs + 9 * 60 * 60 * 1_000).toISOString();
  return { date: value.slice(0, 10), time: value.slice(11, 16) };
};

function expectedSessionMinutes(cutoff: string) {
  const result: string[] = [];
  for (let value = 9 * 60; value <= minute(cutoff); value += 1) {
    if (value >= 11 * 60 + 30 && value < 12 * 60 + 30) continue;
    result.push(time(value));
  }
  return result;
}

/** Uses only regular-session minutes and never bridges the lunch break. */
function causalHoldingMinutes(start: string, end: string) {
  return expectedSessionMinutes(end).filter(value => value >= start);
}

function cappedHoldingEnd(timeValue: string) {
  return timeValue > "15:20" ? "15:20" : timeValue;
}

function sma(values: number[], period: number) {
  if (values.length < period) return null;
  const subset = values.slice(-period);
  return subset.reduce((sum, value) => sum + value, 0) / period;
}

function rsiWilder(values: number[], period = 14) {
  if (values.length < period + 1) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]!);
  let averageGain =
    changes
      .slice(0, period)
      .reduce((sum, value) => sum + Math.max(0, value), 0) / period;
  let averageLoss =
    changes
      .slice(0, period)
      .reduce((sum, value) => sum + Math.max(0, -value), 0) / period;
  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function bollinger(values: number[], period = 20) {
  if (values.length < period)
    return { middle: null, upper2: null, lower2: null, widthPct: null };
  const subset = values.slice(-period);
  const middle = subset.reduce((sum, value) => sum + value, 0) / period;
  const variance =
    subset.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const deviation = Math.sqrt(variance);
  return {
    middle: round(middle),
    upper2: round(middle + 2 * deviation),
    lower2: round(middle - 2 * deviation),
    widthPct: middle > 0 ? round(((4 * deviation) / middle) * 100) : null,
  };
}

function completedFiveMinuteBars(candles: Candle[]) {
  const buckets = new Map<number, Candle[]>();
  for (const candle of candles) {
    const value = minute(candle.candleTime);
    const sessionStart = value < 12 * 60 + 30 ? 9 * 60 : 12 * 60 + 30;
    if (value < sessionStart) continue;
    const bucket = sessionStart + Math.floor((value - sessionStart) / 5) * 5;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), candle]);
  }
  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .flatMap(([bucket, rows]) => {
      const ordered = [...rows].sort((a, b) =>
        a.candleTime.localeCompare(b.candleTime)
      );
      const expected = Array.from({ length: 5 }, (_, index) =>
        time(bucket + index)
      );
      if (
        ordered.length !== 5 ||
        expected.some((value, index) => ordered[index]?.candleTime !== value)
      )
        return [];
      return [
        {
          candleTime: time(bucket + 4),
          open: ordered[0]!.open,
          high: Math.max(...ordered.map(row => row.high)),
          low: Math.min(...ordered.map(row => row.low)),
          close: ordered.at(-1)!.close,
          volume: ordered.reduce((sum, row) => sum + row.volume, 0),
        },
      ];
    });
}

function sessionSummary(candles: Candle[], cutoff: string) {
  const ordered = [...candles].sort((a, b) =>
    a.candleTime.localeCompare(b.candleTime)
  );
  const closes = ordered.map(row => row.close);
  const five = completedFiveMinuteBars(ordered);
  const fiveCloses = five.map(row => row.close);
  const expected = expectedSessionMinutes(cutoff);
  const present = new Set(ordered.map(row => row.candleTime));
  const missing = expected.filter(value => !present.has(value));
  const first = ordered[0] ?? null;
  const last = ordered.at(-1) ?? null;
  const recent = ordered.slice(-30);
  return {
    barCount: ordered.length,
    expectedBarCount: expected.length,
    missingMinuteCount: missing.length,
    missingMinutes: missing.slice(0, 30),
    firstTime: first?.candleTime ?? null,
    lastTime: last?.candleTime ?? null,
    open: first?.open ?? null,
    last: last?.close ?? null,
    high: ordered.length ? Math.max(...ordered.map(row => row.high)) : null,
    low: ordered.length ? Math.min(...ordered.map(row => row.low)) : null,
    changeFromOpenPct:
      first && last ? round((last.close / first.open - 1) * 100) : null,
    recentHigh30: recent.length
      ? Math.max(...recent.map(row => row.high))
      : null,
    recentLow30: recent.length ? Math.min(...recent.map(row => row.low)) : null,
    oneMinute: {
      sma5: round(sma(closes, 5)),
      sma10: round(sma(closes, 10)),
      sma20: round(sma(closes, 20)),
      rsi14: round(rsiWilder(closes)),
      bollinger20: bollinger(closes),
    },
    completedFiveMinuteBarCount: five.length,
    fiveMinute: {
      latestBars: five.slice(-24),
      sma5: round(sma(fiveCloses, 5)),
      sma10: round(sma(fiveCloses, 10)),
      sma20: round(sma(fiveCloses, 20)),
      rsi14: round(rsiWilder(fiveCloses)),
      bollinger20: bollinger(fiveCloses),
    },
    latestOneMinuteBars: ordered.slice(-60),
  };
}

type AiSessionTradeJournalRow = {
  positionId?: string;
  evaluationMode: "signal_quality" | "capital_constrained";
  symbol: AiDailyForecastSymbol;
  side: "long" | "short";
  shares: number;
  entrySourceEventId: string;
  entryTime: string;
  exitSourceEventId: string | null;
  exitTime: string | null;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  realizedR: number | null;
  mfePct: number | null;
  maePct: number | null;
  exitReason: string | null;
  decisionId: string | null;
  planId: string | null;
  entryOrdinal: number;
  entryKind: "initial" | "reentry";
  /** Strategy outcomes come only from signal_quality; capital mode is execution audit. */
  learningRole: "strategy_primary" | "execution_audit";
  isOpeningTrade: boolean;
  statusAtCheckpoint: "closed" | "open";
  mfeMaeQuality: "verified" | "degraded" | "unavailable";
  mfeMaeMissingMinutes: string[];
};

function decisionPlanId(value: unknown) {
  const decision = object(value);
  const plan = object(decision.plan);
  const candidate = plan.sourceSnapshotId ?? decision.activePlanId;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

/**
 * Builds the checkpoint-causal AI trade journal.  It deliberately includes neither
 * a post-checkpoint exit nor a post-checkpoint candle in MFE/MAE.  Each evaluation
 * mode remains independent so the model never silently double-counts results.
 */
export function buildAiSessionTradeJournal(input: {
  trades: Array<typeof rtForwardShadowTrades.$inferSelect>;
  events: Array<typeof rtForwardShadowEvents.$inferSelect>;
  candlesBySymbol: Map<string, Candle[]>;
  cutoffCandleTime: string;
}): AiSessionTradeJournalRow[] {
  const entryPlanByKey = new Map(
    input.events.map(event => [
      `${event.strategyVersion}:${event.evaluationMode}:${event.sourceEventId}`,
      decisionPlanId(event.decisionJson),
    ])
  );
  const ordered = input.trades
    .filter(trade => trade.entryCandleTime <= input.cutoffCandleTime)
    .sort(
      (left, right) =>
        left.evaluationMode.localeCompare(right.evaluationMode) ||
        left.symbol.localeCompare(right.symbol) ||
        left.entryCandleTime.localeCompare(right.entryCandleTime) ||
        left.id - right.id
    );
  const ordinalByKey = new Map<string, number>();
  return ordered.map(trade => {
    const ordinalKey = `${trade.evaluationMode}:${trade.symbol}`;
    const entryOrdinal = (ordinalByKey.get(ordinalKey) ?? 0) + 1;
    ordinalByKey.set(ordinalKey, entryOrdinal);
    const closedAtCheckpoint =
      trade.exitTradeDate === trade.entryTradeDate &&
      trade.exitCandleTime !== null &&
      trade.exitCandleTime <= input.cutoffCandleTime;
    const endTime = cappedHoldingEnd(
      closedAtCheckpoint ? trade.exitCandleTime! : input.cutoffCandleTime
    );
    const entryPrice = Number(trade.entryPrice);
    const held = (input.candlesBySymbol.get(trade.symbol) ?? [])
      .filter(
        candle =>
          candle.candleTime >= trade.entryCandleTime &&
          candle.candleTime <= endTime
      )
      .sort((left, right) => left.candleTime.localeCompare(right.candleTime));
    const expectedHoldingMinutes = causalHoldingMinutes(
      trade.entryCandleTime,
      endTime
    );
    const presentHoldingMinutes = new Set(
      held.map(candle => candle.candleTime)
    );
    const mfeMaeMissingMinutes = expectedHoldingMinutes.filter(
      candleTime => !presentHoldingMinutes.has(candleTime)
    );
    const mfeMaeQuality =
      held.length === 0
        ? "unavailable"
        : mfeMaeMissingMinutes.length === 0
          ? "verified"
          : "degraded";
    const high = held.length
      ? Math.max(...held.map(candle => candle.high))
      : null;
    const low = held.length
      ? Math.min(...held.map(candle => candle.low))
      : null;
    const pct = (value: number | null) =>
      value !== null && entryPrice > 0
        ? round((value / entryPrice - 1) * 100)
        : null;
    const mfePct =
      trade.side === "long"
        ? pct(high)
        : low !== null && entryPrice > 0
          ? round((entryPrice / low - 1) * 100)
          : null;
    const maePct =
      trade.side === "long"
        ? pct(low)
        : high !== null && entryPrice > 0
          ? round((entryPrice / high - 1) * 100)
          : null;
    const planId =
      entryPlanByKey.get(
        `${trade.strategyVersion}:${trade.evaluationMode}:${trade.entrySourceEventId}`
      ) ?? null;
    return {
      evaluationMode: trade.evaluationMode,
      symbol: trade.symbol as AiDailyForecastSymbol,
      side: trade.side,
      shares: Number(trade.shares),
      positionId: aiPositionId(
        trade.symbol,
        trade.side,
        trade.entrySourceEventId
      ),
      entrySourceEventId: trade.entrySourceEventId,
      entryTime: trade.entryCandleTime,
      exitSourceEventId: closedAtCheckpoint ? trade.exitSourceEventId : null,
      exitTime: closedAtCheckpoint ? trade.exitCandleTime : null,
      entryPrice,
      exitPrice:
        closedAtCheckpoint && trade.exitPrice !== null
          ? Number(trade.exitPrice)
          : null,
      pnl: closedAtCheckpoint ? trade.pnl : null,
      realizedR: closedAtCheckpoint ? finite(trade.realizedR) : null,
      mfePct,
      maePct,
      exitReason: closedAtCheckpoint ? trade.exitReason : null,
      decisionId: planId,
      planId,
      entryOrdinal,
      entryKind: entryOrdinal === 1 ? "initial" : "reentry",
      learningRole:
        trade.evaluationMode === "signal_quality"
          ? "strategy_primary"
          : "execution_audit",
      isOpeningTrade:
        trade.entryCandleTime >= "09:00" && trade.entryCandleTime < "09:30",
      statusAtCheckpoint: closedAtCheckpoint ? "closed" : "open",
      mfeMaeQuality,
      mfeMaeMissingMinutes,
    };
  });
}

function summarizeLearning(
  rows: Array<typeof rtForwardShadowTrades.$inferSelect>,
  symbol: AiDailyForecastSymbol
) {
  const closed = rows
    .filter(row => row.symbol === symbol && row.pnl !== null)
    .sort(
      (a, b) => a.entryTradeDate.localeCompare(b.entryTradeDate) || a.id - b.id
    );
  const summarize = (items: typeof closed) => ({
    closedTrades: items.length,
    wins: items.filter(row => Number(row.pnl) > 0).length,
    losses: items.filter(row => Number(row.pnl) < 0).length,
    winRate: items.length
      ? round(
          (items.filter(row => Number(row.pnl) > 0).length / items.length) * 100
        )
      : null,
    totalPnl: items.reduce((sum, row) => sum + Number(row.pnl ?? 0), 0),
    averageR: items.length
      ? round(
          items.reduce((sum, row) => sum + Number(row.realizedR ?? 0), 0) /
            items.length
        )
      : null,
    exitReasons: Object.entries(
      items.reduce<Record<string, number>>((acc, row) => {
        const key = row.exitReason ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {})
    ).map(([reason, count]) => ({ reason, count })),
  });
  const losses = closed
    .filter(row => Number(row.pnl) < 0)
    .slice(-10)
    .map(row => ({
      tradeDate: row.entryTradeDate,
      side: row.side,
      entryTime: row.entryCandleTime,
      exitTime: row.exitCandleTime,
      exitReason: row.exitReason,
      pnl: row.pnl,
      realizedR: finite(row.realizedR),
    }));
  return {
    all: summarize(closed),
    recent20: summarize(closed.slice(-20)),
    recent5: summarize(closed.slice(-5)),
    recentLosses: losses,
  };
}

export type AiIntradayForecastInput = {
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
  cutoffCandleTime: string;
  cutoffMode?: "fixed_checkpoint" | "delayed_latest_processed";
  delayMinutes?: number;
  remainingMinutes?: number;
  effectiveFrom: string;
  validUntil: string;
  capturedAtMs: number;
  morningSourceSnapshotId: string;
  morningInputHash: string;
  morningForecast: Record<string, unknown>;
  previousIntradayForecast: Record<string, unknown> | null;
  priorData: AiDailyForecastInput;
  /** The same strictly-prior closed review as the 08:30 input; no same-day review. */
  latestLearningReview: NonNullable<
    AiDailyForecastInput["latestLearningReview"]
  >;
  currentSession: {
    symbols: Array<{
      symbol: AiDailyForecastSymbol;
      summary: ReturnType<typeof sessionSummary>;
    }>;
    nikkei225Mini: Record<string, unknown>;
  };
  learning: Array<{
    symbol: AiDailyForecastSymbol;
    performance: ReturnType<typeof summarizeLearning>;
  }>;
  learningApplicationAudit: LearningApplicationAudit;
  /** 全modeの台帳。各行のlearningRoleで戦略学習と実行監査を明示的に分離する。 */
  aiSessionTradeJournal: AiSessionTradeJournalRow[];
  /** 同一市場機会を二重学習しないため、戦略判断にはsignal_qualityだけを用いる。 */
  aiSessionStrategyJournal: AiSessionTradeJournalRow[];
  /** 資金・板深度の実行可能性監査。戦略市場事例としては加算しない。 */
  aiSessionExecutionAuditJournal: AiSessionTradeJournalRow[];
  managementDecisionEvents?: Array<{ symbol: string; sourceEventId: string }>;
  managementPositions?: Array<Record<string, unknown>>;
  aiCurrentPositions: AiSessionTradeJournalRow[];
  aiCurrentStrategyPositions: AiSessionTradeJournalRow[];
  aiCurrentExecutionAuditPositions: AiSessionTradeJournalRow[];
  /** 外部senderがAIへ渡す、v6の固定・監査可能な判断指示。 */
  generationContract: {
    version: "ai-adaptive-v6-same-day-journal-morning15-afternoon30-v1";
    strategyLearningSource: "signal_quality_only";
    executionAuditSource: "capital_constrained_separate_not_market_case";
    openingTradeBoundary: "entry_candle_time_09:00_to_09:29";
    reentryPolicy: "new_immutable_plan_id_only";
    missingPlanPolicy: "fail_closed_no_trade";
    lunchCheckpointPolicy: "position_management_only_no_new_entry";
    openPositionContinuationPolicy: "explicit_management_plan_next_executable_event_successor_checkpoint_valid_until_new_positions_only";
    codexQualitativeRevalidationPolicy: "no_fixed_threshold_current_session_corroboration_required";
    automaticSma20ExitPolicy: "disabled_observation_only";
    requiredLearningEvidenceBySymbol: Record<AiDailyForecastSymbol, string[]>;
  };
  inputQuality: "verified" | "degraded" | "invalid";
  qualityReasonCodes: string[];
  /** prepare時点でcutoffまでのshadow queueが追い付いたことを示す監査値。 */
  materializationWatermark?: AiIntradayCheckpointMaterialization;
  /** serverが発行するHMAC。token自体はinputHashの対象外。 */
  inputSnapshotToken?: string;
  inputHash?: string;
};

const countValue = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function classifyAiIntradayCheckpointMaterialization(input: {
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
  cutoffCandleTime: string;
  source: AiIntradayCheckpointMaterialization["source"];
  shadow: AiIntradayCheckpointMaterialization["shadow"];
}): AiIntradayCheckpointMaterialization {
  const terminal = input.source.failed > 0 || input.shadow.error > 0;
  const complete =
    !terminal &&
    input.source.count > 0 &&
    input.source.processing === 0 &&
    input.source.processed === input.source.count &&
    input.shadow.count === input.source.count &&
    input.shadow.pending === 0 &&
    input.shadow.processing === 0 &&
    input.shadow.processed === input.shadow.count;
  return {
    ...input,
    status: terminal ? "terminal_error" : complete ? "complete" : "pending",
    reasonCode: terminal
      ? "ai_intraday_materialization_terminal"
      : complete
        ? "ai_intraday_materialization_complete"
        : "ai_intraday_materialization_pending",
  };
}

export function selectAiIntradayProcessedCutoff(input: {
  checkpoint: AiIntradayCheckpoint;
  nowTime: string;
  rows: Array<{
    candleTime: string;
    symbol: string;
    sourceStatus: string;
    shadowStatus: string | null;
  }>;
}) {
  const spec = checkpointSpec[input.checkpoint];
  const groups = new Map<string, typeof input.rows>();
  for (const row of input.rows) {
    if (
      row.candleTime < "09:00" ||
      row.candleTime >= input.nowTime ||
      row.candleTime >= spec.validUntil
    )
      continue;
    groups.set(row.candleTime, [...(groups.get(row.candleTime) ?? []), row]);
  }
  let latest = spec.cutoff;
  for (const [time, rows] of Array.from(groups.entries()).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (
      rows.some(
        row =>
          row.sourceStatus !== "processed" || row.shadowStatus !== "processed"
      )
    )
      break;
    if (
      time >= spec.cutoff &&
      AI_DAILY_FORECAST_SYMBOLS.every(symbol =>
        rows.some(row => row.symbol === symbol)
      )
    )
      latest = time;
  }
  return latest;
}

async function latestProcessedCutoff(
  tradeDate: string,
  checkpoint: AiIntradayCheckpoint,
  nowTime: string
) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const rows = await db
    .select({
      candleTime: rtSourceEvents.candleTime,
      symbol: rtSourceEvents.symbol,
      sourceStatus: rtSourceEvents.status,
      shadowStatus: rtShadowDispatchQueue.status,
    })
    .from(rtSourceEvents)
    .leftJoin(
      rtShadowDispatchQueue,
      eq(rtShadowDispatchQueue.sourceEventId, rtSourceEvents.sourceEventId)
    )
    .where(
      and(
        eq(rtSourceEvents.tradeDate, tradeDate),
        inArray(rtSourceEvents.symbol, [...AI_DAILY_FORECAST_SYMBOLS]),
        gte(rtSourceEvents.candleTime, "09:00"),
        lt(rtSourceEvents.candleTime, nowTime),
        lt(rtSourceEvents.candleTime, checkpointSpec[checkpoint].validUntil)
      )
    );
  return selectAiIntradayProcessedCutoff({ checkpoint, nowTime, rows });
}

/** checkpoint cutoff以前だけを対象に、同日AI shadow台帳の追随完了を確認する。 */
export async function getAiIntradayCheckpointMaterialization(input: {
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
  cutoffCandleTime?: string;
}): Promise<AiIntradayCheckpointMaterialization> {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const fixedSpec = checkpointSpec[input.checkpoint];
  const spec = fixedSpec && {
    ...fixedSpec,
    cutoff: input.cutoffCandleTime ?? fixedSpec.cutoff,
  };
  if (!spec) throw Error("ai_intraday_checkpoint_invalid");
  const sourceCondition = and(
    eq(rtSourceEvents.tradeDate, input.tradeDate),
    inArray(rtSourceEvents.symbol, [...AI_DAILY_FORECAST_SYMBOLS]),
    gte(rtSourceEvents.candleTime, "09:00"),
    lte(rtSourceEvents.candleTime, spec.cutoff)
  );
  const [sourceRows, shadowRows] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)`,
        processed: sql<number>`coalesce(sum(case when ${rtSourceEvents.status} = 'processed' then 1 else 0 end), 0)`,
        processing: sql<number>`coalesce(sum(case when ${rtSourceEvents.status} = 'processing' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${rtSourceEvents.status} in ('failed', 'payload_mismatch') then 1 else 0 end), 0)`,
        latestCandleTime: sql<string | null>`max(${rtSourceEvents.candleTime})`,
      })
      .from(rtSourceEvents)
      .where(sourceCondition),
    db
      .select({
        count: sql<number>`count(*)`,
        processed: sql<number>`coalesce(sum(case when ${rtShadowDispatchQueue.status} = 'processed' then 1 else 0 end), 0)`,
        pending: sql<number>`coalesce(sum(case when ${rtShadowDispatchQueue.status} = 'pending' then 1 else 0 end), 0)`,
        processing: sql<number>`coalesce(sum(case when ${rtShadowDispatchQueue.status} = 'processing' then 1 else 0 end), 0)`,
        error: sql<number>`coalesce(sum(case when ${rtShadowDispatchQueue.status} = 'error' then 1 else 0 end), 0)`,
        latestProcessedCandleTime: sql<
          string | null
        >`max(case when ${rtShadowDispatchQueue.status} = 'processed' then ${rtSourceEvents.candleTime} else null end)`,
      })
      .from(rtShadowDispatchQueue)
      .innerJoin(
        rtSourceEvents,
        eq(rtShadowDispatchQueue.sourceEventId, rtSourceEvents.sourceEventId)
      )
      .where(sourceCondition),
  ]);
  const source = sourceRows[0];
  const shadow = shadowRows[0];
  return classifyAiIntradayCheckpointMaterialization({
    tradeDate: input.tradeDate,
    checkpoint: input.checkpoint,
    cutoffCandleTime: spec.cutoff,
    source: {
      count: countValue(source?.count),
      processed: countValue(source?.processed),
      processing: countValue(source?.processing),
      failed: countValue(source?.failed),
      latestCandleTime: source?.latestCandleTime ?? null,
    },
    shadow: {
      count: countValue(shadow?.count),
      processed: countValue(shadow?.processed),
      pending: countValue(shadow?.pending),
      processing: countValue(shadow?.processing),
      error: countValue(shadow?.error),
      latestProcessedCandleTime: shadow?.latestProcessedCandleTime ?? null,
    },
  });
}

export async function buildAiIntradayForecastInput(input: {
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
  cutoffCandleTime?: string;
  capturedAtMs?: number;
}): Promise<AiIntradayForecastInput> {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const fixedSpec = checkpointSpec[input.checkpoint];
  const spec = fixedSpec && {
    ...fixedSpec,
    cutoff: input.cutoffCandleTime ?? fixedSpec.cutoff,
  };
  if (!spec) throw Error("ai_intraday_checkpoint_invalid");
  const morning = await getLatestAiDailyForecastSnapshot(input.tradeDate);
  if (!morning || morning.qualityStatus === "invalid")
    throw Error("ai_intraday_morning_snapshot_missing_or_invalid");
  const priorData = await buildAiDailyForecastInput({
    tradeDate: input.tradeDate,
    capturedAtMs: input.capturedAtMs,
  });
  const candleRows = await db
    .select()
    .from(rtCandles)
    .where(
      and(
        eq(rtCandles.tradeDate, input.tradeDate),
        inArray(rtCandles.symbol, [...AI_DAILY_FORECAST_SYMBOLS]),
        gte(rtCandles.candleTime, "09:00"),
        lte(rtCandles.candleTime, spec.cutoff)
      )
    )
    .orderBy(
      asc(rtCandles.symbol),
      asc(rtCandles.candleTime),
      asc(rtCandles.id)
    );
  const deduped = new Map<string, Candle>();
  for (const row of candleRows)
    deduped.set(`${row.symbol}:${row.candleTime}`, {
      candleTime: row.candleTime,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    });
  const summaries = AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
    symbol,
    summary: sessionSummary(
      Array.from(deduped.entries())
        .filter(([key]) => key.startsWith(`${symbol}:`))
        .map(([, value]) => value),
      spec.cutoff
    ),
  }));
  const marketRows = await db
    .select()
    .from(rtMarketContextEvents)
    .where(
      and(
        eq(rtMarketContextEvents.tradeDate, input.tradeDate),
        lte(rtMarketContextEvents.candleTime, spec.cutoff)
      )
    )
    .orderBy(
      asc(rtMarketContextEvents.candleTime),
      asc(rtMarketContextEvents.id)
    );
  const market = marketRows.at(-1);
  const firstMarket = marketRows[0];
  const versions = [
    ...Object.values(RETIRED_AI_DAILY_FORECAST_V1_VERSIONS),
    ...Object.values(RETIRED_AI_ADAPTIVE_FORECAST_V2_VERSIONS),
    ...Object.values(RETIRED_AI_FORECAST_LEARNING_V3_VERSIONS),
    ...Object.values(RETIRED_AI_FORECAST_LEARNING_V4_VERSIONS),
    ...Object.values(RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS),
    ...Object.values(AI_DAILY_FORECAST_VERSIONS),
  ] as string[];
  const learningRows = await db
    .select()
    .from(rtForwardShadowTrades)
    .where(
      and(
        inArray(rtForwardShadowTrades.strategyVersion, versions),
        lte(rtForwardShadowTrades.entryTradeDate, input.tradeDate)
      )
    )
    .orderBy(
      asc(rtForwardShadowTrades.entryTradeDate),
      asc(rtForwardShadowTrades.id)
    );
  const sessionTrades = learningRows.filter(
    row => row.entryTradeDate === input.tradeDate
  );
  const sessionEvents = sessionTrades.length
    ? await db
        .select()
        .from(rtForwardShadowEvents)
        .where(
          and(
            inArray(rtForwardShadowEvents.strategyVersion, versions),
            eq(rtForwardShadowEvents.tradeDate, input.tradeDate),
            lte(rtForwardShadowEvents.candleTime, spec.cutoff)
          )
        )
        .orderBy(
          asc(rtForwardShadowEvents.candleTime),
          asc(rtForwardShadowEvents.id)
        )
    : [];
  // MFE/MAE requires the complete causal holding interval, not the UI's latest 60 bars.
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const symbol of AI_DAILY_FORECAST_SYMBOLS) {
    candlesBySymbol.set(
      symbol,
      Array.from(deduped.entries())
        .filter(([key]) => key.startsWith(`${symbol}:`))
        .map(([, value]) => value)
    );
  }
  const latestManagement = new Map<string, Record<string, unknown>>();
  for (const event of sessionEvents) {
    latestManagement.set(
      `${event.symbol}:${event.evaluationMode}`,
      object(object(event.decisionJson).managementPosition)
    );
  }
  const managementPositions = Array.from(latestManagement.values()).filter(
    row => row.positionId
  );
  const managementDecisionEvents = sessionEvents.map(event => ({
    symbol: event.symbol,
    sourceEventId: event.sourceEventId,
  }));
  const aiSessionTradeJournal = buildAiSessionTradeJournal({
    trades: sessionTrades,
    events: sessionEvents,
    candlesBySymbol,
    cutoffCandleTime: spec.cutoff,
  });
  const aiSessionStrategyJournal = aiSessionTradeJournal.filter(
    item => item.learningRole === "strategy_primary"
  );
  const aiSessionExecutionAuditJournal = aiSessionTradeJournal.filter(
    item => item.learningRole === "execution_audit"
  );
  const aiCurrentPositions = aiSessionTradeJournal.filter(
    item => item.statusAtCheckpoint === "open"
  );
  const aiCurrentStrategyPositions = aiSessionStrategyJournal.filter(
    item => item.statusAtCheckpoint === "open"
  );
  const aiCurrentExecutionAuditPositions =
    aiSessionExecutionAuditJournal.filter(
      item => item.statusAtCheckpoint === "open"
    );
  const requiredLearningEvidenceBySymbol = Object.fromEntries(
    AI_DAILY_FORECAST_SYMBOLS.map(symbol => [
      symbol,
      aiSessionStrategyJournal
        .filter(item => item.symbol === symbol)
        .map(item => `session_trade:signal_quality:${item.entrySourceEventId}`),
    ])
  ) as Record<AiDailyForecastSymbol, string[]>;
  const earlier = await db
    .select()
    .from(rtAiIntradayForecastSnapshots)
    .where(
      and(
        eq(
          rtAiIntradayForecastSnapshots.morningSourceSnapshotId,
          morning.sourceSnapshotId
        ),
        lt(rtAiIntradayForecastSnapshots.checkpoint, input.checkpoint)
      )
    )
    .orderBy(
      desc(rtAiIntradayForecastSnapshots.checkpoint),
      desc(rtAiIntradayForecastSnapshots.id)
    )
    .limit(1);
  const reasons = [...priorData.qualityReasonCodes];
  for (const item of summaries)
    if (item.summary.missingMinuteCount > 0)
      reasons.push(
        `intraday_minute_missing:${item.symbol}:${item.summary.missingMinuteCount}`
      );
  if (!market) reasons.push("nikkei225_mini_missing_at_checkpoint");
  const frozenMacro = object(priorData.macroSnapshot);
  const learningApplicationAudit = buildLearningApplicationAudit({
    checkpoint: input.checkpoint,
    baselines: summaries.map(item => ({
      symbol: item.symbol,
      baseline: priorData.symbols.find(row => row.symbol === item.symbol)!
        .baseline,
      technical: item.summary,
    })),
    macroRegime:
      typeof frozenMacro.regimeState === "string"
        ? frozenMacro.regimeState
        : null,
    learningSnapshot: priorData.learningSnapshot ?? null,
  });
  const prepared: AiIntradayForecastInput = {
    tradeDate: input.tradeDate,
    checkpoint: input.checkpoint,
    cutoffCandleTime: spec.cutoff,
    effectiveFrom: spec.effectiveFrom,
    validUntil: spec.validUntil,
    capturedAtMs: input.capturedAtMs ?? Date.now(),
    morningSourceSnapshotId: morning.sourceSnapshotId,
    morningInputHash: morning.inputHash,
    morningForecast: object(morning.forecastJson),
    previousIntradayForecast: earlier[0]
      ? object(earlier[0].forecastJson)
      : null,
    priorData,
    latestLearningReview: priorData.latestLearningReview!,
    currentSession: {
      symbols: summaries,
      nikkei225Mini:
        market && firstMarket
          ? {
              barCount: marketRows.length,
              firstTime: firstMarket.candleTime,
              lastTime: market.candleTime,
              open: Number(firstMarket.open),
              last: Number(market.close),
              high: Math.max(...marketRows.map(row => Number(row.high))),
              low: Math.min(...marketRows.map(row => Number(row.low))),
              changeFromOpenPct: round(
                (Number(market.close) / Number(firstMarket.open) - 1) * 100
              ),
              qualityStatus: market.qualityStatus,
            }
          : { barCount: 0 },
    },
    learning: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
      symbol,
      performance: summarizeLearning(
        learningRows.filter(
          row =>
            row.evaluationMode === "signal_quality" &&
            row.entryTradeDate <= priorData.dataCutoffDate
        ),
        symbol
      ),
    })),
    learningApplicationAudit,
    aiSessionTradeJournal,
    aiSessionStrategyJournal,
    aiSessionExecutionAuditJournal,
    managementPositions,
    managementDecisionEvents,
    aiCurrentPositions,
    aiCurrentStrategyPositions,
    aiCurrentExecutionAuditPositions,
    generationContract: {
      version: "ai-adaptive-v6-same-day-journal-morning15-afternoon30-v1",
      strategyLearningSource: "signal_quality_only",
      executionAuditSource: "capital_constrained_separate_not_market_case",
      openingTradeBoundary: "entry_candle_time_09:00_to_09:29",
      reentryPolicy: "new_immutable_plan_id_only",
      missingPlanPolicy: "fail_closed_no_trade",
      lunchCheckpointPolicy: "position_management_only_no_new_entry",
      openPositionContinuationPolicy:
        "explicit_management_plan_next_executable_event_successor_checkpoint_valid_until_new_positions_only",
      codexQualitativeRevalidationPolicy:
        "no_fixed_threshold_current_session_corroboration_required",
      automaticSma20ExitPolicy: "disabled_observation_only",
      requiredLearningEvidenceBySymbol,
    },
    inputQuality: reasons.length === 0 ? "verified" : "degraded",
    qualityReasonCodes: Array.from(new Set(reasons)),
  };
  return { ...prepared, inputHash: aiIntradayForecastInputHash(prepared) };
}

function aiIntradayInputSnapshotSecret() {
  const secret = process.env.AI_DAILY_FORECAST_INGEST_KEY;
  if (!secret || secret.length < 32)
    throw Error("ai_intraday_snapshot_signing_key_missing");
  return secret;
}

function aiIntradayInputSnapshotSignaturePayload(
  input: AiIntradayForecastInput
) {
  return {
    version: "ai-intraday-input-snapshot-v1",
    tradeDate: input.tradeDate,
    checkpoint: input.checkpoint,
    cutoffCandleTime: input.cutoffCandleTime,
    capturedAtMs: input.capturedAtMs,
    morningSourceSnapshotId: input.morningSourceSnapshotId,
    inputHash: input.inputHash,
  };
}

function signAiIntradayInputSnapshot(input: AiIntradayForecastInput) {
  return createHmac("sha256", aiIntradayInputSnapshotSecret())
    .update(sha256Stable(aiIntradayInputSnapshotSignaturePayload(input)))
    .digest("hex");
}

function verifyAiIntradayInputSnapshotToken(
  input: AiIntradayForecastInput,
  token: string
) {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const expected = Buffer.from(signAiIntradayInputSnapshot(input), "hex");
  const actual = Buffer.from(token, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * cutoffまでのshadow queueが安定して追い付いた場合だけ、署名付き固定inputを返す。
 * DB schemaを増やさず、senderが返送する入力全体をHMACで改変検知する。
 */
export async function prepareAiIntradayForecastInput(input: {
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
}) {
  const capturedAtMs = Date.now();
  const cutoffCandleTime = await latestProcessedCutoff(
    input.tradeDate,
    input.checkpoint,
    jstDateTime(capturedAtMs).time
  );
  const selected = { ...input, cutoffCandleTime };
  const before = await getAiIntradayCheckpointMaterialization(selected);
  if (before.status !== "complete") {
    if (before.status === "pending") scheduleForwardShadowDispatchDrain(0);
    console.warn(
      "[AiIntradayForecast] checkpoint materialization unavailable",
      {
        tradeDate: input.tradeDate,
        checkpoint: input.checkpoint,
        status: before.status,
        reasonCode: before.reasonCode,
        source: before.source,
        shadow: before.shadow,
      }
    );
    throw Error(before.reasonCode);
  }
  const built = await buildAiIntradayForecastInput({
    ...selected,
    capturedAtMs,
  });
  const after = await getAiIntradayCheckpointMaterialization(selected);
  if (
    after.status !== "complete" ||
    sha256Stable(before) !== sha256Stable(after)
  ) {
    console.warn(
      "[AiIntradayForecast] checkpoint materialization changed while preparing input",
      {
        tradeDate: input.tradeDate,
        checkpoint: input.checkpoint,
        before: before.status,
        after: after.status,
        sourceCountBefore: before.source.count,
        sourceCountAfter: after.source.count,
        shadowProcessedBefore: before.shadow.processed,
        shadowProcessedAfter: after.shadow.processed,
      }
    );
    throw Error(
      after.status === "terminal_error"
        ? "ai_intraday_materialization_terminal"
        : "ai_intraday_materialization_pending"
    );
  }
  const frozenWithoutToken: AiIntradayForecastInput = {
    ...built,
    cutoffMode:
      cutoffCandleTime > checkpointSpec[input.checkpoint].cutoff
        ? "delayed_latest_processed"
        : "fixed_checkpoint",
    delayMinutes:
      minute(cutoffCandleTime) -
      minute(checkpointSpec[input.checkpoint].cutoff),
    remainingMinutes: Math.max(
      0,
      minute(built.validUntil) - minute(jstDateTime(capturedAtMs).time)
    ),
    materializationWatermark: after,
  };
  const frozen: AiIntradayForecastInput = {
    ...frozenWithoutToken,
    inputHash: aiIntradayForecastInputHash(frozenWithoutToken),
  };
  return {
    ...frozen,
    inputSnapshotToken: signAiIntradayInputSnapshot(frozen),
  };
}

const controlSchema = z
  .object({
    symbol: z.enum(AI_DAILY_FORECAST_SYMBOLS),
    planDecision: z.enum(["maintained", "adjusted", "disabled"]),
    changeReason: z.string().min(1).max(480),
    entryWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
    entryWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
    forceExitTime: z.string().regex(/^\d{2}:\d{2}$/),
    entryPolicy: z.enum(["entry_allowed", "manage_only"]).optional(),
    openPositionAction: z.enum([
      "keep",
      "tighten_only",
      "exit_next_event_if_direction_changed",
    ]),
    // Includes session_trade:signal_quality:<entrySourceEventId> for every
    // same-day strategy trade.  Capital mode can be cited only as execution audit.
    learningEvidenceUsed: z.array(z.string().min(1).max(160)).max(500),
  })
  .strict();
const outputSchema = z
  .object({
    managementPlans: z.array(aiPositionManagementPlanSchema).max(20).optional(),
    forecast: z.unknown(),
    controls: z.array(controlSchema).length(10),
    checkpointSummary: z.string().min(1).max(600),
  })
  .strict();
export type AiIntradayForecastOutput = {
  managementPlans?: AiPositionManagementPlan[];
  forecast: AiDailyForecastOutput;
  controls: z.infer<typeof controlSchema>[];
  checkpointSummary: string;
};

export type AiIntradayActivationAudit = {
  policy: "next_source_event_after_ingest_boundary_v1";
  activationAfterEngineSequence: number;
  assessedEventCount: number;
  symbols: Array<{
    symbol: AiDailyForecastSymbol;
    firstTargetReachedBeforeActivation: boolean;
    stretchTargetReachedBeforeActivation: boolean;
    firstTargetReachedAt: string | null;
    stretchTargetReachedAt: string | null;
    entryDisposition: "eligible_after_activation" | "missed_move_no_entry";
  }>;
};

type AiIntradayPreActivationEvent = {
  engineSequence: number;
  symbol: string;
  candleTime: string;
  high: number;
  low: number;
};

/**
 * A late plan may manage an already-open position, but it must not create a
 * new entry after its objective was already reached while the plan was absent.
 */
export function buildAiIntradayActivationAudit(input: {
  output: AiIntradayForecastOutput;
  activationAfterEngineSequence: number;
  events: AiIntradayPreActivationEvent[];
}): AiIntradayActivationAudit {
  const orderedEvents = [...input.events].sort(
    (left, right) => left.engineSequence - right.engineSequence
  );
  return {
    policy: "next_source_event_after_ingest_boundary_v1",
    activationAfterEngineSequence: input.activationAfterEngineSequence,
    assessedEventCount: orderedEvents.length,
    symbols: AI_DAILY_FORECAST_SYMBOLS.map(symbol => {
      const forecast = input.output.forecast.forecasts.find(
        row => row.symbol === symbol
      );
      const direction = String(forecast?.direction ?? "");
      const long = direction === "strong_up" || direction === "up";
      const short = direction === "strong_down" || direction === "down";
      const firstTarget = finite(forecast?.firstTarget);
      const stretchTarget = finite(forecast?.stretchTarget);
      const events = orderedEvents.filter(event => event.symbol === symbol);
      const firstEvent =
        firstTarget === null || (!long && !short)
          ? null
          : (events.find(event =>
              long ? event.high >= firstTarget : event.low <= firstTarget
            ) ?? null);
      const stretchEvent =
        stretchTarget === null || (!long && !short)
          ? null
          : (events.find(event =>
              long ? event.high >= stretchTarget : event.low <= stretchTarget
            ) ?? null);
      return {
        symbol,
        firstTargetReachedBeforeActivation: Boolean(firstEvent),
        stretchTargetReachedBeforeActivation: Boolean(stretchEvent),
        firstTargetReachedAt: firstEvent?.candleTime ?? null,
        stretchTargetReachedAt: stretchEvent?.candleTime ?? null,
        entryDisposition: firstEvent
          ? "missed_move_no_entry"
          : "eligible_after_activation",
      };
    }),
  };
}

function activationAuditFromValidation(value: unknown) {
  return object(object(value).activationAudit);
}

export function isAiIntradaySnapshotCausallyAvailable(
  validationJson: unknown,
  engineSequence: number | null | undefined
) {
  const boundary = finite(
    activationAuditFromValidation(validationJson).activationAfterEngineSequence
  );
  // Legacy snapshots remain readable. New snapshots fail closed when an event
  // has no sequence and become active only after the ingest boundary.
  if (boundary === null) return true;
  return (
    engineSequence !== null &&
    engineSequence !== undefined &&
    Number.isFinite(engineSequence) &&
    engineSequence > boundary
  );
}

async function createAiIntradayActivationAudit(input: {
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
  output: AiIntradayForecastOutput;
}) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const spec = checkpointSpec[input.checkpoint];
  const boundaryRows = await db
    .select({
      engineSequence: sql<
        number | null
      >`max(${rtShadowDispatchQueue.engineSequence})`,
    })
    .from(rtShadowDispatchQueue);
  const activationAfterEngineSequence = countValue(
    boundaryRows[0]?.engineSequence
  );
  const rows = activationAfterEngineSequence
    ? await db
        .select({
          engineSequence: rtShadowDispatchQueue.engineSequence,
          symbol: rtSourceEvents.symbol,
          candleTime: rtSourceEvents.candleTime,
          inputJson: rtShadowDispatchQueue.inputJson,
        })
        .from(rtShadowDispatchQueue)
        .innerJoin(
          rtSourceEvents,
          eq(rtShadowDispatchQueue.sourceEventId, rtSourceEvents.sourceEventId)
        )
        .where(
          and(
            eq(rtShadowDispatchQueue.tradeDate, input.tradeDate),
            inArray(rtShadowDispatchQueue.symbol, [
              ...AI_DAILY_FORECAST_SYMBOLS,
            ]),
            lte(
              rtShadowDispatchQueue.engineSequence,
              activationAfterEngineSequence
            ),
            gte(rtSourceEvents.candleTime, spec.effectiveFrom),
            lte(rtSourceEvents.candleTime, spec.validUntil)
          )
        )
        .orderBy(asc(rtShadowDispatchQueue.engineSequence))
    : [];
  const events = rows.flatMap(row => {
    const candle = object(object(row.inputJson).candle);
    const high = finite(candle.high);
    const low = finite(candle.low);
    if (high === null || low === null) return [];
    return [
      {
        engineSequence: row.engineSequence,
        symbol: row.symbol,
        candleTime: row.candleTime,
        high,
        low,
      },
    ];
  });
  return buildAiIntradayActivationAudit({
    output: input.output,
    activationAfterEngineSequence,
    events,
  });
}

export function validateAiIntradayForecastOutput(
  raw: unknown,
  input: AiIntradayForecastInput
) {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success)
    return {
      valid: false,
      output: null,
      reasonCodes: ["ai_intraday_output_schema_invalid"],
    };
  const forecast = validateAiDailyForecastOutput(
    parsed.data.forecast,
    input.priorData
  );
  const reasons = [...forecast.reasonCodes];
  const knowledgeIds = new Set(
    (input.latestLearningReview?.review?.knowledge ?? []).map(
      row => row.knowledgeId
    )
  );
  const managementIds = new Set<string>();
  const managementPositionIds = new Set<string>();
  for (const command of parsed.data.managementPlans ?? []) {
    if (
      managementIds.has(command.planId) ||
      managementPositionIds.has(command.positionId)
    )
      reasons.push(`duplicate_management_command:${command.planId}`);
    managementIds.add(command.planId);
    managementPositionIds.add(command.positionId);
    if (
      !(input.aiCurrentPositions ?? []).some(
        row =>
          (row.positionId ??
            aiPositionId(row.symbol, row.side, row.entrySourceEventId)) ===
            command.positionId &&
          row.symbol === command.symbol &&
          row.side === command.side
      )
    )
      reasons.push(`management_position_not_open:${command.positionId}`);
    if (
      !(input.managementDecisionEvents ?? []).some(
        row =>
          row.symbol === command.symbol &&
          row.sourceEventId === command.basedOnEventId
      )
    )
      reasons.push(`management_basis_event_unknown:${command.basedOnEventId}`);
    if (
      command.validUntil <= input.effectiveFrom ||
      command.validUntil > "15:20"
    )
      reasons.push(`management_valid_until_invalid:${command.planId}`);
    for (const id of command.knowledgeIds)
      if (!knowledgeIds.has(id))
        reasons.push(`management_knowledge_unknown:${id}`);
  }
  const seen = new Set<string>();
  const openStrategySymbols = new Set(
    (input.aiCurrentStrategyPositions ?? []).map(item => item.symbol)
  );
  for (const control of parsed.data.controls) {
    if (seen.has(control.symbol))
      reasons.push(`duplicate_control_symbol:${control.symbol}`);
    seen.add(control.symbol);
    if (
      control.entryWindowStart < input.effectiveFrom ||
      control.entryWindowEnd > input.validUntil ||
      control.entryWindowStart > control.entryWindowEnd
    )
      reasons.push(`entry_window_outside_checkpoint:${control.symbol}`);
    // 11:30は前場新規entryを許さず、後場最初の完成5分足を待つまでの
    // bridge planに限定する。12:35で改めて因果的に再判断する。
    if (
      input.checkpoint === "11:30" &&
      (control.entryWindowStart < "12:30" || control.entryWindowEnd > "12:34")
    )
      reasons.push(`1130_bridge_entry_window_invalid:${control.symbol}`);
    if (
      input.checkpoint === "11:30" &&
      (control.entryWindowStart < "12:30" || control.entryWindowEnd > "12:34")
    )
      reasons.push(`lunch_entry_window_invalid:${control.symbol}`);
    if (
      input.checkpoint === "11:30" &&
      !openStrategySymbols.has(control.symbol) &&
      control.planDecision !== "disabled"
    )
      reasons.push(`lunch_flat_symbol_must_be_disabled:${control.symbol}`);
    if (
      control.forceExitTime < control.entryWindowEnd ||
      control.forceExitTime > "15:20"
    )
      reasons.push(`force_exit_time_invalid:${control.symbol}`);
  }
  for (const symbol of AI_DAILY_FORECAST_SYMBOLS) {
    if (!seen.has(symbol)) reasons.push(`missing_control_symbol:${symbol}`);
    const control = parsed.data.controls.find(item => item.symbol === symbol);
    const requiredSessionEvidence = (input.aiSessionStrategyJournal ?? [])
      .filter(item => item.symbol === symbol)
      .map(item => `session_trade:signal_quality:${item.entrySourceEventId}`);
    for (const evidence of requiredSessionEvidence)
      if (!control?.learningEvidenceUsed.includes(evidence))
        reasons.push(`session_trade_evidence_missing:${symbol}:${evidence}`);
  }
  return {
    valid: Boolean(forecast.valid && forecast.output && reasons.length === 0),
    output: forecast.output
      ? ({
          managementPlans: parsed.data.managementPlans,
          forecast: forecast.output,
          controls: parsed.data.controls,
          checkpointSummary: parsed.data.checkpointSummary,
        } as AiIntradayForecastOutput)
      : null,
    reasonCodes: reasons,
  };
}

export function aiIntradayForecastInputHash(input: AiIntradayForecastInput) {
  const {
    capturedAtMs: _capturedAtMs,
    inputHash: _inputHash,
    inputSnapshotToken: _inputSnapshotToken,
    priorData,
    ...immutable
  } = input;
  const {
    capturedAtMs: _priorCapturedAtMs,
    inputHash: _priorHash,
    ...immutablePrior
  } = priorData;
  return sha256Stable({ ...immutable, priorData: immutablePrior });
}

export type AiIntradayForecastSubmission = {
  ingestKey?: string;
  sourceRevisionId: string;
  morningSourceSnapshotId: string;
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
  capturedAtMs: number;
  sourceMode: "scheduled_ai_forecast" | "manual_dry_run";
  inputHash: string;
  aiFinalForecast: unknown;
  generatorId: string;
  promptVersion: string;
  generatorMetadata?: Record<string, unknown>;
  /** prepare endpointが返した署名付き固定input。旧senderは未指定でも互換経路で動く。 */
  frozenInput?: unknown;
  inputSnapshotToken?: string;
};

export function assertAiIntradayCutoffNotAfterArrival(
  tradeDate: string,
  cutoff: string,
  receivedAtMs: number
) {
  const arrival = jstDateTime(receivedAtMs);
  if (
    arrival.date < tradeDate ||
    (arrival.date === tradeDate && cutoff > arrival.time)
  )
    throw Error("ai_intraday_cutoff_after_arrival");
}

function frozenAiIntradayInputFromSubmission(
  submission: AiIntradayForecastSubmission
): AiIntradayForecastInput | null {
  const hasFrozenInput = submission.frozenInput !== undefined;
  const hasToken = submission.inputSnapshotToken !== undefined;
  if (!hasFrozenInput && !hasToken) return null;
  if (!hasFrozenInput || !hasToken)
    throw Error("ai_intraday_input_snapshot_incomplete");
  const token = submission.inputSnapshotToken;
  if (typeof token !== "string")
    throw Error("ai_intraday_input_snapshot_incomplete");
  if (!submission.frozenInput || typeof submission.frozenInput !== "object")
    throw Error("ai_intraday_input_snapshot_invalid");
  const frozen = submission.frozenInput as AiIntradayForecastInput;
  const spec = checkpointSpec[submission.checkpoint];
  if (
    frozen.tradeDate !== submission.tradeDate ||
    frozen.checkpoint !== submission.checkpoint ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(frozen.cutoffCandleTime) ||
    frozen.cutoffCandleTime < spec.cutoff ||
    frozen.cutoffCandleTime >= spec.validUntil ||
    frozen.effectiveFrom !== spec.effectiveFrom ||
    frozen.validUntil !== spec.validUntil ||
    frozen.capturedAtMs !== submission.capturedAtMs ||
    frozen.morningSourceSnapshotId !== submission.morningSourceSnapshotId ||
    frozen.inputHash !== submission.inputHash ||
    frozen.inputSnapshotToken !== token
  )
    throw Error("ai_intraday_input_snapshot_identity_mismatch");
  if (
    frozen.materializationWatermark?.status !== "complete" ||
    frozen.materializationWatermark.tradeDate !== submission.tradeDate ||
    frozen.materializationWatermark.checkpoint !== submission.checkpoint ||
    frozen.materializationWatermark.cutoffCandleTime !== frozen.cutoffCandleTime
  )
    throw Error("ai_intraday_input_snapshot_materialization_invalid");
  if (
    !Array.isArray(frozen.currentSession?.symbols) ||
    frozen.currentSession.symbols.length !== AI_DAILY_FORECAST_SYMBOLS.length ||
    !Array.isArray(frozen.priorData?.symbols) ||
    frozen.priorData.symbols.length !== AI_DAILY_FORECAST_SYMBOLS.length
  )
    throw Error("ai_intraday_input_snapshot_contract_invalid");
  const currentSymbols = new Set(
    frozen.currentSession.symbols.map(item => item.symbol)
  );
  const priorSymbols = new Set(
    frozen.priorData.symbols.map(item => item.symbol)
  );
  if (
    AI_DAILY_FORECAST_SYMBOLS.some(
      symbol => !currentSymbols.has(symbol) || !priorSymbols.has(symbol)
    )
  )
    throw Error("ai_intraday_input_snapshot_symbol_mismatch");
  const expectedHash = aiIntradayForecastInputHash(frozen);
  if (expectedHash !== submission.inputHash)
    throw Error("ai_intraday_input_hash_mismatch");
  if (!verifyAiIntradayInputSnapshotToken(frozen, token))
    throw Error("ai_intraday_input_snapshot_signature_invalid");
  return frozen;
}

async function getBySourceRevisionId(sourceRevisionId: string) {
  const db = await getDb();
  if (!db) return null;
  return (
    (
      await db
        .select()
        .from(rtAiIntradayForecastSnapshots)
        .where(
          eq(rtAiIntradayForecastSnapshots.sourceRevisionId, sourceRevisionId)
        )
        .limit(1)
    )[0] ?? null
  );
}
async function insertSnapshot(
  data: Omit<InsertRtAiIntradayForecastSnapshot, "id" | "createdAt">
) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const existing = await getBySourceRevisionId(data.sourceRevisionId);
  if (existing) {
    if (existing.payloadHash !== data.payloadHash)
      throw Error("ai_intraday_idempotency_payload_mismatch");
    return existing;
  }
  const checkpointExisting = (
    await db
      .select()
      .from(rtAiIntradayForecastSnapshots)
      .where(
        and(
          eq(
            rtAiIntradayForecastSnapshots.morningSourceSnapshotId,
            data.morningSourceSnapshotId
          ),
          eq(rtAiIntradayForecastSnapshots.checkpoint, data.checkpoint)
        )
      )
      .limit(1)
  )[0];
  if (checkpointExisting) throw Error("ai_intraday_checkpoint_already_frozen");
  await db.insert(rtAiIntradayForecastSnapshots).values(data);
  const created = await getBySourceRevisionId(data.sourceRevisionId);
  if (!created) throw Error("ai_intraday_snapshot_missing_after_insert");
  return created;
}

export async function ingestAiIntradayForecastSubmission(
  submission: AiIntradayForecastSubmission
) {
  if (
    !/^ai-intraday-forecast:\d{4}-\d{2}-\d{2}:\d{4}:[a-z0-9._:-]{1,100}$/i.test(
      submission.sourceRevisionId
    )
  )
    throw Error("ai_intraday_source_revision_id_invalid");
  const receivedAtMs = Date.now();
  const spec = checkpointSpec[submission.checkpoint];
  if (!spec) throw Error("ai_intraday_checkpoint_invalid");
  if (
    !submission.sourceRevisionId.startsWith(
      `ai-intraday-forecast:${submission.tradeDate}:${submission.checkpoint.replace(":", "")}:`
    )
  )
    throw Error("ai_intraday_source_revision_checkpoint_mismatch");
  const captured = jstDateTime(submission.capturedAtMs);
  if (
    captured.date !== submission.tradeDate ||
    captured.time < submission.checkpoint ||
    captured.time > spec.validUntil
  )
    throw Error("ai_intraday_capture_outside_checkpoint_window_jst");
  // New senders return the exact server-signed prepare input. Never rebuild a
  // mutable same-day journal for those submissions. The legacy rebuild path is
  // retained only for already-created files that predate snapshot tokens.
  const frozenPrepared = frozenAiIntradayInputFromSubmission(submission);
  const prepared =
    frozenPrepared ??
    (await buildAiIntradayForecastInput({
      tradeDate: submission.tradeDate,
      checkpoint: submission.checkpoint,
      capturedAtMs: submission.capturedAtMs,
    }));
  assertAiIntradayCutoffNotAfterArrival(
    submission.tradeDate,
    prepared.cutoffCandleTime,
    receivedAtMs
  );
  if (prepared.morningSourceSnapshotId !== submission.morningSourceSnapshotId)
    throw Error("ai_intraday_morning_snapshot_mismatch");
  const expectedInputHash = aiIntradayForecastInputHash(prepared);
  if (submission.inputHash !== expectedInputHash)
    throw Error("ai_intraday_input_hash_mismatch");
  const validation = validateAiIntradayForecastOutput(
    submission.aiFinalForecast,
    prepared
  );
  if (!validation.valid || !validation.output)
    throw Error(
      `ai_intraday_validation_failed:${validation.reasonCodes.join(",")}`
    );
  const activationAudit = {
    ...(await createAiIntradayActivationAudit({
      tradeDate: submission.tradeDate,
      checkpoint: submission.checkpoint,
      output: validation.output,
    })),
    receivedAtMs: Date.now(),
  };
  const payload = {
    sourceRevisionId: submission.sourceRevisionId,
    morningSourceSnapshotId: submission.morningSourceSnapshotId,
    tradeDate: submission.tradeDate,
    checkpoint: submission.checkpoint,
    cutoffCandleTime: prepared.cutoffCandleTime,
    modelVersion: AI_INTRADAY_FORECAST_VERSION,
    inputHash: expectedInputHash,
    generatorId: submission.generatorId,
    promptVersion: submission.promptVersion,
    aiFinalForecast: validation.output,
    generatorMetadata: submission.generatorMetadata ?? {},
    learningApplicationAudit: prepared.learningApplicationAudit,
    validation: {
      cutoffMode:
        prepared.cutoffCandleTime > spec.cutoff
          ? "delayed_latest_processed"
          : "fixed_checkpoint",
      delayMinutes: minute(prepared.cutoffCandleTime) - minute(spec.cutoff),
      remainingMinutes: Math.max(
        0,
        minute(spec.validUntil) -
          minute(jstDateTime(prepared.capturedAtMs).time)
      ),
      inputQuality: prepared.inputQuality,
      inputReasons: prepared.qualityReasonCodes,
      inputSnapshotMode: frozenPrepared ? "signed_frozen_v1" : "legacy_rebuild",
      materializationWatermark: prepared.materializationWatermark ?? null,
      outputValid: true,
      outputReasons: validation.reasonCodes,
    },
  };
  const payloadHash = sha256Stable(payload);
  return insertSnapshot({
    sourceRevisionId: submission.sourceRevisionId,
    morningSourceSnapshotId: submission.morningSourceSnapshotId,
    tradeDate: submission.tradeDate,
    checkpoint: submission.checkpoint,
    cutoffCandleTime: prepared.cutoffCandleTime,
    capturedAtMs: submission.capturedAtMs,
    modelVersion: AI_INTRADAY_FORECAST_VERSION,
    sourceMode: submission.sourceMode,
    inputHash: expectedInputHash,
    payloadHash,
    qualityStatus:
      prepared.inputQuality === "verified" ? "verified" : "degraded",
    aiModelId: submission.generatorId,
    promptVersion: submission.promptVersion,
    inferenceAtMs: submission.capturedAtMs,
    inputJson: prepared,
    forecastJson: payload,
    validationJson: {
      ...payload.validation,
      activationAudit,
    },
  });
}

export async function getAiIntradayForecastSnapshots(tradeDate: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(rtAiIntradayForecastSnapshots)
    .where(eq(rtAiIntradayForecastSnapshots.tradeDate, tradeDate))
    .orderBy(
      asc(rtAiIntradayForecastSnapshots.checkpoint),
      asc(rtAiIntradayForecastSnapshots.id)
    );
}
/**
 * Read-only UI projection for every v5/v6 AI shadow entry. Rows stay independent
 * by evaluation mode and are never written back to the immutable trade history.
 */
export async function getAiSessionTradeDashboardRows(tradeDate: string) {
  const db = await getDb();
  if (!db)
    return { asOfCandleTime: null, rows: [] as AiSessionTradeJournalRow[] };
  const versions = [
    ...Object.values(RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS),
    ...Object.values(AI_DAILY_FORECAST_VERSIONS),
  ] as string[];
  const [trades, events, candles] = await Promise.all([
    db
      .select()
      .from(rtForwardShadowTrades)
      .where(
        and(
          inArray(rtForwardShadowTrades.strategyVersion, versions),
          eq(rtForwardShadowTrades.entryTradeDate, tradeDate)
        )
      )
      .orderBy(
        asc(rtForwardShadowTrades.evaluationMode),
        asc(rtForwardShadowTrades.symbol),
        asc(rtForwardShadowTrades.entryCandleTime),
        asc(rtForwardShadowTrades.id)
      ),
    db
      .select()
      .from(rtForwardShadowEvents)
      .where(
        and(
          inArray(rtForwardShadowEvents.strategyVersion, versions),
          eq(rtForwardShadowEvents.tradeDate, tradeDate)
        )
      )
      .orderBy(
        asc(rtForwardShadowEvents.candleTime),
        asc(rtForwardShadowEvents.id)
      ),
    db
      .select()
      .from(rtCandles)
      .where(
        and(
          eq(rtCandles.tradeDate, tradeDate),
          inArray(rtCandles.symbol, [...AI_DAILY_FORECAST_SYMBOLS])
        )
      )
      .orderBy(
        asc(rtCandles.symbol),
        asc(rtCandles.candleTime),
        asc(rtCandles.id)
      ),
  ]);
  const asOfCandleTime = candles.at(-1)?.candleTime ?? null;
  if (!asOfCandleTime)
    return { asOfCandleTime, rows: [] as AiSessionTradeJournalRow[] };
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const candle of candles) {
    const rows = candlesBySymbol.get(candle.symbol) ?? [];
    rows.push({
      candleTime: candle.candleTime,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: candle.volume,
    });
    candlesBySymbol.set(candle.symbol, rows);
  }
  return {
    asOfCandleTime,
    rows: buildAiSessionTradeJournal({
      trades,
      events,
      candlesBySymbol,
      cutoffCandleTime: asOfCandleTime,
    }),
  };
}

export async function getAiIntradayForecastDashboardRows(tradeDate: string) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      id: rtAiIntradayForecastSnapshots.id,
      sourceRevisionId: rtAiIntradayForecastSnapshots.sourceRevisionId,
      morningSourceSnapshotId:
        rtAiIntradayForecastSnapshots.morningSourceSnapshotId,
      tradeDate: rtAiIntradayForecastSnapshots.tradeDate,
      checkpoint: rtAiIntradayForecastSnapshots.checkpoint,
      cutoffCandleTime: rtAiIntradayForecastSnapshots.cutoffCandleTime,
      capturedAtMs: rtAiIntradayForecastSnapshots.capturedAtMs,
      qualityStatus: rtAiIntradayForecastSnapshots.qualityStatus,
      aiModelId: rtAiIntradayForecastSnapshots.aiModelId,
      promptVersion: rtAiIntradayForecastSnapshots.promptVersion,
      forecastJson: rtAiIntradayForecastSnapshots.forecastJson,
      validationJson: rtAiIntradayForecastSnapshots.validationJson,
    })
    .from(rtAiIntradayForecastSnapshots)
    .where(eq(rtAiIntradayForecastSnapshots.tradeDate, tradeDate))
    .orderBy(
      asc(rtAiIntradayForecastSnapshots.checkpoint),
      asc(rtAiIntradayForecastSnapshots.id)
    );
}
// These three forecast tables are append-only; duplicate revision writes are no-ops.
// Read all watermarks in one statement so a revision describes one DB view.
export async function getAiForecastPlanRevision(tradeDate: string) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const [rows] = await db.execute(sql`select
    (select concat(coalesce(max(id), 0), ':', count(*)) from ${rtAiDailyForecastSnapshots} where trade_date = ${tradeDate}) as daily,
    (select concat(coalesce(max(id), 0), ':', count(*)) from ${rtAiDailyForecastRevisions} where trade_date = ${tradeDate}) as revision,
    (select concat(coalesce(max(id), 0), ':', count(*)) from ${rtAiIntradayForecastSnapshots} where trade_date = ${tradeDate}) as intraday`);
  const row = (
    rows as unknown as { daily: string; revision: string; intraday: string }[]
  )[0];
  return `${row.daily}:${row.revision}:${row.intraday}`;
}

export async function getAiIntradayPlanCandidates(tradeDate: string) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  return db
    .select({
      id: rtAiIntradayForecastSnapshots.id,
      sourceRevisionId: rtAiIntradayForecastSnapshots.sourceRevisionId,
      checkpoint: rtAiIntradayForecastSnapshots.checkpoint,
      qualityStatus: rtAiIntradayForecastSnapshots.qualityStatus,
      forecastJson: rtAiIntradayForecastSnapshots.forecastJson,
      validationJson: rtAiIntradayForecastSnapshots.validationJson,
      // Only fallback ATR and its symbol association are needed from the frozen input.
      priorSymbols: sql<unknown>`json_extract(${rtAiIntradayForecastSnapshots.inputJson}, '$.priorData.symbols')`,
    })
    .from(rtAiIntradayForecastSnapshots)
    .where(eq(rtAiIntradayForecastSnapshots.tradeDate, tradeDate))
    .orderBy(
      desc(rtAiIntradayForecastSnapshots.checkpoint),
      desc(rtAiIntradayForecastSnapshots.id)
    );
}

export function selectEffectiveAiIntradayPlan(
  candidates: Awaited<ReturnType<typeof getAiIntradayPlanCandidates>>,
  candleTime: string,
  engineSequence: number | null
) {
  // Preserve the former SQL filter, ordering and limit before causal selection.
  return (
    candidates
      .filter(snapshot => snapshot.checkpoint <= candleTime)
      .slice(0, AI_INTRADAY_CHECKPOINTS.length)
      .find(snapshot =>
        isAiIntradaySnapshotCausallyAvailable(
          snapshot.validationJson,
          engineSequence
        )
      ) ?? null
  );
}

export async function getEffectiveAiIntradayForecastSnapshot(
  tradeDate: string,
  candleTime: string,
  engineSequence: number | null = null
) {
  return selectEffectiveAiIntradayPlan(
    await getAiIntradayPlanCandidates(tradeDate),
    candleTime,
    engineSequence
  );
}

export const _aiIntradayForecastTest = {
  checkpointSpec,
  expectedSessionMinutes,
  completedFiveMinuteBars,
  sessionSummary,
  summarizeLearning,
  buildAiSessionTradeJournal,
  causalHoldingMinutes,
  classifyAiIntradayCheckpointMaterialization,
  buildAiIntradayActivationAudit,
  isAiIntradaySnapshotCausallyAvailable,
  signAiIntradayInputSnapshot,
  verifyAiIntradayInputSnapshotToken,
  frozenAiIntradayInputFromSubmission,
};
