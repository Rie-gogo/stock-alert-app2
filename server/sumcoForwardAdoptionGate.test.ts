import { describe, expect, it } from "vitest";
import { SUMCO_TIME_15_VERSION, SUMCO_VOLUME_110_VERSION } from "./runtimeIdentity";
import { applySumcoAdoptionGate, resolveSumcoAdoptionGate } from "./sumcoForwardAdoptionGate";

describe("3436 dedicated forward adoption gate", () => {
  it("VOLUME110を入口品質候補として34日76%・既知欠損付きで表示する", () => {
    expect(resolveSumcoAdoptionGate(SUMCO_VOLUME_110_VERSION)).toMatchObject({
      applicable: true,
      strategyVariant: "volume_110",
      eligibleForAdoption: true,
      historicalSelection: {
        fixedThroughDate: "2026-09-04",
        baselineSavedDays: 29,
        supplementSavedDays: 5,
        selectionSavedDays: 34,
        winRatePct: 76,
        passedMinimumWinRate: true,
        supplementHasKnownGap: true,
        role: "entry_quality_candidate",
      },
    });
  });

  it("TIME15を出口時間候補として34日73.08%で表示する", () => {
    expect(resolveSumcoAdoptionGate(SUMCO_TIME_15_VERSION)).toMatchObject({
      applicable: true,
      strategyVariant: "time_15",
      eligibleForAdoption: true,
      historicalSelection: {
        winRatePct: 73.07692307692308,
        passedMinimumWinRate: true,
        role: "exit_timing_candidate",
      },
    });
  });

  it("通常Gate通過後も891万円比較が終わるまで自動採用しない", () => {
    const gate = resolveSumcoAdoptionGate(SUMCO_VOLUME_110_VERSION);
    expect(applySumcoAdoptionGate({ status: "eligible", reason: "thresholds_met", days: 28 }, gate))
      .toEqual({ status: "interim_continue", reason: "sumco_891m_manual_comparison_required", days: 28 });
  });

  it("対象外versionへ適用しない", () => {
    expect(resolveSumcoAdoptionGate("other").applicable).toBe(false);
  });
});
