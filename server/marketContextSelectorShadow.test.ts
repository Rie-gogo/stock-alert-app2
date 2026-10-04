import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  buildMarketContextSelectorShadowDecision,
  classifyIntradayMarketContext,
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

  it("前日snapshotの正の候補から場中方向と一致する1案だけを選ぶ", () => {
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
      expect.objectContaining({ symbol: "285A", selectedRowId: "long-b", decision: "selector_shadow" }),
      expect.objectContaining({ symbol: "8035", selectedRowId: null, decision: "no_selection" }),
    ]);
    expect(result.orderInstructionConnection).toBe(false);
    expect(result.automaticAdoption).toBe(false);
  });

  it("市場環境ingestionは通常engine・shadow・注文をimportしない", async () => {
    const source = await readFile(new URL("./marketContextIngestion.ts", import.meta.url), "utf8");
    expect(source).not.toContain("./realtimeSimEngine");
    expect(source).not.toContain("./sourceEventIngestion");
    expect(source).not.toContain("./forwardShadow");
    expect(source).not.toContain("./orderBridge");
    expect(source).not.toContain("processCandle(");
  });
});
