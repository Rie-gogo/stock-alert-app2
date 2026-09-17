import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { drainCurrentCandidateVirtualQueue } from "./realtimeDecisionAudit";
import { materializeNextAuditComponentForDate } from "./auditMaterializer";

export const CANDIDATE_VIRTUAL_WORKER_LIMITS = Object.freeze({
  maxRows: 100,
  maxDurationMs: 20_000,
  maxAttempts: 5,
});

function currentJstTradeDate(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * candidate/virtual監査outboxを少量ずつ処理するcron専用worker。
 * 現行売買エンジンは呼び出さず、保存済みpayloadだけをengineSequence順に処理する。
 */
export async function candidateVirtualWorkerHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) return res.status(403).json({ error: "cron-only endpoint" });
    const result = await drainCurrentCandidateVirtualQueue(CANDIDATE_VIRTUAL_WORKER_LIMITS);
    // 運用側でaudit-materializerの個別cron登録が抜けても、candidate/virtualが
    // 空まで追い付いた時点でportfolio比較を必ず前進させる。現行売買は呼ばない。
    const materialization = result.stoppedReason === "empty_or_claimed"
      ? await materializeNextAuditComponentForDate(currentJstTradeDate(), {
          maxTimelineItems: 250,
          maxMinutes: 30,
        })
      : { status: "deferred_until_candidate_queue_caught_up" as const, component: "none" as const };
    console.log("[candidate-virtual-worker] completed", { ...result, materialization });
    return res.json({ ok: true, limits: CANDIDATE_VIRTUAL_WORKER_LIMITS, ...result, materialization });
  } catch (error) {
    console.error("[candidate-virtual-worker] Handler error:", error);
    return res.status(500).json({
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}
