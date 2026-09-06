import { describe, expect, it } from "vitest";
import {
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  getRuntimeIdentity,
} from "./runtimeIdentity";

describe("本番稼働版自己証明", () => {
  it("f6878060売買ロジック、10銘柄、DRY_RUN限定を自己表示する", () => {
    const identity = getRuntimeIdentity();
    expect(identity.baselineStrategyGitSha).toBe(BASELINE_STRATEGY_GIT_SHA);
    expect(identity.tradingLogicMatchesBaseline).toBe(true);
    expect(identity.activeEntrySymbols).toEqual([
      "285A", "3436", "5803", "6146", "6526",
      "6857", "6976", "6981", "8035", "9984",
    ]);
    expect(identity.dryRunRequired).toBe(true);
    expect(identity.liveOrderApproved).toBe(false);
    expect(identity.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.runtimeBuildIdentifier).not.toBe("unavailable");
  });

  it("合意した2週間・20件・4週間10件・最大8週間基準を固定する", () => {
    expect(FORWARD_EVALUATION_POLICY).toMatchObject({
      interimCalendarDays: 14,
      minimumCalendarDaysForSignalCountDecision: 14,
      minimumSignalsForEarlyDecision: 20,
      calendarDaysForTimeDecision: 28,
      minimumSignalsForTimeDecision: 10,
      maximumCalendarDays: 56,
      minimumObservedWinRatePct: 70,
      adverseExitPct: 0.1,
    });
  });

  it("既存の長い5803版を変更せず、全候補・監査versionをDB上限128文字以内に保つ", () => {
    const identity = getRuntimeIdentity();
    const versions = [...identity.strategyVersions, ...identity.auditStrategyVersions];
    expect(identity.strategyVersions).toEqual(expect.arrayContaining([
      SOFTBANK_DEPTH_CONFIRM_VERSION,
      SOFTBANK_RR2_PROTECT_VERSION,
      TAIYO_BOARD_DEMAND_VERSION,
      TAIYO_RR2_PROTECT_VERSION,
      SOCIONEXT_INITIAL_STRENGTH_VERSION,
      SOCIONEXT_CONFIRM_STRENGTH_VERSION,
    ]));
    expect(versions.some(version => version.length > 64)).toBe(true);
    expect(versions.every(version => version.length <= 128)).toBe(true);
  });
});
