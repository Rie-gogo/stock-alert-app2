import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMultiSymbolMonitoringTrend } from "./multiSymbolMonitoringTrend";
import {
  MULTI_SYMBOL_MONITORING_COMPONENT,
  MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
} from "./multiSymbolMonitoringMaterializer";
import { MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS } from "./multiSymbolMonitoringRegistry";

const dates = [
  "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11",
  "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
];

function materialization(tradeDate: string, currentPnl: number) {
  return {
    status: "complete",
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

describe("10-symbol snapshot-only monitoring trend", () => {
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
    expect(current.windows.recent5).toMatchObject({ completedTrades: 5, wins: 5, pnlPer100: 10_000 });
    expect(current.windows.previous5).toMatchObject({ completedTrades: 5, losses: 5, pnlPer100: -5_000 });
    expect(result.pendingClosedTradeDates).toEqual(["2026-09-21"]);
    expect(result.symbols).toHaveLength(10);
    expect(result.dataSource).toBe("closed_daily_materializations_only");
  });

  it("API集計はraw event・取引履歴を読まない", () => {
    const source = readFileSync(new URL("./multiSymbolMonitoringTrend.ts", import.meta.url), "utf8");
    expect(source).toContain("getRtDailyAuditMaterializationsForRange");
    expect(source).not.toContain("getRtSourceEvents");
    expect(source).not.toContain("getRtSignalCandidates");
    expect(source).not.toContain("getRtForwardShadowTrades");
  });

  it("固定component/versionを維持する", () => {
    expect(MULTI_SYMBOL_MONITORING_COMPONENT).toBe("monitoring_trend_10_symbols");
    expect(MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION).toBe("monitoring-trend-10-symbols-daily-v1");
  });
});
