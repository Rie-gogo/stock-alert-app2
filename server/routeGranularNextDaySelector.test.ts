import { describe, expect, it } from "vitest";
import { ROUTE_GRANULAR_VARIANTS, auditRouteGranularCatalog } from "./routeGranularMonitoringRegistry";
import { buildRouteGranularDailySnapshot } from "./routeGranularMonitoringMaterializer";
import { buildRouteGranularSelectorSnapshot, ROUTE_GRANULAR_SELECTOR_CONFIG, ROUTE_GRANULAR_SELECTOR_VERSION } from "./routeGranularNextDaySelector";

const planB = "forward-shadow-285a-five-routes-atr036-route-daily-end-v1";
const currentVersion = "current-10-symbol-candidates-v3-low-win-routes-shadow-only";
function featureRow(tradeDate: string, symbol = "285A", trend: "up" | "down" = "down") {
  const up = trend === "up";
  const technicalFeatures = {
    open: 100, high: up ? 110 : 102, low: up ? 98 : 90, close: up ? 109 : 91, atr14Pct: 1,
    movingAverages: {
      "5": { value: up ? 106 : 94, slopePct: up ? 1 : -1 },
      "20": { value: 100, slopePct: up ? 0.5 : -0.5 },
      "25": { value: up ? 98 : 102, slopePct: up ? 0.4 : -0.4 },
      "50": { value: up ? 95 : 105, slopePct: up ? 0.3 : -0.3 },
    },
    bollinger20: { percentB: up ? 90 : 10, bandwidthPct: 8 },
    volumeRatio: { to20: 20 },
    intraday: { sixtyMinute: { slopePct: up ? 1 : -1 }, sessionBars60: Array.from({ length: 5 }, (_, index) => ({ close: up ? 100 + index : 96 - index })) },
  };
  return {
    tradeDate, status: "complete", resultJson: {
      inputHash: `feature:${tradeDate}`,
      featuresBySymbol: Object.fromEntries(["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"].map(item => [item, { featureEligible: item === symbol, provenanceStatus: item === symbol ? "verified" : "unavailable", features: technicalFeatures, regime: { full: "down|normal|lower", trend: "down", volatility: "normal" } }])),
    },
  } as any;
}
function dailyRow(tradeDate: string, pnl: number) {
  return {
    tradeDate, status: "complete", resultJson: {
      ready: true,
      catalogAudit: { complete: true },
      plans: ROUTE_GRANULAR_VARIANTS.map(item => ({ ...item, signals: 1, openedTrades: 1, completedTrades: 1, openTrades: 0, missingTrades: 0, wins: pnl > 0 ? 1 : 0, losses: pnl < 0 ? 1 : 0, draws: 0, pnlPer100: pnl, grossProfitPer100: Math.max(0, pnl), grossLossPer100: Math.max(0, -pnl) })),
    },
  } as any;
}

describe("route-granular next-day monitoring selector", () => {
  it("declares technical market state as authority and recent trend as a safety gate", () => {
    expect(ROUTE_GRANULAR_SELECTOR_VERSION).toBe("route-granular-technical-regime-authority-v5-market-affinity");
    expect(ROUTE_GRANULAR_SELECTOR_CONFIG).toMatchObject({
      decisionAuthority: "technical_market_regime_conditional_route_performance_manual_review",
      aggregatePlanTrendAuthority: false,
      recentTrendAuthority: false,
      causalAlignment: "D-1_closed_technical_features_to_D_route_outcomes",
      minimumCompletedTrades: 10,
      recentTrend: { recentTradingDays: 5, comparisonTradingDays: 5, minimumCompletedTradesPerWindow: 2 },
      compositePlansSelectable: false,
      unclassifiedSelectable: false,
    });
  });

  it("splits all five 285A Plan-B child routes and never registers a composite selectable row", () => {
    const planBChildren = ROUTE_GRANULAR_VARIANTS.filter(item => item.strategyVersion === planB);
    expect(planBChildren.map(item => item.shadowRouteId).sort()).toEqual(["confirmed_morning_long", "reversal_long", "reversal_short", "safe_cb_short", "trend_short"]);
    expect(planBChildren.every(item => item.shadowRouteId && item.rowId.includes(item.shadowRouteId))).toBe(true);
    expect(ROUTE_GRANULAR_VARIANTS.some(item => item.strategyVersion === planB && !item.shadowRouteId)).toBe(false);
  });

  it("attributes a Plan-B trade only to its child route and keeps zero-fire variants", () => {
    const daily = buildRouteGranularDailySnapshot({
      tradeDate: "2026-10-02",
      candidates: [{ id: 1, candidateVersion: currentVersion, sourceEventId: "c:1", symbol: "285A", routeId: "trendLong", side: "long", realtimeDecision: "accepted" }] as any,
      candidateTrades: [{ candidateId: 1, completed: true, pnl: 100, shares: 100 }] as any,
      shadowEvents: [{ strategyVersion: planB, sourceEventId: "s:1", evaluationMode: "signal_quality", decisionJson: { actions: [{ type: "entry", route: "reversal_long" }] } }] as any,
      shadowTrades: [{ strategyVersion: planB, evaluationMode: "signal_quality", symbol: "285A", entrySourceEventId: "s:1", exitTradeDate: "2026-10-02", pnl: 200, shares: 100 }] as any,
    });
    const reversal = daily.plans.find(item => item.rowId === `shadow:${planB}:reversal_long:reversal_long`)!;
    const safeCb = daily.plans.find(item => item.rowId === `shadow:${planB}:safe_cb_short:safe_cb_short`)!;
    const current = daily.plans.find(item => item.rowId === "current:285A:confirmed_morning_long:trendLong")!;
    expect(reversal.completedTrades).toBe(1);
    expect(reversal.pnlPer100).toBe(200);
    expect(safeCb.completedTrades).toBe(0);
    expect(current.completedTrades).toBe(1);
  });

  it("partitions fixed-target Bollinger outcomes by persisted LONG/SHORT action side", () => {
    const strategyVersion = "candidate-285a-bollinger-directional-fixed-stop140-cooldown30-v1";
    const daily = buildRouteGranularDailySnapshot({
      tradeDate: "2026-10-05",
      candidates: [],
      candidateTrades: [],
      shadowEvents: [{
        strategyVersion,
        sourceEventId: "bollinger:long:entry",
        evaluationMode: "signal_quality",
        decisionJson: { actions: [{ type: "entry", side: "long", routeId: "bollinger_directional_fixed_stop_140_cooldown_30_long" }] },
      }] as any,
      shadowTrades: [{
        strategyVersion,
        evaluationMode: "signal_quality",
        symbol: "285A",
        entrySourceEventId: "bollinger:long:entry",
        exitTradeDate: "2026-10-05",
        pnl: 300,
        shares: 100,
      }] as any,
    });
    const long = daily.plans.find(item => item.strategyVersion === strategyVersion && item.shadowSide === "long")!;
    const short = daily.plans.find(item => item.strategyVersion === strategyVersion && item.shadowSide === "short")!;
    expect(long).toMatchObject({ signals: 1, completedTrades: 1, pnlPer100: 300 });
    expect(short).toMatchObject({ signals: 0, completedTrades: 0, pnlPer100: 0 });
  });

  it("does not use data after the closed cutoff and fails closed for stopped variants", () => {
    const cutoff = "2026-10-30";
    const rows = Array.from({ length: 20 }, (_, index) => dailyRow(`2026-10-${String(index + 1).padStart(2, "0")}`, 100));
    const features = Array.from({ length: 20 }, (_, index) => featureRow(`2026-10-${String(index + 1).padStart(2, "0")}`));
    const lifecycles: any = Object.fromEntries(ROUTE_GRANULAR_VARIANTS.filter(item => item.strategyVersion).map(item => [item.strategyVersion!, { lifecycle: "monitoring", purpose: "candidate" }]));
    lifecycles[planB] = { lifecycle: "stopped", purpose: "candidate" };
    const cutoffDaily = dailyRow(cutoff, 100);
    const snapshot = buildRouteGranularSelectorSnapshot({ sourceTradeDate: cutoff, feature: featureRow(cutoff), featureRows: [featureRow("2026-10-31"), ...features].reverse(), dailyRows: [dailyRow("2026-10-31", -999999), cutoffDaily, ...rows].reverse(), lifecycles, watermark: { source: { count: 1 } } });
    const withoutFuture = buildRouteGranularSelectorSnapshot({ sourceTradeDate: cutoff, feature: featureRow(cutoff), featureRows: features, dailyRows: [...rows, cutoffDaily], lifecycles, watermark: { source: { count: 1 } } });
    expect(snapshot.inputHash).toBe(withoutFuture.inputHash);
    expect(snapshot.scores.filter((item: any) => item.strategyVersion === planB).every((item: any) => item.selectable === false)).toBe(true);
    expect(snapshot.scores.find((item: any) => item.origin === "unclassified")?.selectable).toBe(false);
    expect(snapshot.aggregatePlanTrendAuthority).toBe(false);
    const selected = snapshot.selections.find((item: any) => item.decision === "reference_only");
    expect(selected?.reason).toBe("technical_regime_conditional_expected_value_reference_only");
    const score = snapshot.scores.find((item: any) => item.selectable === true);
    expect(score?.recentTrend).toMatchObject({
      status: "stable",
      windows: {
        recent5: { includedTradingDays: 5, completedTrades: 5, wins: 5, pnlPer100: 500 },
        previous5: { includedTradingDays: 5, completedTrades: 5, wins: 5, pnlPer100: 500 },
        recent10: { includedTradingDays: 10, completedTrades: 10, wins: 10, pnlPer100: 1000 },
        all: { includedTradingDays: 21, completedTrades: 21, wins: 21, pnlPer100: 2100 },
      },
    });
    expect(score?.recentTrend.windows.recent5.toDate).toBe(cutoff);
  });

  it("pairs each closed technical feature only with the following trading day's outcome", () => {
    const dates = Array.from({ length: 26 }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
    const features = dates.map((date, index) => featureRow(date, "285A", index % 2 === 0 ? "up" : "down"));
    const rows = dates.map((date, index) => dailyRow(date, index === 0 ? 0 : (index - 1) % 2 === 0 ? 200 : -50));
    const lifecycles: any = Object.fromEntries(ROUTE_GRANULAR_VARIANTS
      .filter(item => item.strategyVersion)
      .map(item => [item.strategyVersion!, { lifecycle: "monitoring", purpose: "candidate" }]));
    const cutoff = dates.at(-2)!; // even index => up regime; the final row is deliberately future data.
    const snapshot = buildRouteGranularSelectorSnapshot({
      sourceTradeDate: cutoff,
      feature: features.at(-2)!,
      featureRows: features,
      dailyRows: rows,
      lifecycles,
      watermark: { source: { count: 1 } },
    });
    const longScore = snapshot.scores.find((item: any) => item.rowId === "current:285A:confirmed_morning_long:trendLong") as any;
    expect(longScore.technicalRegime.trend).toBe("up");
    expect(longScore.technicalRegimeMatch.featureOutcomeAlignment).toBe("D-1_to_D");
    expect(longScore.technicalRegimeMatch.completedTrades).toBeGreaterThanOrEqual(3);
    expect(longScore.technicalRegimeMatch.pnlPer100).toBeGreaterThan(0);
    expect(longScore.posteriorPnlPer100).toBeGreaterThan(0);
  });

  it("requires ten completed trades for each variant instead of borrowing the route-group total", () => {
    const cutoff = "2026-10-30";
    const currentRowId = "current:285A:confirmed_morning_long:trendLong";
    const planARowId = ROUTE_GRANULAR_VARIANTS.find(item => item.symbol === "285A" && item.routeGroupId === "confirmed_morning_long" && item.origin === "forward_shadow" && item.strategyVersion !== planB)?.rowId;
    const rows = Array.from({ length: 20 }, (_, index) => {
      const row = dailyRow(`2026-10-${String(index + 1).padStart(2, "0")}`, 0);
      row.resultJson.plans = row.resultJson.plans.map((item: any) => {
        const completed = item.rowId === planARowId ? 1 : item.rowId === currentRowId && index < 5 ? 1 : 0;
        return { ...item, signals: completed, openedTrades: completed, completedTrades: completed, wins: completed, losses: 0, pnlPer100: completed * 100, grossProfitPer100: completed * 100, grossLossPer100: 0 };
      });
      return row;
    });
    const features = Array.from({ length: 20 }, (_, index) => featureRow(`2026-10-${String(index + 1).padStart(2, "0")}`));
    const lifecycles: any = Object.fromEntries(ROUTE_GRANULAR_VARIANTS.filter(item => item.strategyVersion).map(item => [item.strategyVersion!, { lifecycle: "monitoring", purpose: "candidate" }]));
    const snapshot = buildRouteGranularSelectorSnapshot({ sourceTradeDate: cutoff, feature: featureRow(cutoff), featureRows: features, dailyRows: [...rows, dailyRow(cutoff, 0)], lifecycles, watermark: { source: { count: 1 } } });
    const current = snapshot.scores.find((item: any) => item.rowId === currentRowId) as any;
    expect(current.completedTrades).toBe(5);
    expect(current.routeGroupCompletedTrades).toBeGreaterThan(10);
    expect(current.selectable).toBe(false);
    expect(current.exclusionReasons).toContain("fewer_than_10_variant_completed_trades");
  });

  it("keeps an active market-context candidate when technical features are unavailable", () => {
    const cutoff = "2026-10-30";
    const rows = [
      ...Array.from({ length: 9 }, (_, index) => dailyRow(`2026-10-${String(index + 21).padStart(2, "0")}`, 100)),
      dailyRow(cutoff, 100),
    ];
    const unavailableFeature = featureRow(cutoff, "untracked");
    const lifecycles: any = Object.fromEntries(ROUTE_GRANULAR_VARIANTS
      .filter(item => item.strategyVersion)
      .map(item => [item.strategyVersion!, { lifecycle: "monitoring", purpose: "candidate" }]));
    const snapshot = buildRouteGranularSelectorSnapshot({
      sourceTradeDate: cutoff,
      feature: unavailableFeature,
      featureRows: [unavailableFeature],
      dailyRows: rows,
      lifecycles,
      watermark: { source: { count: 1 } },
    });
    const score = snapshot.scores.find((item: any) => item.rowId === "current:285A:confirmed_morning_long:trendLong") as any;
    expect(score.selectable).toBe(false);
    expect(score.exclusionReasons).toContain("feature_or_provenance_unavailable");
    expect(score).toMatchObject({
      marketContextEligible: true,
      marketContextEvidenceLevel: "observed",
      marketContextCompletedTrades: 10,
      marketContextRecent10CompletedTrades: 10,
      marketContextExpectedDailyPnlPer100: 100,
    });
  });

  it("does not exclude a route from market-context matching merely because recent pnl is negative", () => {
    const cutoff = "2026-10-30";
    const rows = [
      ...Array.from({ length: 9 }, (_, index) => dailyRow(`2026-10-${String(index + 21).padStart(2, "0")}`, -100)),
      dailyRow(cutoff, -100),
    ];
    const unavailableFeature = featureRow(cutoff, "untracked");
    const lifecycles: any = Object.fromEntries(ROUTE_GRANULAR_VARIANTS
      .filter(item => item.strategyVersion)
      .map(item => [item.strategyVersion!, { lifecycle: "monitoring", purpose: "candidate" }]));
    const snapshot = buildRouteGranularSelectorSnapshot({
      sourceTradeDate: cutoff,
      feature: unavailableFeature,
      featureRows: [unavailableFeature],
      dailyRows: rows,
      lifecycles,
      watermark: { source: { count: 1 } },
    });
    const score = snapshot.scores.find((item: any) => item.rowId === "current:285A:confirmed_morning_long:trendLong") as any;
    expect(score).toMatchObject({
      marketContextEligible: true,
      marketContextExpectedDailyPnlPer100: -100,
      marketContextRecent10PnlPer100: -1000,
      marketContextAllPnlPer100: -1000,
    });
    expect(score.marketContextExclusionReasons).toEqual([]);
  });

  it("blocks a route variant whose recent five-day trend deteriorated", () => {
    const cutoff = "2026-10-30";
    const rows = Array.from({ length: 20 }, (_, index) => dailyRow(`2026-10-${String(index + 1).padStart(2, "0")}`, index < 15 ? 100 : -100));
    const features = Array.from({ length: 20 }, (_, index) => featureRow(`2026-10-${String(index + 1).padStart(2, "0")}`));
    const lifecycles: any = Object.fromEntries(ROUTE_GRANULAR_VARIANTS.filter(item => item.strategyVersion).map(item => [item.strategyVersion!, { lifecycle: "monitoring", purpose: "candidate" }]));
    const snapshot = buildRouteGranularSelectorSnapshot({ sourceTradeDate: cutoff, feature: featureRow(cutoff), featureRows: features, dailyRows: [...rows, dailyRow(cutoff, -100)], lifecycles, watermark: { source: { count: 1 } } });
    const current = snapshot.scores.find((item: any) => item.rowId === "current:285A:confirmed_morning_long:trendLong") as any;
    expect(current.recentTrend.status).toBe("deteriorating");
    expect(current.recentTrend.windows.recent5.pnlPer100).toBe(-500);
    expect(current.selectable).toBe(false);
    expect(current.exclusionReasons).toEqual(expect.arrayContaining(["non_positive_recent5_pnl", "route_recent_trend_deteriorating"]));
  });

  it("never imports the source hot path, engine, order bridge, or normal trade writer", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("./routeGranularNextDaySelector.ts", import.meta.url), "utf8");
    for (const forbidden of ["./realtimeSimEngine", "./sourceEventIngestion", "./forwardShadowSequence", "./orderBridge", "insertRtTrade("]) expect(source).not.toContain(forbidden);
  });

  it("keeps all remediated engine routes in a code-derived catalog and quarantines old bad mappings", () => {
    expect(auditRouteGranularCatalog()).toMatchObject({ complete: true, requirementMissing: [], duplicateSelectableRows: [], invalidMappedSelectableRows: [] });
    const exactKioxia = ROUTE_GRANULAR_VARIANTS.find(item => item.strategyVersion === "candidate-285a-reversal-long-exact-monitoring-reopen-v2");
    const exactSocionext = ROUTE_GRANULAR_VARIANTS.find(item => item.strategyVersion === "candidate-6526-confirmed-long-exact-monitoring-reopen-v2");
    expect(exactKioxia?.canonicalLogic).toBe("candidate-285a-current-reversal-long-exact-monitoring-reopen");
    expect(exactSocionext?.canonicalLogic).toBe("candidate-6526-confirmed-long-exact-monitoring-reopen");
    expect(ROUTE_GRANULAR_VARIANTS.filter(item => item.lifecycleRequirement === "invalid_mapping").map(item => item.strategyVersion).sort()).toEqual([
      "candidate-285a-reversal-long-monitoring-reopen-v1",
      "candidate-6526-initial-strength-monitoring-reopen-v1",
    ]);
    expect(ROUTE_GRANULAR_VARIANTS.some(item => item.symbol === "5803" && item.candidateRouteId === "afternoonLowBreakShort")).toBe(true);
    expect(ROUTE_GRANULAR_VARIANTS.filter(item => item.symbol === "6857" && item.origin === "forward_shadow").map(item => item.canonicalLogic).sort()).toEqual([
      "6857_bollinger_directional_fixed_stop140_cooldown30",
      "6857_bollinger_directional_fixed_stop140_cooldown30",
      "6857_bollinger_directional_sma10_slope_gap050_stop140_cooldown30",
      "6857_bollinger_directional_sma10_slope_gap050_stop140_cooldown30",
      "6857_bollinger_directional_sma20_dynamic_rsi22long_gap060_stop140_cooldown30",
      "6857_bollinger_directional_sma20_dynamic_rsi22long_gap060_stop140_cooldown30",
      "candidate-6857-confirmed-continuation-depth",
      "candidate-6857-short-body008-depth",
    ]);
    expect(ROUTE_GRANULAR_VARIANTS.some(item => item.symbol === "6981" && item.candidateRouteId === "openingBreakShort")).toBe(true);
  });

  it("partitions 8035 shared strategy versions by child direction without double attribution", () => {
    const rows = ROUTE_GRANULAR_VARIANTS.filter(item => item.symbol === "8035" && item.strategyVersion === planB);
    expect(rows).toHaveLength(0);
    const generic = ROUTE_GRANULAR_VARIANTS.filter(item => item.symbol === "8035" && item.strategyVersion === "forward-shadow-8035-causal-current-price-v2");
    expect(generic.map(item => `${item.routeGroupId}:${item.shadowSide}`).sort()).toEqual([
      "open_direction_breakout_long:long",
      "open_direction_breakout_short:short",
    ]);
  });

  it("fails closed when the persisted route catalog audit is unresolved", () => {
    const cutoff = "2026-10-30";
    const daily = dailyRow(cutoff, 100);
    daily.resultJson.catalogAudit = { complete: false, requirementMissing: ["6981:opening_break_short"] };
    const snapshot = buildRouteGranularSelectorSnapshot({
      sourceTradeDate: cutoff,
      feature: featureRow(cutoff),
      featureRows: [featureRow("2026-10-29")],
      dailyRows: [daily],
      lifecycles: {},
      watermark: { source: { count: 1 } },
    });
    expect(snapshot.catalogAudit.complete).toBe(false);
    expect(snapshot.selections.every((selection: any) => selection.decision === "no_selection")).toBe(true);
    expect(snapshot.scores.every((score: any) => score.exclusionReasons.includes("route_catalog_incomplete_or_unresolved"))).toBe(true);
  });

  it("reports an active lifecycle orphan instead of silently selecting around it", () => {
    const audit = auditRouteGranularCatalog(ROUTE_GRANULAR_VARIANTS, [{
      versionId: "orphan-monitoring-v1", strategyId: "orphan", status: "monitoring", evaluationPurpose: "candidate", eligibleForAdoption: false, configJson: { symbol: "6981" },
    }]);
    expect(audit.complete).toBe(false);
    expect(audit.orphanMonitoringCandidateVersions).toEqual(["orphan-monitoring-v1"]);
  });
});
