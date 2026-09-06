import { describe, expect, it } from "vitest";
import {
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
} from "./runtimeIdentity";
import {
  applySocionextAdoptionGate,
  resolveSocionextAdoptionGate,
} from "./socionextForwardAdoptionGate";

describe("6526 A/B adoption gate", () => {
  it("Aは最新51日68.75%の診断候補として採用不可を固定する", () => {
    const gate = resolveSocionextAdoptionGate(SOCIONEXT_INITIAL_STRENGTH_VERSION);
    expect(gate).toMatchObject({
      applicable: true,
      strategyVariant: "initial_strength",
      eligibleForAdoption: false,
      historicalSelection: {
        fixedThroughDate: "2026-09-04",
        fixedSavedDays: 51,
        winRatePct: 68.75,
        passedMinimumWinRate: false,
        role: "diagnostic_candidate",
      },
    });
    expect(applySocionextAdoptionGate({ status: "eligible", reason: "all_thresholds_passed", days: 28 }, gate))
      .toMatchObject({ status: "interim_continue", reason: "socionext_diagnostic_manual_reclassification_required" });
  });

  it("Bは最新51日73.33%の採用審査候補だが891万円比較を手動必須にする", () => {
    const gate = resolveSocionextAdoptionGate(SOCIONEXT_CONFIRM_STRENGTH_VERSION);
    expect(gate).toMatchObject({
      applicable: true,
      strategyVariant: "confirmation_strength",
      eligibleForAdoption: true,
      historicalSelection: { passedMinimumWinRate: true, role: "adoption_review_candidate" },
      portfolioGate: { status: "manual_comparison_required", automaticAdoption: false },
    });
    expect(applySocionextAdoptionGate({ status: "eligible", reason: "all_thresholds_passed", days: 28 }, gate))
      .toMatchObject({ status: "interim_continue", reason: "socionext_891m_manual_comparison_required" });
  });
});
