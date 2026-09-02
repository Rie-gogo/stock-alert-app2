import {
  claimRtSourceEvent,
  completeRtSourceEvent,
  getPriorRtSourceEventForCandle,
  getRtSourceEvent,
} from "./db";
import { updateOrderBook, type KabuOrderBook } from "./kabuStation";
import { processForwardShadowSourceEvent } from "./forwardShadow";
import { processCandle, type RtCandle1Min } from "./realtimeSimEngine";
import { sha256Stable } from "./runtimeIdentity";

export interface SourceEventMetadata {
  sourceEventId?: string;
  relaySessionId?: string;
  eventSeq?: number;
  payloadHash?: string;
  relayReceivedAtMs?: number;
  relaySentAtMs?: number;
  correctedEventId?: string;
}

export interface IngestCandleInput extends RtCandle1Min, SourceEventMetadata {
  board?: Omit<KabuOrderBook, "symbol" | "receivedAt"> | null;
}

function normalizeMetadata(input: IngestCandleInput) {
  const canonicalPayload = {
    symbol: input.symbol,
    tradeDate: input.tradeDate,
    candleTime: input.candleTime,
    open: input.open,
    high: input.high,
    low: input.low,
    close: input.close,
    volume: input.volume,
    board: input.board ?? null,
  };
  const serverPayloadHash = sha256Stable(canonicalPayload);
  const relaySessionId = input.relaySessionId ?? "server-derived-legacy";
  const sourceEventId = input.sourceEventId
    ?? `legacy:${input.symbol}:${input.tradeDate}:${input.candleTime}:${serverPayloadHash.slice(0, 24)}`;
  const eventSeq = input.eventSeq ?? Number.parseInt(serverPayloadHash.slice(0, 7), 16);
  return {
    canonicalPayload,
    sourceEventId,
    relaySessionId,
    eventSeq,
    payloadHash: input.payloadHash ?? serverPayloadHash,
    serverPayloadHash,
  };
}

export async function ingestSourceCandle(input: IngestCandleInput) {
  const metadata = normalizeMetadata(input);
  const claimed = await claimRtSourceEvent({
    sourceEventId: metadata.sourceEventId,
    relaySessionId: metadata.relaySessionId,
    eventSeq: metadata.eventSeq,
    symbol: input.symbol,
    tradeDate: input.tradeDate,
    candleTime: input.candleTime,
    payloadHash: metadata.payloadHash,
    payloadJson: metadata.canonicalPayload,
    relayReceivedAtMs: input.relayReceivedAtMs ?? null,
    relaySentAtMs: input.relaySentAtMs ?? null,
    correctedEventId: input.correctedEventId ?? null,
    status: "processing",
    resultAction: null,
    resultJson: null,
    errorDetail: null,
  });

  if (!claimed) {
    const existing = await getRtSourceEvent(metadata.sourceEventId);
    if (existing && existing.payloadHash !== metadata.payloadHash) {
      return {
        symbol: input.symbol,
        tradeDate: input.tradeDate,
        candleTime: input.candleTime,
        action: "none" as const,
        reason: "source_event_payload_mismatch",
        sourceEventId: metadata.sourceEventId,
        sourceEventDuplicate: true as const,
      };
    }
    const existingResult = existing?.status === "processed" && existing.resultJson && typeof existing.resultJson === "object"
      ? existing.resultJson as Record<string, unknown>
      : {};
    return {
      symbol: input.symbol,
      tradeDate: input.tradeDate,
      candleTime: input.candleTime,
      action: "none" as const,
      reason: existing?.status === "processed" ? "duplicate_source_event" : `duplicate_source_event_${existing?.status ?? "unknown"}`,
      sourceEventId: metadata.sourceEventId,
      sourceEventDuplicate: true as const,
      originalResult: existingResult,
    };
  }


  // 同一銘柄・日時の先行イベントが完了済みなら、訂正足として追記だけ行い過去判断は変更しない。
  const priorEvent = await getPriorRtSourceEventForCandle({
    sourceEventId: metadata.sourceEventId,
    symbol: input.symbol,
    tradeDate: input.tradeDate,
    candleTime: input.candleTime,
  });
  if (priorEvent?.status === "processed") {
    const correctionResult = {
      symbol: input.symbol,
      tradeDate: input.tradeDate,
      candleTime: input.candleTime,
      action: "none" as const,
      reason: "correction_stored_not_replayed",
      sourceEventId: metadata.sourceEventId,
      correctedEventId: input.correctedEventId ?? priorEvent.sourceEventId,
      sourceEventDuplicate: false as const,
    };
    await completeRtSourceEvent({
      sourceEventId: metadata.sourceEventId,
      status: "processed",
      resultAction: "correction_ignored",
      resultJson: correctionResult,
    });
    return correctionResult;
  }

  try {
    if (input.board) {
      updateOrderBook({
        symbol: input.symbol,
        ...input.board,
        receivedAt: Date.now(),
      } as KabuOrderBook);
    }
    const result = await processCandle({
      symbol: input.symbol,
      tradeDate: input.tradeDate,
      candleTime: input.candleTime,
      open: input.open,
      high: input.high,
      low: input.low,
      close: input.close,
      volume: input.volume,
    });
    let shadowResult: unknown = null;
    try {
      shadowResult = await processForwardShadowSourceEvent({
        sourceEventId: metadata.sourceEventId,
        candle: input,
        board: input.board ?? null,
      });
    } catch (shadowError) {
      console.error("[ForwardShadow] シャドー評価エラー（現行DRY_RUN処理は継続）:", shadowError);
      shadowResult = { error: String(shadowError) };
    }
    const combinedResult = {
      ...result,
      sourceEventId: metadata.sourceEventId,
      sourceEventDuplicate: false as const,
      shadowEvaluation: shadowResult,
    };
    await completeRtSourceEvent({
      sourceEventId: metadata.sourceEventId,
      status: "processed",
      resultAction: result.action,
      resultJson: combinedResult,
    });
    return combinedResult;
  } catch (error) {
    await completeRtSourceEvent({
      sourceEventId: metadata.sourceEventId,
      status: "failed",
      resultAction: "error",
      resultJson: null,
      errorDetail: String(error),
    });
    throw error;
  }
}
