import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtDailySummary: vi.fn(async () => ({ reportSent: false })),
  getRtTradesForDate: vi.fn(async () => [{ action: "sell", symbol: "5803", pnl: 1000 }]),
  claimRtReportDelivery: vi.fn(),
  startRtReportDeliverySend: vi.fn(async () => true),
  completeRtReportDelivery: vi.fn(async () => true),
  failRtReportDeliveryBeforeSend: vi.fn(async () => undefined),
  markRtReportDeliveryUnknown: vi.fn(async () => undefined),
}));
const notificationMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./db", () => dbMock);
vi.mock("./forwardShadow", () => ({ formatForwardShadowDryRunReport: vi.fn(async () => "正式評価Gate: pending_manual_activation\n" + "x".repeat(25_000)) }));
vi.mock("./_core/notification", () => ({ notifyOwner: notificationMock }));
vi.mock("./runtimeIdentity", () => ({ getRuntimeIdentity: () => ({ dryRunRequired: true, liveOrderApproved: false, tradingLogicMatchesBaseline: true, sourceTreeHash: "fixed" }) }));

import {
  compactDailyReportNotification,
  deliverRtDailyReportNotification,
  RT_DAILY_REPORT_NOTIFICATION_LIMIT,
  sendReadOnlyRtDailyReportForDate,
} from "./rtDailyReportNotification";

describe("16時通知短縮・read-only再送", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.claimRtReportDelivery.mockResolvedValue({
      outcome: "claimed",
      row: { status: "claimed", leaseOwner: "owner" },
    });
    dbMock.startRtReportDeliverySend.mockResolvedValue(true);
    dbMock.completeRtReportDelivery.mockResolvedValue(true);
    notificationMock.mockResolvedValue(true);
  });

  it("20,000文字を超える本文を17,500文字以内へ短縮する", () => {
    const compacted = compactDailyReportNotification("header\n" + "formal Gate x\n".repeat(3000));
    expect(compacted.length).toBeLessThanOrEqual(RT_DAILY_REPORT_NOTIFICATION_LIMIT);
    expect(compacted).toContain("formal Gate");
  });

  it("通知成功時だけreportSentを更新し、売買engineを必要としない", async () => {
    const result = await sendReadOnlyRtDailyReportForDate("2026-09-08");
    expect(result).toMatchObject({ notificationSent: true, reportSent: true, tradesCount: 1, totalPnl: 1000 });
    expect(result.bodyLength).toBeLessThanOrEqual(RT_DAILY_REPORT_NOTIFICATION_LIMIT);
    expect(dbMock.claimRtReportDelivery).toHaveBeenCalledTimes(1);
    expect(dbMock.startRtReportDeliverySend).toHaveBeenCalledTimes(1);
    expect(dbMock.completeRtReportDelivery).toHaveBeenCalledTimes(1);
  });

  it("通知失敗時はreportSentを更新しない", async () => {
    notificationMock.mockResolvedValueOnce(false);
    await expect(sendReadOnlyRtDailyReportForDate("2026-09-08")).rejects.toThrow("owner_notification_failed");
    expect(dbMock.completeRtReportDelivery).not.toHaveBeenCalled();
    expect(dbMock.markRtReportDeliveryUnknown).toHaveBeenCalledTimes(1);
  });

  it("reportSent済みなら再通知せずalready_sentで終了する", async () => {
    dbMock.claimRtReportDelivery.mockResolvedValueOnce({
      outcome: "already_sent",
      row: { status: "sent" },
    });
    const result = await sendReadOnlyRtDailyReportForDate("2026-09-08");
    expect(result).toMatchObject({
      tradeDate: "2026-09-08",
      skipped: "already_sent",
      notificationSent: false,
      reportSent: true,
    });
    expect(notificationMock).not.toHaveBeenCalled();
    expect(dbMock.startRtReportDeliverySend).not.toHaveBeenCalled();
    expect(dbMock.completeRtReportDelivery).not.toHaveBeenCalled();
  });

  it("同じ日を同時に2回呼んでもDB claimを得た1回だけ通知する", async () => {
    let claimCount = 0;
    dbMock.claimRtReportDelivery.mockImplementation(async () => {
      claimCount += 1;
      return claimCount === 1
        ? { outcome: "claimed", row: { status: "claimed", leaseOwner: "owner-a" } }
        : { outcome: "busy", row: { status: "claimed", leaseOwner: "owner-a" } };
    });
    const [first, second] = await Promise.all([
      deliverRtDailyReportNotification({ tradeDate: "2026-09-08", title: "same", content: "same" }),
      deliverRtDailyReportNotification({ tradeDate: "2026-09-08", title: "same", content: "same" }),
    ]);
    expect([first.notificationSent, second.notificationSent].sort()).toEqual([false, true]);
    expect(notificationMock).toHaveBeenCalledTimes(1);
    expect(dbMock.startRtReportDeliverySend).toHaveBeenCalledTimes(1);
    expect(dbMock.completeRtReportDelivery).toHaveBeenCalledTimes(1);
  });

  it("送信結果unknownの行は自動再通知しない", async () => {
    dbMock.claimRtReportDelivery.mockResolvedValueOnce({
      outcome: "unknown",
      row: { status: "unknown" },
    });
    const result = await deliverRtDailyReportNotification({
      tradeDate: "2026-09-08",
      title: "same",
      content: "same",
    });
    expect(result).toMatchObject({ skipped: "unknown", notificationSent: false, reportSent: false });
    expect(notificationMock).not.toHaveBeenCalled();
  });

  it("送信前にclaimを失った場合はfailedへ戻し通知しない", async () => {
    dbMock.startRtReportDeliverySend.mockResolvedValueOnce(false);
    await expect(deliverRtDailyReportNotification({
      tradeDate: "2026-09-08",
      title: "same",
      content: "same",
    })).rejects.toThrow("delivery_claim_lost_before_send");
    expect(dbMock.failRtReportDeliveryBeforeSend).toHaveBeenCalledTimes(1);
    expect(notificationMock).not.toHaveBeenCalled();
  });

  it("通知成功後にDB確定できない場合はunknownへ隔離して自動再送しない", async () => {
    dbMock.completeRtReportDelivery.mockResolvedValueOnce(false);
    await expect(deliverRtDailyReportNotification({
      tradeDate: "2026-09-08",
      title: "same",
      content: "same",
    })).rejects.toThrow("delivery_sent_but_completion_not_recorded");
    expect(notificationMock).toHaveBeenCalledTimes(1);
    expect(dbMock.markRtReportDeliveryUnknown).toHaveBeenCalledTimes(1);
  });
});
