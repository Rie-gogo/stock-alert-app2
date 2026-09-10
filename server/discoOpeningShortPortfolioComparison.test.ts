import { describe, expect, it } from "vitest";
import { simulateDiscoShortPortfolio, type DiscoPortfolioAllocation } from "./discoOpeningShortPortfolioComparison";

function allocation(input: Partial<DiscoPortfolioAllocation> & Pick<DiscoPortfolioAllocation, "id" | "symbol" | "entrySequence" | "exitSequence" | "entryTime" | "exitTime" | "requiredMargin" | "pnl">): DiscoPortfolioAllocation {
  return {
    sourceKind: "current_candidate",
    strategyVersion: "current",
    sourceEventId: `entry:${input.id}`,
    exitSourceEventId: `exit:${input.id}`,
    routeId: "route",
    side: "long",
    shares: 100,
    completed: true,
    ...input,
  };
}

describe("6146 Position B・10銘柄891万円統合比較", () => {
  it("同一銘柄でLONG保有中なら後発SHORTだけをブロックする", () => {
    const result = simulateDiscoShortPortfolio({
      order: "actual_receipt",
      allocations: [
        allocation({ id: "long", symbol: "6146", entrySequence: 1, exitSequence: 4, entryTime: "09:40", exitTime: "10:10", requiredMargin: 6_000_000, pnl: 10_000 }),
        allocation({ id: "short", symbol: "6146", side: "short", sourceKind: "disco_forward_shadow", entrySequence: 2, exitSequence: 3, entryTime: "09:50", exitTime: "10:00", requiredMargin: 5_900_000, pnl: 20_000 }),
      ],
    });
    expect(result).toMatchObject({ accepted: 1, symbolPositionBlocked: 1, marginBlocked: 0, closed: 1, realizedPnl: 10_000, complete: true });
    expect(result.decisions[1]).toMatchObject({ allocationId: "short", decision: "symbol_position_block", blockerAllocationId: "long" });
  });

  it("他銘柄との合計が891万円を超える場合だけ証拠金ブロックにする", () => {
    const result = simulateDiscoShortPortfolio({
      order: "actual_receipt",
      allocations: [
        allocation({ id: "other", symbol: "285A", entrySequence: 1, exitSequence: 4, entryTime: "09:40", exitTime: "10:10", requiredMargin: 5_000_000, pnl: 30_000 }),
        allocation({ id: "disco", symbol: "6146", side: "short", sourceKind: "disco_forward_shadow", entrySequence: 2, exitSequence: 3, entryTime: "09:50", exitTime: "10:00", requiredMargin: 6_000_000, pnl: 20_000 }),
      ],
    });
    expect(result).toMatchObject({ accepted: 1, marginBlocked: 1, symbolPositionBlocked: 0, realizedPnl: 30_000, complete: true });
    expect(result.decisions[1]).toMatchObject({ allocationId: "disco", decision: "margin_block", blockerSymbol: "285A" });
  });

  it("未決済やsource順欠損がある日はcompleteにしない", () => {
    const incomplete = allocation({ id: "gap", symbol: "6146", entrySequence: null, exitSequence: null, entryTime: "09:50", exitTime: null, requiredMargin: 6_000_000, pnl: null });
    incomplete.completed = false;
    incomplete.exitSourceEventId = null;
    const result = simulateDiscoShortPortfolio({ order: "actual_receipt", allocations: [incomplete] });
    expect(result.complete).toBe(false);
    expect(result.missingEntrySequence).toEqual(["gap"]);
    expect(result.incompleteTrades).toEqual(["gap"]);
  });
});
