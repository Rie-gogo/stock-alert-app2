import { and, asc, desc, eq, inArray, lt, lte } from "drizzle-orm";
import {
  rtAiDailyForecastSnapshots,
  rtAiForecastLearningSnapshots,
  rtAiIntradayForecastSnapshots,
  rtCandles,
  rtForwardShadowEvents,
  rtForwardShadowTrades,
  rtMarketContextEvents,
  type InsertRtAiForecastLearningSnapshot,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  AI_DAILY_FORECAST_SYMBOLS,
  type AiDailyForecastSymbol,
} from "./aiDailyForecastService";
import { AI_FORECAST_LEARNING_MODEL_VERSION } from "./aiForecastLearningContract";
import {
  AI_DAILY_FORECAST_VERSIONS,
  RETIRED_AI_ADAPTIVE_FORECAST_V2_VERSIONS,
  RETIRED_AI_DAILY_FORECAST_V1_VERSIONS,
  RETIRED_AI_FORECAST_LEARNING_V3_VERSIONS,
  RETIRED_AI_FORECAST_LEARNING_V4_VERSIONS,
  sha256Stable,
} from "./runtimeIdentity";

export { AI_FORECAST_LEARNING_MODEL_VERSION } from "./aiForecastLearningContract";
export const AI_FORECAST_LEARNING_COMPONENT = "ai_forecast_learning_snapshot";
export const AI_FORECAST_LEARNING_MATERIALIZATION_VERSION =
  "ai-forecast-learning-materialized-v1";
export const AI_FORECAST_LEARNING_MAX_BYTES = 180_000;

const symbols = new Set<string>(AI_DAILY_FORECAST_SYMBOLS);
const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
export function calculateOpeningGapPct(
  dayOpen: number | null,
  previousClose: number | null
) {
  if (
    dayOpen === null ||
    previousClose === null ||
    !Number.isFinite(dayOpen) ||
    !Number.isFinite(previousClose) ||
    previousClose <= 0
  )
    return null;
  return round((dayOpen / previousClose - 1) * 100);
}
export function selectCausalMiniEvent<
  T extends { candleTime: string; qualityStatus: string },
>(events: readonly T[], entryCandleTime: string) {
  return (
    events
      .filter(
        item =>
          item.candleTime <= entryCandleTime && item.qualityStatus !== "invalid"
      )
      .at(-1) ?? null
  );
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const round = (value: number | null, digits = 6) =>
  value === null ? null : Number(value.toFixed(digits));
const minute = (time: string | null | undefined) => {
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [hour, minutePart] = time.split(":").map(Number);
  return hour * 60 + minutePart;
};

type Candle = {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type LearningFeature = Record<string, unknown>;
type CauseCandidate = {
  tag: string;
  usesFuture: boolean;
  evidence: Record<string, unknown>;
  judgementVersion: "ai-forecast-learning-v2";
};

type LearningExample = {
  source: "reference_v1_v2" | "current_v3";
  tradeDate: string;
  symbol: string;
  side: "long" | "short";
  checkpoint: string | null;
  macroRegime: string | null;
  entry: LearningFeature;
  diagnosisOnly: LearningFeature;
  causeCandidates: CauseCandidate[];
};

function sma(values: number[], period: number) {
  if (values.length < period) return null;
  const sample = values.slice(-period);
  return sample.reduce((sum, value) => sum + value, 0) / period;
}

function rsiWilder(values: number[], period = 14) {
  if (values.length < period + 1) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]!);
  let gain =
    changes
      .slice(0, period)
      .reduce((sum, value) => sum + Math.max(0, value), 0) / period;
  let loss =
    changes
      .slice(0, period)
      .reduce((sum, value) => sum + Math.max(0, -value), 0) / period;
  for (const change of changes.slice(period)) {
    gain = (gain * (period - 1) + Math.max(0, change)) / period;
    loss = (loss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function bollinger(values: number[], period = 20) {
  if (values.length < period)
    return {
      middle: null,
      upper2: null,
      lower2: null,
      widthPct: null,
      zScore: null,
    };
  const sample = values.slice(-period);
  const middle = sample.reduce((sum, value) => sum + value, 0) / period;
  const deviation = Math.sqrt(
    sample.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period
  );
  const latest = values.at(-1)!;
  return {
    middle: round(middle),
    upper2: round(middle + 2 * deviation),
    lower2: round(middle - 2 * deviation),
    widthPct: middle > 0 ? round(((4 * deviation) / middle) * 100) : null,
    zScore: deviation > 0 ? round((latest - middle) / deviation) : null,
  };
}

function completedFiveMinuteBars(candles: Candle[]) {
  const buckets = new Map<number, Candle[]>();
  for (const candle of candles) {
    const candleMinute = minute(candle.candleTime);
    if (candleMinute === null) continue;
    const sessionStart = candleMinute < 12 * 60 + 30 ? 9 * 60 : 12 * 60 + 30;
    if (candleMinute < sessionStart) continue;
    const bucket =
      sessionStart + Math.floor((candleMinute - sessionStart) / 5) * 5;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), candle]);
  }
  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .flatMap(([bucket, rows]) => {
      const sorted = [...rows].sort((left, right) =>
        left.candleTime.localeCompare(right.candleTime)
      );
      const expected = Array.from({ length: 5 }, (_, index) => {
        const value = bucket + index;
        return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
      });
      if (
        sorted.length !== 5 ||
        expected.some((value, index) => sorted[index]?.candleTime !== value)
      )
        return [];
      return [
        {
          candleTime: sorted.at(-1)!.candleTime,
          open: sorted[0]!.open,
          high: Math.max(...sorted.map(row => row.high)),
          low: Math.min(...sorted.map(row => row.low)),
          close: sorted.at(-1)!.close,
          volume: sorted.reduce((sum, row) => sum + row.volume, 0),
        },
      ];
    });
}

function directionFromSma(value: number | null, sma20: number | null) {
  if (value === null || sma20 === null) return "unavailable";
  return value > sma20 ? "up" : value < sma20 ? "down" : "flat";
}

function snapshotFromCandles(
  candles: Candle[],
  entryTime: string
): LearningFeature {
  const observed = candles
    .filter(candle => candle.candleTime <= entryTime)
    .sort((left, right) => left.candleTime.localeCompare(right.candleTime));
  const closes = observed.map(candle => candle.close);
  const five = completedFiveMinuteBars(observed);
  const fiveCloses = five.map(candle => candle.close);
  const first = observed[0] ?? null;
  const latest = observed.at(-1) ?? null;
  const recent = observed.slice(-30);
  const one = bollinger(closes);
  const fiveBollinger = bollinger(fiveCloses);
  const sessionHigh = observed.length
    ? Math.max(...observed.map(candle => candle.high))
    : null;
  const sessionLow = observed.length
    ? Math.min(...observed.map(candle => candle.low))
    : null;
  const previous = observed.length > 1 ? observed.at(-2)! : null;
  return {
    observedAtOrBeforeEntry: true,
    candle: latest
      ? {
          candleTime: latest.candleTime,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
          volume: latest.volume,
        }
      : null,
    sessionOpen: first?.open ?? null,
    sessionHigh,
    sessionLow,
    changeFromOpenPct:
      first && latest ? round((latest.close / first.open - 1) * 100) : null,
    oneMinute: {
      sma5: round(sma(closes, 5)),
      sma10: round(sma(closes, 10)),
      sma20: round(sma(closes, 20)),
      rsi14: round(rsiWilder(closes)),
      bollinger20: one,
    },
    fiveMinute: {
      completedBars: five.length,
      sma5: round(sma(fiveCloses, 5)),
      sma10: round(sma(fiveCloses, 10)),
      sma20: round(sma(fiveCloses, 20)),
      rsi14: round(rsiWilder(fiveCloses)),
      bollinger20: fiveBollinger,
    },
    bbZScore: one.zScore,
    recentHigh30: recent.length
      ? Math.max(...recent.map(candle => candle.high))
      : null,
    recentLow30: recent.length
      ? Math.min(...recent.map(candle => candle.low))
      : null,
    sessionHighUpdated: latest
      ? latest.high >=
        (previous
          ? Math.max(...observed.slice(0, -1).map(candle => candle.high))
          : latest.high)
      : false,
    sessionLowUpdated: latest
      ? latest.low <=
        (previous
          ? Math.min(...observed.slice(0, -1).map(candle => candle.low))
          : latest.low)
      : false,
    recentHighUpdated: latest
      ? latest.high >=
        (recent.length > 1
          ? Math.max(...recent.slice(0, -1).map(candle => candle.high))
          : latest.high)
      : false,
    recentLowUpdated: latest
      ? latest.low <=
        (recent.length > 1
          ? Math.min(...recent.slice(0, -1).map(candle => candle.low))
          : latest.low)
      : false,
    fiveMinuteSma20Direction: directionFromSma(
      latest?.close ?? null,
      sma(fiveCloses, 20)
    ),
  };
}

function outcomeFromCandles(
  candles: Candle[],
  trade: {
    side: "long" | "short";
    entryCandleTime: string;
    entryPrice: unknown;
    exitCandleTime: string | null;
    exitPrice: unknown;
    exitReason: string | null;
    pnl: unknown;
    realizedR: unknown;
  },
  plan: {
    firstTarget: number | null;
    stretchTarget: number | null;
    stopPrice: number | null;
  },
  relatedEvents: Array<typeof rtForwardShadowEvents.$inferSelect>
) {
  const ordered = [...candles].sort((left, right) =>
    left.candleTime.localeCompare(right.candleTime)
  );
  const entryIndex = ordered.findIndex(
    candle => candle.candleTime === trade.entryCandleTime
  );
  const exitIndex = trade.exitCandleTime
    ? ordered.findIndex(candle => candle.candleTime === trade.exitCandleTime)
    : -1;
  const held =
    entryIndex < 0 || exitIndex < entryIndex
      ? []
      : ordered.slice(entryIndex, exitIndex + 1);
  const postExit = exitIndex >= 0 ? ordered.slice(exitIndex + 1) : [];
  const entryPrice = finite(trade.entryPrice);
  const pct = (price: number | null) =>
    entryPrice && price !== null
      ? round(
          (trade.side === "long"
            ? price / entryPrice - 1
            : entryPrice / price - 1) * 100
        )
      : null;
  const favorable =
    held.length && entryPrice !== null
      ? trade.side === "long"
        ? Math.max(...held.map(candle => candle.high))
        : Math.min(...held.map(candle => candle.low))
      : null;
  const adverse =
    held.length && entryPrice !== null
      ? trade.side === "long"
        ? Math.min(...held.map(candle => candle.low))
        : Math.max(...held.map(candle => candle.high))
      : null;
  const returnReasons: string[] = [];
  const returnAt = (minutes: number) => {
    if (entryIndex < 0 || entryPrice === null) return null;
    const value = minute(trade.entryCandleTime);
    if (value === null) return null;
    const expected = value + minutes;
    const target = `${String(Math.floor(expected / 60)).padStart(2, "0")}:${String(expected % 60).padStart(2, "0")}`;
    const candle = ordered.find(item => item.candleTime === target);
    if (!candle) {
      returnReasons.push(`return_${minutes}m_exact_candle_missing`);
      return null;
    }
    return pct(candle.close);
  };
  const reachedAt = (kind: "target" | "stop" | "stretch") => {
    const price =
      kind === "target"
        ? plan.firstTarget
        : kind === "stretch"
          ? plan.stretchTarget
          : plan.stopPrice;
    if (price === null || held.length === 0) return null;
    const matching = held.find(candle =>
      trade.side === "long"
        ? kind === "stop"
          ? candle.low <= price
          : candle.high >= price
        : kind === "stop"
          ? candle.high >= price
          : candle.low <= price
    );
    return matching?.candleTime ?? null;
  };
  const eventActions = relatedEvents.flatMap(event => {
    const actions = Array.isArray(record(event.decisionJson).actions)
      ? (record(event.decisionJson).actions as unknown[]).map(record)
      : [];
    return actions.map(action => ({ event, action }));
  });
  const zoneEvidence = eventActions.find(
    item => item.action.type === "zone_touched"
  );
  const entryEvidence = eventActions.find(item => item.action.type === "entry");
  const exitEvidence = eventActions.filter(item => item.action.type === "exit");
  const targetEvidence = exitEvidence.find(item =>
    ["first_target", "target", "take_profit"].includes(
      String(item.action.reason)
    )
  );
  const stopEvidence = exitEvidence.find(
    item => String(item.action.reason) === "stop_loss"
  );
  const stretchEvidence = exitEvidence.find(item =>
    ["stretch_target", "second_target"].includes(String(item.action.reason))
  );
  const targetReachedAt = reachedAt("target");
  const stopReachedAt = reachedAt("stop");
  const stretchTargetReachedAt = reachedAt("stretch");
  const sameBar = targetReachedAt !== null && targetReachedAt === stopReachedAt;
  const stopIndex = stopReachedAt
    ? ordered.findIndex(candle => candle.candleTime === stopReachedAt)
    : -1;
  const laterTarget =
    stopIndex >= 0 && plan.firstTarget !== null
      ? ordered
          .slice(stopIndex + 1)
          .some(candle =>
            trade.side === "long"
              ? candle.high >= plan.firstTarget!
              : candle.low <= plan.firstTarget!
          )
      : null;
  return {
    diagnosisOnly: true,
    exitTime: trade.exitCandleTime,
    exitPrice: finite(trade.exitPrice),
    exitReason: trade.exitReason,
    pnl: finite(trade.pnl),
    realizedR: finite(trade.realizedR),
    holdingMinutes:
      entryIndex >= 0 && exitIndex >= entryIndex
        ? Math.max(
            0,
            (minute(ordered[exitIndex]!.candleTime) ?? 0) -
              (minute(ordered[entryIndex]!.candleTime) ?? 0)
          )
        : null,
    mfePct: pct(favorable),
    maePct: pct(adverse),
    returns: {
      m1: returnAt(1),
      m3: returnAt(3),
      m5: returnAt(5),
      m15: returnAt(15),
      m30: returnAt(30),
    },
    reasonCodes: [
      ...(entryIndex < 0 ? ["entry_candle_missing"] : []),
      ...(exitIndex < entryIndex ? ["exit_candle_missing"] : []),
      ...(sameBar ? ["same_bar_order_ambiguous"] : []),
      ...(zoneEvidence ? [] : ["zone_touch_event_evidence_missing"]),
      ...(entryEvidence ? [] : ["confirmation_event_evidence_missing"]),
      ...(targetEvidence || stopEvidence
        ? []
        : ["target_stop_event_evidence_missing"]),
      ...returnReasons,
    ],
    targetReachedAt: targetEvidence?.event.candleTime ?? null,
    stopReachedAt: stopEvidence?.event.candleTime ?? null,
    targetAndStopSameCandle:
      targetEvidence && stopEvidence
        ? targetEvidence.event.sourceEventId ===
          stopEvidence.event.sourceEventId
        : null,
    stopThenOriginalTarget: null,
    zoneTouched: zoneEvidence ? true : null,
    zoneTouchTime: zoneEvidence?.event.candleTime ?? null,
    zoneTouchSourceEventId: zoneEvidence?.event.sourceEventId ?? null,
    confirmationEstablished: entryEvidence ? true : null,
    confirmationTime: entryEvidence?.event.candleTime ?? null,
    confirmationSourceEventId: entryEvidence?.event.sourceEventId ?? null,
    firstTargetReached: targetEvidence ? true : null,
    stretchTargetReached: stretchEvidence ? true : null,
    postExitCounterfactual: {
      diagnosisOnly: true,
      estimatedTargetReachedAt: targetReachedAt,
      estimatedStopReachedAt: stopReachedAt,
      estimatedStretchTargetReachedAt: stretchTargetReachedAt,
      targetAndStopSameCandle: sameBar ? true : null,
      stopThenOriginalTarget: laterTarget,
      mfePct: postExit.length
        ? pct(
            trade.side === "long"
              ? Math.max(...postExit.map(candle => candle.high))
              : Math.min(...postExit.map(candle => candle.low))
          )
        : null,
      maePct: postExit.length
        ? pct(
            trade.side === "long"
              ? Math.min(...postExit.map(candle => candle.low))
              : Math.max(...postExit.map(candle => candle.high))
          )
        : null,
    },
  };
}

function expectedMetrics(
  side: "long" | "short",
  entryPrice: number | null,
  firstTarget: number | null,
  stopPrice: number | null
) {
  if (
    entryPrice === null ||
    firstTarget === null ||
    stopPrice === null ||
    entryPrice <= 0
  )
    return { expectedRewardPct: null, expectedRiskPct: null, expectedRR: null };
  const reward =
    side === "long"
      ? (firstTarget / entryPrice - 1) * 100
      : (entryPrice / firstTarget - 1) * 100;
  const risk =
    side === "long"
      ? (entryPrice / stopPrice - 1) * 100
      : (stopPrice / entryPrice - 1) * 100;
  return {
    expectedRewardPct: round(reward),
    expectedRiskPct: round(risk),
    expectedRR: reward > 0 && risk > 0 ? round(reward / risk) : null,
  };
}

export function deriveCauseCandidates(input: {
  symbol: string;
  side: "long" | "short";
  entry: LearningFeature;
  diagnosisOnly: LearningFeature;
  expectedRR: number | null;
  gapPct: number | null;
  macroRegime: string | null;
}): CauseCandidate[] {
  const one = record(input.entry.oneMinute);
  const bb = record(one.bollinger20);
  const five = record(input.entry.fiveMinute);
  const output: CauseCandidate[] = [];
  const add = (
    tag: string,
    usesFuture: boolean,
    evidence: Record<string, unknown>
  ) =>
    output.push({
      tag,
      usesFuture,
      evidence,
      judgementVersion: AI_FORECAST_LEARNING_MODEL_VERSION,
    });
  if (input.expectedRR !== null && input.expectedRR < 1)
    add("low_expected_rr", false, { expectedRR: input.expectedRR });
  if (input.gapPct !== null && Math.abs(input.gapPct) >= 1.5)
    add("forecast_baseline_stale_after_large_gap", false, {
      gapPct: input.gapPct,
    });
  if (
    input.entry.sessionHighUpdated !== true &&
    input.entry.sessionLowUpdated !== true
  )
    add("late_entry_without_session_break", false, {
      sessionHighUpdated: false,
      sessionLowUpdated: false,
    });
  const zScore = finite(bb.zScore);
  if (input.side === "long" && zScore !== null && zScore >= 2)
    add("long_chase_above_upper_bb", false, { bbZScore: zScore });
  if (input.side === "short" && zScore !== null && zScore <= -2)
    add("short_chase_below_lower_bb", false, { bbZScore: zScore });
  const rsi = finite(one.rsi14);
  if (rsi !== null && (rsi >= 75 || rsi <= 25))
    add("rsi_extreme_chase", false, { rsi14: rsi });
  const trend = String(
    five.sma20Direction ?? input.entry.fiveMinuteSma20Direction ?? "unavailable"
  );
  if (
    (input.side === "long" && trend === "down") ||
    (input.side === "short" && trend === "up")
  )
    add("countertrend_to_5m_sma20", false, { fiveMinuteSma20Direction: trend });
  const returns = record(input.diagnosisOnly.returns);
  if (finite(returns.m3) !== null && finite(returns.m3)! < 0)
    add("no_followthrough_3m", true, { return3mPct: finite(returns.m3) });
  if (
    input.diagnosisOnly.exitReason === "stop_loss" &&
    input.diagnosisOnly.stopThenOriginalTarget === true
  )
    add("stop_then_original_target", true, { exitReason: "stop_loss" });
  if (input.macroRegime === "unavailable" || input.macroRegime === "mixed")
    add("market_context_divergence", false, { macroRegime: input.macroRegime });
  return output;
}

function bucket(
  value: number | null,
  boundaries: readonly number[],
  labels: readonly string[]
) {
  if (value === null) return "unavailable";
  for (let index = 0; index < boundaries.length; index += 1)
    if (value < boundaries[index]!) return labels[index]!;
  return labels.at(-1)!;
}

function metrics(rows: LearningExample[]) {
  const closed = rows.filter(row => finite(row.diagnosisOnly.pnl) !== null);
  const pnl = closed.map(row => finite(row.diagnosisOnly.pnl) ?? 0);
  const r = closed
    .map(row => finite(row.diagnosisOnly.realizedR))
    .filter((value): value is number => value !== null);
  const mfe = closed
    .map(row => finite(row.diagnosisOnly.mfePct))
    .filter((value): value is number => value !== null);
  const mae = closed
    .map(row => finite(row.diagnosisOnly.maePct))
    .filter((value): value is number => value !== null);
  return {
    count: closed.length,
    winRatePct: closed.length
      ? round(
          (closed.filter(row => (finite(row.diagnosisOnly.pnl) ?? 0) > 0)
            .length /
            closed.length) *
            100
        )
      : null,
    totalPnl: pnl.reduce((sum, value) => sum + value, 0),
    averageR: r.length
      ? round(r.reduce((sum, value) => sum + value, 0) / r.length)
      : null,
    averageMfePct: mfe.length
      ? round(mfe.reduce((sum, value) => sum + value, 0) / mfe.length)
      : null,
    averageMaePct: mae.length
      ? round(mae.reduce((sum, value) => sum + value, 0) / mae.length)
      : null,
  };
}

function grouped(
  rows: LearningExample[],
  selector: (row: LearningExample) => string
) {
  const map = new Map<string, LearningExample[]>();
  for (const row of rows)
    map.set(selector(row), [...(map.get(selector(row)) ?? []), row]);
  return Array.from(map.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => ({ key, ...metrics(values) }));
}

function compactExamples(rows: LearningExample[]) {
  const ordered = [...rows].sort((left, right) =>
    `${right.tradeDate}:${right.entry.candleTime ?? ""}`.localeCompare(
      `${left.tradeDate}:${left.entry.candleTime ?? ""}`
    )
  );
  const losses = ordered
    .filter(row => (finite(row.diagnosisOnly.pnl) ?? 0) < 0)
    .slice(0, 6);
  const used = new Set(
    losses.map(row => `${row.tradeDate}:${row.symbol}:${row.entry.candleTime}`)
  );
  const wins = ordered.filter(row => (finite(row.diagnosisOnly.pnl) ?? 0) > 0);
  const analogs = wins
    .filter(
      row => !used.has(`${row.tradeDate}:${row.symbol}:${row.entry.candleTime}`)
    )
    .slice(0, 3);
  for (const row of analogs)
    used.add(`${row.tradeDate}:${row.symbol}:${row.entry.candleTime}`);
  const recentWins = wins
    .filter(
      row => !used.has(`${row.tradeDate}:${row.symbol}:${row.entry.candleTime}`)
    )
    .slice(0, 3);
  return [...losses, ...analogs, ...recentWins].slice(0, 12);
}

function learningBySymbol(examples: LearningExample[]) {
  return AI_DAILY_FORECAST_SYMBOLS.map(symbol => {
    const rows = examples.filter(row => row.symbol === symbol);
    const withEntry = (row: LearningExample) => record(row.entry);
    return {
      symbol,
      all: metrics(rows),
      recent20: metrics(rows.slice(-20)),
      recent5: metrics(rows.slice(-5)),
      bySide: grouped(rows, row => row.side),
      byCheckpoint: grouped(rows, row => row.checkpoint ?? "08:30"),
      byMacroRegime: grouped(rows, row => row.macroRegime ?? "unavailable"),
      byGapBucket: grouped(rows, row =>
        bucket(
          finite(withEntry(row).gapPct),
          [-1.5, -0.3, 0.3, 1.5],
          ["large_down", "down", "flat", "up", "large_up"]
        )
      ),
      byFiveMinuteSma20: grouped(rows, row =>
        String(withEntry(row).fiveMinuteSma20Direction ?? "unavailable")
      ),
      byBbPosition: grouped(rows, row =>
        bucket(
          finite(withEntry(row).bbZScore),
          [-1, 1, 2],
          ["lower", "middle", "upper", "outer"]
        )
      ),
      byExpectedRr: grouped(rows, row =>
        bucket(
          finite(withEntry(row).expectedRR),
          [1, 1.5, 2],
          ["below_1", "1_to_1_5", "1_5_to_2", "at_least_2"]
        )
      ),
      byCauseTag: grouped(
        rows.flatMap(row =>
          row.causeCandidates.map(candidate => ({
            ...row,
            causeTag: candidate.tag,
          }))
        ),
        row => String((row as LearningExample & { causeTag: string }).causeTag)
      ),
      analogCases: rows.map(row => {
        const entry = record(row.entry);
        const one = record(entry.oneMinute);
        const bb = record(one.bollinger20);
        return {
          identity: {
            tradeDate: row.tradeDate,
            symbol: row.symbol,
            entryCandleTime: record(entry.candle).candleTime ?? null,
          },
          side: row.side,
          checkpoint: row.checkpoint,
          gapBucket: bucket(
            finite(entry.gapPct),
            [-1.5, -0.3, 0.3, 1.5],
            ["large_down", "down", "flat", "up", "large_up"]
          ),
          fiveMinuteSma20Direction: String(
            entry.fiveMinuteSma20Direction ?? "unavailable"
          ),
          bbPositionBucket: bucket(
            finite(bb.zScore),
            [-1, 1, 2],
            ["lower", "middle", "upper", "outer"]
          ),
          rsiBucket: bucket(
            finite(one.rsi14),
            [30, 45, 55, 70],
            ["oversold", "low", "neutral", "high", "overbought"]
          ),
          macroRegime: row.macroRegime ?? "unavailable",
          expectedRrBucket: bucket(
            finite(entry.expectedRR),
            [1, 1.5, 2],
            ["below_1", "1_to_1_5", "1_5_to_2", "at_least_2"]
          ),
          pnl: row.diagnosisOnly.pnl,
          realizedR: row.diagnosisOnly.realizedR,
        };
      }),
      examples: compactExamples(rows),
    };
  });
}

function asPlanSnapshot(
  event: typeof rtForwardShadowEvents.$inferSelect,
  dailyById: Map<string, typeof rtAiDailyForecastSnapshots.$inferSelect>,
  intradayById: Map<string, typeof rtAiIntradayForecastSnapshots.$inferSelect>
) {
  const decision = record(event.decisionJson);
  const plan = record(decision.plan);
  const snapshotId =
    typeof plan.sourceSnapshotId === "string" ? plan.sourceSnapshotId : null;
  const intraday = snapshotId ? intradayById.get(snapshotId) : null;
  const morning = snapshotId ? dailyById.get(snapshotId) : null;
  const payload = intraday
    ? record(intraday.forecastJson)
    : morning
      ? record(morning.forecastJson)
      : {};
  const aiFinal = record(payload.aiFinalForecast);
  const nestedForecast = record(aiFinal.forecast);
  const forecasts = Array.isArray(nestedForecast.forecasts)
    ? nestedForecast.forecasts
    : Array.isArray(aiFinal.forecasts)
      ? aiFinal.forecasts
      : [];
  const row = record(
    forecasts.find(item => record(item).symbol === event.symbol)
  );
  const controls = Array.isArray(aiFinal.controls) ? aiFinal.controls : [];
  const control = record(
    controls.find(item => record(item).symbol === event.symbol)
  );
  const input = intraday
    ? record(intraday.inputJson)
    : morning
      ? record(morning.inputJson)
      : {};
  const macro = intraday
    ? record(record(input.priorData).macroSnapshot)
    : record(input.macroSnapshot);
  return {
    plan,
    row,
    control,
    checkpoint: intraday?.checkpoint ?? "08:30",
    morningSnapshotId:
      intraday?.morningSourceSnapshotId ?? morning?.sourceSnapshotId ?? null,
    intradayRevisionId: intraday?.sourceRevisionId ?? null,
    macroRegime:
      typeof macro.regimeState === "string" ? macro.regimeState : null,
    macroConfidence:
      typeof macro.confidence === "string" ? macro.confidence : null,
  };
}

async function loadExamples(asOfDate: string): Promise<LearningExample[]> {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const versions = [
    ...Object.values(RETIRED_AI_DAILY_FORECAST_V1_VERSIONS),
    ...Object.values(RETIRED_AI_ADAPTIVE_FORECAST_V2_VERSIONS),
    ...Object.values(RETIRED_AI_FORECAST_LEARNING_V3_VERSIONS),
    ...Object.values(RETIRED_AI_FORECAST_LEARNING_V4_VERSIONS),
    ...Object.values(AI_DAILY_FORECAST_VERSIONS),
  ] as string[];
  const [
    trades,
    events,
    candles,
    dailySnapshots,
    intradaySnapshots,
    marketEvents,
  ] = await Promise.all([
    db
      .select()
      .from(rtForwardShadowTrades)
      .where(
        and(
          inArray(rtForwardShadowTrades.strategyVersion, versions),
          eq(rtForwardShadowTrades.evaluationMode, "signal_quality"),
          lte(rtForwardShadowTrades.entryTradeDate, asOfDate)
        )
      )
      .orderBy(
        asc(rtForwardShadowTrades.entryTradeDate),
        asc(rtForwardShadowTrades.id)
      ),
    db
      .select()
      .from(rtForwardShadowEvents)
      .where(
        and(
          inArray(rtForwardShadowEvents.strategyVersion, versions),
          eq(rtForwardShadowEvents.evaluationMode, "signal_quality"),
          lte(rtForwardShadowEvents.tradeDate, asOfDate)
        )
      )
      .orderBy(
        asc(rtForwardShadowEvents.tradeDate),
        asc(rtForwardShadowEvents.id)
      ),
    db
      .select()
      .from(rtCandles)
      .where(
        and(
          inArray(rtCandles.symbol, [...AI_DAILY_FORECAST_SYMBOLS]),
          lte(rtCandles.tradeDate, asOfDate)
        )
      )
      .orderBy(
        asc(rtCandles.tradeDate),
        asc(rtCandles.candleTime),
        asc(rtCandles.id)
      ),
    db
      .select()
      .from(rtAiDailyForecastSnapshots)
      .where(lte(rtAiDailyForecastSnapshots.tradeDate, asOfDate))
      .orderBy(
        asc(rtAiDailyForecastSnapshots.tradeDate),
        asc(rtAiDailyForecastSnapshots.id)
      ),
    db
      .select()
      .from(rtAiIntradayForecastSnapshots)
      .where(lte(rtAiIntradayForecastSnapshots.tradeDate, asOfDate))
      .orderBy(
        asc(rtAiIntradayForecastSnapshots.tradeDate),
        asc(rtAiIntradayForecastSnapshots.id)
      ),
    db
      .select()
      .from(rtMarketContextEvents)
      .where(lte(rtMarketContextEvents.tradeDate, asOfDate))
      .orderBy(
        asc(rtMarketContextEvents.tradeDate),
        asc(rtMarketContextEvents.candleTime),
        asc(rtMarketContextEvents.id)
      ),
  ]);
  const eventByEntry = new Map(
    events.map(event => [
      `${event.strategyVersion}:${event.sourceEventId}`,
      event,
    ])
  );
  const eventsByTradeVersion = new Map<
    string,
    Array<typeof rtForwardShadowEvents.$inferSelect>
  >();
  for (const event of events) {
    const key = `${event.strategyVersion}:${event.tradeDate}:${event.symbol}`;
    eventsByTradeVersion.set(key, [
      ...(eventsByTradeVersion.get(key) ?? []),
      event,
    ]);
  }
  const candlesByDaySymbol = new Map<string, Candle[]>();
  for (const row of candles) {
    const key = `${row.tradeDate}:${row.symbol}`;
    candlesByDaySymbol.set(key, [
      ...(candlesByDaySymbol.get(key) ?? []),
      {
        candleTime: row.candleTime,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      },
    ]);
  }
  const dailyById = new Map(
    dailySnapshots.map(row => [row.sourceSnapshotId, row])
  );
  const intradayById = new Map(
    intradaySnapshots.map(row => [row.sourceRevisionId, row])
  );
  const datesBySymbol = new Map<string, string[]>();
  for (const key of Array.from(candlesByDaySymbol.keys())) {
    const [tradeDate, symbol] = key.split(":");
    datesBySymbol.set(symbol!, [
      ...(datesBySymbol.get(symbol!) ?? []),
      tradeDate!,
    ]);
  }
  for (const [symbol, dates] of Array.from(datesBySymbol.entries()))
    datesBySymbol.set(symbol, Array.from(new Set(dates)).sort());
  const miniByDate = new Map<string, typeof marketEvents>();
  for (const event of marketEvents)
    miniByDate.set(event.tradeDate, [
      ...(miniByDate.get(event.tradeDate) ?? []),
      event,
    ]);
  return trades.flatMap(trade => {
    if (
      !symbols.has(trade.symbol) ||
      !trade.exitTradeDate ||
      trade.pnl === null
    )
      return [];
    const event = eventByEntry.get(
      `${trade.strategyVersion}:${trade.entrySourceEventId}`
    );
    if (!event) return [];
    const plan = asPlanSnapshot(event, dailyById, intradayById);
    const dayCandles =
      candlesByDaySymbol.get(`${trade.entryTradeDate}:${trade.symbol}`) ?? [];
    const technical = snapshotFromCandles(dayCandles, trade.entryCandleTime);
    const planRow = plan.row;
    const entryPrice = finite(trade.entryPrice);
    const firstTarget = finite(plan.plan.firstTarget ?? planRow.firstTarget);
    const stopReference = finite(plan.plan.stopPrice ?? planRow.stopReference);
    const metric = expectedMetrics(
      trade.side,
      entryPrice,
      firstTarget,
      stopReference
    );
    const dayOpen = finite(technical.sessionOpen);
    const dates = datesBySymbol.get(trade.symbol) ?? [];
    const previousDate = dates
      .filter(date => date < trade.entryTradeDate)
      .at(-1);
    const previousClose = previousDate
      ? (candlesByDaySymbol
          .get(`${previousDate}:${trade.symbol}`)
          ?.sort((left, right) =>
            left.candleTime.localeCompare(right.candleTime)
          )
          .at(-1)?.close ?? null)
      : null;
    const gapPct = calculateOpeningGapPct(dayOpen, previousClose);
    const mini = selectCausalMiniEvent(
      miniByDate.get(trade.entryTradeDate) ?? [],
      trade.entryCandleTime
    );
    const entry = {
      tradeDate: trade.entryTradeDate,
      symbol: trade.symbol,
      side: trade.side,
      morningSnapshotId: plan.morningSnapshotId,
      intradayRevisionId: plan.intradayRevisionId,
      checkpoint: plan.checkpoint,
      entryWindowStart:
        plan.control.entryWindowStart ?? plan.plan.entryWindowStart ?? null,
      entryWindowEnd:
        plan.control.entryWindowEnd ?? plan.plan.entryWindowEnd ?? null,
      forceExitTime:
        plan.control.forceExitTime ?? plan.plan.forceExitTime ?? null,
      aiDirection: plan.plan.direction ?? planRow.direction ?? null,
      confidence: planRow.evidenceStrength ?? null,
      rationale: planRow.entryRationale ?? planRow.rationale ?? null,
      forecastLow: finite(plan.plan.forecastLow ?? planRow.forecastLow),
      forecastHigh: finite(plan.plan.forecastHigh ?? planRow.forecastHigh),
      zoneLow: finite(plan.plan.zoneLow ?? planRow.zoneLow),
      zoneHigh: finite(plan.plan.zoneHigh ?? planRow.zoneHigh),
      confirmPrice: finite(plan.plan.confirmPrice ?? planRow.confirmPrice),
      firstTarget,
      stretchTarget: finite(plan.plan.stretchTarget ?? planRow.stretchTarget),
      stopReference,
      entryPrice,
      shares: trade.shares,
      boardVwap: entryPrice,
      boardFreshnessMs: (() => {
        const actions = record(event.decisionJson).actions;
        const firstAction = Array.isArray(actions) ? record(actions[0]) : {};
        return finite(firstAction.sourceBoardAgeMs);
      })(),
      ...metric,
      ...technical,
      gapPct,
      gapReasonCodes: previousClose ? [] : ["previous_close_unavailable"],
      nikkei225Mini: {
        sourceEventId: mini?.sourceEventId ?? null,
        candleTime: mini?.candleTime ?? null,
        observedAt: mini?.observedAtMs ?? null,
        qualityStatus: mini?.qualityStatus ?? null,
        open: mini ? Number(mini.open) : null,
        last: mini ? Number(mini.close) : null,
        changeFromOpenPct:
          mini && Number(mini.open) > 0
            ? round((Number(mini.close) / Number(mini.open) - 1) * 100)
            : null,
        direction:
          mini && Number(mini.close) > Number(mini.open)
            ? "up"
            : mini && Number(mini.close) < Number(mini.open)
              ? "down"
              : mini
                ? "flat"
                : null,
      },
      macroRegime: plan.macroRegime,
      macroConfidence: plan.macroConfidence,
      changeFromPrevious: planRow.changeFromPrevious ?? null,
      positionAction:
        plan.control.openPositionAction ??
        plan.plan.openPositionAction ??
        "keep",
    } satisfies LearningFeature;
    const diagnosisOnly = outcomeFromCandles(
      dayCandles,
      trade,
      {
        firstTarget,
        stretchTarget: finite(plan.plan.stretchTarget ?? planRow.stretchTarget),
        stopPrice: stopReference,
      },
      (
        eventsByTradeVersion.get(
          `${trade.strategyVersion}:${trade.entryTradeDate}:${trade.symbol}`
        ) ?? []
      ).filter(
        item => !trade.exitCandleTime || item.candleTime <= trade.exitCandleTime
      )
    );
    const causes = deriveCauseCandidates({
      symbol: trade.symbol,
      side: trade.side,
      entry,
      diagnosisOnly,
      expectedRR: metric.expectedRR,
      gapPct,
      macroRegime: plan.macroRegime,
    });
    return [
      {
        source:
          trade.strategyVersion.includes("-v3") ||
          trade.strategyVersion.includes("-v4")
            ? "current_v3"
            : "reference_v1_v2",
        tradeDate: trade.entryTradeDate,
        symbol: trade.symbol,
        side: trade.side,
        checkpoint: plan.checkpoint,
        macroRegime: plan.macroRegime,
        entry,
        diagnosisOnly,
        causeCandidates: causes,
      } satisfies LearningExample,
    ];
  });
}

function trimToLimit(payload: Record<string, unknown>) {
  let serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") <= AI_FORECAST_LEARNING_MAX_BYTES)
    return {
      payload,
      qualityStatus: "verified" as const,
      reasons: [] as string[],
    };
  const reduced = structuredClone(payload) as Record<string, unknown>;
  const symbolsPayload = Array.isArray(reduced.symbols)
    ? (reduced.symbols as Array<Record<string, unknown>>)
    : [];
  for (const symbol of symbolsPayload) symbol.examples = [];
  serialized = JSON.stringify(reduced);
  return {
    payload: reduced,
    qualityStatus:
      Buffer.byteLength(serialized, "utf8") <= AI_FORECAST_LEARNING_MAX_BYTES
        ? ("degraded" as const)
        : ("invalid" as const),
    reasons: ["learning_payload_examples_trimmed_to_size_limit"],
  };
}

export function buildLearningPayloadForTest(input: {
  asOfDate: string;
  examples: LearningExample[];
}) {
  const payload = {
    schemaVersion: AI_FORECAST_LEARNING_MODEL_VERSION,
    asOfDate: input.asOfDate,
    causalBoundary: {
      usableForTradeDateStrictlyAfter: input.asOfDate,
      diagnosisOnlyExcludedFromDecisionFeatures: true,
    },
    symbols: learningBySymbol(input.examples),
    generatedFrom: {
      signalQualityOnly: true,
      capitalConstrainedSeparate: true,
      referenceVersionsRetained: true,
      automaticRuleMutation: false,
      learningMode: input.examples.length === 0 ? "cold_start" : "learned",
      coldStartReason:
        input.examples.length === 0 ? "learning_examples_unavailable" : null,
    },
  };
  return trimToLimit(payload);
}

export async function getLatestVerifiedAiForecastLearningSnapshotBefore(
  tradeDate: string
) {
  const db = await getDb();
  if (!db) return null;
  return (
    (
      await db
        .select()
        .from(rtAiForecastLearningSnapshots)
        .where(
          and(
            lt(rtAiForecastLearningSnapshots.asOfDate, tradeDate),
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
        .limit(1)
    )[0] ?? null
  );
}

async function getExisting(asOfDate: string) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  return (
    (
      await db
        .select()
        .from(rtAiForecastLearningSnapshots)
        .where(
          and(
            eq(rtAiForecastLearningSnapshots.asOfDate, asOfDate),
            eq(
              rtAiForecastLearningSnapshots.modelVersion,
              AI_FORECAST_LEARNING_MODEL_VERSION
            )
          )
        )
        .limit(1)
    )[0] ?? null
  );
}

export async function insertAiForecastLearningSnapshot(
  data: Omit<InsertRtAiForecastLearningSnapshot, "id" | "createdAt">
) {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const existing = await getExisting(data.asOfDate);
  if (existing) {
    if (
      existing.payloadHash !== data.payloadHash ||
      existing.sourceSnapshotId !== data.sourceSnapshotId
    )
      throw Error("ai_forecast_learning_snapshot_conflict");
    return existing;
  }
  await db.insert(rtAiForecastLearningSnapshots).values(data);
  const created = await getExisting(data.asOfDate);
  if (!created)
    throw Error("ai_forecast_learning_snapshot_missing_after_insert");
  return created;
}

/** Closed-date only caller: builds one immutable learning row and never updates source or trade history. */
export async function materializeAiForecastLearningSnapshotForDate(
  asOfDate: string
) {
  const examples = await loadExamples(asOfDate);
  const built = buildLearningPayloadForTest({ asOfDate, examples });
  const qualityStatus = built.qualityStatus;
  const qualityReasonCodes =
    examples.length === 0
      ? [
          ...built.reasons,
          "learning_examples_unavailable",
          "learning_mode_cold_start",
        ]
      : built.reasons;
  const input = {
    asOfDate,
    modelVersion: AI_FORECAST_LEARNING_MODEL_VERSION,
    exampleIdentity: examples.map(example => ({
      tradeDate: example.tradeDate,
      symbol: example.symbol,
      side: example.side,
      checkpoint: example.checkpoint,
      pnl: example.diagnosisOnly.pnl,
    })),
  };
  const sourceSnapshotId = `ai-forecast-learning:${asOfDate}:${AI_FORECAST_LEARNING_MODEL_VERSION}`;
  const payloadHash = sha256Stable(built.payload);
  const row = await insertAiForecastLearningSnapshot({
    sourceSnapshotId,
    asOfDate,
    modelVersion: AI_FORECAST_LEARNING_MODEL_VERSION,
    generatedAtMs: Date.now(),
    inputHash: sha256Stable(input),
    payloadHash,
    qualityStatus,
    qualityReasonCodesJson: qualityReasonCodes,
    learningJson: built.payload,
  });
  return {
    row,
    examples: examples.length,
    qualityStatus,
    qualityReasonCodes,
  };
}

export const _aiForecastLearningTest = {
  snapshotFromCandles,
  calculateOpeningGapPct,
  selectCausalMiniEvent,
  outcomeFromCandles,
  deriveCauseCandidates,
  buildLearningPayloadForTest,
  expectedMetrics,
};
