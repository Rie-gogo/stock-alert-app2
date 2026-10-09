import { randomUUID } from "node:crypto";
import {
  acquireRtNamedWorkerLock,
  getRtAuditTradeDateWatermark,
  releaseRtNamedWorkerLock,
  type RtAuditTradeDateWatermark,
} from "./db";
import { materializeNextAuditComponentForDate } from "./auditMaterializer";
import { drainForwardShadowDispatchQueue } from "./forwardShadowSequence";
import { drainCurrentCandidateVirtualQueue } from "./realtimeDecisionAudit";
import { sha256Stable } from "./runtimeIdentity";

const CLOSED_TRADE_DATE_TAIL_DRAIN_LOCK = "closed-trade-date-tail-drain-v1";

/**
 * 受信が止まった引け後にだけ使う、既存outbox workerのboundedな回収上限。
 * 現行engine・source ingest・strategy条件は一切呼び出さない。
 */
export const CLOSED_TRADE_DATE_TAIL_DRAIN_LIMITS = Object.freeze({
  maxDrainPasses: 32,
  maxRowsPerPass: 50,
  maxDurationMsPerPass: 15_000,
  maxRetryCycles: 3,
  retryBackoffMs: 1_000,
  maxMaterializationPasses: 40,
  materializationPauseMs: 250,
});

type DrainStopReason =
  | "empty_or_claimed"
  | "retryable_error"
  | "max_batch"
  | "max_duration";
type CandidateStopReason =
  | "empty_or_claimed"
  | "worker_busy"
  | "retryable_error"
  | "max_batch"
  | "max_duration";

export type ClosedTradeDateTailDrainResult = {
  status:
    | "complete"
    | "queue_incomplete"
    | "worker_busy"
    | "materialization_incomplete"
    | "watermark_changed";
  tradeDate: string;
  queue: {
    forwardShadow: Array<{ processed: number; stoppedReason: DrainStopReason }>;
    candidateVirtual: Array<{
      processed: number;
      terminalizedRows: number;
      stoppedReason: CandidateStopReason;
    }>;
  };
  watermark: {
    hash: string;
    sourceCount: number;
    shadow: RtAuditTradeDateWatermark["shadowOutbox"];
    candidate: RtAuditTradeDateWatermark["candidateOutbox"];
    ready: boolean;
  };
  materialization: {
    runs: Array<{ status: string; component: string }>;
    complete: boolean;
  };
  reason?: string;
};

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

function stableWatermark(watermark: RtAuditTradeDateWatermark) {
  return {
    ...watermark,
    latestUpstreamCreatedAt:
      watermark.latestUpstreamCreatedAt?.toISOString() ?? null,
  };
}

export function closedTradeDateWatermarkHash(
  watermark: RtAuditTradeDateWatermark
) {
  return sha256Stable(stableWatermark(watermark));
}

/** 日次snapshotを安全に生成できるoutbox finality条件。 */
export function isClosedTradeDateWatermarkReady(
  watermark: RtAuditTradeDateWatermark
): boolean {
  return (
    watermark.source.count > 0 &&
    watermark.source.processed === watermark.source.count &&
    watermark.source.processing === 0 &&
    watermark.source.failed === 0 &&
    watermark.decision.count === watermark.source.count &&
    watermark.candidateOutbox.processed === watermark.decision.count &&
    watermark.candidateOutbox.pending === 0 &&
    watermark.candidateOutbox.processing === 0 &&
    watermark.candidateOutbox.retryableError === 0 &&
    watermark.candidateOutbox.terminal === 0 &&
    watermark.shadowOutbox.count === watermark.source.count &&
    watermark.shadowOutbox.processed === watermark.shadowOutbox.count &&
    watermark.shadowOutbox.pending === 0 &&
    watermark.shadowOutbox.processing === 0 &&
    watermark.shadowOutbox.error === 0 &&
    watermark.unresolvedGaps === 0
  );
}

function summarizeWatermark(watermark: RtAuditTradeDateWatermark) {
  return {
    hash: closedTradeDateWatermarkHash(watermark),
    sourceCount: watermark.source.count,
    shadow: watermark.shadowOutbox,
    candidate: watermark.candidateOutbox,
    ready: isClosedTradeDateWatermarkReady(watermark),
  };
}

/**
 * 既存queue workerだけを再利用して、最後のsource event後に残ったtailを回収する。
 * named lockは二つのtail coordinatorが同時にmaterializationを始めないためのもの。
 * queue内部のclaim/CASとstrategy state lockは既存のまま利用する。
 */
export async function finalizeClosedTradeDateTail(input: {
  tradeDate: string;
  now?: Date;
  limits?: Partial<typeof CLOSED_TRADE_DATE_TAIL_DRAIN_LIMITS>;
}): Promise<ClosedTradeDateTailDrainResult> {
  const limits = { ...CLOSED_TRADE_DATE_TAIL_DRAIN_LIMITS, ...input.limits };
  const ownerToken = `closed-tail:${input.tradeDate}:${randomUUID()}`;
  const acquired = await acquireRtNamedWorkerLock({
    lockName: CLOSED_TRADE_DATE_TAIL_DRAIN_LOCK,
    ownerToken,
    leaseMs: Math.max(
      120_000,
      limits.maxDrainPasses * limits.maxDurationMsPerPass + 30_000
    ),
  });
  const forwardShadow: ClosedTradeDateTailDrainResult["queue"]["forwardShadow"] =
    [];
  const candidateVirtual: ClosedTradeDateTailDrainResult["queue"]["candidateVirtual"] =
    [];
  const materialization: ClosedTradeDateTailDrainResult["materialization"] = {
    runs: [],
    complete: false,
  };

  if (!acquired) {
    const watermark = await getRtAuditTradeDateWatermark(input.tradeDate);
    return {
      status: "worker_busy",
      tradeDate: input.tradeDate,
      queue: { forwardShadow, candidateVirtual },
      watermark: summarizeWatermark(watermark),
      materialization,
      reason: "closed_tail_worker_lease_held",
    };
  }

  try {
    let retryCycles = 0;
    let queuesCaughtUp = false;
    for (let pass = 0; pass < limits.maxDrainPasses; pass += 1) {
      // 既存candidate workerと同じ順序を維持する。両queueは独立だが、
      // 日次watermarkを読みやすくし、DB負荷を増やさないため並列drainしない。
      let shadow: {
        processedEngineSequences: number[];
        stoppedReason: DrainStopReason;
      };
      let shadowRetryable = false;
      try {
        const result = await drainForwardShadowDispatchQueue({
          maxRows: limits.maxRowsPerPass,
          maxDurationMs: limits.maxDurationMsPerPass,
        });
        shadow = result;
      } catch (error) {
        // forwardShadowSequenceは既存の監査可能なqueue errorを保存してthrowする。
        // hot pathを変えず、引け後coordinatorだけがbounded backoffで同じworkerを再実行する。
        console.error(
          "[closed-tail-drain] forward shadow retryable drain error",
          error
        );
        shadow = {
          processedEngineSequences: [],
          stoppedReason: "retryable_error",
        };
        shadowRetryable = true;
      }
      const candidate = await drainCurrentCandidateVirtualQueue({
        maxRows: limits.maxRowsPerPass,
        maxDurationMs: limits.maxDurationMsPerPass,
      });
      forwardShadow.push({
        processed: shadow.processedEngineSequences.length,
        stoppedReason: shadow.stoppedReason,
      });
      candidateVirtual.push({
        processed: candidate.processedEngineSequences.length,
        terminalizedRows: candidate.terminalizedRows,
        stoppedReason: candidate.stoppedReason,
      });

      const retryable =
        shadowRetryable || candidate.stoppedReason === "retryable_error";
      if (retryable) {
        retryCycles += 1;
        if (retryCycles >= limits.maxRetryCycles) break;
        await sleep(limits.retryBackoffMs * retryCycles);
        continue;
      }
      retryCycles = 0;
      if (
        shadow.stoppedReason === "empty_or_claimed" &&
        candidate.stoppedReason === "empty_or_claimed"
      ) {
        queuesCaughtUp = true;
        break;
      }
      if (candidate.stoppedReason === "worker_busy") break;
    }

    const afterDrain = await getRtAuditTradeDateWatermark(input.tradeDate);
    const summarized = summarizeWatermark(afterDrain);
    if (!queuesCaughtUp || !summarized.ready) {
      return {
        status: "queue_incomplete",
        tradeDate: input.tradeDate,
        queue: { forwardShadow, candidateVirtual },
        watermark: summarized,
        materialization,
        reason: summarized.ready
          ? "tail_drain_pass_limit_or_worker_busy"
          : "watermark_not_ready_after_tail_drain",
      };
    }

    const fixedHash = summarized.hash;
    for (let pass = 0; pass < limits.maxMaterializationPasses; pass += 1) {
      const result = await materializeNextAuditComponentForDate(
        input.tradeDate,
        {
          now: input.now ?? new Date(),
          maxTimelineItems: 250,
          maxMinutes: 30,
        }
      );
      materialization.runs.push({
        status: result.status,
        component: result.component,
      });
      if (result.status === "complete" && result.component === "all") {
        materialization.complete = true;
        break;
      }
      if (result.status === "worker_busy") break;
      await sleep(limits.materializationPauseMs);
    }

    const afterMaterialization = await getRtAuditTradeDateWatermark(
      input.tradeDate
    );
    const finalWatermark = summarizeWatermark(afterMaterialization);
    if (finalWatermark.hash !== fixedHash) {
      return {
        status: "watermark_changed",
        tradeDate: input.tradeDate,
        queue: { forwardShadow, candidateVirtual },
        watermark: finalWatermark,
        materialization,
        reason: "source_or_outbox_watermark_changed_during_materialization",
      };
    }
    return {
      status: materialization.complete
        ? "complete"
        : "materialization_incomplete",
      tradeDate: input.tradeDate,
      queue: { forwardShadow, candidateVirtual },
      watermark: finalWatermark,
      materialization,
      reason: materialization.complete
        ? undefined
        : "bounded_materialization_not_complete",
    };
  } finally {
    await releaseRtNamedWorkerLock(
      CLOSED_TRADE_DATE_TAIL_DRAIN_LOCK,
      ownerToken
    );
  }
}
