import { beforeEach, describe, expect, it, vi } from "vitest";

const discoShadow = vi.hoisted(() => vi.fn());
const discoLongShadow = vi.hoisted(() => vi.fn());

vi.mock("./discoOpeningShortForwardShadowEngine", () => ({
  processDiscoOpeningShortForwardShadowSourceEvent: discoShadow,
}));
vi.mock("./discoConfirmedLongForwardShadowEngine", () => ({
  processDiscoConfirmedLongForwardShadowSourceEvent: discoLongShadow,
}));

import { processForwardShadowSourceEvent } from "./forwardShadow";

const input = {
  sourceEventId: "disco-dispatch:1",
  candle: {
    symbol: "6146", tradeDate: "2026-09-18", candleTime: "09:30",
    open: 60_000, high: 60_050, low: 59_000, close: 59_100, volume: 100,
  },
  board: { bids: [{ price: 59_090, qty: 100 }] },
};

vi.mock("./retiredSixStrategies", () => ({ retireSixShadowStrategyVersions: vi.fn() }));
vi.mock("./aiDailyForecastShadowEngine", () => ({ processAiDailyForecastShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));
vi.mock("./bollingerDirectionalShadowEngine", () => ({ processBollingerDirectionalShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));

describe("legacy source delivery retired", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not call retired engines, even when they would throw", async () => {
    discoShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    discoLongShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    await expect(processForwardShadowSourceEvent(input)).resolves.toMatchObject({ skipped: "legacy_shadow_retired_2026_10_17" });
    expect(discoShadow).not.toHaveBeenCalled();
    expect(discoLongShadow).not.toHaveBeenCalled();
  });
});
