import { describe, expect, it } from "vitest";
import { bollingerDirectionalLifecycleStrategyId, bollingerDirectionalStrategyVersion } from "./bollingerDirectionalShadowEngine";
import { assertForwardCandidateRiskReward } from "./forwardStrategyRegistration";
import { MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS, TEN_MONITORED_SYMBOLS } from "./multiSymbolMonitoringRegistry";
import { ROUTE_GRANULAR_VARIANTS } from "./routeGranularMonitoringRegistry";
import {
  BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS,
  BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI22LONG_GAP_060_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_GAP_060_VERSIONS,
  BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS,
  FORWARD_STRATEGY_VERSIONS,
  RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_VERSIONS,
  RETIRED_TECHNICAL_REGIME_SHADOW_A_VERSIONS,
} from "./runtimeIdentity";

describe("Bollinger directional shadow registration", () => {
  it("3variantを同じ銘柄の独立versionへ写像する", () => {
    expect(bollingerDirectionalStrategyVersion("285A", "fixed_stop_140_cooldown_30")).toBe(BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS["285A"]);
    expect(bollingerDirectionalStrategyVersion("285A", "fixed_stop_140_cooldown_30_sma20_dynamic_rsi22long_gap060")).toBe(BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI22LONG_GAP_060_VERSIONS["285A"]);
    expect(bollingerDirectionalStrategyVersion("285A", "fixed_stop_140_cooldown_30_sma10_slope_gap050")).toBe(BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_VERSIONS["285A"]);
  });
  it("SMA20 RSI後継版は完全versionIdを保ちつつlifecycle strategyIdを64文字内へ短縮する", () => {
    const strategyId = bollingerDirectionalLifecycleStrategyId("9984", "fixed_stop_140_cooldown_30_sma20_dynamic_rsi22long_gap060");
    expect(strategyId).toBe("9984-bb-sma20-rsi22long-v2");
    expect(strategyId.length).toBeLessThanOrEqual(64);
  });
  it("入口時固定の反対側2σ targetは専用の手動監視例外だけを許可する", () => {
    expect(() => assertForwardCandidateRiskReward({
      versionId: BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS["285A"],
      evaluationPurpose: "candidate",
      eligibleForAdoption: false,
      configJson: { riskRewardPolicy: { mode: "fixed_entry_bollinger_opposite_band", exception: "user_approved_bollinger_directional_shadow_2026-10-06", automaticAdoption: false } },
    })).not.toThrow();
    expect(() => assertForwardCandidateRiskReward({
      versionId: BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_VERSIONS["285A"],
      evaluationPurpose: "candidate",
      eligibleForAdoption: false,
      configJson: { riskRewardPolicy: { mode: "fixed_entry_bollinger_opposite_band", exception: "user_approved_bollinger_directional_shadow_2026-10-06", automaticAdoption: false } },
    })).not.toThrow();
    expect(() => assertForwardCandidateRiskReward({
      versionId: "candidate-other-bollinger-directional-no-stop-v1",
      evaluationPurpose: "candidate",
      eligibleForAdoption: false,
      configJson: { riskRewardPolicy: { mode: "fixed_entry_bollinger_opposite_band", exception: "user_approved_bollinger_directional_shadow_2026-10-06", automaticAdoption: false } },
    })).toThrow("candidate_risk_reward_missing");
  });

  it("10銘柄すべてを最近傾向へ3案、経路別へ各案LONG/SHORTで登録する", () => {
    for (const symbol of TEN_MONITORED_SYMBOLS) {
      const fixedStop140 = BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS];
      const sma20Gap060 = BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI22LONG_GAP_060_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_RSI22LONG_GAP_060_VERSIONS];
      const sma10SlopeGap050 = BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_VERSIONS];
      for (const strategyVersion of [fixedStop140, sma20Gap060, sma10SlopeGap050]) {
        expect(MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.filter(plan => plan.symbol === symbol
          && plan.strategyVersion === strategyVersion)).toHaveLength(1);
        expect(ROUTE_GRANULAR_VARIANTS.filter(row => row.symbol === symbol && row.strategyVersion === strategyVersion)).toHaveLength(2);
        expect(FORWARD_STRATEGY_VERSIONS).toContain(strategyVersion);
      }
      expect(FORWARD_STRATEGY_VERSIONS).not.toContain(BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_NO_STOP_VERSIONS]);
      expect(FORWARD_STRATEGY_VERSIONS).not.toContain(BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_STOP_060_VERSIONS]);
      expect(FORWARD_STRATEGY_VERSIONS).not.toContain(BOLLINGER_DIRECTIONAL_SMA20_GAP_060_VERSIONS[symbol as keyof typeof BOLLINGER_DIRECTIONAL_SMA20_GAP_060_VERSIONS]);
      expect(FORWARD_STRATEGY_VERSIONS).not.toContain(RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_VERSIONS[symbol as keyof typeof RETIRED_BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_VERSIONS]);
    }
  });

  it("廃止したテクニカルAを実行・最近傾向・経路別のactive一覧へ残さない", () => {
    for (const oldVersion of Object.values(RETIRED_TECHNICAL_REGIME_SHADOW_A_VERSIONS)) {
      expect(FORWARD_STRATEGY_VERSIONS).not.toContain(oldVersion);
      expect(MULTI_SYMBOL_MONITORING_PLAN_DEFINITIONS.some(plan => plan.strategyVersion === oldVersion)).toBe(false);
      expect(ROUTE_GRANULAR_VARIANTS.some(row => row.strategyVersion === oldVersion)).toBe(false);
    }
  });
});
