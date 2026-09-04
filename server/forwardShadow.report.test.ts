import { describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtForwardShadowTrades: vi.fn(async () => []),
  getRtSourceEventsForDate: vi.fn(async () => [{
    sourceEventId: "session:1",
    status: "processed",
    resultAction: "none",
    payloadJson: {
      symbol: "8035", tradeDate: "2026-09-03", candleTime: "09:40",
      open: 100, high: 100.1, low: 99.9, close: 100, volume: 100,
    },
  }]),
  getRtForwardShadowEventsForDate: vi.fn(async () => []),
  getRtRealtimeDecisionEventsForDate: vi.fn(async () => []),
  updateRtStrategyVersionStatus: vi.fn(),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring", statusReason: null })),
  upsertRtStrategyVersion: vi.fn(),
}));

vi.mock("./db", () => dbMock);
vi.mock("./telParityComparison", () => ({
  compareTelCurrentParityForDate: vi.fn(async () => ({ skipped: "before_evaluation_start" })),
}));
vi.mock("./portfolioAudit", () => ({
  buildActualReceiptPortfolioAuditForDate: vi.fn(async () => ({ processed: 0, accepted: 0, marginBlocked: 0, closed: 0 })),
  buildMinuteNormalizedPortfolioAuditForDate: vi.fn(async () => ({ candidateBatches: 0, accepted: 0, marginBlocked: 0, blockEdges: [] })),
}));
vi.mock("./outcomeDivergenceAudit", () => ({
  buildOutcomeLabelsForDate: vi.fn(async () => ({ labels: 0, completed: 0, blocked: 0 })),
  buildDivergenceHypotheses: vi.fn(async () => ({ hypotheses: [] })),
}));
vi.mock("./telExecutableConfirmEngine", () => ({
  auditTelExecutableConfirmDay: vi.fn(() => ({ replayedEvents: 0, mismatches: 0, invalidPayloads: 0 })),
}));

import { formatForwardShadowDryRunReport, getForwardShadowSummary } from "./forwardShadow";
import {
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  TEL_EXECUTABLE_CONFIRM_VERSION,
} from "./runtimeIdentity";

describe("未見データ前向きシャドー16時報告", () => {
  it("自己証明・受信監査・2方式・残日数と残件数・注文非接続を表示する", async () => {
    const section = await formatForwardShadowDryRunReport("2026-09-03");
    expect(section).toContain("戦略版: forward-shadow-8035-causal-current-price-v2");
    expect(section).toContain("戦略版: forward-shadow-5803-low-reversal-ab-v2-day-baseline-session-gap-fix");
    expect(section).toContain("戦略版: forward-shadow-285a-confirmed-long-momentum-protect-v1");
    expect(section).toContain("285A 確認型前場LONG・MA8失速確認付き利益保護");
    expect(section).toContain("戦略版: forward-shadow-285a-five-routes-atr036-route-daily-end-v1");
    expect(section).toContain("285A 現行5経路・ATR7 0.36%未満の該当経路日次終了");
    expect(section).toContain("戦略版: candidate-8035-executable-confirm-v1");
    expect(section).toContain("8035 次イベント・ブレイク継続確認A案");
    expect(section).toContain("8035 現行完全再現監査");
    expect(section).toContain("現行 因果性Gate");
    expect(section).toContain("10銘柄・891万円 portfolio監査");
    expect(section).toContain("成績乖離原因分析");
    expect(section).toContain("計測開始: 2026-09-07（学習終了: 2026-09-03）");
    expect(section).toContain("売買ロジックf6878060一致: OK");
    expect(section).toContain("注文接続: なし");
    expect(section).toContain("当日受信監査: 1件");
    expect(section).toContain("当日固定版再生: 2判断再生（実時との差=2");
    expect(section).toContain("100株・証拠金なし全発火");
    expect(section).toContain("891万円上限・可変株数（8035単独パイロット");
    expect(section).toContain("891万円上限・可変株数（5803単独パイロット");
    expect(section).toContain("891万円上限・可変株数（285A単独パイロット");
    expect(section).toContain("一次判定まで: あと13日");
    expect(section).toContain("20件まで: あと20件");
    expect(section).toContain("4週間10件条件: あと27日・あと10件");
  });

  it("285Aは学習終了日の2026-09-03を正式評価へ数えず、翌営業日から0日目として扱う", async () => {
    const summaries = await getForwardShadowSummary("2026-09-03", KIOXIA_FORWARD_STRATEGY_VERSION);
    expect(summaries.every(item => item.decision.days === 0)).toBe(true);
    expect(summaries.every(item => item.decision.status === "monitoring")).toBe(true);
    const candidate2 = await getForwardShadowSummary("2026-09-03", KIOXIA_ATR_FORWARD_STRATEGY_VERSION);
    expect(candidate2.every(item => item.decision.days === 0)).toBe(true);
    expect(candidate2.every(item => item.decision.status === "monitoring")).toBe(true);
  });

  it("8035改善案Aは正式開始日の2026-09-07より前を評価日数へ含めない", async () => {
    const summaries = await getForwardShadowSummary("2026-09-04", TEL_EXECUTABLE_CONFIRM_VERSION);
    expect(summaries.every(item => item.decision.days === 0)).toBe(true);
    expect(summaries.every(item => item.decision.status === "monitoring")).toBe(true);
  });
});
