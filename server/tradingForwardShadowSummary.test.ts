import { describe, expect, it, vi } from "vitest";

const summaryMock = vi.hoisted(() => vi.fn(async (_asOfDate: string, strategyVersion: string) => ([{
  mode: "signal_quality",
  strategyVersion,
}])));

vi.mock("./forwardShadow", () => ({
  getForwardShadowSummary: summaryMock,
}));

import { tradingRouter } from "./routers/trading";
import {
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
} from "./runtimeIdentity";

describe("trading.getForwardShadowSummary", () => {
  it("8035・5803との互換順序を保ち、285A第1・第2の独立strategyVersionを追加する", async () => {
    const caller = tradingRouter.createCaller({} as never);
    const result = await caller.getForwardShadowSummary({ asOfDate: "2026-09-04" });

    expect(result.strategies.map(item => ({
      strategyVersion: item.strategyVersion,
      symbol: item.symbol,
    }))).toEqual([
      { strategyVersion: FORWARD_STRATEGY_VERSION, symbol: "8035" },
      { strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION, symbol: "5803" },
      { strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION, symbol: "285A" },
      { strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION, symbol: "285A" },
    ]);
    expect(summaryMock).toHaveBeenCalledTimes(4);
    expect(summaryMock).toHaveBeenNthCalledWith(3, "2026-09-04", KIOXIA_FORWARD_STRATEGY_VERSION);
    expect(summaryMock).toHaveBeenNthCalledWith(4, "2026-09-04", KIOXIA_ATR_FORWARD_STRATEGY_VERSION);
  });
});
