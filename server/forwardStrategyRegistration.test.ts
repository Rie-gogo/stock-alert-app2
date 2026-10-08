import { describe, expect, it } from "vitest";
import { assertForwardCandidateRiskReward } from "./forwardStrategyRegistration";
import { SOFTBANK_DEPTH_CONFIRM_SPEC, SOFTBANK_RR2_PROTECT_SPEC } from "./softbankForwardShadow";
import { TAIYO_BOARD_DEMAND_SPEC, TAIYO_RR2_PROTECT_SPEC } from "./taiyoForwardShadow";
import { SOCIONEXT_CONFIRM_STRENGTH_SPEC, SOCIONEXT_INITIAL_STRENGTH_SPEC } from "./socionextForwardShadow";
import { SUMCO_TIME_15_SPEC, SUMCO_VOLUME_110_SPEC } from "./sumcoForwardShadow";
import { TAIYO_AFTERNOON_DEPTH_SPEC, TAIYO_AFTERNOON_RR2_SPEC } from "./taiyoAfternoonForwardShadow";
import { TAIYO_AFTERNOON_LONG_RR2_SPEC, TAIYO_AFTERNOON_LONG_WINRATE_SPEC } from "./taiyoAfternoonLongForwardShadow";
import {
  BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V2_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V4_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V2_VERSIONS,
  BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V2_VERSIONS,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_LONG_RR2_VERSION,
  TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
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

  it("6976後場SHORT A/Bは実装specの全SL/TP組で2R登録Gateを通過する", () => {
    expect(assertForwardCandidateRiskReward({
      versionId: TAIYO_AFTERNOON_RR2_VERSION,
      configJson: TAIYO_AFTERNOON_RR2_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.8, tpPct: 1.6 }]);
    expect(assertForwardCandidateRiskReward({
      versionId: TAIYO_AFTERNOON_DEPTH_VERSION,
      configJson: TAIYO_AFTERNOON_DEPTH_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.8, tpPct: 1.6 }]);
  });

  it("6976後場LONG Aは2Rを通過し、Bだけは明示された自動採用禁止例外を通過する", () => {
    expect(assertForwardCandidateRiskReward({
      versionId: TAIYO_AFTERNOON_LONG_RR2_VERSION,
      configJson: TAIYO_AFTERNOON_LONG_RR2_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.8, tpPct: 1.6 }]);
    expect(assertForwardCandidateRiskReward({
      versionId: TAIYO_AFTERNOON_LONG_WINRATE_VERSION,
      configJson: TAIYO_AFTERNOON_LONG_WINRATE_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 1.2, tpPct: 0.3 }]);
    expect(() => assertForwardCandidateRiskReward({
      versionId: "candidate-copy-of-exception",
      configJson: TAIYO_AFTERNOON_LONG_WINRATE_SPEC,
    })).toThrow("candidate_risk_reward_below_2x:candidate-copy-of-exception");
  });

  it("6526 A/Bは実装specの全SL/TP組で2R登録Gateを通過する", () => {
    expect(assertForwardCandidateRiskReward({
      versionId: SOCIONEXT_INITIAL_STRENGTH_VERSION,
      evaluationPurpose: "candidate",
      eligibleForAdoption: false,
      configJson: SOCIONEXT_INITIAL_STRENGTH_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.25, tpPct: 0.5 }]);
    expect(assertForwardCandidateRiskReward({
      versionId: SOCIONEXT_CONFIRM_STRENGTH_VERSION,
      configJson: SOCIONEXT_CONFIRM_STRENGTH_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.35, tpPct: 0.7 }]);
  });

  it("3436 A/Bは実装specの全SL/TP組で2R登録Gateを通過する", () => {
    expect(assertForwardCandidateRiskReward({
      versionId: SUMCO_VOLUME_110_VERSION,
      configJson: SUMCO_VOLUME_110_SPEC,
    })).toEqual([{ path: "config.exit", slPct: 0.8, tpPct: 1.6 }]);
    expect(assertForwardCandidateRiskReward({
      versionId: SUMCO_TIME_15_VERSION,
      configJson: SUMCO_TIME_15_SPEC,
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

  it("5案のactive Bollinger版だけが固定entry例外を通過し、旧RSI版・未知版・不正policyを拒否する", () => {
    const validConfig = {
      riskRewardPolicy: {
        mode: "fixed_entry_bollinger_opposite_band",
        exception: "user_approved_bollinger_directional_shadow_2026-10-06",
        automaticAdoption: false,
      },
    };
    const activeVersions = [
      ...Object.values(BOLLINGER_DIRECTIONAL_FIXED_STOP_140_VERSIONS),
      ...Object.values(BOLLINGER_DIRECTIONAL_SMA20_DYNAMIC_GAP_060_V4_VERSIONS),
      ...Object.values(BOLLINGER_DIRECTIONAL_SMA20_SLOPE_GAP_060_V2_VERSIONS),
      ...Object.values(BOLLINGER_DIRECTIONAL_SMA20_SLOPE_BBWIDTH5_GAP_060_V2_VERSIONS),
      ...Object.values(BOLLINGER_DIRECTIONAL_SMA10_SLOPE_GAP_050_V2_VERSIONS),
    ];
    expect(activeVersions).toHaveLength(50);
    for (const versionId of activeVersions) expect(assertForwardCandidateRiskReward({ versionId, eligibleForAdoption: false, configJson: validConfig })).toEqual([]);
    expect(() => assertForwardCandidateRiskReward({
      versionId: "candidate-285a-bollinger-directional-sma20-dynamic-rsi22long-gap060-stop140-cooldown30-v2",
      eligibleForAdoption: false,
      configJson: validConfig,
    })).toThrow("candidate_risk_reward_missing");
    expect(() => assertForwardCandidateRiskReward({
      versionId: "candidate-285a-bollinger-directional-sma20-dynamic-rsi22long-gap060-stop140-cooldown30-v2",
      eligibleForAdoption: false,
      configJson: { riskRewardPolicy: { ...validConfig.riskRewardPolicy, automaticAdoption: true } },
    })).toThrow("candidate_risk_reward_missing");
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
