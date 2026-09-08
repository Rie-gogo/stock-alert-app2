import { createHash, randomUUID } from "node:crypto";
import {
  claimRtReportDelivery,
  completeRtReportDelivery,
  failRtReportDeliveryBeforeSend,
  getRtDailySummary,
  getRtTradesForDate,
  markRtReportDeliveryUnknown,
  startRtReportDeliverySend,
} from "./db";
import { formatForwardShadowDryRunReport } from "./forwardShadow";
import { notifyOwner } from "./_core/notification";
import { getRuntimeIdentity } from "./runtimeIdentity";

export const RT_DAILY_REPORT_NOTIFICATION_LIMIT = 17_500;

function hashNotificationPayload(title: string, content: string): string {
  return createHash("sha256").update(JSON.stringify({ title, content })).digest("hex");
}

export function compactDailyReportNotification(body: string, limit = RT_DAILY_REPORT_NOTIFICATION_LIMIT): string {
  if (body.length <= limit) return body;
  const lines = body.split("\n");
  const important = lines.filter(line => /DRY_RUN|LIVE|source hash|正式評価|formal|routeParity|Gate|candidate|virtual|portfolio|replay|因果|queue|outbox|gap/i.test(line));
  const head = lines.slice(0, 90);
  const tail = lines.slice(-24);
  const merged = [
    ...head,
    "",
    "【長文通知のため要点を抽出】",
    ...important,
    "",
    "【末尾】",
    ...tail,
  ].filter((line, index, all) => index === 0 || line !== all[index - 1]);
  const compacted = merged.join("\n");
  if (compacted.length <= limit) return compacted;
  const marker = "\n…通知上限のため省略。完全版は保存済みsnapshotと公開APIを参照。\n";
  return compacted.slice(0, Math.max(0, limit - marker.length)) + marker;
}

export async function deliverRtDailyReportNotification(input: {
  tradeDate: string;
  title: string;
  content: string;
  ownerToken?: string;
}) {
  const content = compactDailyReportNotification(input.content);
  const payloadHash = hashNotificationPayload(input.title, content);
  const ownerToken = input.ownerToken ?? `rt-report:${input.tradeDate}:${randomUUID()}`;
  const claim = await claimRtReportDelivery({
    tradeDate: input.tradeDate,
    ownerToken,
    payloadHash,
  });
  if (claim.outcome !== "claimed") {
    return {
      tradeDate: input.tradeDate,
      skipped: claim.outcome,
      notificationSent: false,
      reportSent: claim.outcome === "already_sent",
      deliveryStatus: claim.row.status,
      payloadHash,
      bodyLength: content.length,
    };
  }

  const started = await startRtReportDeliverySend({
    tradeDate: input.tradeDate,
    ownerToken,
    payloadHash,
  });
  if (!started) {
    await failRtReportDeliveryBeforeSend({
      tradeDate: input.tradeDate,
      ownerToken,
      error: "delivery_claim_lost_before_send",
    });
    throw new Error("delivery_claim_lost_before_send");
  }

  try {
    const notificationSent = await notifyOwner({ title: input.title, content });
    if (notificationSent !== true) throw new Error("owner_notification_failed");
    const completed = await completeRtReportDelivery({
      tradeDate: input.tradeDate,
      ownerToken,
    });
    if (!completed) throw new Error("delivery_sent_but_completion_not_recorded");
    return {
      tradeDate: input.tradeDate,
      notificationSent: true,
      reportSent: true,
      deliveryStatus: "sent" as const,
      payloadHash,
      bodyLength: content.length,
    };
  } catch (error) {
    try {
      await markRtReportDeliveryUnknown({
        tradeDate: input.tradeDate,
        ownerToken,
        error: `send_outcome_unconfirmed:${String(error)}`,
      });
    } catch (markError) {
      console.error("[rt-daily-report] failed to persist unknown delivery state", markError);
    }
    throw error;
  }
}

export async function sendReadOnlyRtDailyReportForDate(tradeDate: string) {
  const summary = await getRtDailySummary(tradeDate);
  const [trades, forwardSection] = await Promise.all([
    getRtTradesForDate(tradeDate),
    formatForwardShadowDryRunReport(tradeDate),
  ]);
  const identity = getRuntimeIdentity();
  const closedTrades = trades.filter(trade => trade.action === "sell" || trade.action === "cover");
  const totalPnl = closedTrades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
  const wins = closedTrades.filter(trade => Number(trade.pnl ?? 0) > 0).length;
  const losses = closedTrades.length - wins;
  const subject = `📊 Stock Alert App 読取専用再送 ${tradeDate} (${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円)`;
  const symbolPnl = new Map<string, number>();
  for (const trade of closedTrades) symbolPnl.set(trade.symbol, (symbolPnl.get(trade.symbol) ?? 0) + Number(trade.pnl ?? 0));
  const body = compactDailyReportNotification(`${subject}

【実行安全性】
DRY_RUN必須: ${identity.dryRunRequired}
LIVE承認: ${identity.liveOrderApproved}
固定売買source hash一致: ${identity.tradingLogicMatchesBaseline}
source hash: ${identity.sourceTreeHash}
強制決済: 実行しない（読取専用再送）

【当日サマリー】
対象日: ${tradeDate}
損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円
決済: ${closedTrades.length}件（勝${wins} / 負${losses}）
勝率: ${closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(2) : "0.00"}%
reportSent（送信前）: ${summary?.reportSent ?? false}

【銘柄別損益】
${Array.from(symbolPnl.entries()).sort((a, b) => b[1] - a[1]).map(([symbol, pnl]) => `  ${symbol}: ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円`).join("\n") || "  取引なし"}

${forwardSection}

この通知は保存済みデータだけを読む過去日再送です。売買処理・強制決済・正式評価有効化は実行しません。
`);
  const delivery = await deliverRtDailyReportNotification({ tradeDate, title: subject, content: body });
  return { ...delivery, subject, tradesCount: closedTrades.length, totalPnl };
}
