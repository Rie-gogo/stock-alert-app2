import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { drainCurrentCandidateVirtualQueue } from "./realtimeDecisionAudit";
import { materializeNextAuditComponentForDate } from "./auditMaterializer";
import { drainForwardShadowDispatchQueue } from "./forwardShadowSequence";
import { materializeNextMissingMultiSymbolMonitoringDate } from "./multiSymbolMonitoringMaterializer";

export const CANDIDATE_VIRTUAL_WORKER_LIMITS = Object.freeze({
  maxRows: 100,
  maxDurationMs: 20_000,
  maxAttempts: 5,
});

export const FORWARD_SHADOW_RECOVERY_LIMITS = Object.freeze({
  maxRows: 50,
  maxDurationMs: 5_000,
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
    // 通常は受信後の非同期workerが即時処理する。runtime停止・再起動時の残件だけを
    // 既存2分cronで確実に回収し、シャドー検証を欠落させない。
    const forwardShadow = await drainForwardShadowDispatchQueue(FORWARD_SHADOW_RECOVERY_LIMITS);
    const result = await drainCurrentCandidateVirtualQueue(CANDIDATE_VIRTUAL_WORKER_LIMITS);
    // 運用側でaudit-materializerの個別cron登録が抜けても、candidate/virtualが
    // 空まで追い付いた時点でportfolio比較を必ず前進させる。現行売買は呼ばない。
    const allEvaluationQueuesCaughtUp = result.stoppedReason === "empty_or_claimed"
      && forwardShadow.stoppedReason === "empty_or_claimed";
    const materialization = allEvaluationQueuesCaughtUp
      ? await materializeNextAuditComponentForDate(currentJstTradeDate(), {
          maxTimelineItems: 250,
          maxMinutes: 30,
        })
      : { status: "deferred_until_candidate_queue_caught_up" as const, component: "none" as const };
    // 10銘柄の過去snapshot backfillは、当日の全監査が閉場後に完了した時だけ高々1日進める。
    // 日中・queue残留中・当日監査途中では一切実行しない。
    const monitoringBackfill = materialization.status === "complete"
      ? await materializeNextMissingMultiSymbolMonitoringDate(currentJstTradeDate())
      : { status: "deferred_until_daily_audit_complete" as const };
    console.log("[candidate-virtual-worker] completed", { forwardShadow, ...result, materialization, monitoringBackfill });
    return res.json({
      ok: true,
      limits: CANDIDATE_VIRTUAL_WORKER_LIMITS,
      forwardShadowLimits: FORWARD_SHADOW_RECOVERY_LIMITS,
      forwardShadow,
      ...result,
      materialization,
      monitoringBackfill,
    });
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
