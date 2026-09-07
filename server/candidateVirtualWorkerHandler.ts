import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { drainCurrentCandidateVirtualQueue } from "./realtimeDecisionAudit";

export const CANDIDATE_VIRTUAL_WORKER_LIMITS = Object.freeze({
  maxRows: 150,
  maxDurationMs: 50_000,
  maxAttempts: 5,
});

/**
 * candidate/virtual監査outboxを少量ずつ処理するcron専用worker。
 * 現行売買エンジンは呼び出さず、保存済みpayloadだけをengineSequence順に処理する。
 */
export async function candidateVirtualWorkerHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) return res.status(403).json({ error: "cron-only endpoint" });
    const result = await drainCurrentCandidateVirtualQueue(CANDIDATE_VIRTUAL_WORKER_LIMITS);
    console.log("[candidate-virtual-worker] completed", result);
    return res.json({ ok: true, limits: CANDIDATE_VIRTUAL_WORKER_LIMITS, ...result });
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
