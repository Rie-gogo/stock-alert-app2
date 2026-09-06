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
  buildAllCandidateReceiptPortfolioForDate: vi.fn(async () => ({ candidates: 0, accepted: 0, marginBlocked: 0, closed: 0, realizedPnl: 0, blockEdges: [], eligibleForPortfolioPnlComparison: true })),
  buildAllCandidateMinutePortfolioForDate: vi.fn(async () => ({ candidates: 0, accepted: 0, marginBlocked: 0, closed: 0, realizedPnl: 0, blockEdges: [], eligibleForPortfolioPnlComparison: true })),
}));
vi.mock("./outcomeDivergenceAudit", () => ({
  buildOutcomeLabelsForDate: vi.fn(async () => ({ labels: 0, completed: 0, blocked: 0 })),
  buildDivergenceHypotheses: vi.fn(async () => ({ hypotheses: [] })),
}));
vi.mock("./telExecutableConfirmEngine", () => ({
  auditTelExecutableConfirmDay: vi.fn(() => ({ replayedEvents: 0, mismatches: 0, invalidPayloads: 0 })),
}));
vi.mock("./telExecutableConfirmDepthEngine", () => ({
  auditTelExecutableConfirmDepthDay: vi.fn(() => ({ replayedEvents: 0, mismatches: 0, invalidPayloads: 0 })),
}));

import { formatForwardShadowDryRunReport, getForwardShadowSummary } from "./forwardShadow";
import {
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
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
    expect(section).toContain("戦略版: candidate-8035-executable-depth-v2");
    expect(section).toContain("8035 次イベント・side別板depth VWAP継続確認A案 v2");
    expect(section).toContain(`戦略版: ${SOFTBANK_DEPTH_CONFIRM_VERSION}`);
    expect(section).toContain("9984 前場10本高値更新LONG A・次イベント100株ask depth継続確認");
    expect(section).toContain(`戦略版: ${SOFTBANK_RR2_PROTECT_VERSION}`);
    expect(section).toContain("9984 前場10本高値更新LONG B・2R出口＋次足利益保護");
    expect(section).toContain(`戦略版: ${TAIYO_BOARD_DEMAND_VERSION}`);
    expect(section).toContain("6976 候補B・10本高値更新LONG A・同時点BPR1.30＋大口売り壁なし");
    expect(section).toContain(`戦略版: ${TAIYO_RR2_PROTECT_VERSION}`);
    expect(section).toContain("6976 候補B・10本高値更新LONG B・2R出口＋次足利益保護");
    expect(section).toContain(`戦略版: ${SOCIONEXT_INITIAL_STRENGTH_VERSION}`);
    expect(section).toContain("6526 確認型LONG A・初動始値比+0.25%未満で日次終了");
    expect(section).toContain(`戦略版: ${SOCIONEXT_CONFIRM_STRENGTH_VERSION}`);
    expect(section).toContain("6526 確認型LONG B・確認上昇率+0.075%未満で日次終了");
    expect(section).toContain(`戦略版: ${SUMCO_VOLUME_110_VERSION}`);
    expect(section).toContain("3436 前場15本安値更新SHORT A・出来高1.10倍＋15分2R");
    expect(section).toContain(`戦略版: ${SUMCO_TIME_15_VERSION}`);
    expect(section).toContain("3436 前場15本安値更新SHORT B・現行入口＋15分2R");
    expect(section).toContain("9984追加Gate: 実現平均利益÷平均損失=");
    expect(section).toContain("6976追加Gate: 案=board_demand");
    expect(section).toContain("板需給案は追加0.80基準なし");
    expect(section).toContain("6976追加Gate: 案=rr2_protect");
    expect(section).toContain("TP到達=0/0（未算出）");
    expect(section).toContain("6526追加Gate: 案=initial_strength");
    expect(section).toContain("51保存日勝率=68.75%");
    expect(section).toContain("役割=diagnostic_candidate");
    expect(section).toContain("6526追加Gate: 案=confirmation_strength");
    expect(section).toContain("51保存日勝率=73.33%");
    expect(section).toContain("3436追加Gate: 案=volume_110");
    expect(section).toContain("選定用34保存日勝率=76.00%");
    expect(section).toContain("役割=entry_quality_candidate");
    expect(section).toContain("3436追加Gate: 案=time_15");
    expect(section).toContain("選定用34保存日勝率=73.08%");
    expect(section).toContain("追加5日既知欠損=true");
    expect(section).toContain("891万円比較=manual_comparison_required");
    expect(section).toContain("対象外（旧版停止・監査保持のみ）");
    expect(section).toContain("8035 現行完全再現監査");
    expect(section).toContain("現行 因果性Gate");
    expect(section).toContain("10銘柄・891万円 portfolio監査");
    expect(section).toContain("全candidate正式v2・engineSequence実受信順");
    expect(section).toContain("全candidate正式v2・同一分exit先行＋固定銘柄優先");
    expect(section).toContain("成績乖離原因分析");
    expect(section).toContain("候補収集開始: 2026-09-07（学習終了: 2026-09-03）");
    expect(section).toContain("正式集計最短開始: 2026-09-08");
    expect(section).toContain("経路parity Gate: passed");
    expect(section).toContain("経路parity Gate: required");
    expect(section).toContain("正式評価Gate: pending_validation_day");
    expect(section).toContain("売買ロジックf6878060一致: OK");
    expect(section).toContain("注文接続: なし");
    expect(section).toContain("当日受信監査: 1件");
    expect(section).toContain("当日固定版再生: 2判断再生（実時との差=2");
    expect(section).toContain("100株・証拠金なし全発火");
    expect(section).toContain("891万円上限・可変株数（8035単独パイロット");
    expect(section).toContain("891万円上限・可変株数（5803単独パイロット");
    expect(section).toContain("891万円上限・可変株数（285A単独パイロット");
    expect(section).toContain("一次判定まで: あと14日");
    expect(section).toContain("20件到達時も継続判定のみ: あと20件");
    expect(section).toContain("4週間10件条件: あと28日・あと10件");
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
    const legacy = await getForwardShadowSummary("2026-09-04", TEL_EXECUTABLE_CONFIRM_VERSION);
    expect(legacy.every(item => item.decision.days === 0)).toBe(true);
    expect(legacy.every(item => item.decision.status === "stopped")).toBe(true);
    expect(legacy.every(item => item.decision.reason === "superseded_by_depth_v2_audit_only")).toBe(true);

    const depth = await getForwardShadowSummary("2026-09-04", TEL_EXECUTABLE_DEPTH_VERSION);
    expect(depth.every(item => item.decision.days === 0)).toBe(true);
    expect(depth.every(item => item.decision.status === "monitoring")).toBe(true);
  });
});
