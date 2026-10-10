import { and, asc, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { z } from "zod";
import {
  rtAiIntradayForecastSnapshots,
  rtCandles,
  rtForwardShadowTrades,
  rtMarketContextEvents,
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
import { AI_DAILY_FORECAST_VERSIONS, RETIRED_AI_DAILY_FORECAST_V1_VERSIONS, sha256Stable } from "./runtimeIdentity";

export const AI_INTRADAY_FORECAST_VERSION = "ai-intraday-forecast-v1";
export const AI_INTRADAY_CHECKPOINTS = ["09:30", "10:00", "10:30", "11:00", "11:30", "12:35", "13:00", "13:30", "14:00", "14:30", "15:00"] as const;
export type AiIntradayCheckpoint = typeof AI_INTRADAY_CHECKPOINTS[number];
type Candle = { candleTime: string; open: number; high: number; low: number; close: number; volume: number };

const checkpointSpec: Record<AiIntradayCheckpoint, { cutoff: string; effectiveFrom: string; validUntil: string }> = {
  "09:30": { cutoff: "09:29", effectiveFrom: "09:30", validUntil: "09:59" },
  "10:00": { cutoff: "09:59", effectiveFrom: "10:00", validUntil: "10:29" },
  "10:30": { cutoff: "10:29", effectiveFrom: "10:30", validUntil: "10:59" },
  "11:00": { cutoff: "10:59", effectiveFrom: "11:00", validUntil: "11:29" },
  "11:30": { cutoff: "11:29", effectiveFrom: "11:30", validUntil: "12:34" },
  "12:35": { cutoff: "12:34", effectiveFrom: "12:35", validUntil: "12:59" },
  "13:00": { cutoff: "12:59", effectiveFrom: "13:00", validUntil: "13:29" },
  "13:30": { cutoff: "13:29", effectiveFrom: "13:30", validUntil: "13:59" },
  "14:00": { cutoff: "13:59", effectiveFrom: "14:00", validUntil: "14:29" },
  "14:30": { cutoff: "14:29", effectiveFrom: "14:30", validUntil: "14:59" },
  "15:00": { cutoff: "14:59", effectiveFrom: "15:00", validUntil: "15:19" },
};

const finite = (value: unknown) => { const number = Number(value); return Number.isFinite(number) ? number : null; };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const round = (value: number | null, digits = 6) => value === null ? null : Number(value.toFixed(digits));
const minute = (time: string) => { const [hour, min] = time.split(":").map(Number); return hour * 60 + min; };
const time = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const jstDateTime = (epochMs: number) => { const value = new Date(epochMs + 9 * 60 * 60 * 1_000).toISOString(); return { date: value.slice(0, 10), time: value.slice(11, 16) }; };

function expectedSessionMinutes(cutoff: string) {
  const result: string[] = [];
  for (let value = 9 * 60; value <= minute(cutoff); value += 1) {
    if (value >= 11 * 60 + 30 && value < 12 * 60 + 30) continue;
    result.push(time(value));
  }
  return result;
}

function sma(values: number[], period: number) {
  if (values.length < period) return null;
  const subset = values.slice(-period);
  return subset.reduce((sum, value) => sum + value, 0) / period;
}

function rsiWilder(values: number[], period = 14) {
  if (values.length < period + 1) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]!);
  let averageGain = changes.slice(0, period).reduce((sum, value) => sum + Math.max(0, value), 0) / period;
  let averageLoss = changes.slice(0, period).reduce((sum, value) => sum + Math.max(0, -value), 0) / period;
  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function bollinger(values: number[], period = 20) {
  if (values.length < period) return { middle: null, upper2: null, lower2: null, widthPct: null };
  const subset = values.slice(-period);
  const middle = subset.reduce((sum, value) => sum + value, 0) / period;
  const variance = subset.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const deviation = Math.sqrt(variance);
  return { middle: round(middle), upper2: round(middle + 2 * deviation), lower2: round(middle - 2 * deviation), widthPct: middle > 0 ? round(4 * deviation / middle * 100) : null };
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
  return Array.from(buckets.entries()).sort(([left], [right]) => left - right).flatMap(([bucket, rows]) => {
    const ordered = [...rows].sort((a, b) => a.candleTime.localeCompare(b.candleTime));
    const expected = Array.from({ length: 5 }, (_, index) => time(bucket + index));
    if (ordered.length !== 5 || expected.some((value, index) => ordered[index]?.candleTime !== value)) return [];
    return [{ candleTime: time(bucket + 4), open: ordered[0]!.open, high: Math.max(...ordered.map(row => row.high)), low: Math.min(...ordered.map(row => row.low)), close: ordered.at(-1)!.close, volume: ordered.reduce((sum, row) => sum + row.volume, 0) }];
  });
}

function sessionSummary(candles: Candle[], cutoff: string) {
  const ordered = [...candles].sort((a, b) => a.candleTime.localeCompare(b.candleTime));
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
    changeFromOpenPct: first && last ? round((last.close / first.open - 1) * 100) : null,
    recentHigh30: recent.length ? Math.max(...recent.map(row => row.high)) : null,
    recentLow30: recent.length ? Math.min(...recent.map(row => row.low)) : null,
    oneMinute: { sma5: round(sma(closes, 5)), sma10: round(sma(closes, 10)), sma20: round(sma(closes, 20)), rsi14: round(rsiWilder(closes)), bollinger20: bollinger(closes) },
    completedFiveMinuteBarCount: five.length,
    fiveMinute: { latestBars: five.slice(-24), sma5: round(sma(fiveCloses, 5)), sma10: round(sma(fiveCloses, 10)), sma20: round(sma(fiveCloses, 20)), rsi14: round(rsiWilder(fiveCloses)), bollinger20: bollinger(fiveCloses) },
    latestOneMinuteBars: ordered.slice(-60),
  };
}

function summarizeLearning(rows: Array<typeof rtForwardShadowTrades.$inferSelect>, symbol: AiDailyForecastSymbol) {
  const closed = rows.filter(row => row.symbol === symbol && row.pnl !== null).sort((a, b) => a.entryTradeDate.localeCompare(b.entryTradeDate) || a.id - b.id);
  const summarize = (items: typeof closed) => ({
    closedTrades: items.length,
    wins: items.filter(row => Number(row.pnl) > 0).length,
    losses: items.filter(row => Number(row.pnl) < 0).length,
    winRate: items.length ? round(items.filter(row => Number(row.pnl) > 0).length / items.length * 100) : null,
    totalPnl: items.reduce((sum, row) => sum + Number(row.pnl ?? 0), 0),
    averageR: items.length ? round(items.reduce((sum, row) => sum + Number(row.realizedR ?? 0), 0) / items.length) : null,
    exitReasons: Object.entries(items.reduce<Record<string, number>>((acc, row) => { const key = row.exitReason ?? "unknown"; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {})).map(([reason, count]) => ({ reason, count })),
  });
  const losses = closed.filter(row => Number(row.pnl) < 0).slice(-10).map(row => ({ tradeDate: row.entryTradeDate, side: row.side, entryTime: row.entryCandleTime, exitTime: row.exitCandleTime, exitReason: row.exitReason, pnl: row.pnl, realizedR: finite(row.realizedR) }));
  return { all: summarize(closed), recent20: summarize(closed.slice(-20)), recent5: summarize(closed.slice(-5)), recentLosses: losses };
}

export type AiIntradayForecastInput = {
  tradeDate: string;
  checkpoint: AiIntradayCheckpoint;
  cutoffCandleTime: string;
  effectiveFrom: string;
  validUntil: string;
  capturedAtMs: number;
  morningSourceSnapshotId: string;
  morningInputHash: string;
  morningForecast: Record<string, unknown>;
  previousIntradayForecast: Record<string, unknown> | null;
  priorData: AiDailyForecastInput;
  currentSession: {
    symbols: Array<{ symbol: AiDailyForecastSymbol; summary: ReturnType<typeof sessionSummary> }>;
    nikkei225Mini: Record<string, unknown>;
  };
  learning: Array<{ symbol: AiDailyForecastSymbol; performance: ReturnType<typeof summarizeLearning> }>;
  inputQuality: "verified" | "degraded" | "invalid";
  qualityReasonCodes: string[];
  inputHash?: string;
};

export async function buildAiIntradayForecastInput(input: { tradeDate: string; checkpoint: AiIntradayCheckpoint; capturedAtMs?: number }): Promise<AiIntradayForecastInput> {
  const db = await getDb(); if (!db) throw Error("database_unavailable");
  const spec = checkpointSpec[input.checkpoint]; if (!spec) throw Error("ai_intraday_checkpoint_invalid");
  const morning = await getLatestAiDailyForecastSnapshot(input.tradeDate); if (!morning || morning.qualityStatus === "invalid") throw Error("ai_intraday_morning_snapshot_missing_or_invalid");
  const priorData = await buildAiDailyForecastInput({ tradeDate: input.tradeDate, capturedAtMs: input.capturedAtMs });
  const candleRows = await db.select().from(rtCandles).where(and(eq(rtCandles.tradeDate, input.tradeDate), inArray(rtCandles.symbol, [...AI_DAILY_FORECAST_SYMBOLS]), gte(rtCandles.candleTime, "09:00"), lte(rtCandles.candleTime, spec.cutoff))).orderBy(asc(rtCandles.symbol), asc(rtCandles.candleTime), asc(rtCandles.id));
  const deduped = new Map<string, Candle>();
  for (const row of candleRows) deduped.set(`${row.symbol}:${row.candleTime}`, { candleTime: row.candleTime, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) });
  const summaries = AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({ symbol, summary: sessionSummary(Array.from(deduped.entries()).filter(([key]) => key.startsWith(`${symbol}:`)).map(([, value]) => value), spec.cutoff) }));
  const marketRows = await db.select().from(rtMarketContextEvents).where(and(eq(rtMarketContextEvents.tradeDate, input.tradeDate), lte(rtMarketContextEvents.candleTime, spec.cutoff))).orderBy(asc(rtMarketContextEvents.candleTime), asc(rtMarketContextEvents.id));
  const market = marketRows.at(-1);
  const firstMarket = marketRows[0];
  const versions = [...Object.values(RETIRED_AI_DAILY_FORECAST_V1_VERSIONS), ...Object.values(AI_DAILY_FORECAST_VERSIONS)];
  const learningRows = await db.select().from(rtForwardShadowTrades).where(and(inArray(rtForwardShadowTrades.strategyVersion, versions), eq(rtForwardShadowTrades.evaluationMode, "signal_quality"), lte(rtForwardShadowTrades.entryTradeDate, priorData.dataCutoffDate))).orderBy(asc(rtForwardShadowTrades.entryTradeDate), asc(rtForwardShadowTrades.id));
  const earlier = await db.select().from(rtAiIntradayForecastSnapshots).where(and(eq(rtAiIntradayForecastSnapshots.morningSourceSnapshotId, morning.sourceSnapshotId), lt(rtAiIntradayForecastSnapshots.checkpoint, input.checkpoint))).orderBy(desc(rtAiIntradayForecastSnapshots.checkpoint), desc(rtAiIntradayForecastSnapshots.id)).limit(1);
  const reasons = [...priorData.qualityReasonCodes];
  for (const item of summaries) if (item.summary.missingMinuteCount > 0) reasons.push(`intraday_minute_missing:${item.symbol}:${item.summary.missingMinuteCount}`);
  if (!market) reasons.push("nikkei225_mini_missing_at_checkpoint");
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
    previousIntradayForecast: earlier[0] ? object(earlier[0].forecastJson) : null,
    priorData,
    currentSession: {
      symbols: summaries,
      nikkei225Mini: market && firstMarket ? { barCount: marketRows.length, firstTime: firstMarket.candleTime, lastTime: market.candleTime, open: Number(firstMarket.open), last: Number(market.close), high: Math.max(...marketRows.map(row => Number(row.high))), low: Math.min(...marketRows.map(row => Number(row.low))), changeFromOpenPct: round((Number(market.close) / Number(firstMarket.open) - 1) * 100), qualityStatus: market.qualityStatus } : { barCount: 0 },
    },
    learning: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({ symbol, performance: summarizeLearning(learningRows, symbol) })),
    inputQuality: reasons.length === 0 ? "verified" : "degraded",
    qualityReasonCodes: Array.from(new Set(reasons)),
  };
  return { ...prepared, inputHash: aiIntradayForecastInputHash(prepared) };
}

const controlSchema = z.object({
  symbol: z.enum(AI_DAILY_FORECAST_SYMBOLS),
  planDecision: z.enum(["maintained", "adjusted", "disabled"]),
  changeReason: z.string().min(1).max(480),
  entryWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
  entryWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
  forceExitTime: z.string().regex(/^\d{2}:\d{2}$/),
  openPositionAction: z.enum(["keep", "tighten_only", "exit_next_event_if_direction_changed"]),
  learningEvidenceUsed: z.array(z.string().min(1).max(160)).max(8),
}).strict();
const outputSchema = z.object({
  forecast: z.unknown(),
  controls: z.array(controlSchema).length(10),
  checkpointSummary: z.string().min(1).max(600),
}).strict();
export type AiIntradayForecastOutput = { forecast: AiDailyForecastOutput; controls: z.infer<typeof controlSchema>[]; checkpointSummary: string };

export function validateAiIntradayForecastOutput(raw: unknown, input: AiIntradayForecastInput) {
  const parsed = outputSchema.safeParse(raw); if (!parsed.success) return { valid: false, output: null, reasonCodes: ["ai_intraday_output_schema_invalid"] };
  const forecast = validateAiDailyForecastOutput(parsed.data.forecast, input.priorData); const reasons = [...forecast.reasonCodes];
  const seen = new Set<string>();
  for (const control of parsed.data.controls) {
    if (seen.has(control.symbol)) reasons.push(`duplicate_control_symbol:${control.symbol}`); seen.add(control.symbol);
    if (control.entryWindowStart < input.effectiveFrom || control.entryWindowEnd > input.validUntil || control.entryWindowStart > control.entryWindowEnd) reasons.push(`entry_window_outside_checkpoint:${control.symbol}`);
    if (control.forceExitTime < control.entryWindowEnd || control.forceExitTime > "15:20") reasons.push(`force_exit_time_invalid:${control.symbol}`);
  }
  for (const symbol of AI_DAILY_FORECAST_SYMBOLS) if (!seen.has(symbol)) reasons.push(`missing_control_symbol:${symbol}`);
  return { valid: Boolean(forecast.valid && forecast.output && reasons.length === 0), output: forecast.output ? { forecast: forecast.output, controls: parsed.data.controls, checkpointSummary: parsed.data.checkpointSummary } as AiIntradayForecastOutput : null, reasonCodes: reasons };
}

export function aiIntradayForecastInputHash(input: AiIntradayForecastInput) {
  const { capturedAtMs: _capturedAtMs, inputHash: _inputHash, priorData, ...immutable } = input;
  const { capturedAtMs: _priorCapturedAtMs, inputHash: _priorHash, ...immutablePrior } = priorData;
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
};

async function getBySourceRevisionId(sourceRevisionId: string) { const db = await getDb(); if (!db) return null; return (await db.select().from(rtAiIntradayForecastSnapshots).where(eq(rtAiIntradayForecastSnapshots.sourceRevisionId, sourceRevisionId)).limit(1))[0] ?? null; }
async function insertSnapshot(data: Omit<InsertRtAiIntradayForecastSnapshot, "id" | "createdAt">) {
  const db = await getDb(); if (!db) throw Error("database_unavailable");
  const existing = await getBySourceRevisionId(data.sourceRevisionId);
  if (existing) { if (existing.payloadHash !== data.payloadHash) throw Error("ai_intraday_idempotency_payload_mismatch"); return existing; }
  const checkpointExisting = (await db.select().from(rtAiIntradayForecastSnapshots).where(and(eq(rtAiIntradayForecastSnapshots.morningSourceSnapshotId, data.morningSourceSnapshotId), eq(rtAiIntradayForecastSnapshots.checkpoint, data.checkpoint))).limit(1))[0];
  if (checkpointExisting) throw Error("ai_intraday_checkpoint_already_frozen");
  await db.insert(rtAiIntradayForecastSnapshots).values(data);
  const created = await getBySourceRevisionId(data.sourceRevisionId); if (!created) throw Error("ai_intraday_snapshot_missing_after_insert"); return created;
}

export async function ingestAiIntradayForecastSubmission(submission: AiIntradayForecastSubmission) {
  if (!/^ai-intraday-forecast:\d{4}-\d{2}-\d{2}:\d{4}:[a-z0-9._:-]{1,100}$/i.test(submission.sourceRevisionId)) throw Error("ai_intraday_source_revision_id_invalid");
  const spec = checkpointSpec[submission.checkpoint]; if (!spec) throw Error("ai_intraday_checkpoint_invalid");
  if (!submission.sourceRevisionId.startsWith(`ai-intraday-forecast:${submission.tradeDate}:${submission.checkpoint.replace(":", "")}:`)) throw Error("ai_intraday_source_revision_checkpoint_mismatch");
  const captured = jstDateTime(submission.capturedAtMs);
  if (captured.date !== submission.tradeDate || captured.time < submission.checkpoint || captured.time > spec.validUntil) throw Error("ai_intraday_capture_outside_checkpoint_window_jst");
  const prepared = await buildAiIntradayForecastInput({ tradeDate: submission.tradeDate, checkpoint: submission.checkpoint, capturedAtMs: submission.capturedAtMs });
  if (prepared.morningSourceSnapshotId !== submission.morningSourceSnapshotId) throw Error("ai_intraday_morning_snapshot_mismatch");
  const expectedInputHash = aiIntradayForecastInputHash(prepared); if (submission.inputHash !== expectedInputHash) throw Error("ai_intraday_input_hash_mismatch");
  const validation = validateAiIntradayForecastOutput(submission.aiFinalForecast, prepared); if (!validation.valid || !validation.output) throw Error(`ai_intraday_validation_failed:${validation.reasonCodes.join(",")}`);
  const payload = { sourceRevisionId: submission.sourceRevisionId, morningSourceSnapshotId: submission.morningSourceSnapshotId, tradeDate: submission.tradeDate, checkpoint: submission.checkpoint, cutoffCandleTime: spec.cutoff, modelVersion: AI_INTRADAY_FORECAST_VERSION, inputHash: expectedInputHash, generatorId: submission.generatorId, promptVersion: submission.promptVersion, aiFinalForecast: validation.output, generatorMetadata: submission.generatorMetadata ?? {}, validation: { inputQuality: prepared.inputQuality, inputReasons: prepared.qualityReasonCodes, outputValid: true, outputReasons: validation.reasonCodes } };
  const payloadHash = sha256Stable(payload);
  return insertSnapshot({ sourceRevisionId: submission.sourceRevisionId, morningSourceSnapshotId: submission.morningSourceSnapshotId, tradeDate: submission.tradeDate, checkpoint: submission.checkpoint, cutoffCandleTime: spec.cutoff, capturedAtMs: submission.capturedAtMs, modelVersion: AI_INTRADAY_FORECAST_VERSION, sourceMode: submission.sourceMode, inputHash: expectedInputHash, payloadHash, qualityStatus: prepared.inputQuality === "verified" ? "verified" : "degraded", aiModelId: submission.generatorId, promptVersion: submission.promptVersion, inferenceAtMs: submission.capturedAtMs, inputJson: prepared, forecastJson: payload, validationJson: payload.validation });
}

export async function getAiIntradayForecastSnapshots(tradeDate: string) { const db = await getDb(); if (!db) return []; return db.select().from(rtAiIntradayForecastSnapshots).where(eq(rtAiIntradayForecastSnapshots.tradeDate, tradeDate)).orderBy(asc(rtAiIntradayForecastSnapshots.checkpoint), asc(rtAiIntradayForecastSnapshots.id)); }
export async function getAiIntradayForecastDashboardRows(tradeDate: string) { const db = await getDb(); if (!db) return []; return db.select({ id: rtAiIntradayForecastSnapshots.id, sourceRevisionId: rtAiIntradayForecastSnapshots.sourceRevisionId, morningSourceSnapshotId: rtAiIntradayForecastSnapshots.morningSourceSnapshotId, tradeDate: rtAiIntradayForecastSnapshots.tradeDate, checkpoint: rtAiIntradayForecastSnapshots.checkpoint, cutoffCandleTime: rtAiIntradayForecastSnapshots.cutoffCandleTime, capturedAtMs: rtAiIntradayForecastSnapshots.capturedAtMs, qualityStatus: rtAiIntradayForecastSnapshots.qualityStatus, aiModelId: rtAiIntradayForecastSnapshots.aiModelId, promptVersion: rtAiIntradayForecastSnapshots.promptVersion, forecastJson: rtAiIntradayForecastSnapshots.forecastJson, validationJson: rtAiIntradayForecastSnapshots.validationJson }).from(rtAiIntradayForecastSnapshots).where(eq(rtAiIntradayForecastSnapshots.tradeDate, tradeDate)).orderBy(asc(rtAiIntradayForecastSnapshots.checkpoint), asc(rtAiIntradayForecastSnapshots.id)); }
export async function getEffectiveAiIntradayForecastSnapshot(tradeDate: string, candleTime: string) { const db = await getDb(); if (!db) return null; return (await db.select().from(rtAiIntradayForecastSnapshots).where(and(eq(rtAiIntradayForecastSnapshots.tradeDate, tradeDate), lte(rtAiIntradayForecastSnapshots.checkpoint, candleTime))).orderBy(desc(rtAiIntradayForecastSnapshots.checkpoint), desc(rtAiIntradayForecastSnapshots.id)).limit(1))[0] ?? null; }

export const _aiIntradayForecastTest = { checkpointSpec, expectedSessionMinutes, completedFiveMinuteBars, sessionSummary, summarizeLearning };
