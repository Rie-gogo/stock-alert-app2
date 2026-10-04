import {
  getRtDailyAuditMaterialization,
  getRtMarketContextEvent,
  getRtMarketContextEventsForDate,
  insertRtMarketContextEvent,
} from "./db";
import {
  buildMarketContextSelectorShadowDecision,
  classifyIntradayMarketContext,
  type MarketContextBar,
} from "./marketContextSelectorShadow";
import {
  ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT,
  ROUTE_GRANULAR_SELECTOR_VERSION,
} from "./routeGranularNextDaySelector";
import { sha256Stable } from "./runtimeIdentity";

export type MarketContextInput = {
  instrumentKey: "nikkei225_cash" | "nikkei225_mini_front";
  providerSymbol: string;
  productType: "index" | "future";
  contractMonth?: string | null;
  marketSession: "cash" | "day" | "night" | "day_night";
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  previousClose?: number | null;
  valueSource: "ws_aggregated" | "rest_fallback";
  sourceEventId?: string;
  relaySessionId?: string;
  eventSeq?: number;
  payloadHash?: string;
  observedAtMs?: number | null;
  relaySentAtMs?: number | null;
  correctedEventId?: string | null;
};

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
  const relaySessionId = input.relaySessionId ?? "server-derived-market-context";
  const sourceEventId = input.sourceEventId
    ?? `market:${input.instrumentKey}:${input.tradeDate}:${input.candleTime}:${payloadHash.slice(0, 20)}`;
  const eventSeq = input.eventSeq ?? Number.parseInt(payloadHash.slice(0, 7), 16);
  const existing = await getRtMarketContextEvent(sourceEventId);
  if (existing) {
    return {
      accepted: existing.payloadHash === payloadHash,
      duplicate: true,
      payloadMismatch: existing.payloadHash !== payloadHash,
      sourceEventId,
      qualityStatus: existing.qualityStatus,
      result: existing.resultJson,
    };
  }

  const observedQuality = quality(input, cloudReceivedAtMs);
  const priorRows = observedQuality.status === "verified"
    ? await getRtMarketContextEventsForDate({
      tradeDate: input.tradeDate,
      instrumentKey: input.instrumentKey,
      verifiedOnly: true,
    })
    : [];
  const currentBar = toBar(canonicalPayload);
  const regime = observedQuality.status === "verified"
    ? classifyIntradayMarketContext([...priorRows.map(toBar), currentBar])
    : classifyIntradayMarketContext([]);

  let selectorShadow: ReturnType<typeof buildMarketContextSelectorShadowDecision> | null = null;
  let selectorReason = regime.checkpoint ? "route_selector_snapshot_missing" : "not_a_fixed_checkpoint";
  if (observedQuality.status === "verified" && regime.checkpoint) {
    const routeSnapshot = await getRtDailyAuditMaterialization({
      component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT,
      version: ROUTE_GRANULAR_SELECTOR_VERSION,
      tradeDate: input.tradeDate,
    });
    if (routeSnapshot) {
      selectorShadow = buildMarketContextSelectorShadowDecision({
        tradeDate: input.tradeDate,
        sourceEventId,
        regime,
        routeSelectorSnapshot: routeSnapshot.resultJson,
      });
      selectorReason = "fixed_checkpoint_selector_shadow_recorded";
    }
  }

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
    selectorShadow,
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
    observedAtMs: input.observedAtMs ?? null,
    relaySentAtMs: input.relaySentAtMs ?? null,
    cloudReceivedAtMs,
    correctedEventId: input.correctedEventId ?? null,
    qualityStatus: observedQuality.status,
    resultJson,
  });
  return {
    accepted: row.qualityStatus !== "invalid",
    duplicate: false,
    payloadMismatch: false,
    sourceEventId,
    qualityStatus: row.qualityStatus,
    result: row.resultJson,
  };
}
