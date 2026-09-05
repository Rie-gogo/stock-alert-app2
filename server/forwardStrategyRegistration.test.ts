import { describe, expect, it } from "vitest";
import { assertForwardCandidateRiskReward } from "./forwardStrategyRegistration";
import { SOFTBANK_DEPTH_CONFIRM_SPEC, SOFTBANK_RR2_PROTECT_SPEC } from "./softbankForwardShadow";
import { TAIYO_BOARD_DEMAND_SPEC, TAIYO_RR2_PROTECT_SPEC } from "./taiyoForwardShadow";
import {
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
} from "./runtimeIdentity";

describe("前向きcandidate登録Gate", () => {
  it("9984 A/Bは実装specの全SL/TP組で2R登録Gateを通過する", () => {
    expect(assertForwardCandidateRiskReward({
      versionId: SOFTBANK_DEPTH_CONFIRM_VERSION,
      configJson: SOFTBANK_DEPTH_CONFIRM_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.4, tpPct: 0.8 }]);
    expect(assertForwardCandidateRiskReward({
      versionId: SOFTBANK_RR2_PROTECT_VERSION,
      configJson: SOFTBANK_RR2_PROTECT_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.5, tpPct: 1 }]);
  });

  it("6976 A/Bは実装specの全SL/TP組で2R登録Gateを通過する", () => {
    expect(assertForwardCandidateRiskReward({
      versionId: TAIYO_BOARD_DEMAND_VERSION,
      configJson: TAIYO_BOARD_DEMAND_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.5, tpPct: 1 }]);
    expect(assertForwardCandidateRiskReward({
      versionId: TAIYO_RR2_PROTECT_VERSION,
      configJson: TAIYO_RR2_PROTECT_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.8, tpPct: 1.6 }]);
  });

  it("TPがSLの2倍以上なら登録可能", () => {
    expect(assertForwardCandidateRiskReward({
      versionId: "candidate-ok",
      configJson: { route: { slPct: 0.6, tpPct: 1.2 } },
    })).toHaveLength(1);
  });

  it("TPがSLの2倍未満ならcandidate登録を拒否", () => {
    expect(() => assertForwardCandidateRiskReward({
      versionId: "candidate-ng",
      configJson: { route: { slPct: 0.8, tpPct: 0.7 } },
    })).toThrow("candidate_risk_reward_below_2x:candidate-ng");
  });

  it("parity監査版は採用Gateの対象外", () => {
    expect(assertForwardCandidateRiskReward({
      versionId: "parity",
      evaluationPurpose: "parity_only",
      eligibleForAdoption: false,
      configJson: {},
    })).toEqual([]);
  });
});
