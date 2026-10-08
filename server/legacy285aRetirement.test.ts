import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ROUTE_GRANULAR_VARIANTS } from "./routeGranularMonitoringRegistry";
import { sha256Stable } from "./runtimeIdentity";

async function source(relativePath: string) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("legacy 285A selector and comparison retirement", () => {
  it("removes the two legacy cards, their refresh invalidation, and all three retired tRPC procedures", async () => {
    const [page, router] = await Promise.all([
      source("../client/src/pages/RealtimeTradingLog.tsx"),
      source("./routers/trading.ts"),
    ]);
    for (const retired of [
      "KioxiaNormalizedComparisonSection",
      "KioxiaNextDaySelectorSection",
      "getKioxiaMonitoringTrend",
      "getKioxiaNormalizedComparisonTrend",
      "getKioxiaNextDaySelector",
    ]) {
      expect(page).not.toContain(retired);
      expect(router).not.toContain(retired);
    }
  });

  it("does not schedule or report retired 285A-only materializations", async () => {
    const audit = await source("./auditMaterializer.ts");
    for (const retired of [
      "monitoring_comparison_285a",
      "kioxia_manifest_v2",
      "kioxia_next_day_selector_result",
      "kioxia_next_day_selector",
      "materializeMonitoringComparisonForDate",
      "materializeKioxiaManifestV2ForDate",
      "materializeKioxiaNextDaySelectorResultForDate",
      "materializeKioxiaNextDaySelectorForSourceDate",
    ]) {
      expect(audit).not.toContain(retired);
    }
    expect(audit).toContain("TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT");
    expect(audit).toContain("ROUTE_GRANULAR_MONITORING_COMPONENT");
    expect(audit).toContain("MARKET_CONTEXT_PERFORMANCE_COMPONENT");
  });

  it("keeps future safe-CB attribution refreshes away from retired comparison snapshots", async () => {
    const db = await source("./db.ts");
    const activeSet = db.slice(
      db.indexOf("const KIOXIA_SAFE_CB_ACTIVE_SNAPSHOT_VERSIONS"),
      db.indexOf("function isActiveKioxiaSafeCbSnapshot")
    );
    expect(activeSet).toContain("monitoring_trend_10_symbols");
    expect(activeSet).not.toContain("monitoring_comparison_285a");
    const backfill = db.slice(
      db.indexOf("export async function backfillKioxiaSafeCbShortRouteAttribution"),
      db.indexOf("export async function upsertRtSignalCandidateTrade")
    );
    expect(backfill).toContain("tx.update(rtSignalCandidates)");
    expect(backfill).toContain("tx.update(rtSignalCandidateTrades)");
    expect(backfill).toContain("tx.update(rtPortfolioAuditEvents)");
    expect(backfill).not.toContain(".delete(");
  });

  it("keeps route catalog identity and v4 sources independent of retired components", async () => {
    const v4 = await source("./marketContextPerformanceSelector.ts");
    for (const retired of [
      "monitoring_comparison_285a",
      "kioxia_manifest_v2",
      "kioxia_next_day_selector",
    ]) {
      expect(v4).not.toContain(retired);
    }
    const rows = ROUTE_GRANULAR_VARIANTS.map(
      ({ rowId, strategyVersion, direction }) => ({
        rowId,
        strategyVersion,
        direction,
      })
    );
    expect(rows).toHaveLength(157);
    expect(sha256Stable(rows)).toBe(
      "abab14701381c2c9380d8f18c3cbd66c829c28121291a254ea7c803bdb5a8bf3"
    );
  });

  it("does not introduce legacy comparison references into protected trading paths", async () => {
    const sources = await Promise.all([
      source("./realtimeSimEngine.ts"),
      source("./sourceEventIngestion.ts"),
      source("./forwardShadowSequence.ts"),
      source("./orderBridge.ts"),
      source("../shared/stocks.ts"),
    ]);
    for (const text of sources) {
      expect(text).not.toContain("monitoring_comparison_285a");
      expect(text).not.toContain("kioxia_next_day_selector");
    }
  });
});
