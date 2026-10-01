import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyKioxiaCurrentReversalLongExactTransition, emptyKioxiaCurrentReversalLongExactState } from "./kioxiaCurrentReversalLongExact";
import { applySocionextConfirmedLongExactReopenTransition, createEmptySocionextForwardState } from "./socionextForwardShadow";
import {
  KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION,
  KIOXIA_REVERSAL_LONG_REOPEN_VERSION,
  SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION,
} from "./runtimeIdentity";
import { ROUTE_GRANULAR_VARIANTS } from "./routeGranularMonitoringRegistry";

describe("exact-current monitoring reopening isolation", () => {
  it("285A exact reopening owns a fresh state and preserves the old current route identity", () => {
    const oldState = emptyKioxiaCurrentReversalLongExactState();
    oldState.tradeDate = "2026-10-01";
    oldState.dailySlotConsumed = true;
    const transition = applyKioxiaCurrentReversalLongExactTransition(oldState, {
      sourceEventId: "reopen:1", candle: { symbol: "285A", tradeDate: "2026-10-02", candleTime: "09:31", open: 100, high: 101, low: 99, close: 100, volume: 100 }, board: null,
    }, "signal_quality");
    expect(transition.nextState.tradeDate).toBe("2026-10-02");
    expect(transition.nextState.dailySlotConsumed).toBe(false);
    expect(oldState.tradeDate).toBe("2026-10-01");
  });

  it("6526 exact reopening uses a distinct confirmed-long state variant", () => {
    const oldState = createEmptySocionextForwardState("initial_strength");
    const transition = applySocionextConfirmedLongExactReopenTransition(oldState, {
      sourceEventId: "reopen:1", candle: { symbol: "6526", tradeDate: "2026-10-02", candleTime: "09:20", open: 100, high: 100.1, low: 99.9, close: 100, volume: 1 }, board: null,
    }, "signal_quality");
    expect(transition.nextState.variant).toBe("confirmed_long_exact_reopen");
    expect(oldState.variant).toBe("initial_strength");
  });

  it("exact reopening engines remain DRY_RUN forward-shadow-only", () => {
    const kioxia = readFileSync(new URL("./kioxiaCurrentReversalLongExactEngine.ts", import.meta.url), "utf8");
    const socionext = readFileSync(new URL("./socionextForwardShadowEngine.ts", import.meta.url), "utf8");
    expect(kioxia).toContain("KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION");
    expect(socionext).toContain("SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION");
    for (const source of [kioxia, socionext]) {
      expect(source).not.toContain("./orderBridge");
      expect(source).not.toContain("insertRtTrade(");
      expect(source).toContain("insertRtForwardShadowTrade");
    }
  });

  it("quarantines the two incorrect mappings and exposes only exact versions as selectable reopens", () => {
    const invalid = ROUTE_GRANULAR_VARIANTS.filter(row => row.lifecycleRequirement === "invalid_mapping");
    expect(invalid.map(row => row.strategyVersion).sort()).toEqual([KIOXIA_REVERSAL_LONG_REOPEN_VERSION, SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION].sort());
    const exact = ROUTE_GRANULAR_VARIANTS.filter(row => row.strategyVersion === KIOXIA_REVERSAL_LONG_EXACT_REOPEN_VERSION || row.strategyVersion === SOCIONEXT_CONFIRMED_LONG_EXACT_REOPEN_VERSION);
    expect(exact.map(row => row.canonicalLogic).sort()).toEqual([
      "candidate-285a-current-reversal-long-exact-monitoring-reopen",
      "candidate-6526-confirmed-long-exact-monitoring-reopen",
    ]);
    expect(exact.every(row => row.lifecycleRequirement === "monitoring_candidate")).toBe(true);
  });
});
