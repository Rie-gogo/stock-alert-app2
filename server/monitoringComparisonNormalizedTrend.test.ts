import { describe, expect, it } from "vitest";
import {
  buildKioxiaNormalizedComparisonTrend,
  KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS,
} from "./monitoringComparisonNormalizedTrend";
import { MONITORING_COMPARISON_MATERIALIZATION_VERSION } from "./monitoringComparisonMaterializer";

describe("285A normalized comparison trend", () => {
  it("未発火のCurrent・Plan A・Plan B経路も旧版を混ぜず固定行で表示する", () => {
    const result = buildKioxiaNormalizedComparisonTrend({
      asOfDate: "2026-09-29",
      closedTradeDates: ["2026-09-29"],
      materializations: [{
        tradeDate: "2026-09-29",
        status: "complete",
        resultJson: {
          materializationVersion: MONITORING_COMPARISON_MATERIALIZATION_VERSION,
          entries: [],
        },
      }] as any,
    });

    expect(result.plans).toHaveLength(KIOXIA_NORMALIZED_COMPARISON_PLAN_SPECS.length);
    expect(result.plans.filter(plan => plan.origin === "current_baseline")).toHaveLength(5);
    expect(result.plans.filter(plan => plan.strategyVersion.includes("five-routes"))).toHaveLength(5);
    expect(result.plans.every(plan => plan.intrinsic.all.signals === 0)).toBe(true);
    expect(result.plans.every(plan => plan.reviewStatus === "preliminary")).toBe(true);
    expect(result.plans.some(plan => plan.strategyVersion.includes("v2"))).toBe(false);
  });
});
