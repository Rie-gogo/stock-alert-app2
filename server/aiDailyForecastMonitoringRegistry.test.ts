import { describe, expect, it } from "vitest";
import { AI_DAILY_FORECAST_VERSIONS } from "./runtimeIdentity";
import {
  MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS,
  TEN_MONITORED_SYMBOLS,
} from "./multiSymbolMonitoringRegistry";
import {
  ROUTE_GRANULAR_VARIANTS,
  auditRouteGranularCatalog,
} from "./routeGranularMonitoringRegistry";
import { buildMultiSymbolMonitoringDailySnapshot } from "./multiSymbolMonitoringMaterializer";
import {
  buildRouteGranularDailySnapshot,
  ROUTE_GRANULAR_MONITORING_VERSION,
} from "./routeGranularMonitoringMaterializer";
import { MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION } from "./multiSymbolMonitoringMaterializer";
import { buildRouteGranularSelectorSnapshot } from "./routeGranularNextDaySelector";

const aiVersions = new Set(Object.values(AI_DAILY_FORECAST_VERSIONS));

function featureRow(tradeDate: string) {
  const technicalFeatures = {
    open: 100, high: 102, low: 98, close: 101, atr14Pct: 1,
    movingAverages: {
      "5": { value: 101, slopePct: 0.1 },
      "20": { value: 100, slopePct: 0.1 },
      "25": { value: 99, slopePct: 0.1 },
      "50": { value: 98, slopePct: 0.1 },
    },
    bollinger20: { percentB: 60, bandwidthPct: 8 },
    volumeRatio: { to20: 1 },
    intraday: { sixtyMinute: { slopePct: 0.1 }, sessionBars60: Array.from({ length: 5 }, (_, index) => ({ close: 100 + index })) },
  };
  return {
    tradeDate,
    status: "complete",
    resultJson: {
      inputHash: `feature:${tradeDate}`,
      featuresBySymbol: Object.fromEntries(TEN_MONITORED_SYMBOLS.map(symbol => [symbol, {
        featureEligible: true,
        provenanceStatus: "verified",
        features: technicalFeatures,
        regime: { full: "up|normal|middle", trend: "up", volatility: "normal" },
      }])),
    },
  } as any;
}

function dailyRow(tradeDate: string) {
  return {
    tradeDate,
    status: "complete",
    resultJson: {
      ready: true,
      catalogAudit: { complete: true },
      plans: ROUTE_GRANULAR_VARIANTS.map(item => ({
        ...item,
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
      })),
    },
  } as any;
}

describe("AI daily forecast monitoring registry", () => {
  it("uses non-destructive materialization versions while moving the active AI generation to v4", () => {
    expect(MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION).toBe("monitoring-trend-10-symbols-daily-v3-ai-forecast-learning");
    expect(ROUTE_GRANULAR_MONITORING_VERSION).toBe("monitoring-route-granular-10-symbols-v3-ai-forecast-learning");
    expect(Object.values(AI_DAILY_FORECAST_VERSIONS).every(version => version.endsWith("-ai-adaptive-forecast-v4"))).toBe(true);
  });

  it("adds exactly one immutable AI plan per monitored symbol even when no event has fired", () => {
    const plans = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(plan => aiVersions.has(plan.strategyVersion));
    expect(plans).toHaveLength(10);
    expect(plans.map(plan => plan.symbol).sort()).toEqual([...TEN_MONITORED_SYMBOLS].sort());
    expect(plans.every(plan => plan.label === "AI適応予測shadow（08:30＋30分更新）" && plan.purpose === "diagnostic" && plan.eligibleForAdoption === false)).toBe(true);

    const snapshot = buildMultiSymbolMonitoringDailySnapshot({
      tradeDate: "2026-10-09",
      candidates: [],
      candidateTrades: [],
      shadowTrades: [],
    });
    const zeroFirePlans = snapshot.plans.filter(plan => aiVersions.has(plan.strategyVersion));
    expect(zeroFirePlans).toHaveLength(10);
    expect(zeroFirePlans.every(plan => plan.signals === 0 && plan.openedTrades === 0 && plan.completedTrades === 0)).toBe(true);
  });

  it("adds exactly LONG and SHORT audit rows for every AI version and attributes a persisted action side without mixing", () => {
    const rows = ROUTE_GRANULAR_VARIANTS.filter(variant => variant.strategyVersion !== null && aiVersions.has(variant.strategyVersion));
    expect(rows).toHaveLength(20);
    for (const [symbol, strategyVersion] of Object.entries(AI_DAILY_FORECAST_VERSIONS)) {
      const perSymbol = rows.filter(row => row.symbol === symbol && row.strategyVersion === strategyVersion);
      expect(perSymbol.map(row => row.shadowSide).sort()).toEqual(["long", "short"]);
      expect(perSymbol.every(row => row.lifecycleRequirement === "monitoring_display_only" && row.unavailableReason === "monitoring_display_only_not_selector_candidate")).toBe(true);
    }
    expect(auditRouteGranularCatalog()).toMatchObject({
      complete: true,
      displayOnlyRequirementMissing: [],
      displayOnlyDuplicateRows: [],
    });

    const version = AI_DAILY_FORECAST_VERSIONS["8035"];
    const snapshot = buildRouteGranularDailySnapshot({
      tradeDate: "2026-10-09",
      candidates: [],
      candidateTrades: [],
      shadowEvents: [{
        strategyVersion: version,
        sourceEventId: "ai:8035:long",
        evaluationMode: "signal_quality",
        decisionJson: { actions: [{ type: "entry", side: "long" }] },
      }] as any,
      shadowTrades: [{
        strategyVersion: version,
        evaluationMode: "signal_quality",
        symbol: "8035",
        entrySourceEventId: "ai:8035:long",
        exitTradeDate: "2026-10-09",
        pnl: 250,
        shares: 100,
      }] as any,
    });
    const long = snapshot.plans.find(plan => plan.strategyVersion === version && plan.shadowSide === "long")!;
    const short = snapshot.plans.find(plan => plan.strategyVersion === version && plan.shadowSide === "short")!;
    expect(long).toMatchObject({ signals: 1, completedTrades: 1, pnlPer100: 250 });
    expect(short).toMatchObject({ signals: 0, completedTrades: 0, pnlPer100: 0 });
  });

  it("keeps AI rows visible in route history but excludes them from selector and v4 candidate eligibility", () => {
    const cutoff = "2026-10-30";
    const snapshot = buildRouteGranularSelectorSnapshot({
      sourceTradeDate: cutoff,
      feature: featureRow(cutoff),
      featureRows: Array.from({ length: 20 }, (_, index) => featureRow(`2026-10-${String(index + 1).padStart(2, "0")}`)),
      dailyRows: [
        ...Array.from({ length: 20 }, (_, index) => dailyRow(`2026-10-${String(index + 1).padStart(2, "0")}`)),
        dailyRow(cutoff),
      ],
      lifecycles: Object.fromEntries(Object.values(AI_DAILY_FORECAST_VERSIONS).map(version => [version, { lifecycle: "monitoring", purpose: "causality_audit" }])),
      watermark: { source: { count: 1 } },
    });
    const aiScores = snapshot.scores.filter((score: any) => aiVersions.has(score.strategyVersion));
    expect(aiScores).toHaveLength(20);
    expect(aiScores.every((score: any) => score.selectable === false && score.marketContextEligible === false && score.exclusionReasons.includes("monitoring_display_only_not_selector_candidate"))).toBe(true);
    expect(snapshot.selections.every((selection: any) => !String(selection.selectedStrategyVersion ?? "").includes("-ai-daily-forecast-"))).toBe(true);
  });
});
