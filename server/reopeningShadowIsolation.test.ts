import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyKioxiaReversalLongReopenTransition, emptyKioxiaAtrForwardState } from "./kioxiaAtrForwardShadow";
import { applySocionextInitialStrengthReopenTransition, createEmptySocionextForwardState } from "./socionextForwardShadow";
import { KIOXIA_REVERSAL_LONG_REOPEN_VERSION, SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION } from "./runtimeIdentity";
import { ROUTE_GRANULAR_VARIANTS } from "./routeGranularMonitoringRegistry";

describe("monitoring reopening isolation", () => {
  it("285A reopening force-disables Plan-B sibling routes in its separate state", () => {
    const state = emptyKioxiaAtrForwardState();
    const transition = applyKioxiaReversalLongReopenTransition(state, { sourceEventId: "reopen:1", candle: { symbol: "285A", tradeDate: "2026-10-02", candleTime: "09:31", open: 100, high: 101, low: 99, close: 100, volume: 100 }, board: null }, "signal_quality");
    expect(transition.nextState.routeEnded).toMatchObject({ confirmed_morning_long: true, reversal_short: true, trend_short: true, safe_cb_short: true });
    expect(transition.nextState.routeEnded.reversal_long).toBe(false);
  });

  it("6526 reopening preserves a distinct variant and does not mutate a stopped-v1 state object", () => {
    const stoppedV1 = createEmptySocionextForwardState("initial_strength");
    const transition = applySocionextInitialStrengthReopenTransition(stoppedV1, { sourceEventId: "reopen:1", candle: { symbol: "6526", tradeDate: "2026-10-02", candleTime: "09:20", open: 100, high: 100.1, low: 99.9, close: 100, volume: 1 }, board: null }, "signal_quality");
    expect(transition.nextState.variant).toBe("initial_strength_reopen");
    expect(stoppedV1.variant).toBe("initial_strength");
  });

  it("reopening engines keep DRY_RUN shadow-only boundaries", () => {
    const kioxia = readFileSync(new URL("./kioxiaReversalLongReopenEngine.ts", import.meta.url), "utf8");
    const socionext = readFileSync(new URL("./socionextForwardShadowEngine.ts", import.meta.url), "utf8");
    expect(kioxia).toContain("KIOXIA_REVERSAL_LONG_REOPEN_VERSION");
    expect(socionext).toContain("SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION");
    for (const source of [kioxia, socionext]) {
      expect(source).not.toContain("./orderBridge");
      expect(source).not.toContain("insertRtTrade(");
      expect(source).toContain("insertRtForwardShadowTrade");
    }
  });

  it("reopening rows use new canonical logic identities rather than stopped versions", () => {
    const rows = ROUTE_GRANULAR_VARIANTS.filter(row => row.strategyVersion === KIOXIA_REVERSAL_LONG_REOPEN_VERSION || row.strategyVersion === SOCIONEXT_INITIAL_STRENGTH_REOPEN_VERSION);
    expect(rows.map(row => row.canonicalLogic)).toEqual([
      "candidate-285a-reversal-long-monitoring-reopen",
      "candidate-6526-initial-strength-monitoring-reopen",
    ]);
  });
});
