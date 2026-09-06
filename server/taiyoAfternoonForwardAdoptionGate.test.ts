import { describe, expect, it } from "vitest";
import {
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
} from "./runtimeIdentity";
import {
  applyTaiyoAfternoonAdoptionGate,
  resolveTaiyoAfternoonAdoptionGate,
} from "./taiyoAfternoonForwardAdoptionGate";

describe("6976 afternoon short adoption gate", () => {
  it("keeps historical selection evidence outside formal performance", () => {
    const rr2 = resolveTaiyoAfternoonAdoptionGate(TAIYO_AFTERNOON_RR2_VERSION);
    expect(rr2).toMatchObject({
      applicable: true,
      strategyVariant: "rr2_exit",
      eligibleForAdoption: true,
      historicalSelection: {
        fixedThroughDate: "2026-09-04",
        savedDays: 51,
        selectionTradeCount: 8,
        selectionWinRatePct: 87.5,
        formalPerformanceUsable: false,
        role: "exit_structure_candidate",
      },
    });
    const depth = resolveTaiyoAfternoonAdoptionGate(TAIYO_AFTERNOON_DEPTH_VERSION);
    expect(depth).toMatchObject({
      strategyVariant: "depth_execution",
      historicalSelection: {
        depthReplayDays: 2,
        selectionTradeCount: 0,
        selectionWinRatePct: null,
        formalPerformanceUsable: false,
        depthCoverage: "insufficient_for_historical_performance",
      },
    });
  });

  it("requires the manual 8.91m portfolio comparison after common eligibility", () => {
    const decision = { status: "eligible", reason: "criteria_met", days: 28 };
    expect(applyTaiyoAfternoonAdoptionGate(decision, resolveTaiyoAfternoonAdoptionGate(TAIYO_AFTERNOON_RR2_VERSION)))
      .toMatchObject({ status: "interim_continue", reason: "taiyo_afternoon_891m_manual_comparison_required" });
  });

  it("is not applicable to other strategies", () => {
    expect(resolveTaiyoAfternoonAdoptionGate("other")).toMatchObject({ applicable: false, eligibleForAdoption: null });
  });
});
