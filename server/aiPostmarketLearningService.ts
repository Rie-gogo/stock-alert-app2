import { and, asc, count, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import {
  rtAiDailyForecastSnapshots,
  rtAiIntradayForecastSnapshots,
  rtAiPostmarketLearningReviews,
  rtAuditTradeDateFinality,
  rtCandles,
  rtForwardShadowEvents,
  rtForwardShadowTrades,
  rtMarketContextEvents,
  type InsertRtAiPostmarketLearningReview,
} from "../drizzle/schema";
import {
  getDb,
  getRtAuditTradeDateFinality,
  getRtAuditTradeDateWatermark,
  getRtDailyAuditMaterialization,
} from "./db";
import {
  closedTradeDateWatermarkHash,
  isClosedTradeDateWatermarkReady,
} from "./closedTradeDateTailDrain";
import { nextTokyoEquityTradeDate } from "./jpxEquityCalendar";
import {
  AI_FORECAST_LEARNING_COMPONENT,
  AI_FORECAST_LEARNING_MATERIALIZATION_VERSION,
  outcomeFromCandles,
  snapshotFromCandles,
} from "./aiForecastLearningService";
import {
  AI_DAILY_FORECAST_VERSIONS,
  sha256Stable,
} from "./runtimeIdentity";

/**
 * Closed-date Codex review contract. This module never invokes an LLM and never
 * touches source ingestion, shadow dispatch, current logic, or order tables.
 */
export const AI_POSTMARKET_LEARNING_CONTRACT_VERSION =
  "ai-postmarket-learning-contract-v1";
export const AI_POSTMARKET_REVIEW_ID_SUFFIX = "codex-v1";
export const AI_POSTMARKET_MAX_HISTORY_DAYS = 60;
export const AI_POSTMARKET_MAX_HISTORY_EXAMPLES = 500;

const POSTMARKET_SYMBOLS = [
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
type PostmarketSymbol = (typeof POSTMARKET_SYMBOLS)[number];
type RecordValue = Record<string, unknown>;
type Candle = {
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const asRecord = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const unique = <T,>(values: readonly T[]) => Array.from(new Set(values));
const jstDate = (epochMs: number) =>
  new Date(epochMs + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);

function previousCalendarDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Uses the canonical equity calendar, including the 2026-10-12 cash-market holiday. */
export function isTokyoEquityTradingDate(value: string) {
  const previous = previousCalendarDate(value);
  if (!previous) return false;
  try {
    return nextTokyoEquityTradeDate(previous) === value;
  } catch {
    return false;
  }
}

function actionRows(event: typeof rtForwardShadowEvents.$inferSelect) {
  const actions = asRecord(event.decisionJson).actions;
  return Array.isArray(actions) ? actions.map(asRecord) : [];
}

function snapshotSymbols(row: {
  forecastJson: unknown;
  kind: "morning" | "intraday";
}) {
  const payload = asRecord(row.forecastJson);
  const final = asRecord(payload.aiFinalForecast);
  const forecast = row.kind === "morning" ? final : asRecord(final.forecast);
  const rows = Array.isArray(forecast.forecasts) ? forecast.forecasts : [];
  return rows.map(asRecord).map(value => String(value.symbol ?? ""));
}

function snapshotProjection(
  row:
    | typeof rtAiDailyForecastSnapshots.$inferSelect
    | typeof rtAiIntradayForecastSnapshots.$inferSelect,
  kind: "morning" | "intraday"
) {
  const base = {
    kind,
    tradeDate: row.tradeDate,
    inputHash: row.inputHash,
    payloadHash: row.payloadHash,
    qualityStatus: row.qualityStatus,
    input: row.inputJson,
    forecast: row.forecastJson,
    validation: row.validationJson,
  };
  return kind === "morning"
    ? {
        ...base,
        sourceSnapshotId: (row as typeof rtAiDailyForecastSnapshots.$inferSelect)
          .sourceSnapshotId,
        capturedAtMs: (row as typeof rtAiDailyForecastSnapshots.$inferSelect)
          .capturedAtMs,
        effectiveFrom: "09:00",
        validUntil: "15:20",
      }
    : {
        ...base,
        sourceRevisionId: (row as typeof rtAiIntradayForecastSnapshots.$inferSelect)
          .sourceRevisionId,
        checkpoint: (row as typeof rtAiIntradayForecastSnapshots.$inferSelect)
          .checkpoint,
        cutoffCandleTime: (row as typeof rtAiIntradayForecastSnapshots.$inferSelect)
          .cutoffCandleTime,
        effectiveFrom: (row as typeof rtAiIntradayForecastSnapshots.$inferSelect)
          .checkpoint,
        validUntil: "15:20",
      };
}

function causalMarketSnapshot(
  rows: Array<typeof rtMarketContextEvents.$inferSelect>,
  entryTime: string
) {
  const selected = rows
    .filter(
      row => row.candleTime <= entryTime && row.qualityStatus !== "invalid"
    )
    .at(-1);
  if (!selected) return null;
  return {
    sourceEventId: selected.sourceEventId,
    candleTime: selected.candleTime,
    qualityStatus: selected.qualityStatus,
    open: Number(selected.open),
    high: Number(selected.high),
    low: Number(selected.low),
    close: Number(selected.close),
    observedAtMs: selected.observedAtMs,
  };
}

function planProjection(event: typeof rtForwardShadowEvents.$inferSelect | undefined) {
  const decision = asRecord(event?.decisionJson);
  const plan = asRecord(decision.plan);
  return {
    activePlanId:
      typeof decision.activePlanId === "string" ? decision.activePlanId : null,
    sourceSnapshotId:
      typeof plan.sourceSnapshotId === "string" ? plan.sourceSnapshotId : null,
    checkpoint: typeof plan.checkpoint === "string" ? plan.checkpoint : null,
    direction: typeof plan.direction === "string" ? plan.direction : null,
    entryWindowStart:
      typeof plan.entryWindowStart === "string" ? plan.entryWindowStart : null,
    entryWindowEnd:
      typeof plan.entryWindowEnd === "string" ? plan.entryWindowEnd : null,
    confirmPrice: finite(plan.confirmPrice),
    firstTarget: finite(plan.firstTarget),
    stretchTarget: finite(plan.stretchTarget),
    stopPrice: finite(plan.stopPrice),
  };
}

function mfeMaeOccurrenceTimes(input: {
  candles: Candle[];
  side: "long" | "short";
  entryCandleTime: string;
  exitCandleTime: string | null;
}) {
  if (!input.exitCandleTime) return { mfeOccurredAt: null, maeOccurredAt: null };
  const held = input.candles
    .filter(
      candle =>
        candle.candleTime >= input.entryCandleTime &&
        candle.candleTime <= input.exitCandleTime!
    )
    .sort((left, right) => left.candleTime.localeCompare(right.candleTime));
  if (held.length === 0) return { mfeOccurredAt: null, maeOccurredAt: null };
  const favorable =
    input.side === "long"
      ? Math.max(...held.map(candle => candle.high))
      : Math.min(...held.map(candle => candle.low));
  const adverse =
    input.side === "long"
      ? Math.min(...held.map(candle => candle.low))
      : Math.max(...held.map(candle => candle.high));
  return {
    mfeOccurredAt:
      held.find(candle =>
        input.side === "long"
          ? candle.high === favorable
          : candle.low === favorable
      )?.candleTime ?? null,
    maeOccurredAt:
      held.find(candle =>
        input.side === "long"
          ? candle.low === adverse
          : candle.high === adverse
      )?.candleTime ?? null,
  };
}

function buildExample(input: {
  trade: typeof rtForwardShadowTrades.$inferSelect;
  event: typeof rtForwardShadowEvents.$inferSelect | undefined;
  relatedEvents: Array<typeof rtForwardShadowEvents.$inferSelect>;
  candles: Candle[];
  marketEvents: Array<typeof rtMarketContextEvents.$inferSelect>;
}) {
  const plan = planProjection(input.event);
  const technical = snapshotFromCandles(
    input.candles,
    input.trade.entryCandleTime
  );
  const outcome = outcomeFromCandles(
    input.candles,
    input.trade,
    {
      firstTarget: plan.firstTarget,
      stretchTarget: plan.stretchTarget,
      stopPrice: plan.stopPrice,
    },
    input.relatedEvents
  ) as RecordValue;
  const entryActions = input.event ? actionRows(input.event) : [];
  const entryAction = entryActions.find(action => action.type === "entry") ?? {};
  const exitAction = input.relatedEvents
    .flatMap(actionRows)
    .find(action => action.type === "exit") ?? {};
  const occurrenceTimes = mfeMaeOccurrenceTimes({
    candles: input.candles,
    side: input.trade.side,
    entryCandleTime: input.trade.entryCandleTime,
    exitCandleTime: input.trade.exitCandleTime,
  });
  return {
    identity: {
      strategyVersion: input.trade.strategyVersion,
      evaluationMode: input.trade.evaluationMode,
      tradeEntrySourceEventId: input.trade.entrySourceEventId,
      entrySourceEventId: input.trade.entrySourceEventId,
      exitSourceEventId: input.trade.exitSourceEventId,
      entryTradeDate: input.trade.entryTradeDate,
      entryCandleTime: input.trade.entryCandleTime,
    },
    symbol: input.trade.symbol,
    side: input.trade.side,
    learningRole:
      input.trade.evaluationMode === "signal_quality"
        ? "strategy_primary"
        : "execution_audit",
    causalFeatures: {
      decisionAt: input.event?.candleTime ?? null,
      plan,
      entry: {
        price: Number(input.trade.entryPrice),
        shares: input.trade.shares,
        signalCandleTime: input.trade.signalCandleTime,
        entryCandleTime: input.trade.entryCandleTime,
        entryOrdinal: null,
        sourceBoardAgeMs: finite(entryAction.sourceBoardAgeMs),
        deliveryBoardAgeMs: finite(entryAction.deliveryBoardAgeMs),
        boardAgeBasis:
          typeof entryAction.boardAgeBasis === "string"
            ? entryAction.boardAgeBasis
            : null,
      },
      technical,
      marketContext: causalMarketSnapshot(
        input.marketEvents,
        input.trade.entryCandleTime
      ),
      dataQuality: {
        entryEventPresent: Boolean(input.event),
        candlesObservedAtOrBeforeEntry: true,
      },
    },
    results: {
      exit: {
        tradeDate: input.trade.exitTradeDate,
        candleTime: input.trade.exitCandleTime,
        sourceEventId: input.trade.exitSourceEventId,
        price: input.trade.exitPrice === null ? null : Number(input.trade.exitPrice),
        reason: input.trade.exitReason,
        actionReason: typeof exitAction.reason === "string" ? exitAction.reason : null,
      },
      pnl: input.trade.pnl,
      realizedR: finite(input.trade.realizedR),
      outcome,
      ...occurrenceTimes,
      directionAligned: input.trade.pnl === null ? null : input.trade.pnl > 0,
      takeProfitUnreachedReversal:
        input.trade.exitReason === "stop_loss" &&
        outcome.firstTargetReached !== true,
      stopThenFavorableContinuation: Boolean(
        asRecord(outcome.postExitCounterfactual).stopThenOriginalTarget
      ),
    },
  };
}

function referenceIndex(input: {
  events: Array<typeof rtForwardShadowEvents.$inferSelect>;
  trades: Array<typeof rtForwardShadowTrades.$inferSelect>;
}) {
  const eventSymbolById = new Map<string, string>();
  for (const event of input.events) eventSymbolById.set(event.sourceEventId, event.symbol);
  const tradeSymbolByEntryId = new Map<string, string>();
  for (const trade of input.trades)
    tradeSymbolByEntryId.set(trade.entrySourceEventId, trade.symbol);
  return {
    eventsBySymbol: Object.fromEntries(
      POSTMARKET_SYMBOLS.map(symbol => [
        symbol,
        input.events
          .filter(event => event.symbol === symbol)
          .map(event => event.sourceEventId),
      ])
    ),
    tradesBySymbol: Object.fromEntries(
      POSTMARKET_SYMBOLS.map(symbol => [
        symbol,
        input.trades
          .filter(trade => trade.symbol === symbol)
          .map(trade => trade.entrySourceEventId),
      ])
    ),
    eventSymbolById: Object.fromEntries(eventSymbolById),
    tradeSymbolByEntryId: Object.fromEntries(tradeSymbolByEntryId),
  };
}

export type AiPostmarketLearningInput = {
  contractVersion: typeof AI_POSTMARKET_LEARNING_CONTRACT_VERSION;
  tradeDate: string;
  dataFinality: RecordValue;
  inputQuality: "verified" | "degraded" | "invalid";
  qualityReasonCodes: string[];
  snapshots: {
    morning: RecordValue[];
    intraday: RecordValue[];
  };
  currentDay: {
    symbols: Array<RecordValue>;
    referenceIndex: RecordValue;
  };
  historical: {
    closedTradeDates: string[];
    examples: Array<RecordValue>;
    maximumExamples: number;
    strategyLearningSource: "signal_quality_only";
    executionAuditSource: "capital_constrained_separate_not_market_case";
  };
  dataState: {
    coldStart: boolean;
    smallSample: boolean;
    missing: string[];
  };
  inputHash?: string;
};

function inputHash(input: AiPostmarketLearningInput) {
  const { inputHash: _inputHash, ...immutable } = input;
  return sha256Stable(immutable);
}
export const aiPostmarketLearningInputHash = inputHash;

async function loadExamples(input: {
  tradeDates: string[];
  versions: string[];
  limit: number;
}) {
  const db = await getDb();
  if (!db || input.tradeDates.length === 0) return [] as Array<RecordValue>;
  const [trades, events, candles, marketEvents] = await Promise.all([
    db
      .select()
      .from(rtForwardShadowTrades)
      .where(
        and(
          inArray(rtForwardShadowTrades.strategyVersion, input.versions),
          inArray(rtForwardShadowTrades.entryTradeDate, input.tradeDates)
        )
      )
      .orderBy(
        asc(rtForwardShadowTrades.entryTradeDate),
        asc(rtForwardShadowTrades.entryCandleTime),
        asc(rtForwardShadowTrades.id)
      ),
    db
      .select()
      .from(rtForwardShadowEvents)
      .where(
        and(
          inArray(rtForwardShadowEvents.strategyVersion, input.versions),
          inArray(rtForwardShadowEvents.tradeDate, input.tradeDates)
        )
      )
      .orderBy(
        asc(rtForwardShadowEvents.tradeDate),
        asc(rtForwardShadowEvents.candleTime),
        asc(rtForwardShadowEvents.id)
      ),
    db
      .select()
      .from(rtCandles)
      .where(
        and(
          inArray(rtCandles.symbol, [...POSTMARKET_SYMBOLS]),
          inArray(rtCandles.tradeDate, input.tradeDates)
        )
      )
      .orderBy(asc(rtCandles.tradeDate), asc(rtCandles.symbol), asc(rtCandles.candleTime)),
    db
      .select()
      .from(rtMarketContextEvents)
      .where(inArray(rtMarketContextEvents.tradeDate, input.tradeDates))
      .orderBy(asc(rtMarketContextEvents.tradeDate), asc(rtMarketContextEvents.candleTime)),
  ]);
  const eventByKey = new Map(
    events.map(event => [
      `${event.strategyVersion}:${event.evaluationMode}:${event.sourceEventId}`,
      event,
    ])
  );
  const eventsByDateSymbol = new Map<string, Array<typeof rtForwardShadowEvents.$inferSelect>>();
  for (const event of events) {
    const key = `${event.tradeDate}:${event.symbol}`;
    eventsByDateSymbol.set(key, [...(eventsByDateSymbol.get(key) ?? []), event]);
  }
  const candlesByDateSymbol = new Map<string, Candle[]>();
  for (const candle of candles) {
    const key = `${candle.tradeDate}:${candle.symbol}`;
    candlesByDateSymbol.set(key, [
      ...(candlesByDateSymbol.get(key) ?? []),
      {
        candleTime: candle.candleTime,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: candle.volume,
      },
    ]);
  }
  const marketByDate = new Map<string, Array<typeof rtMarketContextEvents.$inferSelect>>();
  for (const event of marketEvents)
    marketByDate.set(event.tradeDate, [...(marketByDate.get(event.tradeDate) ?? []), event]);

  return trades
    .filter(trade => POSTMARKET_SYMBOLS.includes(trade.symbol as PostmarketSymbol))
    .map(trade =>
      buildExample({
        trade,
        event: eventByKey.get(
          `${trade.strategyVersion}:${trade.evaluationMode}:${trade.entrySourceEventId}`
        ),
        relatedEvents:
          eventsByDateSymbol.get(`${trade.entryTradeDate}:${trade.symbol}`) ?? [],
        candles:
          candlesByDateSymbol.get(`${trade.entryTradeDate}:${trade.symbol}`) ?? [],
        marketEvents: marketByDate.get(trade.entryTradeDate) ?? [],
      })
    )
    .slice(-input.limit);
}

function assertClosedFinality(input: {
  tradeDate: string;
  finality: Awaited<ReturnType<typeof getRtAuditTradeDateFinality>>;
  watermark: Awaited<ReturnType<typeof getRtAuditTradeDateWatermark>>;
  materialization: Awaited<ReturnType<typeof getRtDailyAuditMaterialization>>;
}) {
  if (!isTokyoEquityTradingDate(input.tradeDate))
    throw Error("ai_postmarket_learning_non_trading_date");
  const currentHash = closedTradeDateWatermarkHash(input.watermark);
  if (
    input.finality?.status !== "closed" ||
    input.finality.watermarkHash !== currentHash ||
    !isClosedTradeDateWatermarkReady(input.watermark)
  )
    throw Error("ai_postmarket_learning_finality_not_closed_or_watermark_changed");
  if (input.materialization?.status !== "complete")
    throw Error("ai_postmarket_learning_snapshot_materialization_incomplete");
  return currentHash;
}

/** Pure test seam for closed/finality fail-closed semantics. */
export function assertAiPostmarketFinalityForTest(input: {
  tradeDate: string;
  finality: { status: string; watermarkHash: string | null } | null;
  watermark: Parameters<typeof closedTradeDateWatermarkHash>[0];
  materializationStatus: string | null;
}) {
  return assertClosedFinality({
    tradeDate: input.tradeDate,
    finality: input.finality as Awaited<ReturnType<typeof getRtAuditTradeDateFinality>>,
    watermark: input.watermark,
    materialization: input.materializationStatus
      ? ({ status: input.materializationStatus } as Awaited<
          ReturnType<typeof getRtDailyAuditMaterialization>
        >)
      : null,
  });
}

/** Builds a deterministic, finality-gated read-only Codex input. */
export async function buildAiPostmarketLearningInput(input: {
  tradeDate: string;
}): Promise<AiPostmarketLearningInput> {
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  const [finality, watermark, materialization, morning, intraday, closedDates] =
    await Promise.all([
      getRtAuditTradeDateFinality(input.tradeDate),
      getRtAuditTradeDateWatermark(input.tradeDate),
      getRtDailyAuditMaterialization({
        component: AI_FORECAST_LEARNING_COMPONENT,
        version: AI_FORECAST_LEARNING_MATERIALIZATION_VERSION,
        tradeDate: input.tradeDate,
      }),
      db
        .select()
        .from(rtAiDailyForecastSnapshots)
        .where(eq(rtAiDailyForecastSnapshots.tradeDate, input.tradeDate))
        .orderBy(asc(rtAiDailyForecastSnapshots.capturedAtMs), asc(rtAiDailyForecastSnapshots.id)),
      db
        .select()
        .from(rtAiIntradayForecastSnapshots)
        .where(eq(rtAiIntradayForecastSnapshots.tradeDate, input.tradeDate))
        .orderBy(asc(rtAiIntradayForecastSnapshots.checkpoint), asc(rtAiIntradayForecastSnapshots.id)),
      db
        .select({ tradeDate: rtAuditTradeDateFinality.tradeDate })
        .from(rtAuditTradeDateFinality)
        .where(
          and(
            eq(rtAuditTradeDateFinality.status, "closed"),
            lt(rtAuditTradeDateFinality.tradeDate, input.tradeDate)
          )
        )
        .orderBy(desc(rtAuditTradeDateFinality.tradeDate))
        .limit(AI_POSTMARKET_MAX_HISTORY_DAYS),
    ]);
  const watermarkHash = assertClosedFinality({
    tradeDate: input.tradeDate,
    finality,
    watermark,
    materialization,
  });
  const versions = Object.values(AI_DAILY_FORECAST_VERSIONS) as string[];
  const historyDates = closedDates.map(row => row.tradeDate).reverse();
  const [todayExamples, historyExamples] = await Promise.all([
    loadExamples({ tradeDates: [input.tradeDate], versions, limit: 10_000 }),
    loadExamples({
      tradeDates: historyDates,
      versions,
      limit: AI_POSTMARKET_MAX_HISTORY_EXAMPLES,
    }),
  ]);
  const currentEvents = await db
    .select()
    .from(rtForwardShadowEvents)
    .where(
      and(
        inArray(rtForwardShadowEvents.strategyVersion, versions),
        eq(rtForwardShadowEvents.tradeDate, input.tradeDate)
      )
    )
    .orderBy(asc(rtForwardShadowEvents.candleTime), asc(rtForwardShadowEvents.id));
  const currentTrades = await db
    .select()
    .from(rtForwardShadowTrades)
    .where(
      and(
        inArray(rtForwardShadowTrades.strategyVersion, versions),
        eq(rtForwardShadowTrades.entryTradeDate, input.tradeDate)
      )
    )
    .orderBy(
      asc(rtForwardShadowTrades.evaluationMode),
      asc(rtForwardShadowTrades.symbol),
      asc(rtForwardShadowTrades.entryCandleTime),
      asc(rtForwardShadowTrades.id)
    );
  const missing: string[] = [];
  const morningSymbols = unique(
    morning.flatMap(row => snapshotSymbols({ forecastJson: row.forecastJson, kind: "morning" }))
  );
  if (morning.length === 0) missing.push("morning_0830_snapshot_missing");
  if (
    morningSymbols.length !== POSTMARKET_SYMBOLS.length ||
    POSTMARKET_SYMBOLS.some(symbol => !morningSymbols.includes(symbol))
  )
    missing.push("morning_snapshot_ten_symbol_coverage_incomplete");
  if (morning.some(row => row.qualityStatus === "invalid"))
    missing.push("morning_snapshot_invalid");
  const snapshotQualityReasons = [
    ...morning.filter(row => row.qualityStatus === "degraded").map(() => "morning_snapshot_degraded"),
    ...intraday.filter(row => row.qualityStatus === "invalid").map(() => "intraday_snapshot_invalid"),
    ...intraday.filter(row => row.qualityStatus === "degraded").map(() => "intraday_snapshot_degraded"),
  ];
  const skippedCandidates = currentEvents
    .flatMap(event =>
      actionRows(event)
        .filter(action => action.type === "entry_rejected")
        .map(action => ({
          sourceEventId: event.sourceEventId,
          symbol: event.symbol,
          evaluationMode: event.evaluationMode,
          candleTime: event.candleTime,
          reason: typeof action.reason === "string" ? action.reason : "unknown",
          action,
        }))
    )
    .sort((left, right) =>
      `${left.symbol}:${left.candleTime}:${left.sourceEventId}`.localeCompare(
        `${right.symbol}:${right.candleTime}:${right.sourceEventId}`
      )
    );
  const symbols = POSTMARKET_SYMBOLS.map(symbol => ({
    symbol,
    trades: todayExamples.filter(example => example.symbol === symbol),
    skippedCandidates: {
      availability: "partial_persisted_entry_rejections_only",
      records: skippedCandidates.filter(item => item.symbol === symbol),
    },
  }));
  const prepared: AiPostmarketLearningInput = {
    contractVersion: AI_POSTMARKET_LEARNING_CONTRACT_VERSION,
    tradeDate: input.tradeDate,
    dataFinality: {
      status: finality!.status,
      watermarkHash,
      closedAt: finality!.closedAt?.toISOString() ?? null,
      reason: finality!.reason,
      watermark: finality!.watermarkJson,
      learningMaterialization: {
        component: materialization!.component,
        version: materialization!.version,
        status: materialization!.status,
        generatedAt: materialization!.generatedAt?.toISOString() ?? null,
      },
    },
    inputQuality:
      missing.length > 0
        ? "invalid"
        : snapshotQualityReasons.length > 0
          ? "degraded"
          : "verified",
    qualityReasonCodes: unique([
      ...missing,
      ...snapshotQualityReasons,
      ...(todayExamples.length === 0 ? ["cold_start_no_ai_v5_trades"] : []),
      ...(historyExamples.length < 10 ? ["historical_examples_below_ten"] : []),
    ]),
    snapshots: {
      morning: morning.map(row => snapshotProjection(row, "morning")),
      intraday: intraday.map(row => snapshotProjection(row, "intraday")),
    },
    currentDay: {
      symbols,
      referenceIndex: referenceIndex({ events: currentEvents, trades: currentTrades }),
    },
    historical: {
      closedTradeDates: historyDates,
      examples: historyExamples,
      maximumExamples: AI_POSTMARKET_MAX_HISTORY_EXAMPLES,
      strategyLearningSource: "signal_quality_only",
      executionAuditSource: "capital_constrained_separate_not_market_case",
    },
    dataState: {
      coldStart: todayExamples.length === 0 && historyExamples.length === 0,
      smallSample: historyExamples.filter(
        example => example.learningRole === "strategy_primary"
      ).length < 10,
      missing,
    },
  };
  if (prepared.inputQuality === "invalid")
    throw Error(
      `ai_postmarket_learning_input_invalid:${prepared.qualityReasonCodes.join(",")}`
    );
  return { ...prepared, inputHash: inputHash(prepared) };
}

const evidenceSchema = z
  .object({
    eventIds: z.array(z.string().min(1).max(180)).max(500),
    tradeEntrySourceEventIds: z.array(z.string().min(1).max(180)).max(500),
  })
  .strict();
const executionMetricsSchema = z
  .object({
    pnl: z.number().finite(),
    totalR: z.number().finite(),
    winRatePct: z.number().finite().min(0).max(100).nullable(),
    maxDrawdown: z.number().finite().nonnegative(),
  })
  .strict();
const scopeSchema = z
  .object({
    symbols: z.array(z.enum(POSTMARKET_SYMBOLS)).min(1).max(10),
    sides: z.array(z.enum(["long", "short"])).min(1).max(2),
    timeWindows: z.array(z.string().min(1).max(32)).max(20),
    regimes: z.array(z.string().min(1).max(64)).max(20),
  })
  .strict();
const postmarketReviewSchema = z
  .object({
    reviewId: z.string().min(1).max(180),
    tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAtMs: z.number().int().positive(),
    generatorId: z.string().min(1).max(96),
    promptVersion: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    status: z.enum(["observation_only", "candidate", "validated", "rejected"]),
    symbolReviews: z
      .array(
        z
          .object({
            symbol: z.enum(POSTMARKET_SYMBOLS),
            strengths: z.array(z.string().min(1).max(320)).max(20),
            failureTags: z.array(z.string().min(1).max(120)).max(30),
            evidence: evidenceSchema,
            reproducibility: z.enum(["low", "medium", "high", "unverified"]),
            confidence: z.number().finite().min(0).max(1),
          })
          .strict()
      )
      .length(10),
    hypotheses: z
      .array(
        z
          .object({
            hypothesisId: z.string().min(1).max(128),
            scope: scopeSchema,
            preconditions: z.array(z.string().min(1).max(320)).max(20),
            proposedChange: z.string().min(1).max(800),
            worseningRisks: z.array(z.string().min(1).max(320)).max(20),
            evidence: evidenceSchema,
          })
          .strict()
      )
      .max(30),
    validation: z
      .object({
        method: z.enum(["walk_forward", "not_run"]),
        learningPeriod: z.object({ start: z.string().nullable(), end: z.string().nullable() }).strict(),
        validationPeriod: z.object({ start: z.string().nullable(), end: z.string().nullable() }).strict(),
        closedTrades: z.number().int().nonnegative(),
        validationBusinessDays: z.number().int().nonnegative(),
        dataQuality: z.enum(["verified", "degraded", "invalid"]),
        excludesDegradedInvalid: z.boolean(),
        baseline: executionMetricsSchema,
        normalExecution: executionMetricsSchema,
        adverseExecution010Pct: executionMetricsSchema,
      })
      .strict(),
    policyAdvice: z
      .object({
        advice: z
          .array(
            z
              .object({
                policyId: z.string().min(1).max(128),
                scope: scopeSchema,
                advice: z.string().min(1).max(800),
                evidence: evidenceSchema,
              })
              .strict()
          )
          .max(30),
        prohibitions: z.array(z.string().min(1).max(320)).max(30),
      })
      .strict(),
  })
  .strict();
export type AiPostmarketLearningReview = z.infer<typeof postmarketReviewSchema>;

function validationGate(review: AiPostmarketLearningReview) {
  const reasons: string[] = [];
  const validation = review.validation;
  if (review.status === "validated") {
    if (jstDate(review.generatedAtMs) === review.tradeDate)
      reasons.push("same_day_review_cannot_be_validated");
    if (validation.method !== "walk_forward")
      reasons.push("validated_requires_walk_forward");
    if (!validation.learningPeriod.start || !validation.learningPeriod.end || !validation.validationPeriod.start || !validation.validationPeriod.end)
      reasons.push("validated_requires_explicit_time_series_periods");
    if (
      validation.learningPeriod.end &&
      validation.validationPeriod.start &&
      validation.learningPeriod.end >= validation.validationPeriod.start
    )
      reasons.push("validated_learning_and_validation_periods_overlap_or_reversed");
    if (
      validation.validationPeriod.end &&
      validation.validationPeriod.end >= review.tradeDate
    )
      reasons.push("validated_validation_period_must_end_before_review_trade_date");
    if (validation.closedTrades < 10) reasons.push("validated_requires_ten_closed_trades");
    if (validation.validationBusinessDays < 3)
      reasons.push("validated_requires_three_validation_business_days");
    if (validation.dataQuality !== "verified" || !validation.excludesDegradedInvalid)
      reasons.push("validated_cannot_include_degraded_or_invalid_data");
    for (const [name, metrics] of [
      ["normal", validation.normalExecution],
      ["adverse_010pct", validation.adverseExecution010Pct],
    ] as const) {
      if (metrics.pnl < validation.baseline.pnl)
        reasons.push(`validated_${name}_pnl_degrades_baseline`);
      if (metrics.totalR < validation.baseline.totalR)
        reasons.push(`validated_${name}_total_r_degrades_baseline`);
      if (metrics.maxDrawdown > validation.baseline.maxDrawdown)
        reasons.push(`validated_${name}_max_drawdown_worsens`);
    }
  }
  return { valid: reasons.length === 0, reasonCodes: reasons };
}

function validateReferenceOwnership(
  review: AiPostmarketLearningReview,
  reference: RecordValue
) {
  const eventSymbolById = asRecord(reference.eventSymbolById);
  const tradeSymbolByEntryId = asRecord(reference.tradeSymbolByEntryId);
  const reasons: string[] = [];
  const check = (symbol: string, evidence: z.infer<typeof evidenceSchema>, prefix: string) => {
    for (const eventId of evidence.eventIds)
      if (eventSymbolById[eventId] !== symbol)
        reasons.push(`${prefix}:event_reference_not_owned:${eventId}`);
    for (const tradeId of evidence.tradeEntrySourceEventIds)
      if (tradeSymbolByEntryId[tradeId] !== symbol)
        reasons.push(`${prefix}:trade_reference_not_owned:${tradeId}`);
  };
  for (const symbolReview of review.symbolReviews)
    check(symbolReview.symbol, symbolReview.evidence, `symbol:${symbolReview.symbol}`);
  for (const hypothesis of review.hypotheses)
    for (const symbol of hypothesis.scope.symbols)
      check(symbol, hypothesis.evidence, `hypothesis:${hypothesis.hypothesisId}:${symbol}`);
  for (const policy of review.policyAdvice.advice)
    for (const symbol of policy.scope.symbols)
      check(symbol, policy.evidence, `policy:${policy.policyId}:${symbol}`);
  return reasons;
}

/** Pure validation seam used by regression tests before database persistence. */
export function validateAiPostmarketLearningReviewForTest(input: {
  review: unknown;
  prepared: Pick<AiPostmarketLearningInput, "tradeDate" | "inputHash" | "currentDay">;
}) {
  const parsed = postmarketReviewSchema.safeParse(input.review);
  if (!parsed.success)
    return { valid: false, review: null, reasonCodes: ["review_schema_invalid"] };
  const review = parsed.data;
  const reasons: string[] = [];
  if (review.reviewId !== `ai-learning-review:${review.tradeDate}:${AI_POSTMARKET_REVIEW_ID_SUFFIX}`)
    reasons.push("review_id_invalid");
  if (review.tradeDate !== input.prepared.tradeDate)
    reasons.push("review_trade_date_mismatch");
  if (review.inputHash !== input.prepared.inputHash)
    reasons.push("review_input_hash_mismatch");
  const symbolSet = new Set(review.symbolReviews.map(row => row.symbol));
  if (symbolSet.size !== POSTMARKET_SYMBOLS.length)
    reasons.push("review_symbol_coverage_invalid");
  reasons.push(
    ...validateReferenceOwnership(review, input.prepared.currentDay.referenceIndex),
    ...validationGate(review).reasonCodes
  );
  return { valid: reasons.length === 0, review, reasonCodes: reasons };
}

async function getReview(reviewId: string) {
  const db = await getDb();
  if (!db) return null;
  return (
    (await db
      .select()
      .from(rtAiPostmarketLearningReviews)
      .where(eq(rtAiPostmarketLearningReviews.reviewId, reviewId))
      .limit(1))[0] ?? null
  );
}

/** Hash equality is the immutable duplicate/no-op boundary; different content is never overwritten. */
export function aiPostmarketReviewIdempotencyOutcomeForTest(
  existingPayloadHash: string | null,
  submittedPayloadHash: string
) {
  if (existingPayloadHash === null) return "insert" as const;
  return existingPayloadHash === submittedPayloadHash
    ? ("duplicate" as const)
    : ("conflict" as const);
}

async function insertReview(
  data: Omit<InsertRtAiPostmarketLearningReview, "id" | "createdAt">
) {
  const existing = await getReview(data.reviewId);
  if (existing) {
    if (
      aiPostmarketReviewIdempotencyOutcomeForTest(
        existing.payloadHash,
        data.payloadHash
      ) === "conflict"
    )
      throw Error("ai_postmarket_learning_review_idempotency_payload_mismatch");
    return { row: existing, duplicate: true };
  }
  const db = await getDb();
  if (!db) throw Error("database_unavailable");
  await db.insert(rtAiPostmarketLearningReviews).values(data);
  const created = await getReview(data.reviewId);
  if (!created) throw Error("ai_postmarket_learning_review_missing_after_insert");
  return { row: created, duplicate: false };
}

/** Auth is enforced at the tRPC boundary; this function revalidates finality and input hash. */
export async function ingestAiPostmarketLearningReview(submission: unknown) {
  const candidate = asRecord(submission);
  const prepared = await buildAiPostmarketLearningInput({
    tradeDate: String(candidate.tradeDate ?? ""),
  });
  const validation = validateAiPostmarketLearningReviewForTest({
    review: candidate,
    prepared,
  });
  if (!validation.valid || !validation.review)
    throw Error(
      `ai_postmarket_learning_review_validation_failed:${validation.reasonCodes.join(",")}`
    );
  const review = validation.review;
  const payloadHash = sha256Stable(review);
  const persisted = await insertReview({
    reviewId: review.reviewId,
    tradeDate: review.tradeDate,
    inputHash: review.inputHash,
    payloadHash,
    generatedAtMs: review.generatedAtMs,
    generatorId: review.generatorId,
    promptVersion: review.promptVersion,
    modelId: review.model,
    status: review.status,
    reviewJson: review,
    validationJson: {
      contractVersion: AI_POSTMARKET_LEARNING_CONTRACT_VERSION,
      statusGate: validationGate(review),
      inputQuality: prepared.inputQuality,
      inputQualityReasonCodes: prepared.qualityReasonCodes,
      automaticRuleMutation: false,
      orderInstructionConnection: false,
    },
  });
  return { ...persisted, prepared };
}

export type LearningReviewApplication = {
  state: "unavailable" | "stale" | "advisory_only" | "validated_policy";
  reasonCodes: string[];
  automaticRuleMutation: false;
  review: {
    reviewId: string;
    tradeDate: string;
    inputHash: string;
    payloadHash: string;
    status: string;
    policyAdvice: unknown;
  } | null;
};

export function isPostmarketReviewBeforeForecastForTest(
  reviewTradeDate: string,
  forecastTradeDate: string
) {
  return reviewTradeDate < forecastTradeDate;
}

/** Selects only an earlier review; application remains an external-Codex input, never an app rule mutation. */
export async function getLatestLearningReviewApplicationBefore(
  forecastTradeDate: string
): Promise<LearningReviewApplication> {
  const db = await getDb();
  if (!db)
    return {
      state: "unavailable",
      reasonCodes: ["database_unavailable"],
      automaticRuleMutation: false,
      review: null,
    };
  const [rows, recentClosed] = await Promise.all([
    db
      .select()
      .from(rtAiPostmarketLearningReviews)
      .where(
        and(
          lt(rtAiPostmarketLearningReviews.tradeDate, forecastTradeDate),
          inArray(rtAiPostmarketLearningReviews.status, [
            "observation_only",
            "candidate",
            "validated",
          ])
        )
      )
      .orderBy(desc(rtAiPostmarketLearningReviews.tradeDate), desc(rtAiPostmarketLearningReviews.id))
      .limit(1),
    db
      .select({ tradeDate: rtAuditTradeDateFinality.tradeDate })
      .from(rtAuditTradeDateFinality)
      .where(
        and(
          eq(rtAuditTradeDateFinality.status, "closed"),
          lt(rtAuditTradeDateFinality.tradeDate, forecastTradeDate)
        )
      )
      .orderBy(desc(rtAuditTradeDateFinality.tradeDate))
      .limit(AI_POSTMARKET_MAX_HISTORY_DAYS),
  ]);
  const row = rows[0];
  if (!row || !isPostmarketReviewBeforeForecastForTest(row.tradeDate, forecastTradeDate))
    return {
      state: "unavailable",
      reasonCodes: ["postmarket_learning_review_before_trade_date_missing"],
      automaticRuleMutation: false,
      review: null,
    };
  const review = asRecord(row.reviewJson);
  const compact = {
    reviewId: row.reviewId,
    tradeDate: row.tradeDate,
    inputHash: row.inputHash,
    payloadHash: row.payloadHash,
    status: row.status,
    policyAdvice: asRecord(review.policyAdvice),
  };
  if (!recentClosed.some(item => item.tradeDate === row.tradeDate))
    return {
      state: "stale",
      reasonCodes: ["postmarket_learning_review_older_than_sixty_closed_dates"],
      automaticRuleMutation: false,
      review: compact,
    };
  if (row.status === "validated")
    return {
      state: "validated_policy",
      reasonCodes: ["validated_policy_advice_available_to_external_codex_only"],
      automaticRuleMutation: false,
      review: compact,
    };
  return {
    state: "advisory_only",
    reasonCodes: ["review_status_not_validated_policy_advice_advisory_only"],
    automaticRuleMutation: false,
    review: compact,
  };
}

export async function getAiPostmarketLearningReviewDashboard(asOfDate: string) {
  const db = await getDb();
  if (!db) return { latest: null, count: 0 };
  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(rtAiPostmarketLearningReviews)
      .where(lt(rtAiPostmarketLearningReviews.tradeDate, asOfDate))
      .orderBy(desc(rtAiPostmarketLearningReviews.tradeDate), desc(rtAiPostmarketLearningReviews.id))
      .limit(1),
    db.select({ count: count() }).from(rtAiPostmarketLearningReviews),
  ]);
  const row = rows[0];
  const reviewCount = Number(countRows[0]?.count ?? 0);
  if (!row) return { latest: null, count: reviewCount };
  const review = asRecord(row.reviewJson);
  const symbolReviews = Array.isArray(review.symbolReviews)
    ? review.symbolReviews.map(asRecord)
    : [];
  const causeCounts = new Map<string, number>();
  for (const item of symbolReviews) {
    const tags = Array.isArray(item.failureTags) ? item.failureTags : [];
    for (const tag of tags) {
      const key = String(tag);
      causeCounts.set(key, (causeCounts.get(key) ?? 0) + 1);
    }
  }
  const validation = asRecord(review.validation);
  return {
    count: reviewCount,
    latest: {
      reviewId: row.reviewId,
      tradeDate: row.tradeDate,
      status: row.status,
      payloadHash: row.payloadHash,
      targetCount: Number(validation.closedTrades ?? 0),
      validation: {
        method: validation.method ?? null,
        closedTrades: validation.closedTrades ?? null,
        validationBusinessDays: validation.validationBusinessDays ?? null,
        normalExecution: validation.normalExecution ?? null,
        adverseExecution010Pct: validation.adverseExecution010Pct ?? null,
      },
      leadingCauses: Array.from(causeCounts.entries())
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 5)
        .map(([tag, count]) => ({ tag, count })),
      eligibleForNextDayPolicy: row.status === "validated",
      automaticRuleMutation: false,
      orderInstructionConnection: false,
    },
  };
}
