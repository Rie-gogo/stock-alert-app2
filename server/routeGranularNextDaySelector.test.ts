import { describe, expect, it } from "vitest";
import { ROUTE_GRANULAR_VARIANTS, auditRouteGranularCatalog } from "./routeGranularMonitoringRegistry";
import { buildRouteGranularDailySnapshot } from "./routeGranularMonitoringMaterializer";
import { buildRouteGranularSelectorSnapshot } from "./routeGranularNextDaySelector";

const planB = "forward-shadow-285a-five-routes-atr036-route-daily-end-v1";
const currentVersion = "current-10-symbol-candidates-v3-low-win-routes-shadow-only";
function featureRow(tradeDate: string, symbol = "285A") {
  return {
    tradeDate, status: "complete", resultJson: {
      inputHash: `feature:${tradeDate}`,
      featuresBySymbol: Object.fromEntries(["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"].map(item => [item, { featureEligible: item === symbol, provenanceStatus: item === symbol ? "verified" : "unavailable", regime: { full: "down|normal|lower", trend: "down", volatility: "normal" } }])),
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

  it("does not use data after the closed cutoff and fails closed for stopped variants", () => {
    const cutoff = "2026-10-30";
    const rows = Array.from({ length: 20 }, (_, index) => dailyRow(`2026-10-${String(index + 1).padStart(2, "0")}`, 100));
    const features = Array.from({ length: 20 }, (_, index) => featureRow(`2026-10-${String(index + 1).padStart(2, "0")}`));
    const lifecycles: any = Object.fromEntries(ROUTE_GRANULAR_VARIANTS.filter(item => item.strategyVersion).map(item => [item.strategyVersion!, { lifecycle: "monitoring", purpose: "candidate" }]));
    lifecycles[planB] = { lifecycle: "stopped", purpose: "candidate" };
    const snapshot = buildRouteGranularSelectorSnapshot({ sourceTradeDate: cutoff, feature: featureRow(cutoff), featureRows: [...features, featureRow("2026-10-31")], dailyRows: [...rows, dailyRow("2026-10-31", -999999)], lifecycles, watermark: { source: { count: 1 } } });
    const withoutFuture = buildRouteGranularSelectorSnapshot({ sourceTradeDate: cutoff, feature: featureRow(cutoff), featureRows: features, dailyRows: rows, lifecycles, watermark: { source: { count: 1 } } });
    expect(snapshot.inputHash).toBe(withoutFuture.inputHash);
    expect(snapshot.scores.filter((item: any) => item.strategyVersion === planB).every((item: any) => item.selectable === false)).toBe(true);
    expect(snapshot.scores.find((item: any) => item.origin === "unclassified")?.selectable).toBe(false);
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
