import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { materializeNextAuditComponentForDate } from "./auditMaterializer";

function currentJstTradeDate(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 保存済み監査をbounded batchで更新するcron専用endpoint。 */
export async function auditMaterializerHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron) return res.status(403).json({ error: "cron-only endpoint" });
    const tradeDate = currentJstTradeDate();
    const result = await materializeNextAuditComponentForDate(tradeDate, {
      maxTimelineItems: 250,
      maxMinutes: 30,
    });
    console.log("[audit-materializer] completed", { tradeDate, result });
    return res.json({ ok: true, tradeDate, result });
  } catch (error) {
    console.error("[audit-materializer] Handler error:", error);
    return res.status(500).json({
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: { url: req.url },
      timestamp: new Date().toISOString(),
    });
  }
}
