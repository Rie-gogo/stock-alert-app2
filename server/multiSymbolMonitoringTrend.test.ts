import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMultiSymbolMonitoringTrend } from "./multiSymbolMonitoringTrend";
import {
  MULTI_SYMBOL_MONITORING_COMPATIBLE_LEGACY_VERSIONS,
  MULTI_SYMBOL_MONITORING_COMPONENT,
  MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
} from "./multiSymbolMonitoringMaterializer";
import { MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS } from "./multiSymbolMonitoringRegistry";

const dates = [
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
  "2026-09-11",
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
  "2026-09-17",
  "2026-09-18",
];

function materialization(
  tradeDate: string,
  currentPnl: number,
  version = MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
) {
  return {
    status: "complete",
    version,
    tradeDate,
    resultJson: {
      ready: true,
      plans: MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.map(plan => ({
        ...plan,
        signals: plan.planId === "current:285A" ? 1 : 0,
        openedTrades: plan.planId === "current:285A" ? 1 : 0,
        completedTrades: plan.planId === "current:285A" ? 1 : 0,
        openTrades: 0,
        missingTrades: 0,
        wins: plan.planId === "current:285A" && currentPnl > 0 ? 1 : 0,
        losses: plan.planId === "current:285A" && currentPnl < 0 ? 1 : 0,
        draws: 0,
        pnlPer100: plan.planId === "current:285A" ? currentPnl : 0,
        grossProfitPer100:
          plan.planId === "current:285A" && currentPnl > 0 ? currentPnl : 0,
        grossLossPer100:
          plan.planId === "current:285A" && currentPnl < 0
            ? Math.abs(currentPnl)
            : 0,
      })),
    },
  } as any;
}

describe("10-symbol closed-history monitoring trend with today preview", () => {
  it("確定snapshotだけで最近5日対前5日を比較し、未集計日を明示する", () => {
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-09-21",
      closedTradeDates: [...dates, "2026-09-21"],
      materializations: [
        ...dates.slice(0, 5).map(date => materialization(date, -1_000)),
        ...dates.slice(5).map(date => materialization(date, 2_000)),
      ],
    });
    const kioxia = result.symbols.find(item => item.symbol === "285A")!;
    const current = kioxia.plans.find(plan => plan.planId === "current:285A")!;
    expect(current.trend.status).toBe("improving");
    expect(current.windows.recent5).toMatchObject({
      completedTrades: 5,
      wins: 5,
      pnlPer100: 10_000,
    });
    expect(current.windows.previous5).toMatchObject({
      completedTrades: 5,
      losses: 5,
      pnlPer100: -5_000,
    });
    expect(current.windows.today).toMatchObject({
      includedTradingDays: 0,
      completedTrades: 0,
      pnlPer100: 0,
    });
    expect(result.pendingClosedTradeDates).toEqual(["2026-09-21"]);
    expect(result.symbols).toHaveLength(10);
    expect(result.dataSource).toBe(
      "closed_daily_materializations_with_compatible_legacy_fallback_and_optional_today_preview"
    );
    expect(result.legacyFallbackTradeDates).toEqual([]);
    expect(result.todayStatus).toMatchObject({
      source: "unavailable",
      provisional: false,
    });
  });

  it("未確定の本日だけ保存済み台帳previewを表示し、履歴窓には混ぜない", () => {
    const preview = materialization("2026-09-21", 3_000).resultJson;
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-09-21",
      closedTradeDates: dates,
      materializations: [
        ...dates.slice(0, 5).map(date => materialization(date, -1_000)),
        ...dates.slice(5).map(date => materialization(date, 2_000)),
      ],
      todayPreview: {
        ...preview,
        component: MULTI_SYMBOL_MONITORING_COMPONENT,
        materializationVersion: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
        tradeDate: "2026-09-21",
        incompleteReason: null,
      } as any,
    });
    const current = result.symbols.find(item => item.symbol === "285A")!
      .plans.find(plan => plan.planId === "current:285A")!;

    expect(current.windows.today).toMatchObject({
      includedTradingDays: 1,
      completedTrades: 1,
      wins: 1,
      pnlPer100: 3_000,
    });
    expect(current.windows.recent5).toMatchObject({
      includedTradingDays: 5,
      completedTrades: 5,
      pnlPer100: 10_000,
    });
    expect(current.windows.all).toMatchObject({
      includedTradingDays: 10,
      completedTrades: 10,
      pnlPer100: 5_000,
    });
    expect(result.eligibleTradeDates).toEqual(dates);
    expect(result.latestCompletedTradeDate).toBe("2026-09-18");
    expect(result.todayStatus).toMatchObject({
      source: "persisted_ledger_preview",
      provisional: true,
      ready: true,
    });
  });

  it("新snapshot未作成日は変更のないplanIdだけ旧集計を引き継ぎ、同一日は新snapshotを優先する", () => {
    const legacyVersion = MULTI_SYMBOL_MONITORING_COMPATIBLE_LEGACY_VERSIONS[0];
    const oldestLegacyVersion = MULTI_SYMBOL_MONITORING_COMPATIBLE_LEGACY_VERSIONS[1];
    const legacyOnly = materialization("2026-09-07", 1_000, legacyVersion);
    const olderLegacySameDay = materialization("2026-09-07", 777_000, oldestLegacyVersion);
    const supersededLegacy = materialization("2026-09-08", 99_000, legacyVersion);
    const current = materialization("2026-09-08", 2_000);
    (legacyOnly.resultJson.plans as any[]).push({
      planId: "shadow:retired-strategy-version",
      signals: 1,
      completedTrades: 1,
      openTrades: 0,
      wins: 1,
      losses: 0,
      draws: 0,
      pnlPer100: 500_000,
      grossProfitPer100: 500_000,
      grossLossPer100: 0,
    });

    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-09-08",
      closedTradeDates: ["2026-09-07", "2026-09-08"],
      materializations: [olderLegacySameDay, legacyOnly, supersededLegacy, current],
    });
    const kioxia = result.symbols.find(item => item.symbol === "285A")!;
    const currentPlan = kioxia.plans.find(plan => plan.planId === "current:285A")!;

    expect(currentPlan.windows.all).toMatchObject({
      completedTrades: 2,
      wins: 2,
      pnlPer100: 3_000,
    });
    expect(currentPlan.windows.today).toMatchObject({
      includedTradingDays: 1,
      fromDate: "2026-09-08",
      toDate: "2026-09-08",
      completedTrades: 1,
      wins: 1,
      pnlPer100: 2_000,
    });
    expect(result.legacyFallbackTradeDates).toEqual(["2026-09-07"]);
    expect(result.sourceMaterializationVersionByDate).toEqual({
      "2026-09-07": legacyVersion,
      "2026-09-08": MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
    });
    expect(kioxia.plans.some(plan => plan.planId === "shadow:retired-strategy-version")).toBe(false);
  });

  it("昇格で名称だけ変えた旧Currentは比較shadowへread-timeで引き継ぎ、同日二重計上しない", () => {
    const beforePromotion = materialization("2026-10-09", 0);
    beforePromotion.resultJson.plans = (beforePromotion.resultJson.plans as any[])
      .filter(plan => plan.planId !== "shadow:current:3436:sumcoBreakdownShort")
      .concat({
        planId: "current:3436",
        signals: 2,
        openedTrades: 2,
        completedTrades: 2,
        openTrades: 0,
        missingTrades: 0,
        wins: 1,
        losses: 1,
        draws: 0,
        pnlPer100: 1200,
        grossProfitPer100: 1800,
        grossLossPer100: 600,
      });
    const afterPromotion = materialization("2026-10-10", 0);
    afterPromotion.resultJson.plans = (afterPromotion.resultJson.plans as any[])
      .filter(plan => plan.planId !== "shadow:current:3436:sumcoBreakdownShort")
      .concat({
        planId: "shadow:current:3436:sumcoBreakdownShort",
        signals: 1,
        openedTrades: 1,
        completedTrades: 1,
        openTrades: 0,
        missingTrades: 0,
        wins: 1,
        losses: 0,
        draws: 0,
        pnlPer100: 700,
        grossProfitPer100: 700,
        grossLossPer100: 0,
      });
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-10-10",
      closedTradeDates: ["2026-10-09", "2026-10-10"],
      materializations: [beforePromotion, afterPromotion] as any,
    });
    const comparisonShadow = result.symbols.find(item => item.symbol === "3436")!
      .plans.find(plan => plan.planId === "shadow:current:3436:sumcoBreakdownShort")!;
    expect(comparisonShadow.role).toBe("shadow");
    expect(comparisonShadow.windows.all).toMatchObject({
      completedTrades: 3,
      wins: 2,
      losses: 1,
      pnlPer100: 1900,
    });
  });

  it("正式registry roleで各銘柄のCurrentを先頭にし、shadow間の順序は変えない", () => {
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-10-09",
      closedTradeDates: ["2026-10-09"],
      materializations: [materialization("2026-10-09", 0)],
    });
    expect(result.symbols).toHaveLength(10);
    for (const symbol of result.symbols) {
      expect(symbol.plans.filter(plan => plan.role === "current")).toHaveLength(1);
      expect(symbol.plans[0]?.role).toBe("current");
    }
    expect(result.symbols.find(item => item.symbol === "3436")?.plans.slice(0, 3).map(plan => plan.label)).toEqual([
      "現行仮想：B案・15分時間決済",
      "旧Current：前場安値更新SHORT（比較シャドー）",
      "A案：出来高1.10倍",
    ]);
    expect(result.symbols.find(item => item.symbol === "6146")?.plans[0]).toMatchObject({
      strategyVersion: "candidate-6146-opening-short-executable-a-v3-parity-reset",
      role: "current",
    });
    expect(result.symbols.find(item => item.symbol === "6976")?.plans[0]).toMatchObject({
      strategyVersion: "candidate-6976-afternoon-long-recovery-winrate-v1",
      role: "current",
    });
    expect(result.symbols.find(item => item.symbol === "9984")?.plans[0]).toMatchObject({
      planId: "current:9984",
      role: "current",
    });
  });

  it("API集計はraw event・取引履歴を読まない", () => {
    const source = readFileSync(
      new URL("./multiSymbolMonitoringTrend.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("getRtDailyAuditMaterializationsForRange");
    expect(source).not.toContain("getRtSourceEvents");
    expect(source).not.toContain("getRtSignalCandidates");
    expect(source).not.toContain("getRtForwardShadowTrades");
  });

  it("AI固定行を含む新materialization versionを使用する", () => {
    expect(MULTI_SYMBOL_MONITORING_COMPONENT).toBe(
      "monitoring_trend_10_symbols"
    );
    expect(MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION).toBe(
      "monitoring-trend-10-symbols-daily-v4-ai-forecast-generation-fallback"
    );
  });

  it("6857と6981は現行・独立2案・Bollinger 5案・AI案を発火ゼロでも固定表示する", () => {
    const advantest = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(
      plan => plan.symbol === "6857"
    );
    expect(advantest).toHaveLength(9);
    expect(advantest.map(plan => plan.label)).toEqual([
      "現行（証拠金ブロック含む）",
      "A案：高値失速SHORT・陰線実体0.08%＋次イベント板",
      "B案：確認型継続LONG・二段階高値更新＋次イベント板",
      "ボリンジャー方向判定：入口時固定±2σ・SL1.40%・損切り後30分停止",
      "ボリンジャー方向判定：①〜③不使用・完成5分足SMA20方向・最低戻し余地0.60%",
      "ボリンジャー方向判定 改善A：完成5分足SMA20方向＋傾き一致・最低戻し余地0.60%",
      "ボリンジャー方向判定 改善B：SMA20傾き一致＋BB幅5本非拡大・最低戻し余地0.60%",
      "ボリンジャー方向判定：5分SMA10＋傾き・最低戻し余地0.50%",
      "AI適応予測shadow v6（前場15分・後場30分更新）",
    ]);
    const murata = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(
      plan => plan.symbol === "6981"
    );
    expect(murata).toHaveLength(9);
    expect(murata.map(plan => plan.label)).toEqual([
      "現行（証拠金ブロック含む）",
      "A案：深い下落後の確認反発LONG",
      "B案：前場20本安値更新SHORT",
      "ボリンジャー方向判定：入口時固定±2σ・SL1.40%・損切り後30分停止",
      "ボリンジャー方向判定：①〜③不使用・完成5分足SMA20方向・最低戻し余地0.60%",
      "ボリンジャー方向判定 改善A：完成5分足SMA20方向＋傾き一致・最低戻し余地0.60%",
      "ボリンジャー方向判定 改善B：SMA20傾き一致＋BB幅5本非拡大・最低戻し余地0.60%",
      "ボリンジャー方向判定：5分SMA10＋傾き・最低戻し余地0.50%",
      "AI適応予測shadow v6（前場15分・後場30分更新）",
    ]);
  });
});
