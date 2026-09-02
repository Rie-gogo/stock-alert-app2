import { describe, expect, it } from "vitest";
import {
  BASELINE_STRATEGY_GIT_SHA,
  FORWARD_EVALUATION_POLICY,
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
});
