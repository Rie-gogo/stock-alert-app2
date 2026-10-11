import { and, asc, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db";
import {
  rtAiDailyForecastRevisions,
  rtAiDailyForecastSnapshots,
  rtAiForecastLearningSnapshots,
  rtCandles,
  rtMarketContextEvents,
  rtPremarketContextSnapshots,
  type InsertRtAiDailyForecastSnapshot,
  type RtAiDailyForecastSnapshot,
} from "../drizzle/schema";
import { nextTokyoEquityTradeDate } from "./jpxEquityCalendar";
import { sha256Stable } from "./runtimeIdentity";
import {
  buildLearningApplicationAudit,
  type LearningApplicationAudit,
} from "./aiForecastLearningAudit";
import { AI_FORECAST_LEARNING_MODEL_VERSION } from "./aiForecastLearningContract";
import {
  getLatestLearningReviewApplicationBefore,
  type LearningReviewApplication,
} from "./aiPostmarketLearningService";

export const AI_DAILY_FORECAST_VERSION = "ai-daily-forecast-v1";
export const AI_DAILY_FORECAST_SYMBOLS = [
  "285A",
  "3436",
  "5803",
  "6146",
  "6526",
  "6857",
  "6976",
  "6981",
  "8035",
  "9984",
] as const;
export type AiDailyForecastSymbol = (typeof AI_DAILY_FORECAST_SYMBOLS)[number];
type Direction =
  | "strong_up"
  | "up"
  | "range"
  | "down"
  | "strong_down"
  | "insufficient"
  | "stale";
type Side = "long" | "short" | "wait";
type Quality = "verified" | "degraded" | "invalid";
type Candle = {
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type DailyBar = {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  barCount: number;
  distinctMinuteCount: number;
  firstTime: string;
  lastTime: string;
  duplicateMinuteCount: number;
  maxGapMinutes: number | null;
  usable: boolean;
  qualityReasons: string[];
};

export type QuantBaseline = {
  symbol: AiDailyForecastSymbol;
  direction: Direction;
  atr5: number | null;
  score: number | null;
  closeSlope: number | null;
  momentum3: number | null;
  closeLocation: number | null;
  forecastLow: number | null;
  forecastHigh: number | null;
  zoneType: "pullback" | "return_sell" | "none";
  zoneLow: number | null;
  zoneHigh: number | null;
  confirmPrice: number | null;
  firstTarget: number | null;
  stretchTarget: number | null;
  stopReference: number | null;
  usableDates: string[];
  excludedDates: Array<{ tradeDate: string; reasons: string[] }>;
  originalUnroundedPrices: Record<string, number | null>;
  noTradeReasonCodes: string[];
};

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const roundAudit = (value: number | null, digits = 6) =>
  value === null ? null : Number(value.toFixed(digits));
const clip = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** JPX tick table (equity board prices). Audit retains unrounded values separately. */
export function jpxTickSize(price: number) {
  if (price < 1_000) return 0.1;
  if (price < 3_000) return 0.5;
  if (price < 5_000) return 1;
  if (price < 30_000) return 5;
  if (price < 50_000) return 10;
  if (price < 300_000) return 50;
  if (price < 500_000) return 100;
  if (price < 3_000_000) return 500;
  return 1_000;
}
function roundToTick(
  value: number,
  mode: "nearest" | "up" | "down" = "nearest"
) {
  const tick = jpxTickSize(value);
  const scaled = value / tick;
  const rounded =
    mode === "up"
      ? Math.ceil(scaled)
      : mode === "down"
        ? Math.floor(scaled)
        : Math.round(scaled);
  return Number((rounded * tick).toFixed(4));
}
function minute(time: string) {
  const [hour, min] = time.split(":").map(Number);
  return hour * 60 + min;
}
function maxIntraSessionGap(candles: Candle[]) {
  const ordered = [...candles].sort((a, b) =>
    a.candleTime.localeCompare(b.candleTime)
  );
  let maxGap: number | null = null;
  for (let i = 1; i < ordered.length; i += 1) {
    const gap =
      minute(ordered[i]!.candleTime) - minute(ordered[i - 1]!.candleTime) - 1;
    if (gap > 0) maxGap = Math.max(maxGap ?? 0, gap);
  }
  return maxGap;
}
function regressionSlope(values: number[]) {
  const n = values.length;
  if (n < 2) return null;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (i - meanX) * (values[i]! - meanY);
    denominator += (i - meanX) ** 2;
  }
  return denominator === 0 ? null : numerator / denominator;
}
function extrapolate(values: number[]) {
  const slope = regressionSlope(values);
  if (slope === null) return null;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  return meanY + slope * (n - meanX);
}
function directionFromScore(score: number): Direction {
  if (score >= 0.35) return "strong_up";
  if (score >= 0.1) return "up";
  if (score > -0.1) return "range";
  if (score > -0.35) return "down";
  return "strong_down";
}

export function buildQuantBaseline(
  symbol: AiDailyForecastSymbol,
  dailyBars: DailyBar[]
): QuantBaseline {
  const usable = dailyBars.filter(bar => bar.usable).slice(-6);
  const excludedDates = dailyBars
    .filter(bar => !bar.usable)
    .map(bar => ({ tradeDate: bar.tradeDate, reasons: bar.qualityReasons }));
  const base = {
    symbol,
    atr5: null,
    score: null,
    closeSlope: null,
    momentum3: null,
    closeLocation: null,
    forecastLow: null,
    forecastHigh: null,
    zoneType: "none" as const,
    zoneLow: null,
    zoneHigh: null,
    confirmPrice: null,
    firstTarget: null,
    stretchTarget: null,
    stopReference: null,
    usableDates: usable.map(bar => bar.tradeDate),
    excludedDates,
    originalUnroundedPrices: {},
    noTradeReasonCodes: [] as string[],
  };
  if (usable.length < 5)
    return {
      ...base,
      direction: "insufficient",
      noTradeReasonCodes: ["usable_sessions_below_five"],
    };
  const latest = usable.at(-1)!;
  const five = usable.slice(-5);
  const prior = usable.length >= 6 ? usable.at(-6)! : null;
  const trueRanges = five.map((bar, index) => {
    const prevClose = index === 0 ? prior?.close : five[index - 1]!.close;
    return prevClose === undefined
      ? bar.high - bar.low
      : Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - prevClose),
          Math.abs(bar.low - prevClose)
        );
  });
  if (
    trueRanges.length !== 5 ||
    trueRanges.some(value => !Number.isFinite(value) || value <= 0)
  )
    return {
      ...base,
      direction: "insufficient",
      noTradeReasonCodes: ["atr5_unavailable"],
    };
  const atr5 = trueRanges.reduce((sum, value) => sum + value, 0) / 5;
  const closes = five.map(bar => bar.close);
  const slope = regressionSlope(closes);
  const momentum3 = latest.close - five[1]!.close;
  const momentumNorm = momentum3 / (3 * atr5);
  const closeLocation =
    latest.high > latest.low
      ? (latest.close - latest.low) / (latest.high - latest.low)
      : 0.5;
  const score =
    0.45 * clip(((slope ?? 0) / atr5) * 2.5, -1, 1) +
    0.35 * clip(momentumNorm * 2, -1, 1) +
    0.2 * ((closeLocation - 0.5) * 2);
  const direction = directionFromScore(score);
  const medianUp =
    median(five.map(bar => Math.max(0, bar.high - bar.close))) ?? 0;
  const medianDown =
    median(five.map(bar => Math.max(0, bar.close - bar.low))) ?? 0;
  const drift = score * 0.12 * atr5;
  let forecastHighRaw = latest.close + Math.max(0.35 * atr5, medianUp) + drift;
  let forecastLowRaw = latest.close - Math.max(0.35 * atr5, medianDown) + drift;
  const regressionHigh = extrapolate(five.map(bar => bar.high));
  const regressionLow = extrapolate(five.map(bar => bar.low));
  if (regressionHigh !== null)
    forecastHighRaw =
      0.75 * forecastHighRaw +
      0.25 *
        clip(
          regressionHigh,
          latest.close - 1.2 * atr5,
          latest.close + 1.2 * atr5
        );
  if (regressionLow !== null)
    forecastLowRaw =
      0.75 * forecastLowRaw +
      0.25 *
        clip(
          regressionLow,
          latest.close - 1.2 * atr5,
          latest.close + 1.2 * atr5
        );
  if (!(forecastLowRaw < forecastHighRaw))
    return {
      ...base,
      direction: "insufficient",
      atr5,
      score,
      closeSlope: slope,
      momentum3: momentumNorm,
      closeLocation,
      noTradeReasonCodes: ["forecast_range_invalid"],
    };
  const directionSide: Side =
    direction === "strong_up" || direction === "up"
      ? "long"
      : direction === "strong_down" || direction === "down"
        ? "short"
        : "wait";
  if (directionSide === "wait")
    return {
      ...base,
      direction,
      atr5,
      score,
      closeSlope: slope,
      momentum3: momentumNorm,
      closeLocation,
      noTradeReasonCodes: ["quant_baseline_range"],
    };
  const zoneType = directionSide === "long" ? "pullback" : "return_sell";
  const span = forecastHighRaw - forecastLowRaw;
  const zone32 =
    directionSide === "long"
      ? forecastLowRaw + span * 0.32
      : forecastHighRaw - span * 0.32;
  const target58 =
    directionSide === "long"
      ? forecastLowRaw + span * 0.58
      : forecastHighRaw - span * 0.58;
  const unrounded =
    directionSide === "long"
      ? {
          forecastLow: forecastLowRaw,
          forecastHigh: forecastHighRaw,
          zoneLow: forecastLowRaw,
          zoneHigh: zone32,
          confirmPrice: zone32,
          firstTarget: target58,
          stretchTarget: forecastHighRaw,
          stopReference: Math.min(forecastLowRaw, forecastLowRaw - 0.15 * atr5),
        }
      : {
          forecastLow: forecastLowRaw,
          forecastHigh: forecastHighRaw,
          zoneLow: zone32,
          zoneHigh: forecastHighRaw,
          confirmPrice: zone32,
          firstTarget: target58,
          stretchTarget: forecastLowRaw,
          stopReference: Math.max(
            forecastHighRaw,
            forecastHighRaw + 0.15 * atr5
          ),
        };
  let forecastLow = roundToTick(unrounded.forecastLow);
  let forecastHigh = roundToTick(unrounded.forecastHigh);
  let zoneLow = roundToTick(unrounded.zoneLow);
  let zoneHigh = roundToTick(unrounded.zoneHigh);
  if (directionSide === "long") {
    zoneLow = Math.max(zoneLow, forecastLow + jpxTickSize(forecastLow));
    zoneHigh = Math.max(zoneHigh, zoneLow);
    forecastHigh = Math.max(forecastHigh, zoneHigh + jpxTickSize(zoneHigh));
  } else {
    zoneHigh = Math.min(zoneHigh, forecastHigh - jpxTickSize(forecastHigh));
    zoneLow = Math.min(zoneLow, zoneHigh);
    forecastLow = Math.min(forecastLow, zoneLow - jpxTickSize(zoneLow));
  }
  const confirmPrice = Math.min(
    Math.max(roundToTick(unrounded.confirmPrice), zoneLow),
    zoneHigh
  );
  const firstTarget =
    directionSide === "long"
      ? Math.max(
          roundToTick(unrounded.firstTarget),
          confirmPrice + jpxTickSize(confirmPrice)
        )
      : Math.min(
          roundToTick(unrounded.firstTarget),
          confirmPrice - jpxTickSize(confirmPrice)
        );
  const stretchTarget =
    directionSide === "long"
      ? Math.max(roundToTick(unrounded.stretchTarget), firstTarget)
      : Math.min(roundToTick(unrounded.stretchTarget), firstTarget);
  return {
    ...base,
    direction,
    atr5: roundAudit(atr5),
    score: roundAudit(score),
    closeSlope: roundAudit(slope),
    momentum3: roundAudit(momentumNorm),
    closeLocation: roundAudit(closeLocation),
    zoneType,
    forecastLow,
    forecastHigh,
    zoneLow,
    zoneHigh,
    confirmPrice,
    firstTarget,
    stretchTarget,
    stopReference: roundToTick(unrounded.stopReference),
    originalUnroundedPrices: Object.fromEntries(
      Object.entries(unrounded).map(([key, value]) => [key, roundAudit(value)])
    ),
  };
}

function dailyBarsFromCandles(candles: Candle[]) {
  const byDate = new Map<string, Candle[]>();
  for (const candle of candles)
    byDate.set(candle.tradeDate, [
      ...(byDate.get(candle.tradeDate) ?? []),
      candle,
    ]);
  return Array.from(byDate.values())
    .map(day => {
      const ordered = [...day].sort((a, b) =>
        a.candleTime.localeCompare(b.candleTime)
      );
      const first = ordered[0]!;
      const last = ordered.at(-1)!;
      const distinct = new Set(ordered.map(bar => bar.candleTime));
      const duplicateMinuteCount = ordered.length - distinct.size;
      const maxGapMinutes = maxIntraSessionGap(ordered);
      const reasons: string[] = [];
      if (distinct.size < 250) reasons.push("minute_bars_below_250");
      if (duplicateMinuteCount > 0) reasons.push("duplicate_minute_present");
      if (first.candleTime > "09:10" || last.candleTime < "15:15")
        reasons.push("session_coverage_incomplete");
      return {
        tradeDate: first.tradeDate,
        open: first.open,
        high: Math.max(...ordered.map(bar => bar.high)),
        low: Math.min(...ordered.map(bar => bar.low)),
        close: last.close,
        volume: ordered.reduce((sum, bar) => sum + bar.volume, 0),
        barCount: ordered.length,
        distinctMinuteCount: distinct.size,
        firstTime: first.candleTime,
        lastTime: last.candleTime,
        duplicateMinuteCount,
        maxGapMinutes,
        usable: reasons.length === 0,
        qualityReasons: reasons,
      } satisfies DailyBar;
    })
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

export type AiDailyForecastInput = {
  tradeDate: string;
  dataCutoffDate: string;
  capturedAtMs: number;
  macroSnapshot: Record<string, unknown> | null;
  macroSnapshotId: string | null;
  learningSnapshot?: {
    sourceSnapshotId: string;
    asOfDate: string;
    modelVersion: string;
    payloadHash: string;
    learning: unknown;
  } | null;
  learningApplicationAudit: LearningApplicationAudit;
  /** Only a review strictly before tradeDate; advisory review cannot mutate app rules. */
  latestLearningReview?: LearningReviewApplication;
  symbols: Array<{
    symbol: AiDailyForecastSymbol;
    baseline: QuantBaseline;
    dailyBars: DailyBar[];
  }>;
  inputQuality: Quality;
  qualityReasonCodes: string[];
  inputHash?: string;
};

export async function buildAiDailyForecastInput(input: {
  tradeDate: string;
  capturedAtMs?: number;
}): Promise<AiDailyForecastInput> {
  const db = await getDb();
  if (!db) throw new Error("database_unavailable");
  const capturedAtMs = input.capturedAtMs ?? Date.now();
  const dataCutoffDate = previousTradeDate(input.tradeDate);
  const [macro, learningRows, rows, latestLearningReview] = await Promise.all([
    db
      .select()
      .from(rtPremarketContextSnapshots)
      .where(eq(rtPremarketContextSnapshots.tradeDate, input.tradeDate))
      .orderBy(
        desc(rtPremarketContextSnapshots.capturedAtMs),
        desc(rtPremarketContextSnapshots.id)
      )
      .limit(1),
    db
      .select()
      .from(rtAiForecastLearningSnapshots)
      .where(
        and(
          lt(rtAiForecastLearningSnapshots.asOfDate, input.tradeDate),
          eq(
            rtAiForecastLearningSnapshots.modelVersion,
            AI_FORECAST_LEARNING_MODEL_VERSION
          ),
          eq(rtAiForecastLearningSnapshots.qualityStatus, "verified")
        )
      )
      .orderBy(
        desc(rtAiForecastLearningSnapshots.asOfDate),
        desc(rtAiForecastLearningSnapshots.id)
      )
      .limit(1),
    db
      .select()
      .from(rtCandles)
      .where(
        and(
          inArray(rtCandles.symbol, [...AI_DAILY_FORECAST_SYMBOLS]),
          lte(rtCandles.tradeDate, dataCutoffDate),
          gte(rtCandles.tradeDate, subtractCalendarDays(dataCutoffDate, 45))
        )
      )
      .orderBy(
        asc(rtCandles.tradeDate),
        asc(rtCandles.candleTime),
        asc(rtCandles.id)
      ),
    getLatestLearningReviewApplicationBefore(input.tradeDate),
  ]);
  const macroSnapshot = macro[0] ?? null;
  const learningSnapshot = learningRows[0] ?? null;
  const symbolInputs = AI_DAILY_FORECAST_SYMBOLS.map(symbol => {
    const candles = rows
      .filter(row => row.symbol === symbol)
      .map(row => ({
        tradeDate: row.tradeDate,
        candleTime: row.candleTime,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      }));
    const dailyBars = dailyBarsFromCandles(candles);
    return {
      symbol,
      dailyBars,
      baseline: buildQuantBaseline(symbol, dailyBars),
    };
  });
  const reasons: string[] = [];
  if (!macroSnapshot) reasons.push("premarket_snapshot_missing");
  else {
    const jstMinute = jstMinuteOfDay(macroSnapshot.capturedAtMs);
    if (jstMinute > 9 * 60 || macroSnapshot.capturedAtMs <= 0)
      reasons.push("premarket_snapshot_after_0900_jst");
    if (macroSnapshot.qualityStatus === "invalid")
      reasons.push("premarket_snapshot_invalid");
  }
  if (symbolInputs.some(item => item.baseline.direction === "insufficient"))
    reasons.push("one_or_more_symbols_insufficient_history");
  const learningReason = !learningSnapshot
    ? "verified_learning_snapshot_before_trade_date_missing"
    : null;
  const learningApplicationAudit = buildLearningApplicationAudit({
    checkpoint: "08:30",
    baselines: symbolInputs.map(item => ({
      symbol: item.symbol,
      baseline: item.baseline,
    })),
    macroRegime:
      macroSnapshot && typeof macroSnapshot.regimeState === "string"
        ? macroSnapshot.regimeState
        : null,
    learningSnapshot: learningSnapshot
      ? {
          sourceSnapshotId: learningSnapshot.sourceSnapshotId,
          asOfDate: learningSnapshot.asOfDate,
          modelVersion: learningSnapshot.modelVersion,
          payloadHash: learningSnapshot.payloadHash,
          learning: learningSnapshot.learningJson,
        }
      : null,
  });
  const prepared = {
    tradeDate: input.tradeDate,
    dataCutoffDate,
    capturedAtMs,
    macroSnapshot: macroSnapshot
      ? {
          sourceSnapshotId: macroSnapshot.sourceSnapshotId,
          capturedAtMs: macroSnapshot.capturedAtMs,
          qualityStatus: macroSnapshot.qualityStatus,
          regimeState: macroSnapshot.regimeState,
          confidence: macroSnapshot.confidence,
          input: macroSnapshot.inputJson,
          result: macroSnapshot.resultJson,
        }
      : null,
    macroSnapshotId: macroSnapshot?.sourceSnapshotId ?? null,
    learningSnapshot: learningSnapshot
      ? {
          sourceSnapshotId: learningSnapshot.sourceSnapshotId,
          asOfDate: learningSnapshot.asOfDate,
          modelVersion: learningSnapshot.modelVersion,
          payloadHash: learningSnapshot.payloadHash,
          learning: learningSnapshot.learningJson,
        }
      : null,
    learningApplicationAudit,
    latestLearningReview,
    symbols: symbolInputs,
    inputQuality:
      reasons.length === 0 ? ("verified" as const) : ("degraded" as const),
    qualityReasonCodes: Array.from(
      new Set([
        ...reasons,
        ...(learningReason ? [learningReason] : []),
        ...latestLearningReview.reasonCodes,
      ])
    ),
  };
  return { ...prepared, inputHash: aiDailyForecastInputHash(prepared) };
}

function previousTradeDate(date: string) {
  const probe = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(probe.getTime())) throw Error("invalid_trade_date");
  for (let i = 0; i < 8; i += 1) {
    probe.setUTCDate(probe.getUTCDate() - 1);
    const candidate = probe.toISOString().slice(0, 10);
    if (nextTokyoEquityTradeDate(candidate) === date) return candidate;
  }
  throw Error("previous_trade_date_unavailable");
}
function subtractCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
function jstMinuteOfDay(epochMs: number) {
  const jst = new Date(epochMs + 9 * 60 * 60 * 1_000);
  return jst.getUTCHours() * 60 + jst.getUTCMinutes();
}

const aiForecastRowSchema = z
  .object({
    symbol: z.enum(AI_DAILY_FORECAST_SYMBOLS),
    direction: z.enum([
      "strong_up",
      "up",
      "range",
      "down",
      "strong_down",
      "insufficient",
      "stale",
    ]),
    forecastLow: z.number().positive().nullable(),
    forecastHigh: z.number().positive().nullable(),
    zoneType: z.enum(["pullback", "return_sell", "none"]),
    zoneLow: z.number().positive().nullable(),
    zoneHigh: z.number().positive().nullable(),
    confirmPrice: z.number().positive().nullable(),
    firstTarget: z.number().positive().nullable(),
    stretchTarget: z.number().positive().nullable(),
    baselineDecision: z.enum(["maintained", "adjusted", "reference_only"]),
    aiAdjustment: z
      .object({
        reason: z.string().min(1).max(320),
        exceptionReason: z.string().max(320).nullable(),
      })
      .strict(),
    rationale: z.string().min(1).max(480),
    evidenceUsed: z.array(z.string().min(1).max(120)).min(1).max(10),
    macroAgreement: z.enum(["aligned", "conflicted", "mixed", "unavailable"]),
    confidenceBasis: z.array(z.string().min(1).max(120)).min(1).max(10),
  })
  .strict();
const aiOutputSchema = z
  .object({
    forecasts: z.array(aiForecastRowSchema).length(10),
    marketSummary: z.string().min(1).max(600),
    globalReasonCodes: z.array(z.string().min(1).max(120)).min(1).max(10),
  })
  .strict();
export type AiDailyForecastOutput = z.infer<typeof aiOutputSchema>;

export function validateAiDailyForecastOutput(
  raw: unknown,
  input: AiDailyForecastInput
) {
  const parsed = aiOutputSchema.safeParse(raw);
  const reasons: string[] = [];
  if (!parsed.success)
    return {
      valid: false,
      output: null,
      reasonCodes: ["ai_output_schema_invalid"],
    };
  const output = parsed.data;
  const symbolMap = new Map(
    input.symbols.map(item => [item.symbol, item.baseline])
  );
  const seen = new Set<string>();
  for (const row of output.forecasts) {
    if (seen.has(row.symbol)) reasons.push(`duplicate_symbol:${row.symbol}`);
    seen.add(row.symbol);
    const base = symbolMap.get(row.symbol)!;
    const directional =
      row.direction === "strong_up" ||
      row.direction === "up" ||
      row.direction === "down" ||
      row.direction === "strong_down";
    const prices = [
      row.forecastLow,
      row.forecastHigh,
      row.zoneLow,
      row.zoneHigh,
      row.confirmPrice,
      row.firstTarget,
      row.stretchTarget,
    ];
    if (!directional && prices.some(value => value !== null))
      reasons.push(`non_directional_prices_present:${row.symbol}`);
    if (directional && prices.some(value => value === null))
      reasons.push(`directional_prices_missing:${row.symbol}`);
    if (
      directional &&
      !(
        row.forecastLow! < row.zoneLow! &&
        row.zoneLow! <= row.zoneHigh! &&
        row.zoneHigh! < row.forecastHigh!
      )
    )
      reasons.push(`price_order_invalid:${row.symbol}`);
    if (
      directional &&
      (row.direction === "strong_up" || row.direction === "up") &&
      !(
        row.confirmPrice! >= row.zoneLow! &&
        row.confirmPrice! <= row.zoneHigh! &&
        row.firstTarget! > row.confirmPrice! &&
        row.stretchTarget! >= row.firstTarget!
      )
    )
      reasons.push(`long_levels_invalid:${row.symbol}`);
    if (
      directional &&
      (row.direction === "strong_down" || row.direction === "down") &&
      !(
        row.confirmPrice! >= row.zoneLow! &&
        row.confirmPrice! <= row.zoneHigh! &&
        row.firstTarget! < row.confirmPrice! &&
        row.stretchTarget! <= row.firstTarget!
      )
    )
      reasons.push(`short_levels_invalid:${row.symbol}`);
    if (base.atr5 && row.baselineDecision === "adjusted") {
      const compared = [
        ["forecastLow", row.forecastLow, base.forecastLow],
        ["forecastHigh", row.forecastHigh, base.forecastHigh],
        ["zoneLow", row.zoneLow, base.zoneLow],
        ["zoneHigh", row.zoneHigh, base.zoneHigh],
        ["confirmPrice", row.confirmPrice, base.confirmPrice],
        ["firstTarget", row.firstTarget, base.firstTarget],
      ] as const;
      const exceeded = compared.some(
        ([, actual, baseline]) =>
          actual !== null &&
          baseline !== null &&
          Math.abs(actual - baseline) > base.atr5! * 0.75 + jpxTickSize(actual)
      );
      if (exceeded && !row.aiAdjustment.exceptionReason)
        reasons.push(
          `adjustment_exceeds_075_atr_without_exception:${row.symbol}`
        );
    }
  }
  for (const symbol of AI_DAILY_FORECAST_SYMBOLS)
    if (!seen.has(symbol)) reasons.push(`missing_symbol:${symbol}`);
  return { valid: reasons.length === 0, output, reasonCodes: reasons };
}

export async function insertAiDailyForecastSnapshot(
  data: Omit<InsertRtAiDailyForecastSnapshot, "id" | "createdAt">
) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const existing = await getAiDailyForecastSnapshot(data.sourceSnapshotId);
  if (existing) {
    if (existing.payloadHash !== data.payloadHash)
      throw Error("ai_daily_forecast_idempotency_payload_mismatch");
    return existing;
  }
  await db.insert(rtAiDailyForecastSnapshots).values(data);
  const created = await getAiDailyForecastSnapshot(data.sourceSnapshotId);
  if (!created) throw Error("ai_daily_forecast_snapshot_missing_after_insert");
  return created;
}
export async function getAiDailyForecastSnapshot(sourceSnapshotId: string) {
  const db = await getDb();
  if (!db) return null;
  return (
    (
      await db
        .select()
        .from(rtAiDailyForecastSnapshots)
        .where(
          eq(rtAiDailyForecastSnapshots.sourceSnapshotId, sourceSnapshotId)
        )
        .limit(1)
    )[0] ?? null
  );
}
export async function getLatestAiDailyForecastSnapshot(tradeDate: string) {
  const db = await getDb();
  if (!db) return null;
  return (
    (
      await db
        .select()
        .from(rtAiDailyForecastSnapshots)
        .where(eq(rtAiDailyForecastSnapshots.tradeDate, tradeDate))
        .orderBy(
          desc(rtAiDailyForecastSnapshots.capturedAtMs),
          desc(rtAiDailyForecastSnapshots.id)
        )
        .limit(1)
    )[0] ?? null
  );
}
export async function getAiDailyForecastDashboard(tradeDate: string) {
  const snapshot = await getLatestAiDailyForecastSnapshot(tradeDate);
  if (!snapshot) return { snapshot: null, revisions: [] };
  const db = await getDb();
  if (!db) return { snapshot, revisions: [] };
  const revisions = await db
    .select()
    .from(rtAiDailyForecastRevisions)
    .where(
      eq(rtAiDailyForecastRevisions.sourceSnapshotId, snapshot.sourceSnapshotId)
    )
    .orderBy(
      asc(rtAiDailyForecastRevisions.checkpoint),
      asc(rtAiDailyForecastRevisions.id)
    );
  return { snapshot, revisions };
}

export function aiDailyForecastInputHash(input: AiDailyForecastInput) {
  const {
    capturedAtMs: _capturedAtMs,
    inputHash: _inputHash,
    ...immutableInput
  } = input;
  return sha256Stable(immutableInput);
}

export type AiDailyForecastExternalSubmission = {
  sourceSnapshotId: string;
  tradeDate: string;
  capturedAtMs: number;
  sourceMode: "scheduled_ai_forecast" | "manual_dry_run";
  inputHash: string;
  quantBaseline: unknown;
  aiFinalForecast: unknown;
  generatorId: string;
  promptVersion: string;
  generatorMetadata?: Record<string, unknown>;
};

/**
 * Codex定期タスクからの認証済みpayloadを検証して一度だけ保存する。
 * アプリはLLMを呼ばず、read-only input APIとこのingest endpointだけを担当する。
 */
export async function ingestAiDailyForecastSubmission(
  submission: AiDailyForecastExternalSubmission
) {
  if (
    !/^ai-daily-forecast:\d{4}-\d{2}-\d{2}:[a-z0-9._:-]{1,120}$/i.test(
      submission.sourceSnapshotId
    )
  )
    throw Error("ai_daily_forecast_source_snapshot_id_invalid");
  if (
    !Number.isInteger(submission.capturedAtMs) ||
    submission.capturedAtMs <= 0
  )
    throw Error("ai_daily_forecast_captured_at_invalid");
  const minute = jstMinuteOfDay(submission.capturedAtMs);
  if (minute < 8 * 60 + 30 || minute >= 9 * 60)
    throw Error("ai_daily_forecast_capture_outside_0830_0900_jst");
  const prepared = await buildAiDailyForecastInput({
    tradeDate: submission.tradeDate,
    capturedAtMs: submission.capturedAtMs,
  });
  const expectedInputHash = aiDailyForecastInputHash(prepared);
  if (submission.inputHash !== expectedInputHash)
    throw Error("ai_daily_forecast_input_hash_mismatch");
  const expectedBaselineHash = sha256Stable(
    prepared.symbols.map(item => item.baseline)
  );
  if (sha256Stable(submission.quantBaseline) !== expectedBaselineHash)
    throw Error("ai_daily_forecast_quant_baseline_mismatch");
  const validation = validateAiDailyForecastOutput(
    submission.aiFinalForecast,
    prepared
  );
  if (!validation.valid || !validation.output)
    throw Error(
      `ai_daily_forecast_validation_failed:${validation.reasonCodes.join(",")}`
    );
  const payload = {
    sourceSnapshotId: submission.sourceSnapshotId,
    tradeDate: prepared.tradeDate,
    dataCutoffDate: prepared.dataCutoffDate,
    modelVersion: AI_DAILY_FORECAST_VERSION,
    sourceMode: submission.sourceMode,
    macroSnapshotId: prepared.macroSnapshotId,
    inputHash: expectedInputHash,
    generatorId: submission.generatorId,
    promptVersion: submission.promptVersion,
    quantBaseline: prepared.symbols.map(item => item.baseline),
    aiFinalForecast: validation.output,
    generatorMetadata: submission.generatorMetadata ?? {},
    learningApplicationAudit: prepared.learningApplicationAudit,
    latestLearningReview: prepared.latestLearningReview,
    validation: {
      inputQuality: prepared.inputQuality,
      inputReasons: prepared.qualityReasonCodes,
      outputValid: true,
      outputReasons: validation.reasonCodes,
    },
  };
  const payloadHash = sha256Stable(payload);
  return insertAiDailyForecastSnapshot({
    sourceSnapshotId: submission.sourceSnapshotId,
    tradeDate: prepared.tradeDate,
    capturedAtMs: submission.capturedAtMs,
    dataCutoffDate: prepared.dataCutoffDate,
    modelVersion: AI_DAILY_FORECAST_VERSION,
    sourceMode: submission.sourceMode,
    macroSnapshotId: prepared.macroSnapshotId,
    inputHash: expectedInputHash,
    payloadHash,
    qualityStatus:
      prepared.inputQuality === "verified" ? "verified" : "degraded",
    aiModelId: submission.generatorId,
    promptVersion: submission.promptVersion,
    inferenceAtMs: submission.capturedAtMs,
    inputJson: prepared,
    forecastJson: payload,
    validationJson: payload.validation,
  });
}

/** Immutable revision append: only the five named ④ checkpoints are accepted. */
export async function appendAiDailyForecastRevision(input: {
  sourceSnapshotId: string;
  revisionSourceEventId: string;
  tradeDate: string;
  checkpoint: "09:05" | "09:15" | "10:00" | "12:35" | "13:30";
  resultJson: Record<string, unknown>;
  revisionStatus: "no_change" | "market_context_invalidated" | "invalid";
}) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  await db
    .insert(rtAiDailyForecastRevisions)
    .values(input)
    .onDuplicateKeyUpdate({
      set: { sourceSnapshotId: input.sourceSnapshotId },
    });
}

export async function evaluateAiDailyForecastMarketContextRevision(input: {
  sourceEventId: string;
  tradeDate: string;
  candleTime: string;
}) {
  const allowed = new Set(["09:05", "09:15", "10:00", "12:35", "13:30"]);
  if (!allowed.has(input.candleTime)) return null;
  const snapshot = await getLatestAiDailyForecastSnapshot(input.tradeDate);
  if (!snapshot) return null;
  const db = await getDb();
  if (!db) return null;
  const event = (
    await db
      .select()
      .from(rtMarketContextEvents)
      .where(eq(rtMarketContextEvents.sourceEventId, input.sourceEventId))
      .limit(1)
  )[0];
  if (!event || event.qualityStatus !== "verified") return null;
  const forecast = snapshot.forecastJson as Record<string, unknown>;
  const immutableInput = snapshot.inputJson as Record<string, unknown>;
  const macro = object(immutableInput.macroSnapshot);
  const regimeState =
    typeof macro.regimeState === "string" ? macro.regimeState : "unavailable";
  const miniDirection =
    Number(event.close) > Number(event.open)
      ? "up"
      : Number(event.close) < Number(event.open)
        ? "down"
        : "flat";
  const opposing =
    ((regimeState === "up" || regimeState === "strong_up") &&
      miniDirection === "down") ||
    ((regimeState === "down" || regimeState === "strong_down") &&
      miniDirection === "up");
  const status = opposing
    ? ("market_context_invalidated" as const)
    : ("no_change" as const);
  await appendAiDailyForecastRevision({
    sourceSnapshotId: snapshot.sourceSnapshotId,
    revisionSourceEventId: input.sourceEventId,
    tradeDate: input.tradeDate,
    checkpoint: input.candleTime as
      | "09:05"
      | "09:15"
      | "10:00"
      | "12:35"
      | "13:30",
    revisionStatus: status,
    resultJson: {
      marketContextEventId: event.id,
      qualityStatus: event.qualityStatus,
      open: Number(event.open),
      close: Number(event.close),
      premarketRegimeState: regimeState,
      miniDirection,
      originalForecastPresent: Boolean(forecast.aiFinalForecast),
      entryRule: opposing
        ? "disable_unentered_ai_daily_forecast_signals_only"
        : "no_change",
      reasonCodes: [
        opposing
          ? "nikkei_mini_opposes_frozen_premarket_regime"
          : "nikkei_mini_not_opposing_frozen_premarket_regime",
        "immutable_morning_snapshot_not_updated",
      ],
    },
  });
  return { status };
}
