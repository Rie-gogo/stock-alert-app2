import { describe, expect, it } from "vitest";
import { assertForwardCandidateRiskReward } from "./forwardStrategyRegistration";
import { MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS, TEN_MONITORED_SYMBOLS } from "./multiSymbolMonitoringRegistry";
import { ROUTE_GRANULAR_VARIANTS } from "./routeGranularMonitoringRegistry";
import { TECHNICAL_REGIME_SHADOW_A_VERSIONS } from "./runtimeIdentity";

describe("technical-regime A registration", () => {
  it("動的な技術的TP/SLは専用の手動監視例外だけを許可する", () => {
    expect(() => assertForwardCandidateRiskReward({
      versionId: TECHNICAL_REGIME_SHADOW_A_VERSIONS["285A"],
      evaluationPurpose: "candidate",
      eligibleForAdoption: true,
      configJson: { riskRewardPolicy: { mode: "dynamic_technical_levels", minimumRewardRisk: 1.2, exception: "user_approved_dynamic_technical_levels_2026-10-02", automaticAdoption: false } },
    })).not.toThrow();
    expect(() => assertForwardCandidateRiskReward({
      versionId: "candidate-other-technical-regime-a-v1",
      evaluationPurpose: "candidate",
      eligibleForAdoption: true,
      configJson: { riskRewardPolicy: { mode: "dynamic_technical_levels", minimumRewardRisk: 1.2, exception: "user_approved_dynamic_technical_levels_2026-10-02", automaticAdoption: false } },
    })).toThrow("candidate_risk_reward_missing");
  });

  it("10銘柄すべてを最近傾向へ1案、経路別へLONG/SHORT各1行登録する", () => {
    for (const symbol of TEN_MONITORED_SYMBOLS) {
      const version = TECHNICAL_REGIME_SHADOW_A_VERSIONS[symbol as keyof typeof TECHNICAL_REGIME_SHADOW_A_VERSIONS];
      expect(MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(plan => plan.symbol === symbol && plan.strategyVersion === version)).toHaveLength(1);
      expect(ROUTE_GRANULAR_VARIANTS.filter(row => row.symbol === symbol && row.strategyVersion === version)).toHaveLength(2);
    }
  });
});
