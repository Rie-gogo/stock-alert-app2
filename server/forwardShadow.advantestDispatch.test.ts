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

vi.mock("./retiredSixStrategies", () => ({ retireSixShadowStrategyVersions: vi.fn() }));
vi.mock("./aiDailyForecastShadowEngine", () => ({ processAiDailyForecastShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));
vi.mock("./bollingerDirectionalShadowEngine", () => ({ processBollingerDirectionalShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));

describe("legacy source delivery retired", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not call retired engines, even when they would throw", async () => {
    advantestShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    await expect(processForwardShadowSourceEvent(input)).resolves.toMatchObject({ skipped: "legacy_shadow_retired_2026_10_17" });
    expect(advantestShadow).not.toHaveBeenCalled();
  });
});
