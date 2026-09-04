import { describe, expect, it } from "vitest";
import { assertForwardCandidateRiskReward } from "./forwardStrategyRegistration";

describe("前向きcandidate登録Gate", () => {
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
