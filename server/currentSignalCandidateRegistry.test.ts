import { describe, expect, it } from "vitest";
import {
  parseMarginCandidateReason,
  parseRequiredMarginFromReason,
  resolveCandidateSideFromAuditRoute,
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

  it.each([
    "大台確認(2本維持): 大台割れ (54900円割り込み)｜[信頼度：強] (押し目なし・強トレンド)",
    "大台割れ (54400円割り込み)｜[信頼度：中] (即エントリー: 前足近接)",
    "大台割れ (54400円割り込み)｜[信頼度：強] (即エントリー: vol)",
  ])("既知の証拠金wrapperだけを展開し、完全reason %s を安全CB SHORTへ残す", complete => {
    expect(parseMarginCandidateReason(complete)).toBeNull();
    expect(parseMarginCandidateReason(`証拠金使用率制限: 使用中0円 + 候補5490000円 > 上限8910000円 (${complete})`))
      .toBe(complete);
    expect(parseMarginCandidateReason(`margin_block：（${complete}）`)).toBe(complete);
    expect(resolveCurrentRouteSpec({
      symbol: "285A",
      side: "short",
      reason: complete,
      entryCandleTime: "10:00",
    }).routeId).toBe("kioxiaSafeCbShort");
  });

  it("固定済みaudit routeから日本語理由に依存せずsideを復元し、別銘柄への誤用を拒否する", () => {
    expect(resolveCandidateSideFromAuditRoute({
      symbol: "6146",
      externalRouteId: "disco_opening_short",
    })).toBe("short");
    expect(resolveCandidateSideFromAuditRoute({
      symbol: "9984",
      externalRouteId: "ten_bar_breakout_long",
    })).toBe("long");
    expect(resolveCandidateSideFromAuditRoute({
      symbol: "5803",
      externalRouteId: "disco_opening_short",
    })).toBeNull();
  });
});
