import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FORWARD_REPLAY_DEFINITIONS } from "./forwardReplayMaterializer";
import {
  MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS,
  TEN_MONITORED_SYMBOLS,
} from "./multiSymbolMonitoringRegistry";
import {
  auditRouteGranularCatalog,
  ROUTE_GRANULAR_VARIANTS,
} from "./routeGranularMonitoringRegistry";
import {
  FORWARD_STRATEGY_VERSIONS,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
} from "./runtimeIdentity";
import {
  RETIRED_SIX_SHADOW_VERSIONS,
  RETIRED_TAIYO_AFTERNOON_DEPTH_VERSION,
  RETIRED_TAIYO_AFTERNOON_LONG_RR2_VERSION,
  RETIRED_TAIYO_AFTERNOON_RR2_VERSION,
  RETIRED_TEL_EXECUTABLE_DEPTH_VERSION,
} from "./retiredSixStrategies";
import { TEN_SYMBOL_SELECTOR_SLOTS } from "./tenSymbolNextDaySelector";

const retired = new Set<string>(RETIRED_SIX_SHADOW_VERSIONS);
const retiredStoppedCurrent = new Set([
  "current-5803-afternoon-low-break-short",
  "current-6981-opening-break-short",
]);

describe("six-logic retirement contract", () => {
  it("excludes all four shadow versions from active dispatch, replay, summaries, selectors, and route catalog", () => {
    expect(FORWARD_STRATEGY_VERSIONS.filter(version => retired.has(version))).toEqual([]);
    expect(FORWARD_REPLAY_DEFINITIONS.filter(item => retired.has(item.version))).toEqual([]);
    expect(
      MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(
        item => retired.has(item.strategyVersion),
      ),
    ).toEqual([]);
    expect(
      ROUTE_GRANULAR_VARIANTS.filter(item => retired.has(item.strategyVersion ?? "")),
    ).toEqual([]);
    expect(
      TEN_SYMBOL_SELECTOR_SLOTS.filter(item => retired.has(item.strategyVersion ?? "")),
    ).toEqual([]);
  });

  it("removes the two stopped-current routes from public comparison/catalog contracts without changing the frozen engine", () => {
    expect(
      ROUTE_GRANULAR_VARIANTS.filter(item => retiredStoppedCurrent.has(item.canonicalLogic ?? "")),
    ).toEqual([]);
    expect(
      ROUTE_GRANULAR_VARIANTS.filter(item => ["afternoonLowBreakShort", "openingBreakShort"].includes(item.candidateRouteId ?? "")),
    ).toEqual([]);
    expect(auditRouteGranularCatalog()).toMatchObject({
      complete: true,
      requirementMissing: [],
      duplicateSelectableRows: [],
      invalidMappedSelectableRows: [],
    });
  });

  it("keeps the 6976 recovery-winrate LONG B and all five Bollinger variants per symbol", () => {
    expect(FORWARD_STRATEGY_VERSIONS).toContain(TAIYO_AFTERNOON_LONG_WINRATE_VERSION);
    expect(
      MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.some(
        item => item.strategyVersion === TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
      ),
    ).toBe(true);
    for (const symbol of TEN_MONITORED_SYMBOLS) {
      const bollinger = MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(
        item => item.symbol === symbol && item.strategyVersion.includes("bollinger-directional-"),
      );
      expect(bollinger).toHaveLength(5);
      expect(new Set(bollinger.map(item => item.strategyVersion)).size).toBe(5);
    }
  });

  it("retains legacy-only identifiers only in isolated historical modules and excludes them from v4 production source", async () => {
    const marketContext = await readFile(
      new URL("./marketContextPerformanceSelector.ts", import.meta.url),
      "utf8",
    );
    const dispatcher = await readFile(new URL("./forwardShadow.ts", import.meta.url), "utf8");
    const router = await readFile(new URL("./routers/trading.ts", import.meta.url), "utf8");
    const names = [
      RETIRED_TEL_EXECUTABLE_DEPTH_VERSION,
      RETIRED_TAIYO_AFTERNOON_RR2_VERSION,
      RETIRED_TAIYO_AFTERNOON_DEPTH_VERSION,
      RETIRED_TAIYO_AFTERNOON_LONG_RR2_VERSION,
      ...retiredStoppedCurrent,
    ];
    for (const id of names) {
      expect(marketContext).not.toContain(id);
      expect(dispatcher).not.toContain(id);
      expect(router).not.toContain(id);
    }
  });
});
