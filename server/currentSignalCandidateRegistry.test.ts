import { describe, expect, it } from "vitest";
import {
  parseMarginCandidateReason,
  parseRequiredMarginFromReason,
  resolveCurrentRouteSpec,
} from "./currentSignalCandidateRegistry";

describe("現行10銘柄candidate routeレジストリ", () => {
  it("8035主経路を安定routeIdとSL0.6/TP1.2へ正規化する", () => {
    expect(resolveCurrentRouteSpec({
      symbol: "8035",
      side: "long",
      reason: "東京エレクトロン短期ブレイクLONG: 匿名fixture",
      entryCandleTime: "10:05",
    })).toMatchObject({
      routeId: "telShortBreak",
      side: "long",
      slPct: 0.6,
      tpPct: 1.2,
      eligibleNominalRiskReward: true,
    });
  });

  it("証拠金拒否文字列から元signal reasonと候補必要額を分離する", () => {
    const reason = "証拠金不足: 使用中6000000円 + 候補4000000円 > 上限8910000円 (東京エレクトロン短期ブレイクSHORT)";
    expect(parseMarginCandidateReason(reason)).toBe("東京エレクトロン短期ブレイクSHORT");
    expect(parseRequiredMarginFromReason(reason)).toBe(4_000_000);
  });
});
