import {
  getRtMarketContextEvent,
  getRtMarketContextEventsForDate,
  insertRtMarketContextEvent,
} from "./db";
import {
  classifyIntradayMarketContext,
  type MarketContextBar,
} from "./marketContextSelectorShadow";
import {
  RollingMarketContextBars,
} from "./marketContextPerformanceSelector";
import {
  enqueueMarketContextSelectorWorker,
  marketContextSelectorWorkerEnabled,
} from "./marketContextSelectorWorker";
import { sha256Stable } from "./runtimeIdentity";

export type MarketContextInput = {
  instrumentKey: "nikkei225_mini_front";
  providerSymbol: string;
  productType: "future";
  contractMonth?: string | null;
  marketSession: "day_night";
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  previousClose?: number | null;
  valueSource: "ws_aggregated" | "rest_fallback";
  sourceEventId: string;
  relaySessionId: string;
  eventSeq: number;
  payloadHash: string;
  observedAtMs: number;
  relaySentAtMs: number;
  correctedEventId?: string | null;
};

export const MARKET_CONTEXT_MINI_INSTRUMENT = "nikkei225_mini_front" as const;
export const MARKET_CONTEXT_DAY_SESSION_START = "08:45";
export const MARKET_CONTEXT_DAY_SESSION_END = "15:45";

// One bounded, isolated mini timeline per relay process. A restart hydrates once
// from the dedicated market-context table; normal 10-symbol ingestion is untouched.
const rollingBarsByInstrument = new Map<string, RollingMarketContextBars>();

/**
 * Public relay input is deliberately not OAuth-gated so it can use the existing
 * Windows pushCandle transport. This is the independent fail-closed boundary:
 * only the resolved Nikkei 225 mini day/night feed and its immutable relay
 * identity may reach the market-context-only table.
 */
export function marketContextIngressViolation(input: MarketContextInput): string | null {
  if (input.instrumentKey !== MARKET_CONTEXT_MINI_INSTRUMENT) return "unexpected_market_context_instrument";
  if (input.productType !== "future") return "market_context_product_must_be_future";
  if (input.marketSession !== "day_night") return "market_context_session_must_be_day_night";
  if (!/^\d{2}:\d{2}$/.test(input.candleTime)
    || input.candleTime < MARKET_CONTEXT_DAY_SESSION_START
    || input.candleTime > MARKET_CONTEXT_DAY_SESSION_END) return "market_context_candle_time_outside_day_session";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tradeDate)) return "market_context_trade_date_invalid";
  if (!input.providerSymbol || input.providerSymbol.length > 32) return "market_context_provider_symbol_invalid";
  if (!input.sourceEventId || input.sourceEventId.length > 128) return "market_context_source_event_id_invalid";
  if (!input.relaySessionId || input.relaySessionId.length > 96) return "market_context_relay_session_id_invalid";
  if (!Number.isInteger(input.eventSeq) || input.eventSeq < 0) return "market_context_event_seq_invalid";
  if (!/^[a-f0-9]{64}$/.test(input.payloadHash)) return "market_context_payload_hash_invalid";
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) return "market_context_observed_time_invalid";
  if (!Number.isSafeInteger(input.relaySentAtMs) || input.relaySentAtMs < 0) return "market_context_relay_sent_time_invalid";
  if (input.correctedEventId) return "market_context_correction_not_accepted";
  if (![input.open, input.high, input.low, input.close].every(value => Number.isFinite(value) && value > 0)
    || input.high < Math.max(input.open, input.close)
    || input.low > Math.min(input.open, input.close)
    || input.high < input.low) return "market_context_ohlc_invalid";
  return null;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function quality(input: MarketContextInput, cloudReceivedAtMs: number) {
  if (input.valueSource !== "ws_aggregated") {
    return { status: "degraded" as const, reasonCodes: ["point_price_fallback_not_one_minute_ohlc"] };
  }
  const observed = input.observedAtMs ?? null;
  const sent = input.relaySentAtMs ?? null;
  if (observed === null || sent === null) {
    return { status: "degraded" as const, reasonCodes: ["relay_clock_provenance_missing"] };
  }
  if (observed > sent || sent > cloudReceivedAtMs + 5_000) {
    return { status: "invalid" as const, reasonCodes: ["relay_clock_order_invalid"] };
  }
  if (sent - observed > 120_000) {
    return { status: "degraded" as const, reasonCodes: ["market_observation_to_relay_over_120_seconds"] };
  }
  if (cloudReceivedAtMs - sent > 120_000) {
    return { status: "degraded" as const, reasonCodes: ["relay_to_cloud_over_120_seconds"] };
  }
  return { status: "verified" as const, reasonCodes: ["clock_safe_verified_relay"] };
}

function toBar(row: {
  tradeDate: string;
  candleTime: string;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  previousClose: unknown;
}): MarketContextBar {
  const previousClose = row.previousClose === null || row.previousClose === undefined ? null : number(row.previousClose);
  return {
    tradeDate: row.tradeDate,
    candleTime: row.candleTime,
    open: number(row.open),
    high: number(row.high),
    low: number(row.low),
    close: number(row.close),
    previousClose: previousClose !== null && Number.isFinite(previousClose) ? previousClose : null,
  };
}

/**
 * 市場環境専用の追記保存。通常source ingestionを呼ばないため、売買・shadow・注文は発生しない。
 */
export async function ingestMarketContext(input: MarketContextInput) {
  const ingressViolation = marketContextIngressViolation(input);
  if (ingressViolation) {
    return {
      accepted: false,
      duplicate: false,
      payloadMismatch: false,
      sourceEventId: input.sourceEventId,
      reason: ingressViolation,
    };
  }
  const cloudReceivedAtMs = Date.now();
  const canonicalPayload = {
    instrumentKey: input.instrumentKey,
    providerSymbol: input.providerSymbol,
    productType: input.productType,
    contractMonth: input.contractMonth ?? null,
    marketSession: input.marketSession,
    tradeDate: input.tradeDate,
    candleTime: input.candleTime,
    open: input.open,
    high: input.high,
    low: input.low,
    close: input.close,
    volume: input.volume ?? null,
    previousClose: input.previousClose ?? null,
    valueSource: input.valueSource,
  };
  const payloadHash = sha256Stable(canonicalPayload);
  const relaySessionId = input.relaySessionId;
  const sourceEventId = input.sourceEventId;
  const eventSeq = input.eventSeq;
  const existing = await getRtMarketContextEvent(sourceEventId);
  if (existing) {
    const payloadMismatch = existing.payloadHash !== payloadHash
      || existing.relayPayloadHash !== input.payloadHash;
    return {
      accepted: !payloadMismatch,
      duplicate: true,
      payloadMismatch,
      sourceEventId,
      qualityStatus: existing.qualityStatus,
      result: existing.resultJson,
    };
  }

  const {
    getLatestRtMarketContextEventForInstrumentDate,
    getLatestRtMarketContextEventForRelaySession,
  } = await import("./db");
  const [latestAccepted, latestRelaySequence] = await Promise.all([
    getLatestRtMarketContextEventForInstrumentDate({
      instrumentKey: input.instrumentKey,
      tradeDate: input.tradeDate,
    }),
    getLatestRtMarketContextEventForRelaySession({
      relaySessionId,
      tradeDate: input.tradeDate,
    }),
  ]);
  if (latestAccepted && input.candleTime <= latestAccepted.candleTime) {
    return {
      accepted: false,
      duplicate: false,
      payloadMismatch: false,
      sourceEventId,
      reason: "market_context_candle_time_non_monotonic",
      latestAcceptedCandleTime: latestAccepted.candleTime,
    };
  }
  if (latestRelaySequence && input.eventSeq <= latestRelaySequence.eventSeq) {
    return {
      accepted: false,
      duplicate: false,
      payloadMismatch: false,
      sourceEventId,
      reason: "market_context_event_sequence_non_monotonic",
      latestAcceptedEventSeq: latestRelaySequence.eventSeq,
    };
  }

  const observedQuality = quality(input, cloudReceivedAtMs);
  const currentBar = toBar(canonicalPayload);
  let rolling = rollingBarsByInstrument.get(input.instrumentKey);
  if (!rolling || rolling.tradeDate() !== input.tradeDate) {
    rolling = new RollingMarketContextBars();
    if (observedQuality.status === "verified") {
      const priorRows = await getRtMarketContextEventsForDate({
        tradeDate: input.tradeDate,
        instrumentKey: input.instrumentKey,
        verifiedOnly: true,
      });
      rolling.hydrate(priorRows.map(toBar));
    }
    rollingBarsByInstrument.set(input.instrumentKey, rolling);
  }
  if (observedQuality.status === "verified") rolling.append(currentBar);
  const regime = observedQuality.status === "verified"
    ? classifyIntradayMarketContext(rolling.bars())
    : classifyIntradayMarketContext([]);

  const shouldScheduleSelector = observedQuality.status === "verified"
    && regime.checkpoint
    && marketContextSelectorWorkerEnabled();
  const selectorReason = shouldScheduleSelector
    ? "selector_scheduled_receive_priority"
    : regime.checkpoint
      ? "selector_not_scheduled_feature_disabled_or_quality_not_verified"
      : "not_a_fixed_checkpoint";

  const resultJson = {
    monitoringOnly: true,
    currentEngineConnection: false,
    forwardShadowDispatchConnection: false,
    candidateConnection: false,
    marginConnection: false,
    orderInstructionConnection: false,
    quality: observedQuality,
    regime,
    selectorReason,
    selectorWorker: {
      status: shouldScheduleSelector ? "scheduled" : "not_scheduled",
      checkpoint: regime.checkpoint ? regime.decisionAt : null,
      reason: selectorReason,
      receivePriorityIsolation: true,
    },
  };
  const row = await insertRtMarketContextEvent({
    sourceEventId,
    relaySessionId,
    eventSeq,
    instrumentKey: input.instrumentKey,
    providerSymbol: input.providerSymbol,
    productType: input.productType,
    contractMonth: input.contractMonth ?? null,
    marketSession: input.marketSession,
    tradeDate: input.tradeDate,
    candleTime: input.candleTime,
    open: String(input.open),
    high: String(input.high),
    low: String(input.low),
    close: String(input.close),
    volume: input.volume ?? null,
    previousClose: input.previousClose === null || input.previousClose === undefined ? null : String(input.previousClose),
    payloadHash,
    relayPayloadHash: input.payloadHash ?? null,
    payloadJson: canonicalPayload,
    observedAtMs: input.observedAtMs,
    relaySentAtMs: input.relaySentAtMs,
    cloudReceivedAtMs,
    correctedEventId: input.correctedEventId ?? null,
    qualityStatus: observedQuality.status,
    resultJson,
  });
  if (row.payloadHash !== payloadHash || row.relayPayloadHash !== input.payloadHash) {
    return {
      accepted: false,
      duplicate: true,
      payloadMismatch: true,
      sourceEventId,
      qualityStatus: row.qualityStatus,
      result: row.resultJson,
    };
  }
  if (shouldScheduleSelector) {
    enqueueMarketContextSelectorWorker({
      sourceEventId,
      tradeDate: input.tradeDate,
      checkpoint: regime.decisionAt as "09:05" | "09:15" | "10:00" | "12:35" | "13:30",
      intradayRegime: regime,
    });
  }
  if (process.env.NODE_ENV !== "test" && observedQuality.status === "verified" && regime.checkpoint) {
    // AI朝forecastのrevisionはimmutable追記だけ。受信・通常engine・既存selectorを待たせない。
    void import("./aiDailyForecastService")
      .then(({ evaluateAiDailyForecastMarketContextRevision }) => evaluateAiDailyForecastMarketContextRevision({
        sourceEventId,
        tradeDate: input.tradeDate,
        candleTime: regime.decisionAt!,
      }))
      .catch(error => console.error("[AiDailyForecastRevision] detached revision append failed", error));
  }
  return {
    accepted: row.qualityStatus !== "invalid",
    duplicate: false,
    payloadMismatch: false,
    sourceEventId,
    qualityStatus: row.qualityStatus,
    result: row.resultJson,
  };
}
