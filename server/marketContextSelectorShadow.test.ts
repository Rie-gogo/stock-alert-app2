import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  buildMarketContextSelectorShadowDecision,
  buildPremarketMarketContextSelectorShadowDecision,
  classifyIntradayMarketContext,
  classifyPremarketContext,
  combinePremarketAndIntraday,
  type MarketContextBar,
} from "./marketContextSelectorShadow";

function bars(input: {
  previousClose?: number;
  open?: number;
  closes: number[];
}): MarketContextBar[] {
  const previousClose = input.previousClose ?? 100;
  const open = input.open ?? input.closes[0]!;
  return input.closes.map((close, index) => ({
    tradeDate: "2026-10-05",
    candleTime: `09:${String(index).padStart(2, "0")}`,
    open: index === 0 ? open : input.closes[index - 1]!,
    high: Math.max(close, index === 0 ? open : input.closes[index - 1]!) + 0.1,
    low: Math.min(close, index === 0 ? open : input.closes[index - 1]!) - 0.1,
    close,
    previousClose,
  }));
}

describe("market context selector shadow", () => {
  const premarketInput = {
    tradeDate: "2026-10-05",
    capturedAtMs: Date.parse("2026-10-05T08:30:00+09:00"),
    collectorVersion: "test-v1",
    sourceMode: "scheduled_research" as const,
    dow: { sessionDate: "2026-10-02", close: 45000, changePct: 1.1, observedAtMs: 1, sourceUrl: "https://example.com/dow", status: "verified" as const },
    cme: {
      providerSymbol: "NIY",
      contractMonth: "2026/12",
      currency: "JPY" as const,
      quote: 50600,
      observedAtMs: Date.parse("2026-10-05T08:25:00+09:00"),
      comparisonPolicy: "same_cme_previous_jpx_business_day_0830" as const,
      previousSession: {
        tradeDate: "2026-10-02",
        providerSymbol: "NIY",
        contractMonth: "2026/12",
        currency: "JPY" as const,
        quote: 50000,
        observedAtMs: Date.parse("2026-10-02T08:25:00+09:00"),
      },
      sourceUrl: "https://example.com/cme",
      status: "verified" as const,
    },
    usdJpy: { previousRate: 150, previousAtMs: 3, currentRate: 151, currentAtMs: 4, sourceUrl: "https://example.com/fx", status: "verified" as const },
  };

  it("①〜③が同方向なら強い上昇として固定する", () => {
    const result = classifyPremarketContext(premarketInput);
    expect(result).toMatchObject({
      state: "strong_up",
      confidence: "high",
      allowedDirections: ["long"],
      qualityStatus: "verified",
      verifiedLegs: 3,
    });
  });

  it("CMEの通貨がUSDならverified材料にしない", () => {
    const result = classifyPremarketContext({
      ...premarketInput,
      cme: {
        ...premarketInput.cme,
        currency: "USD",
        previousSession: { ...premarketInput.cme.previousSession, currency: "USD" },
      },
      dow: null,
    });
    expect(result.state).toBe("unavailable");
    expect(result.reasonCodes).toContain("cme_currency_not_jpy");
  });

  it("10/5は前JPX営業日10/2の同一CME 08:25比で上昇と判定する", () => {
    const result = classifyPremarketContext({
      ...premarketInput,
      dow: { ...premarketInput.dow, changePct: 0.49 },
      cme: {
        ...premarketInput.cme,
        quote: 69835,
        previousSession: { ...premarketInput.cme.previousSession, quote: 68475 },
      },
      usdJpy: { ...premarketInput.usdJpy, previousRate: 147.30, currentRate: 147.33 },
    });
    expect(result).toMatchObject({ state: "up", allowedDirections: ["long"] });
    expect(result.metrics.cmePreviousSessionChangePct).toBeCloseTo(1.986, 3);
    expect(result.metrics.directionalScore).toBe(3);
  });

  it("旧OSE比較だけのCME payloadは受信互換でも方向判定に使用しない", () => {
    const result = classifyPremarketContext({
      ...premarketInput,
      dow: null,
      cme: { ...premarketInput.cme, previousSession: null },
    });
    expect(result).toMatchObject({ state: "unavailable", qualityStatus: "degraded" });
    expect(result.metrics.cmePreviousSessionChangePct).toBeNull();
    expect(result.reasonCodes).toContain("cme_previous_session_reference_missing");
  });

  it("前営業日のCMEが別限月なら比較せずfail-closedにする", () => {
    const result = classifyPremarketContext({
      ...premarketInput,
      dow: null,
      cme: {
        ...premarketInput.cme,
        previousSession: { ...premarketInput.cme.previousSession, contractMonth: "2027/03" },
      },
    });
    expect(result).toMatchObject({ state: "unavailable", qualityStatus: "degraded" });
    expect(result.reasonCodes).toContain("cme_previous_session_instrument_mismatch");
  });

  it("単に過去の日付ではなく直前のJPX営業日だけを比較対象にする", () => {
    const result = classifyPremarketContext({
      ...premarketInput,
      dow: null,
      cme: {
        ...premarketInput.cme,
        previousSession: {
          ...premarketInput.cme.previousSession,
          tradeDate: "2026-10-01",
          observedAtMs: Date.parse("2026-10-01T08:25:00+09:00"),
        },
      },
    });
    expect(result).toMatchObject({ state: "unavailable", qualityStatus: "degraded" });
    expect(result.reasonCodes).toContain("cme_reference_not_previous_jpx_business_day");
  });

  it("当日と前営業日が同じ08:25確定足でなければsnapshotを無効にする", () => {
    const result = classifyPremarketContext({
      ...premarketInput,
      cme: {
        ...premarketInput.cme,
        observedAtMs: Date.parse("2026-10-05T08:20:00+09:00"),
      },
    });
    expect(result).toMatchObject({ state: "unavailable", qualityStatus: "invalid" });
    expect(result.reasonCodes).toContain("cme_comparison_not_same_0825_completed_bar");
  });

  it("9:00 JST以降に凍結した開場前snapshotを選択材料にしない", () => {
    const result = classifyPremarketContext({
      ...premarketInput,
      capturedAtMs: Date.parse("2026-10-05T09:01:00+09:00"),
    });
    expect(result).toMatchObject({ state: "unavailable", qualityStatus: "invalid", allowedDirections: [] });
    expect(result.reasonCodes).toContain("captured_at_or_after_cash_open");
  });

  it("snapshot凍結後の観測値を先読みとして無効にする", () => {
    const result = classifyPremarketContext({
      ...premarketInput,
      dow: { ...premarketInput.dow, observedAtMs: premarketInput.capturedAtMs + 1 },
    });
    expect(result).toMatchObject({ state: "unavailable", qualityStatus: "invalid" });
    expect(result.reasonCodes).toContain("source_observed_after_snapshot_capture");
  });

  it("最初の5分が揃うまで方向を選ばない", () => {
    const result = classifyIntradayMarketContext(bars({ closes: [100, 100.1, 100.2, 100.3] }));
    expect(result.state).toBe("waiting_open_confirmation");
    expect(result.allowedDirections).toEqual([]);
  });

  it("ギャップダウン後の3本回復をLONG方向として09:05 checkpointで固定する", () => {
    const result = classifyIntradayMarketContext(bars({
      previousClose: 100,
      open: 99,
      closes: [99, 99.05, 99.1, 99.2, 99.4],
    }));
    expect(result).toMatchObject({
      state: "gap_down_recovery",
      allowedDirections: ["long"],
      checkpoint: true,
      decisionAt: "09:05",
    });
  });

  it("大幅下落が継続する場合はSHORT方向に限定する", () => {
    const result = classifyIntradayMarketContext(bars({
      previousClose: 100,
      open: 99.5,
      closes: [99.5, 99.3, 99.1, 98.9, 98.7],
    }));
    expect(result.state).toBe("strong_down");
    expect(result.allowedDirections).toEqual(["short"]);
  });

  it("開場前と場中が09:05に逆なら見送る", () => {
    const premarket = classifyPremarketContext(premarketInput);
    const intraday = classifyIntradayMarketContext(bars({
      previousClose: 100,
      open: 99.5,
      closes: [99.5, 99.3, 99.1, 98.9, 98.7],
    }));
    const combined = combinePremarketAndIntraday(premarket, intraday);
    expect(combined).toMatchObject({ state: "wait", allowedDirections: [] });
  });

  it("明確なギャップ反転は開場前判断より場中事実を優先する", () => {
    const premarket = classifyPremarketContext({
      ...premarketInput,
      dow: { ...premarketInput.dow, changePct: -1.1 },
      cme: { ...premarketInput.cme, quote: 49400 },
      usdJpy: { ...premarketInput.usdJpy, currentRate: 149 },
    });
    const intraday = classifyIntradayMarketContext(bars({
      previousClose: 100,
      open: 99,
      closes: [99, 99.05, 99.1, 99.2, 99.4],
    }));
    const combined = combinePremarketAndIntraday(premarket, intraday);
    expect(combined).toMatchObject({ state: "long", allowedDirections: ["long"] });
    expect(combined.reasonCodes).toContain("explicit_gap_reversal_overrides_premarket");
  });

  it("同一分の再送を別の1分足として数えない", () => {
    const source = bars({
      previousClose: 100,
      open: 99,
      closes: [99, 99.05, 99.1, 99.2, 99.4],
    });
    const duplicated = [source[0]!, source[1]!, source[1]!, source[2]!, source[3]!, source[4]!];
    const result = classifyIntradayMarketContext(duplicated);
    expect(result).toMatchObject({
      state: "gap_down_recovery",
      checkpoint: true,
      decisionAt: "09:05",
    });
  });

  it("直近損益で足切りせず、場中方向とroute styleが同率の案を並行選択する", () => {
    const regime = classifyIntradayMarketContext(bars({
      previousClose: 100,
      open: 99,
      closes: [99, 99.05, 99.1, 99.2, 99.4],
    }));
    const result = buildMarketContextSelectorShadowDecision({
      tradeDate: "2026-10-05",
      sourceEventId: "market:1",
      regime,
      routeSelectorSnapshot: {
        selectorVersion: "route-v3",
        inputHash: "frozen",
        scores: [
          { symbol: "285A", rowId: "long-a", canonicalLogic: "long-a", strategyVersion: "a", direction: "long", selectable: true, expectedDailyPnlPer100: 100 },
          { symbol: "285A", rowId: "long-b", canonicalLogic: "long-b", strategyVersion: "b", direction: "long", selectable: true, expectedDailyPnlPer100: 200 },
          { symbol: "285A", rowId: "short-a", canonicalLogic: "short-a", strategyVersion: "c", direction: "short", selectable: true, expectedDailyPnlPer100: 900 },
          { symbol: "8035", rowId: "negative", canonicalLogic: "negative", strategyVersion: "d", direction: "long", selectable: true, expectedDailyPnlPer100: -1 },
        ],
      },
    });
    expect(result.selections).toEqual([
      expect.objectContaining({
        symbol: "285A",
        selectedRowId: "long-a",
        decision: "selector_shadow_group",
        unconditionalRecentPnlUsedForSelection: false,
        selectedAlternatives: [
          expect.objectContaining({ rowId: "long-a" }),
          expect.objectContaining({ rowId: "long-b" }),
        ],
      }),
      expect.objectContaining({ symbol: "8035", selectedRowId: "negative", decision: "selector_shadow" }),
    ]);
    expect(result.orderInstructionConnection).toBe(false);
    expect(result.automaticAdoption).toBe(false);
    expect(result.unconditionalRecentPnlUsedForSelection).toBe(false);
    expect(result.selectionPolicy).toBe("market_regime_route_style_affinity_v1");
  });

  it("通常選択器のtechnical featureが不足していても①〜④専用候補を選べる", () => {
    const regime = classifyIntradayMarketContext(bars({
      previousClose: 100,
      open: 99,
      closes: [99, 99.05, 99.1, 99.2, 99.4],
    }));
    const result = buildMarketContextSelectorShadowDecision({
      tradeDate: "2026-10-05",
      sourceEventId: "market:2",
      regime,
      routeSelectorSnapshot: {
        selectorVersion: "route-v3",
        inputHash: "frozen",
        scores: [
          {
            symbol: "285A",
            rowId: "market-long",
            canonicalLogic: "market-long",
            strategyVersion: "market-long-v1",
            direction: "long",
            selectable: false,
            exclusionReasons: ["feature_or_provenance_unavailable"],
            marketContextEligible: true,
            marketContextEvidenceLevel: "provisional",
            marketContextExpectedDailyPnlPer100: 180,
            marketContextCompletedTrades: 4,
            marketContextRecent10CompletedTrades: 2,
          },
        ],
      },
    });
    expect(result.selections[0]).toMatchObject({
      selectedRowId: "market-long",
      decision: "selector_shadow",
      unconditionalRecentPnlUsedForSelection: false,
    });
  });

  it("ギャップ安から回復した日は単純な順張りより反転LONG経路を優先する", () => {
    const regime = classifyIntradayMarketContext(bars({
      previousClose: 100,
      open: 99,
      closes: [99, 99.05, 99.1, 99.2, 99.4],
    }));
    const result = buildMarketContextSelectorShadowDecision({
      tradeDate: "2026-10-05",
      sourceEventId: "market:gap-recovery",
      regime,
      routeSelectorSnapshot: {
        selectorVersion: "route-v5",
        inputHash: "frozen",
        scores: [
          { symbol: "285A", rowId: "trend", routeGroupId: "confirmed_morning_long", canonicalLogic: "trend", strategyVersion: "trend-v1", direction: "long", marketContextEligible: true, marketContextExpectedDailyPnlPer100: 500 },
          { symbol: "285A", rowId: "reversal", routeGroupId: "reversal_long", canonicalLogic: "reversal", strategyVersion: "reversal-v1", direction: "long", marketContextEligible: true, marketContextExpectedDailyPnlPer100: -500 },
        ],
      },
    });
    expect(result.selections[0]).toMatchObject({
      selectedRowId: "reversal",
      selectedCanonicalLogic: "reversal",
      routeStyle: "reversal_long",
      marketAffinityScore: 5,
    });
  });

  it("開場前①〜③だけでも08:30の選択結果を作る", () => {
    const premarket = classifyPremarketContext(premarketInput);
    const result = buildPremarketMarketContextSelectorShadowDecision({
      tradeDate: "2026-10-05",
      sourceSnapshotId: "premarket:2026-10-05:scheduled:test",
      premarketRegime: premarket,
      routeSelectorSnapshot: {
        selectorVersion: "route-v3",
        inputHash: "frozen",
        scores: [
          { symbol: "285A", rowId: "long", canonicalLogic: "long", strategyVersion: "long-v1", direction: "long", marketContextEligible: true, marketContextExpectedDailyPnlPer100: 100 },
          { symbol: "285A", rowId: "short", canonicalLogic: "short", strategyVersion: "short-v1", direction: "short", marketContextEligible: true, marketContextExpectedDailyPnlPer100: 900 },
        ],
      },
    });
    expect(result).toMatchObject({ decisionAt: "08:30", decisionStage: "premarket_0830" });
    expect(result.selections[0]).toMatchObject({ selectedRowId: "long", selectedDirection: "long" });
  });

  it("市場環境ingestionは通常engine・shadow・注文をimportしない", async () => {
    const sources = await Promise.all([
      readFile(new URL("./marketContextIngestion.ts", import.meta.url), "utf8"),
      readFile(new URL("./premarketContextIngestion.ts", import.meta.url), "utf8"),
    ]);
    for (const source of sources) {
      expect(source).not.toContain("./realtimeSimEngine");
      expect(source).not.toContain("./sourceEventIngestion");
      expect(source).not.toContain("./forwardShadow");
      expect(source).not.toContain("./orderBridge");
      expect(source).not.toContain("processCandle(");
    }
  });
});
