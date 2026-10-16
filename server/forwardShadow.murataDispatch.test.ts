import { beforeEach, describe, expect, it, vi } from "vitest";

const murataShadow = vi.hoisted(() => vi.fn());
vi.mock("./murataIndependentShadowEngine", () => ({ processMurataIndependentShadowSourceEvent: murataShadow }));

import { processForwardShadowSourceEvent } from "./forwardShadow";

const input = {
  sourceEventId: "6981:dispatch:1",
  candle: { symbol: "6981", tradeDate: "2026-10-01", candleTime: "09:45", open: 100, high: 101, low: 99, close: 100, volume: 100 },
  board: null,
};

vi.mock("./retiredSixStrategies", () => ({ retireSixShadowStrategyVersions: vi.fn() }));
vi.mock("./aiDailyForecastShadowEngine", () => ({ processAiDailyForecastShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));
vi.mock("./bollingerDirectionalShadowEngine", () => ({ processBollingerDirectionalShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));

describe("legacy source delivery retired", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not call retired engines, even when they would throw", async () => {
    murataShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    await expect(processForwardShadowSourceEvent(input)).resolves.toMatchObject({ skipped: "legacy_shadow_retired_2026_10_17" });
    expect(murataShadow).not.toHaveBeenCalled();
  });
});
