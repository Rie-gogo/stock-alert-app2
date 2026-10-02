import { describe, expect, it } from "vitest";
import {
  TEN_SYMBOL_SELECTOR_SLOTS,
  buildTenSymbolSelectorResult,
  buildTenSymbolSelectorSnapshot,
  selectNextPendingTenSymbolFeatureDate,
} from "./tenSymbolNextDaySelector";

function featureRow(tradeDate: string, symbol = "285A", eligible = true) {
  return {
    tradeDate,
    status: "complete",
    resultJson: {
      inputHash: `feature:${tradeDate}`,
      featuresBySymbol: Object.fromEntries(["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"].map(item => [item, {
        featureEligible: item === symbol ? eligible : false,
        features: {},
        regime: { full: "up|normal|upper", trend: "up", volatility: "normal", location: "upper" },
      }])),
    },
  } as any;
}
function dailyRow(tradeDate: string, planId: string, pnlPer100: number, completedTrades = 1) {
  return {
    tradeDate,
    status: "complete",
    resultJson: {
      ready: true,
      plans: [{ planId, signals: completedTrades, completedTrades, openTrades: 0, wins: pnlPer100 > 0 ? completedTrades : 0, losses: pnlPer100 < 0 ? completedTrades : 0, draws: 0, pnlPer100, grossProfitPer100: Math.max(0, pnlPer100), grossLossPer100: Math.max(0, -pnlPer100) }],
    },
  } as any;
}

const activeLifecycle = Object.fromEntries(TEN_SYMBOL_SELECTOR_SLOTS
  .filter(slot => slot.strategyVersion && slot.lifecycleRequirement === "monitoring_candidate")
  .map(slot => [slot.strategyVersion!, { lifecycle: "monitoring", purpose: "candidate" }]));

describe("10銘柄翌日選択器の固定運用契約", () => {
  it("閉場済みfeatureは最古の未処理日を一日だけ選び、不完全確定済みを再走査しない", () => {
    expect(selectNextPendingTenSymbolFeatureDate({
      requestedTradeDate: "2026-10-05",
      closedDates: ["2026-10-05", "2026-10-02", "2026-10-01"],
      existingRows: [
        { tradeDate: "2026-10-01", status: "complete" },
        { tradeDate: "2026-10-02", status: "incomplete_source" },
      ],
    })).toBe("2026-10-05");
    expect(selectNextPendingTenSymbolFeatureDate({
      requestedTradeDate: "2026-10-05",
      closedDates: ["2026-10-05", "2026-10-02", "2026-10-01"],
      existingRows: [{ tradeDate: "2026-10-01", status: "complete" }],
    })).toBe("2026-10-02");
  });

  it("Current/A/Bを10銘柄×3行で固定し、停止版や診断版を候補に混ぜない", () => {
    expect(TEN_SYMBOL_SELECTOR_SLOTS).toHaveLength(30);
    expect(TEN_SYMBOL_SELECTOR_SLOTS.filter(slot => slot.slot === "Current")).toHaveLength(10);
    expect(TEN_SYMBOL_SELECTOR_SLOTS.filter(slot => slot.origin === "unavailable").map(slot => `${slot.symbol}:${slot.slot}`)).toEqual(["5803:B", "6526:A"]);
    expect(TEN_SYMBOL_SELECTOR_SLOTS.filter(slot => slot.symbol === "6857").map(slot => slot.origin)).toEqual(["current", "forward_shadow", "forward_shadow"]);
    expect(TEN_SYMBOL_SELECTOR_SLOTS.filter(slot => slot.symbol === "6981").map(slot => slot.origin)).toEqual(["current", "forward_shadow", "forward_shadow"]);
    const versions = TEN_SYMBOL_SELECTOR_SLOTS.map(slot => slot.strategyVersion).filter(Boolean).join("\n");
    expect(versions).not.toContain("candidate-5803-morning-20bar-breakdown-short-depth-v1");
    expect(versions).not.toContain("candidate-8035-executable-depth-v2");
    expect(versions).not.toContain("baseline-6146-opening-short-paused-v1");
  });

  it("data cutoffより後のfeature/daily rowを選択scoreに使わず、immutable hashへも混ぜない", () => {
    const slot = TEN_SYMBOL_SELECTOR_SLOTS.find(item => item.symbol === "285A" && item.slot === "A")!;
    const history = Array.from({ length: 20 }, (_, index) => {
      const day = `2026-10-${String(index + 1).padStart(2, "0")}`;
      return dailyRow(day, slot.planId, 200);
    });
    const features = Array.from({ length: 20 }, (_, index) => featureRow(`2026-10-${String(index + 1).padStart(2, "0")}`));
    const cutoff = "2026-10-20";
    const snapshot = buildTenSymbolSelectorSnapshot({
      sourceTradeDate: cutoff,
      feature: features.at(-1)!,
      featureRows: [...features, featureRow("2026-10-21")],
      dailyRows: [...history, dailyRow("2026-10-21", slot.planId, -999_999)],
      lifecycleByVersion: activeLifecycle,
      watermark: { source: { count: 1 } },
    });
    const withoutFuture = buildTenSymbolSelectorSnapshot({
      sourceTradeDate: cutoff,
      feature: features.at(-1)!,
      featureRows: features,
      dailyRows: history,
      lifecycleByVersion: activeLifecycle,
      watermark: { source: { count: 1 } },
    });
    const score = snapshot.scores.find((item: any) => item.planId === slot.planId)!;
    expect(score.eligibleDays).toBe(20);
    expect(score.completedTrades).toBe(20);
    expect(score.expectedDailyPnlPer100).toBeGreaterThan(0);
    expect(snapshot.targetDate).toBe("2026-10-21");
    expect(snapshot.inputHash).toBe(withoutFuture.inputHash);
  });

  it("feature/provenance不足なら全銘柄をfail-closedのno_selectionにする", () => {
    const feature = featureRow("2026-10-20", "285A", false);
    const snapshot = buildTenSymbolSelectorSnapshot({
      sourceTradeDate: "2026-10-20",
      feature,
      featureRows: [feature],
      dailyRows: [],
      lifecycleByVersion: activeLifecycle,
      watermark: {},
    });
    expect(snapshot.selections).toHaveLength(10);
    expect(snapshot.selections.every((item: any) => item.decision === "no_selection")).toBe(true);
    expect(snapshot.selections.find((item: any) => item.symbol === "285A")).toMatchObject({ reason: "feature_or_provenance_unavailable" });
  });

  it("結果はD-1に固定済みplanとfixed Current/A/Bを同じD snapshotへ結合し、再選択しない", () => {
    const selected = { selections: [{ symbol: "285A", selectedPlanId: "current:285A", decision: "reference_only" }] };
    const result = buildTenSymbolSelectorResult({ tradeDate: "2026-10-21", snapshot: selected, daily: dailyRow("2026-10-21", "current:285A", 100) });
    const row = result.results.find((item: any) => item.symbol === "285A")!;
    expect(row.selected).toMatchObject({ planId: "current:285A", outcome: "observed", pnlPer100: 100 });
    expect(row.fixed).toHaveLength(3);
  });

  it("通常取引・注文・hot pathへ接続しない", async () => {
    const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("./tenSymbolNextDaySelector.ts", import.meta.url), "utf8"));
    expect(source).not.toContain("./realtimeSimEngine");
    expect(source).not.toContain("./sourceEventIngestion");
    expect(source).not.toContain("./forwardShadowSequence");
    expect(source).not.toContain("./orderBridge");
    expect(source).not.toContain("insertRtTrade(");
    expect(source).not.toContain("orderInstructions");
  });
});
