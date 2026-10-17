import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildMultiSymbolMonitoringTrend,
  isTokyoEquityTradeDate,
  listTokyoEquityTradeDatesBefore,
  loadLedgerPreviewsForDates,
} from "./multiSymbolMonitoringTrend";
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
  version = MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION
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
        grossProfitPer100: plan.planId === "current:285A" && currentPnl > 0 ? currentPnl : 0,
        grossLossPer100: plan.planId === "current:285A" && currentPnl < 0 ? Math.abs(currentPnl) : 0,
      })),
    },
  } as any;
}

function ledgerPreview(tradeDate: string, currentPnl: number) {
  return {
    ...materialization(tradeDate, currentPnl).resultJson,
    component: MULTI_SYMBOL_MONITORING_COMPONENT,
    materializationVersion: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
    tradeDate,
    incompleteReason: null,
  } as any;
}

function zeroLedgerPreview(tradeDate: string) {
  const preview = ledgerPreview(tradeDate, 0);
  preview.plans = preview.plans.map((plan: any) => ({
    ...plan,
    signals: 0,
    openedTrades: 0,
    completedTrades: 0,
    openTrades: 0,
    missingTrades: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    pnlPer100: 0,
    grossProfitPer100: 0,
    grossLossPer100: 0,
  }));
  preview.summary = {
    plans: preview.plans.length,
    signals: 0,
    completedTrades: 0,
    openTrades: 0,
    missingTrades: 0,
  };
  return preview;
}

function monitoringTotalsMaterialization(input: {
  tradeDate: string;
  aiTrades: number;
  aiPnl: number;
  bollingerTrades: number;
}) {
  const row = materialization(input.tradeDate, 0);
  let aiAssigned = false;
  let bollingerAssigned = false;
  row.resultJson.plans = (row.resultJson.plans as any[]).map(plan => {
    if (!aiAssigned && plan.label.includes("AI適応予測shadow v6")) {
      aiAssigned = true;
      return {
        ...plan,
        signals: input.aiTrades,
        openedTrades: input.aiTrades,
        completedTrades: input.aiTrades,
        openTrades: 0,
        missingTrades: 0,
        wins: input.aiTrades,
        losses: 0,
        draws: 0,
        pnlPer100: input.aiPnl,
        grossProfitPer100: input.aiPnl,
        grossLossPer100: 0,
      };
    }
    if (!bollingerAssigned && plan.label.startsWith("ボリンジャー方向判定")) {
      bollingerAssigned = true;
      return {
        ...plan,
        signals: input.bollingerTrades,
        openedTrades: input.bollingerTrades,
        completedTrades: input.bollingerTrades,
        openTrades: 0,
        missingTrades: 0,
        wins: 0,
        losses: 0,
        draws: input.bollingerTrades,
        pnlPer100: 0,
        grossProfitPer100: 0,
        grossLossPer100: 0,
      };
    }
    return plan;
  });
  return row;
}

describe("10-symbol closed-history monitoring trend with today preview", () => {
  it("確定snapshotだけで最近5日対前5日を比較し、未集計日を明示する", () => {
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-09-24",
      closedTradeDates: [...dates, "2026-09-24"],
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
    expect(result.pendingClosedTradeDates).toEqual(["2026-09-24"]);
    expect(result.symbols).toHaveLength(10);
    expect(result.dataSource).toBe(
      "closed_daily_materializations_with_compatible_legacy_fallback_and_ledger_previews_in_display_windows"
    );
    expect(result.legacyFallbackTradeDates).toEqual([]);
    expect(result.todayStatus).toMatchObject({
      source: "unavailable",
      provisional: false,
    });
  });

  it("日付更新後も未確定の前営業日を保存済み台帳から期間窓へ一度だけ引き継ぐ", () => {
    const prior = materialization("2026-09-24", 3_000).resultJson;
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-09-25",
      closedTradeDates: dates,
      materializations: [
        ...dates.slice(0, 5).map(date => materialization(date, -1_000)),
        ...dates.slice(5).map(date => materialization(date, 2_000)),
      ],
      priorLedgerPreviews: [
        {
          ...prior,
          component: MULTI_SYMBOL_MONITORING_COMPONENT,
          materializationVersion: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
          tradeDate: "2026-09-24",
          incompleteReason: null,
        } as any,
      ],
    });
    const current = result.symbols
      .find(item => item.symbol === "285A")!
      .plans.find(plan => plan.planId === "current:285A")!;

    expect(current.windows.today).toMatchObject({
      includedTradingDays: 0,
      completedTrades: 0,
      pnlPer100: 0,
    });
    expect(current.windows.recent5).toMatchObject({
      includedTradingDays: 5,
      completedTrades: 5,
      pnlPer100: 11_000,
    });
    expect(current.windows.previous5).toMatchObject({
      fromDate: "2026-09-08",
      toDate: "2026-09-14",
      includedTradingDays: 5,
      completedTrades: 5,
      pnlPer100: -2_000,
    });
    expect(current.windows.all).toMatchObject({
      includedTradingDays: 11,
      completedTrades: 11,
      pnlPer100: 8_000,
    });
    expect(result.latestCompletedTradeDate).toBe("2026-09-18");
    expect(result.latestDisplayedTradeDate).toBe("2026-09-24");
    expect(result.provisionalLedgerTradeDates).toEqual(["2026-09-24"]);
    expect(result.displayTradeDates.slice(-5)).toEqual([
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-24",
    ]);
  });

  it("前営業日の確定snapshotができたら暫定台帳を同日分へ二重加算しない", () => {
    const closedPrior = materialization("2026-09-24", 3_000);
    const conflictingPreview = {
      ...materialization("2026-09-24", 999_000).resultJson,
      component: MULTI_SYMBOL_MONITORING_COMPONENT,
      materializationVersion: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
      tradeDate: "2026-09-24",
      incompleteReason: null,
    } as any;
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-09-25",
      closedTradeDates: [...dates, "2026-09-24"],
      materializations: [
        ...dates.slice(0, 5).map(date => materialization(date, -1_000)),
        ...dates.slice(5).map(date => materialization(date, 2_000)),
        closedPrior,
      ],
      priorLedgerPreviews: [conflictingPreview],
    });
    const current = result.symbols
      .find(item => item.symbol === "285A")!
      .plans.find(plan => plan.planId === "current:285A")!;

    expect(current.windows.all).toMatchObject({
      includedTradingDays: 11,
      completedTrades: 11,
      pnlPer100: 8_000,
    });
    expect(result.provisionalLedgerTradeDates).toEqual([]);
    expect(result.latestCompletedTradeDate).toBe("2026-09-24");
  });

  it("未確定の本日を保存済み台帳previewで表示し、期間窓にも一度だけ加える", () => {
    const preview = materialization("2026-09-24", 3_000).resultJson;
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-09-24",
      closedTradeDates: dates,
      materializations: [
        ...dates.slice(0, 5).map(date => materialization(date, -1_000)),
        ...dates.slice(5).map(date => materialization(date, 2_000)),
      ],
      todayPreview: {
        ...preview,
        component: MULTI_SYMBOL_MONITORING_COMPONENT,
        materializationVersion: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
        tradeDate: "2026-09-24",
        incompleteReason: null,
      } as any,
    });
    const current = result.symbols
      .find(item => item.symbol === "285A")!
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
      pnlPer100: 11_000,
    });
    expect(current.windows.all).toMatchObject({
      includedTradingDays: 11,
      completedTrades: 11,
      pnlPer100: 8_000,
    });
    expect(result.eligibleTradeDates).toEqual(dates);
    expect(result.latestCompletedTradeDate).toBe("2026-09-18");
    expect(result.todayStatus).toMatchObject({
      source: "persisted_ledger_preview",
      provisional: true,
      ready: true,
    });
  });

  it("本日初めて発火した案を全期間0件にせず、本日値を各期間へ一度だけ反映する", () => {
    const preview = materialization("2026-09-24", 0).resultJson as any;
    const fixedBollinger = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.find(
      plan => plan.symbol === "285A" && plan.label.includes("入口時固定±2σ")
    )!;
    preview.plans = preview.plans.map((plan: any) =>
      plan.planId === fixedBollinger.planId
        ? {
            ...plan,
            signals: 3,
            openedTrades: 3,
            completedTrades: 3,
            openTrades: 0,
            wins: 3,
            losses: 0,
            draws: 0,
            pnlPer100: 65_562,
            grossProfitPer100: 65_562,
            grossLossPer100: 0,
          }
        : plan
    );

    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-09-24",
      closedTradeDates: dates,
      materializations: dates.map(date => materialization(date, 0)),
      todayPreview: {
        ...preview,
        component: MULTI_SYMBOL_MONITORING_COMPONENT,
        materializationVersion: MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
        tradeDate: "2026-09-24",
        incompleteReason: null,
      },
    });
    const displayed = result.symbols
      .find(item => item.symbol === "285A")!
      .plans.find(plan => plan.planId === fixedBollinger.planId)!;

    expect(displayed.windows.today).toMatchObject({
      completedTrades: 3,
      wins: 3,
      pnlPer100: 65_562,
    });
    expect(displayed.windows.recent5).toMatchObject({
      includedTradingDays: 5,
      completedTrades: 3,
      wins: 3,
      pnlPer100: 65_562,
    });
    expect(displayed.windows.recent10).toMatchObject({
      includedTradingDays: 10,
      completedTrades: 3,
      wins: 3,
      pnlPer100: 65_562,
    });
    expect(displayed.windows.all).toMatchObject({
      includedTradingDays: 11,
      completedTrades: 3,
      wins: 3,
      pnlPer100: 65_562,
    });
  });

  it("closedでもcomplete+readyでない日は台帳を暫定採用し、確定日は不変かつ二重計上しない", () => {
    const incomplete = materialization("2026-10-15", 999_000);
    incomplete.status = "incomplete_source";
    incomplete.resultJson.ready = false;
    incomplete.resultJson.incompleteReason = "missing_current_trades=1";
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-10-16",
      closedTradeDates: ["2026-10-14", "2026-10-15", "2026-10-16"],
      materializations: [materialization("2026-10-14", 1_000), incomplete, materialization("2026-10-16", 3_000)],
      priorLedgerPreviews: [ledgerPreview("2026-10-15", 2_000)],
    });
    const current = result.symbols
      .find(item => item.symbol === "285A")!
      .plans.find(plan => plan.planId === "current:285A")!;

    expect(result.eligibleTradeDates).toEqual(["2026-10-14", "2026-10-16"]);
    expect(result.pendingClosedTradeDates).toEqual(["2026-10-15"]);
    expect(result.provisionalLedgerTradeDates).toEqual(["2026-10-15"]);
    expect(current.windows.all).toMatchObject({
      includedTradingDays: 3,
      completedTrades: 3,
      pnlPer100: 6_000,
    });
  });

  it("closedだがsnapshot未生成の日も保存済み台帳で暫定補完する", () => {
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-10-16",
      closedTradeDates: ["2026-10-14", "2026-10-15", "2026-10-16"],
      materializations: [materialization("2026-10-14", 1_000), materialization("2026-10-16", 3_000)],
      priorLedgerPreviews: [ledgerPreview("2026-10-15", 2_000)],
    });
    const current = result.symbols
      .find(item => item.symbol === "285A")!
      .plans.find(plan => plan.planId === "current:285A")!;

    expect(result.pendingClosedTradeDates).toEqual(["2026-10-15"]);
    expect(result.provisionalLedgerTradeDates).toEqual(["2026-10-15"]);
    expect(current.windows.all).toMatchObject({
      includedTradingDays: 3,
      completedTrades: 3,
      pnlPer100: 6_000,
    });
  });

  it("営業日のゼロ件previewは1日として数え、未決済・missingは確定ゼロ扱いにしない", () => {
    const zeroDay = zeroLedgerPreview("2026-10-16");
    const zeroResult = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-10-16",
      closedTradeDates: ["2026-10-14", "2026-10-15"],
      materializations: [materialization("2026-10-14", 1_000), materialization("2026-10-15", 2_000)],
      todayPreview: zeroDay,
    });
    const zeroCurrent = zeroResult.symbols
      .find(item => item.symbol === "285A")!
      .plans.find(plan => plan.planId === "current:285A")!;
    expect(zeroResult.todayStatus).toMatchObject({
      isTradingDay: true,
      source: "persisted_ledger_preview",
      provisional: true,
      ready: true,
    });
    expect(zeroCurrent.windows.today).toMatchObject({
      includedTradingDays: 1,
      signals: 0,
      completedTrades: 0,
      openTrades: 0,
    });
    expect(zeroCurrent.windows.all.includedTradingDays).toBe(3);

    const unresolved = zeroLedgerPreview("2026-10-16");
    unresolved.ready = false;
    unresolved.incompleteReason = "open_trades=1,missing_current_trades=1";
    unresolved.summary = {
      ...unresolved.summary,
      signals: 2,
      openTrades: 1,
      missingTrades: 1,
    };
    unresolved.plans = unresolved.plans.map((plan: any) =>
      plan.planId === "current:285A"
        ? {
            ...plan,
            signals: 2,
            openedTrades: 1,
            openTrades: 1,
            missingTrades: 1,
          }
        : plan
    );
    const unresolvedResult = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-10-16",
      closedTradeDates: [],
      materializations: [],
      todayPreview: unresolved,
    });
    const unresolvedCurrent = unresolvedResult.symbols
      .find(item => item.symbol === "285A")!
      .plans.find(plan => plan.planId === "current:285A")!;
    expect(unresolvedResult.todayStatus).toMatchObject({
      provisional: true,
      ready: false,
      incompleteReason: "open_trades=1,missing_current_trades=1",
    });
    expect(unresolvedCurrent.windows.today).toMatchObject({
      signals: 2,
      completedTrades: 0,
      openTrades: 1,
    });
  });

  it("JPX休日と土曜10/17は当日previewにも期間窓にも入れない", () => {
    expect(isTokyoEquityTradeDate("2026-10-12")).toBe(false);
    expect(isTokyoEquityTradeDate("2026-10-17")).toBe(false);
    expect(listTokyoEquityTradeDatesBefore("2026-10-17").slice(-3)).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-10-17",
      closedTradeDates: ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"],
      materializations: [
        materialization("2026-10-14", 1_000),
        materialization("2026-10-15", 2_000),
        materialization("2026-10-16", 3_000),
        materialization("2026-10-17", 999_000),
      ],
      todayPreview: ledgerPreview("2026-10-17", 888_000),
    });
    expect(result.displayTradeDates).toEqual(["2026-10-14", "2026-10-15", "2026-10-16"]);
    expect(result.todayStatus).toMatchObject({
      isTradingDay: false,
      source: "unavailable",
      provisional: false,
    });
    expect(result.symbols[0]!.plans[0]!.windows.today.includedTradingDays).toBe(0);
  });

  it("不足日の台帳取得は2日ずつに制限し、1日の失敗を他の日から隔離する", async () => {
    let active = 0;
    let maxActive = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const requestedDates = ["2026-10-08", "2026-10-09", "2026-10-13", "2026-10-14", "2026-10-15"];
    try {
      const previews = await loadLedgerPreviewsForDates(requestedDates, async tradeDate => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        if (tradeDate === "2026-10-13") throw new Error("isolated_failure");
        return zeroLedgerPreview(tradeDate);
      });
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(previews.map(preview => preview.tradeDate)).toEqual([
        "2026-10-08",
        "2026-10-09",
        "2026-10-14",
        "2026-10-15",
      ]);
      expect(warning).toHaveBeenCalledWith(
        "[multi-symbol-monitoring] ledger preview unavailable",
        expect.objectContaining({ tradeDate: "2026-10-13" })
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("10/14〜10/16のAI v6とBollinger 5案をsignal_quality・100株で合算する", () => {
    const result = buildMultiSymbolMonitoringTrend({
      asOfDate: "2026-10-16",
      closedTradeDates: ["2026-10-14", "2026-10-15", "2026-10-16"],
      materializations: [
        monitoringTotalsMaterialization({
          tradeDate: "2026-10-14",
          aiTrades: 10,
          aiPnl: 30_000,
          bollingerTrades: 18,
        }),
        monitoringTotalsMaterialization({
          tradeDate: "2026-10-15",
          aiTrades: 20,
          aiPnl: 50_000,
          bollingerTrades: 70,
        }),
        monitoringTotalsMaterialization({
          tradeDate: "2026-10-16",
          aiTrades: 36,
          aiPnl: 73_980,
          bollingerTrades: 66,
        }),
      ],
    });
    const plans = result.symbols.flatMap(symbol => symbol.plans);
    const ai = plans.filter(plan => plan.label.includes("AI適応予測shadow v6"));
    const bollinger = plans.filter(plan => plan.label.startsWith("ボリンジャー方向判定"));
    expect(ai.reduce((sum, plan) => sum + plan.windows.all.completedTrades, 0)).toBe(66);
    expect(ai.reduce((sum, plan) => sum + plan.windows.all.pnlPer100, 0)).toBe(153_980);
    expect(bollinger.reduce((sum, plan) => sum + plan.windows.all.completedTrades, 0)).toBe(154);
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
    const afterPromotion = materialization("2026-10-13", 0);
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
      asOfDate: "2026-10-13",
      closedTradeDates: ["2026-10-09", "2026-10-13"],
      materializations: [beforePromotion, afterPromotion] as any,
    });
    const comparisonShadow = result.symbols
      .find(item => item.symbol === "3436")!
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
    expect(
      result.symbols
        .find(item => item.symbol === "3436")
        ?.plans.slice(0, 3)
        .map(plan => plan.label)
    ).toEqual(["現行仮想：B案・15分時間決済", "旧Current：前場安値更新SHORT（比較シャドー）", "A案：出来高1.10倍"]);
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
    const source = readFileSync(new URL("./multiSymbolMonitoringTrend.ts", import.meta.url), "utf8");
    expect(source).toContain("getRtDailyAuditMaterializationsForRange");
    expect(source).not.toContain("getRtSourceEvents");
    expect(source).not.toContain("getRtSignalCandidates");
    expect(source).not.toContain("getRtForwardShadowTrades");
  });

  it("AI固定行を含む新materialization versionを使用する", () => {
    expect(MULTI_SYMBOL_MONITORING_COMPONENT).toBe("monitoring_trend_10_symbols");
    expect(MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION).toBe(
      "monitoring-trend-10-symbols-daily-v4-ai-forecast-generation-fallback"
    );
  });

  it("6857と6981は現行・独立2案・Bollinger 5案・AI案を発火ゼロでも固定表示する", () => {
    const advantest = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(plan => plan.symbol === "6857");
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
    const murata = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(plan => plan.symbol === "6981");
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
