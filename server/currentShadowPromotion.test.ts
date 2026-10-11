import { describe, expect, it } from "vitest";
import { buildMultiSymbolMonitoringDailySnapshot } from "./multiSymbolMonitoringMaterializer";
import {
  MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS,
  PROMOTED_FORWARD_CURRENT_VERSIONS,
} from "./multiSymbolMonitoringRegistry";
import { buildRouteGranularDailySnapshot } from "./routeGranularMonitoringMaterializer";
import { ROUTE_GRANULAR_VARIANTS, auditRouteGranularCatalog } from "./routeGranularMonitoringRegistry";
import {
  DISCO_SHORT_BASELINE_VERSION,
  DISCO_SHORT_EXECUTABLE_A_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SUMCO_TIME_15_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
} from "./runtimeIdentity";

const promotions = [
  { symbol: "3436", version: SUMCO_TIME_15_VERSION, routeGroupId: "sumco_breakdown_short", direction: "short" },
  { symbol: "6146", version: DISCO_SHORT_EXECUTABLE_A_VERSION, routeGroupId: "opening_short", direction: "short" },
  { symbol: "6976", version: TAIYO_AFTERNOON_LONG_WINRATE_VERSION, routeGroupId: "afternoon_reversal_long", direction: "long" },
] as const;

describe("current/shadow role promotions", () => {
  it("keeps three forward promotions and restores 9984 Current with B as comparison shadow", () => {
    expect(PROMOTED_FORWARD_CURRENT_VERSIONS).toEqual(promotions.map(item => item.version));
    for (const promotion of promotions) {
      const plan = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.find(item => item.strategyVersion === promotion.version);
      expect(plan).toMatchObject({ symbol: promotion.symbol, origin: "forward_shadow", role: "current" });
      const route = ROUTE_GRANULAR_VARIANTS.find(item => item.strategyVersion === promotion.version && item.routeGroupId === promotion.routeGroupId);
      expect(route).toMatchObject({ symbol: promotion.symbol, direction: promotion.direction, origin: "forward_shadow", role: "current", lifecycleRequirement: "monitoring_candidate" });
    }

    expect(MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(item => item.planId.startsWith("current:"))).toHaveLength(7);
    for (const [symbol, candidateRouteId] of [["3436", "sumcoBreakdownShort"], ["6976", "taiyoAfternoonReversal"]] as const) {
      const oldCurrent = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.find(item => item.symbol === symbol && item.candidateRouteId === candidateRouteId);
      expect(oldCurrent).toMatchObject({ origin: "current", role: "shadow", candidateDisposition: "shadow_only" });
    }
    expect(MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.find(item => item.strategyVersion === DISCO_SHORT_BASELINE_VERSION)).toMatchObject({
      symbol: "6146", role: "shadow", origin: "forward_shadow",
    });
    expect(MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.find(item => item.planId === "current:9984")).toMatchObject({
      origin: "current", role: "current",
    });
    expect(MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.find(item => item.strategyVersion === SOFTBANK_RR2_PROTECT_VERSION)).toMatchObject({
      symbol: "9984", origin: "forward_shadow", role: "shadow", eligibleForAdoption: false,
    });
  });

  it("keeps demoted current ledger outcomes separate from the promoted forward outcome", () => {
    const oldCandidate = { id: 100, symbol: "3436", routeId: "sumcoBreakdownShort", side: "short", realtimeDecision: "shadow_only" } as any;
    const activeCandidate = { id: 101, symbol: "3436", routeId: "sumcoBreakdownShort", side: "short", realtimeDecision: "accepted" } as any;
    const multi = buildMultiSymbolMonitoringDailySnapshot({
      tradeDate: "2026-10-13",
      candidates: [oldCandidate, activeCandidate],
      candidateTrades: [{ candidateId: 100, completed: true, pnl: 400, shares: 100 }] as any,
      shadowTrades: [{ strategyVersion: SUMCO_TIME_15_VERSION, evaluationMode: "signal_quality", symbol: "3436", pnl: 500, shares: 100, exitTradeDate: "2026-10-13" }] as any,
    });
    const promoted = multi.plans.find(item => item.strategyVersion === SUMCO_TIME_15_VERSION)!;
    const demoted = multi.plans.find(item => item.planId === "shadow:current:3436:sumcoBreakdownShort")!;
    expect(promoted).toMatchObject({ role: "current", signals: 1, completedTrades: 1, pnlPer100: 500 });
    expect(demoted).toMatchObject({ role: "shadow", signals: 1, completedTrades: 1, pnlPer100: 400 });

    const route = buildRouteGranularDailySnapshot({
      tradeDate: "2026-10-13",
      candidates: [oldCandidate, activeCandidate],
      candidateTrades: [{ candidateId: 100, completed: true, pnl: 400, shares: 100 }] as any,
      shadowEvents: [],
      shadowTrades: [{ strategyVersion: SUMCO_TIME_15_VERSION, evaluationMode: "signal_quality", symbol: "3436", pnl: 500, shares: 100, exitTradeDate: "2026-10-13" }] as any,
    });
    const promotedRoute = route.plans.find(item => item.strategyVersion === SUMCO_TIME_15_VERSION)!;
    const demotedRoute = route.plans.find(item => item.symbol === "3436" && item.candidateRouteId === "sumcoBreakdownShort")!;
    expect(promotedRoute).toMatchObject({ role: "current", completedTrades: 1, pnlPer100: 500 });
    expect(demotedRoute).toMatchObject({ role: "shadow", signals: 1, completedTrades: 1, pnlPer100: 400 });
  });

  it("keeps 9984 Current and B performance on distinct rows without double counting", () => {
    const currentCandidate = { id: 200, symbol: "9984", routeId: "softbankBreakoutLong", side: "long", realtimeDecision: "accepted" } as any;
    const bTrade = { strategyVersion: SOFTBANK_RR2_PROTECT_VERSION, evaluationMode: "signal_quality", symbol: "9984", pnl: 220, shares: 100, exitTradeDate: "2026-10-13" } as any;
    const multi = buildMultiSymbolMonitoringDailySnapshot({
      tradeDate: "2026-10-13",
      candidates: [currentCandidate],
      candidateTrades: [{ candidateId: 200, completed: true, pnl: 120, shares: 100 }] as any,
      shadowTrades: [bTrade],
    });
    expect(multi.plans.find(item => item.planId === "current:9984")).toMatchObject({ role: "current", signals: 1, completedTrades: 1, pnlPer100: 120 });
    expect(multi.plans.find(item => item.strategyVersion === SOFTBANK_RR2_PROTECT_VERSION)).toMatchObject({ role: "shadow", signals: 1, completedTrades: 1, pnlPer100: 220 });

    const route = buildRouteGranularDailySnapshot({
      tradeDate: "2026-10-13",
      candidates: [currentCandidate],
      candidateTrades: [{ candidateId: 200, completed: true, pnl: 120, shares: 100 }] as any,
      shadowEvents: [],
      shadowTrades: [bTrade],
    });
    expect(route.plans.find(item => item.symbol === "9984" && item.candidateRouteId === "softbankBreakoutLong")).toMatchObject({ role: "current", signals: 1, completedTrades: 1, pnlPer100: 120 });
    expect(route.plans.find(item => item.strategyVersion === SOFTBANK_RR2_PROTECT_VERSION)).toMatchObject({ role: "shadow", signals: 0, completedTrades: 1, pnlPer100: 220 });
  });

  it("keeps the route catalog complete with exactly one 9984 Current owner", () => {
    const audit = auditRouteGranularCatalog();
    expect(audit).toMatchObject({ complete: true, requirementMissing: [], duplicateSelectableRows: [] });
    for (const symbol of ["3436", "6976"]) {
      const demoted = ROUTE_GRANULAR_VARIANTS.filter(item => item.symbol === symbol && item.role === "shadow" && item.origin === "current");
      expect(demoted).toHaveLength(1);
      expect(demoted[0]?.lifecycleRequirement).toBe("monitoring_display_only");
    }
    const softbankCurrent = ROUTE_GRANULAR_VARIANTS.filter(item => item.symbol === "9984" && item.routeGroupId === "breakout_long" && item.role === "current");
    expect(softbankCurrent).toHaveLength(1);
    expect(softbankCurrent[0]).toMatchObject({ origin: "current", candidateRouteId: "softbankBreakoutLong", lifecycleRequirement: "current_candidate_ledger" });
    expect(ROUTE_GRANULAR_VARIANTS.find(item => item.strategyVersion === SOFTBANK_RR2_PROTECT_VERSION)).toMatchObject({ role: "shadow", lifecycleRequirement: "monitoring_candidate" });
  });
});
