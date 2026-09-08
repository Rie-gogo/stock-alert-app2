import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtDailySummary: vi.fn(async () => ({ reportSent: false })),
  getRtTradesForDate: vi.fn(async () => [{ action: "sell", symbol: "5803", pnl: 1000 }]),
  markRtDailySummaryReportSent: vi.fn(async () => undefined),
}));
const notificationMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./db", () => dbMock);
vi.mock("./forwardShadow", () => ({ formatForwardShadowDryRunReport: vi.fn(async () => "正式評価Gate: pending_manual_activation\n" + "x".repeat(25_000)) }));
vi.mock("./_core/notification", () => ({ notifyOwner: notificationMock }));
vi.mock("./runtimeIdentity", () => ({ getRuntimeIdentity: () => ({ dryRunRequired: true, liveOrderApproved: false, tradingLogicMatchesBaseline: true, sourceTreeHash: "fixed" }) }));

import { compactDailyReportNotification, RT_DAILY_REPORT_NOTIFICATION_LIMIT, sendReadOnlyRtDailyReportForDate } from "./rtDailyReportNotification";

describe("16時通知短縮・read-only再送", () => {
  beforeEach(() => vi.clearAllMocks());

  it("20,000文字を超える本文を17,500文字以内へ短縮する", () => {
    const compacted = compactDailyReportNotification("header\n" + "formal Gate x\n".repeat(3000));
    expect(compacted.length).toBeLessThanOrEqual(RT_DAILY_REPORT_NOTIFICATION_LIMIT);
    expect(compacted).toContain("formal Gate");
  });

  it("通知成功時だけreportSentを更新し、売買engineを必要としない", async () => {
    const result = await sendReadOnlyRtDailyReportForDate("2026-09-08");
    expect(result).toMatchObject({ notificationSent: true, reportSent: true, tradesCount: 1, totalPnl: 1000 });
    expect(result.bodyLength).toBeLessThanOrEqual(RT_DAILY_REPORT_NOTIFICATION_LIMIT);
    expect(dbMock.markRtDailySummaryReportSent).toHaveBeenCalledWith("2026-09-08");
  });

  it("通知失敗時はreportSentを更新しない", async () => {
    notificationMock.mockResolvedValueOnce(false);
    await expect(sendReadOnlyRtDailyReportForDate("2026-09-08")).rejects.toThrow("owner_notification_failed");
    expect(dbMock.markRtDailySummaryReportSent).not.toHaveBeenCalled();
  });

  it("reportSent済みなら再通知せずalready_sentで終了する", async () => {
    dbMock.getRtDailySummary.mockResolvedValueOnce({ reportSent: true });
    const result = await sendReadOnlyRtDailyReportForDate("2026-09-08");
    expect(result).toEqual({
      tradeDate: "2026-09-08",
      skipped: "already_sent",
      notificationSent: false,
      reportSent: true,
    });
    expect(notificationMock).not.toHaveBeenCalled();
    expect(dbMock.markRtDailySummaryReportSent).not.toHaveBeenCalled();
    expect(dbMock.getRtTradesForDate).not.toHaveBeenCalled();
  });
});
