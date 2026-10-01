import { beforeEach, describe, expect, it, vi } from "vitest";

const advantestShadow = vi.hoisted(() => vi.fn());

vi.mock("./advantestForwardShadowEngine", () => ({
  processAdvantestForwardShadowSourceEvent: advantestShadow,
}));

import { processForwardShadowSourceEvent } from "./forwardShadow";

const input = {
  sourceEventId: "6857-dispatch:1",
  candle: {
    symbol: "6857", tradeDate: "2026-10-02", candleTime: "10:00",
    open: 18_000, high: 18_050, low: 17_900, close: 17_950, volume: 100,
  },
  board: null,
};

describe("6857 A/B forward-shadow dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    advantestShadow.mockResolvedValue({
      skipped: false,
      symbol: "6857",
      evaluations: ["short-body008-depth", "confirmed-continuation-depth"],
    });
  });

  it("同じ6857 source eventを独立A/B engineへ一度だけ渡す", async () => {
    await expect(processForwardShadowSourceEvent(input)).resolves.toMatchObject({
      skipped: false,
      symbol: "6857",
      evaluations: ["short-body008-depth", "confirmed-continuation-depth"],
    });
    expect(advantestShadow).toHaveBeenCalledOnce();
    expect(advantestShadow).toHaveBeenCalledWith(input);
  });
});
