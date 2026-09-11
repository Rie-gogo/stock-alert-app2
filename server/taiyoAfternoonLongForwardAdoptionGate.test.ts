import { describe, expect, it } from "vitest";
import {
  TAIYO_AFTERNOON_LONG_RR2_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
} from "./runtimeIdentity";
import {
  applyTaiyoAfternoonLongAdoptionGate,
  resolveTaiyoAfternoonLongAdoptionGate,
} from "./taiyoAfternoonLongForwardAdoptionGate";

describe("6976 afternoon long adoption gate", () => {
  it("Aを診断専用、Bを891万円手動比較必須として固定する", () => {
    expect(resolveTaiyoAfternoonLongAdoptionGate(TAIYO_AFTERNOON_LONG_RR2_VERSION)).toMatchObject({
      strategyVariant: "rr2_10",
      eligibleForAdoption: false,
      historicalSelection: { fixedThroughDate: "2026-09-11", savedTradeCount: 17, adverseExecutionStatus: "failed" },
      portfolioGate: { status: "diagnostic_only", automaticAdoption: false },
    });
    expect(resolveTaiyoAfternoonLongAdoptionGate(TAIYO_AFTERNOON_LONG_WINRATE_VERSION)).toMatchObject({
      strategyVariant: "recovery_winrate",
      eligibleForAdoption: true,
      historicalSelection: { savedTradeCount: 33, savedWinRatePct: 81.82, adverseExecutionStatus: "fragile" },
      portfolioGate: { status: "manual_comparison_required", automaticAdoption: false },
    });
  });

  it("共通条件を満たしてもBを自動採用せず手動portfolio比較へ止める", () => {
    const decision = { status: "eligible", reason: "criteria_met", days: 28 };
    expect(applyTaiyoAfternoonLongAdoptionGate(
      decision,
      resolveTaiyoAfternoonLongAdoptionGate(TAIYO_AFTERNOON_LONG_WINRATE_VERSION),
    )).toMatchObject({ status: "interim_continue", reason: "taiyo_afternoon_long_891m_manual_comparison_required" });
  });
});
