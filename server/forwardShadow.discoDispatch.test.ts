import { beforeEach, describe, expect, it, vi } from "vitest";

const discoShadow = vi.hoisted(() => vi.fn());

vi.mock("./discoOpeningShortForwardShadowEngine", () => ({
  processDiscoOpeningShortForwardShadowSourceEvent: discoShadow,
}));

import { processForwardShadowSourceEvent } from "./forwardShadow";

const input = {
  sourceEventId: "disco-dispatch:1",
  candle: {
    symbol: "6146", tradeDate: "2026-09-11", candleTime: "09:30",
    open: 60_000, high: 60_050, low: 59_000, close: 59_100, volume: 100,
  },
  board: { bids: [{ price: 59_090, qty: 100 }] },
};

describe("6146停止中SHORT・現行/A/Bシャドーディスパッチ", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoShadow.mockResolvedValue({ skipped: false, symbol: "6146", evaluations: ["baseline", "a", "b"] });
  });

  it("6146の同一受信を専用3案エンジンへ渡す", async () => {
    const result = await processForwardShadowSourceEvent(input);
    expect(discoShadow).toHaveBeenCalledOnce();
    expect(discoShadow).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      skipped: false,
      symbol: "6146",
      evaluations: ["baseline", "a", "b"],
    });
  });
});
