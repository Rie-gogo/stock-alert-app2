import {
  finalizeRtMarketContextSelectorResult,
  finalizeRtPremarketContextSelectorResult,
  getLatestRtPremarketContextSnapshot,
  getRtAuditTradeDateWatermark,
  getRtDailyAuditMaterialization,
} from "./db";
import {
  buildPremarketMarketContextSelectorShadowDecision,
  buildMarketContextSelectorShadowDecision,
  type IntradayMarketRegime,
  type PremarketMarketRegime,
} from "./marketContextSelectorShadow";
import {
  buildPremarketContextPerformanceSelectorDecision,
  buildIntradayContextPerformanceSelectorDecision,
  resolveMarketContextV4RouteCandidatesCached,
} from "./marketContextPerformanceSelector";
import {
  ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT,
  ROUTE_GRANULAR_SELECTOR_VERSION,
} from "./routeGranularNextDaySelector";

/**
 * Detached, bounded selector worker. It is deliberately not part of the
 * market-context ingress transaction: a slow selector can never reject or delay
 * the immutable Nikkei225 mini event itself.
 */
export const MARKET_CONTEXT_SELECTOR_WORKER_TIMEOUT_MS = 1_500;
export const MARKET_CONTEXT_SELECTOR_WORKER_FEATURE_FLAG = "MARKET_CONTEXT_PERFORMANCE_SELECTOR_ENABLED";

type Checkpoint = "09:05" | "09:15" | "10:00" | "12:35" | "13:30";
type SelectorWorkerInput = {
  sourceEventId: string;
  tradeDate: string;
  checkpoint: Checkpoint;
  intradayRegime: IntradayMarketRegime;
};
type PremarketSelectorWorkerInput = {
  sourceSnapshotId: string;
  tradeDate: string;
  premarketRegime: PremarketMarketRegime;
};

const inFlightSourceEventIds = new Set<string>();

export function marketContextSelectorWorkerEnabled(): boolean {
  return process.env[MARKET_CONTEXT_SELECTOR_WORKER_FEATURE_FLAG] !== "false";
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function backlogReason(watermark: Awaited<ReturnType<typeof getRtAuditTradeDateWatermark>>): string | null {
  if (watermark.source.processing > 0 || watermark.source.failed > 0) return "source_processing_or_failed";
  if (watermark.candidateOutbox.pending > 0 || watermark.candidateOutbox.processing > 0 || watermark.candidateOutbox.retryableError > 0 || watermark.candidateOutbox.terminal > 0) return "candidate_queue_backlog";
  if (watermark.shadowOutbox.pending > 0 || watermark.shadowOutbox.processing > 0 || watermark.shadowOutbox.error > 0) return "shadow_queue_backlog";
  if (watermark.unresolvedGaps > 0) return "unresolved_source_gap";
  return null;
}

async function runSelectorWorker(input: SelectorWorkerInput): Promise<void> {
  const startedAtMs = Date.now();
  try {
    const watermark = await getRtAuditTradeDateWatermark(input.tradeDate);
    const deferReason = backlogReason(watermark);
    if (deferReason) {
      await finalizeRtMarketContextSelectorResult({
        sourceEventId: input.sourceEventId,
        selectorResult: {
          selectorReason: "selector_deferred_receive_priority",
          selectorWorker: {
            status: "deferred",
            reason: deferReason,
            checkpoint: input.checkpoint,
            elapsedMs: Date.now() - startedAtMs,
            input: "saved_checkpoint_regime_only",
          },
        },
      });
      return;
    }

    const [routeSnapshot, premarketSnapshot] = await Promise.all([
      getRtDailyAuditMaterialization({
        component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT,
        version: ROUTE_GRANULAR_SELECTOR_VERSION,
        tradeDate: input.tradeDate,
      }),
      getLatestRtPremarketContextSnapshot({ tradeDate: input.tradeDate, usableOnly: true }),
    ]);
    const premarketResult = object(premarketSnapshot?.resultJson);
    const premarketRegime = object(premarketResult?.regime) as PremarketMarketRegime | null;
    const candidates = await resolveMarketContextV4RouteCandidatesCached(input.tradeDate);

    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > MARKET_CONTEXT_SELECTOR_WORKER_TIMEOUT_MS) {
      await finalizeRtMarketContextSelectorResult({
        sourceEventId: input.sourceEventId,
        selectorResult: {
          selectorReason: "selector_deferred_timeout",
          selectorWorker: {
            status: "deferred",
            reason: "selector_worker_timeout",
            checkpoint: input.checkpoint,
            elapsedMs,
            timeoutMs: MARKET_CONTEXT_SELECTOR_WORKER_TIMEOUT_MS,
            input: "bounded_snapshot_reads_only",
          },
        },
      });
      return;
    }

    const selectorShadow = routeSnapshot
      ? buildMarketContextSelectorShadowDecision({
        tradeDate: input.tradeDate,
        sourceEventId: input.sourceEventId,
        regime: input.intradayRegime,
        premarketRegime,
        routeSelectorSnapshot: routeSnapshot.resultJson,
      })
      : null;
    const contextPerformanceSelectorV4 = buildIntradayContextPerformanceSelectorDecision({
      tradeDate: input.tradeDate,
      sourceEventId: input.sourceEventId,
      checkpoint: input.checkpoint,
      intradayRegime: input.intradayRegime,
      premarketRegime,
      routeSelectorSnapshot: {
        selectorVersion: candidates.selectorVersion,
        inputHash: candidates.inputHash,
        routeCandidateSource: candidates.source,
        catalogAudit: candidates.catalogAudit,
        scores: candidates.scores,
      },
    });

    await finalizeRtMarketContextSelectorResult({
      sourceEventId: input.sourceEventId,
      selectorResult: {
        selectorReason: routeSnapshot
          ? "v3_history_preserved_and_v4_frozen_context_selector_recorded"
          : "v4_frozen_context_selector_recorded_route_snapshot_missing",
        selectorShadow,
        contextPerformanceSelectorV4,
        selectorWorker: {
          status: "completed",
          checkpoint: input.checkpoint,
          elapsedMs,
          timeoutMs: MARKET_CONTEXT_SELECTOR_WORKER_TIMEOUT_MS,
          input: "bounded_snapshot_reads_only",
          currentEngineConnection: false,
          forwardShadowDispatchConnection: false,
          orderInstructionConnection: false,
        },
      },
    });
  } catch (error) {
    await finalizeRtMarketContextSelectorResult({
      sourceEventId: input.sourceEventId,
      selectorResult: {
        selectorReason: "selector_worker_failed_receive_continues",
        selectorWorker: {
          status: "failed",
          checkpoint: input.checkpoint,
          elapsedMs: Date.now() - startedAtMs,
          errorCode: error instanceof Error ? error.name : "unknown_error",
          input: "bounded_snapshot_reads_only",
        },
      },
    }).catch(() => undefined);
  }
}

async function runPremarketSelectorWorker(input: PremarketSelectorWorkerInput): Promise<void> {
  const startedAtMs = Date.now();
  try {
    const watermark = await getRtAuditTradeDateWatermark(input.tradeDate);
    const deferReason = backlogReason(watermark);
    if (deferReason) {
      await finalizeRtPremarketContextSelectorResult({
        sourceSnapshotId: input.sourceSnapshotId,
        selectorResult: {
          selectorReason: "selector_deferred_receive_priority",
          selectorWorker: { status: "deferred", reason: deferReason, checkpoint: "08:30", elapsedMs: Date.now() - startedAtMs, input: "saved_snapshot_only" },
        },
      });
      return;
    }
    const [routeSnapshot, candidates] = await Promise.all([
      getRtDailyAuditMaterialization({
        component: ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT,
        version: ROUTE_GRANULAR_SELECTOR_VERSION,
        tradeDate: input.tradeDate,
      }),
      resolveMarketContextV4RouteCandidatesCached(input.tradeDate),
    ]);
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > MARKET_CONTEXT_SELECTOR_WORKER_TIMEOUT_MS) {
      await finalizeRtPremarketContextSelectorResult({
        sourceSnapshotId: input.sourceSnapshotId,
        selectorResult: {
          selectorReason: "selector_deferred_timeout",
          selectorWorker: { status: "deferred", reason: "selector_worker_timeout", checkpoint: "08:30", elapsedMs, timeoutMs: MARKET_CONTEXT_SELECTOR_WORKER_TIMEOUT_MS, input: "bounded_snapshot_reads_only" },
        },
      });
      return;
    }
    const selectorShadow = routeSnapshot
      ? buildPremarketMarketContextSelectorShadowDecision({
        tradeDate: input.tradeDate,
        sourceSnapshotId: input.sourceSnapshotId,
        premarketRegime: input.premarketRegime,
        routeSelectorSnapshot: routeSnapshot.resultJson,
      })
      : null;
    const contextPerformanceSelectorV4 = buildPremarketContextPerformanceSelectorDecision({
      tradeDate: input.tradeDate,
      sourceSnapshotId: input.sourceSnapshotId,
      premarketRegime: input.premarketRegime,
      routeSelectorSnapshot: {
        selectorVersion: candidates.selectorVersion,
        inputHash: candidates.inputHash,
        routeCandidateSource: candidates.source,
        catalogAudit: candidates.catalogAudit,
        scores: candidates.scores,
      },
    });
    await finalizeRtPremarketContextSelectorResult({
      sourceSnapshotId: input.sourceSnapshotId,
      selectorResult: {
        selectorReason: routeSnapshot
          ? "v3_history_preserved_and_v4_premarket_frozen_context_recorded"
          : "v4_premarket_frozen_context_recorded_route_snapshot_missing",
        selectorShadow,
        contextPerformanceSelectorV4,
        selectorWorker: { status: "completed", checkpoint: "08:30", elapsedMs, timeoutMs: MARKET_CONTEXT_SELECTOR_WORKER_TIMEOUT_MS, input: "bounded_snapshot_reads_only", orderInstructionConnection: false },
      },
    });
  } catch (error) {
    await finalizeRtPremarketContextSelectorResult({
      sourceSnapshotId: input.sourceSnapshotId,
      selectorResult: {
        selectorReason: "selector_worker_failed_receive_continues",
        selectorWorker: { status: "failed", checkpoint: "08:30", elapsedMs: Date.now() - startedAtMs, errorCode: error instanceof Error ? error.name : "unknown_error", input: "bounded_snapshot_reads_only" },
      },
    }).catch(() => undefined);
  }
}

/** Schedule exactly once per immutable source event without awaiting it from ingress. */
export function enqueueMarketContextSelectorWorker(input: SelectorWorkerInput): void {
  if (!marketContextSelectorWorkerEnabled() || inFlightSourceEventIds.has(input.sourceEventId)) return;
  inFlightSourceEventIds.add(input.sourceEventId);
  void runSelectorWorker(input).finally(() => inFlightSourceEventIds.delete(input.sourceEventId));
}

/** Schedule the 08:30 selector separately from immutable premarket ingestion. */
export function enqueuePremarketContextSelectorWorker(input: PremarketSelectorWorkerInput): void {
  if (!marketContextSelectorWorkerEnabled() || inFlightSourceEventIds.has(input.sourceSnapshotId)) return;
  inFlightSourceEventIds.add(input.sourceSnapshotId);
  void runPremarketSelectorWorker(input).finally(() => inFlightSourceEventIds.delete(input.sourceSnapshotId));
}
