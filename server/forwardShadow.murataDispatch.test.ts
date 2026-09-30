import { beforeEach, describe, expect, it, vi } from "vitest";

const murataShadow = vi.hoisted(() => vi.fn());
vi.mock("./murataIndependentShadowEngine", () => ({ processMurataIndependentShadowSourceEvent: murataShadow }));

import { processForwardShadowSourceEvent } from "./forwardShadow";

const input = {
  sourceEventId: "6981:dispatch:1",
  candle: { symbol: "6981", tradeDate: "2026-10-01", candleTime: "09:45", open: 100, high: 101, low: 99, close: 100, volume: 100 },
  board: null,
};

describe("6981 independent A/B shadow dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    murataShadow.mockResolvedValue({ skipped: false, strategyVersions: ["A", "B"] });
  });

  it("dispatches the source event only to the dedicated independent shadow engine", async () => {
    await expect(processForwardShadowSourceEvent(input)).resolves.toMatchObject({ skipped: false, strategyVersions: ["A", "B"] });
    expect(murataShadow).toHaveBeenCalledWith(input);
  });
});
