import { beforeEach, describe, expect, it, vi } from "vitest";

const longShadow = vi.hoisted(() => vi.fn());
const shortShadow = vi.hoisted(() => vi.fn());

vi.mock("./fujikuraForwardShadowEngine", () => ({
  FUJIKURA_FORWARD_EVALUATION_START_DATE: "2026-09-04",
  FUJIKURA_FORWARD_LEARNING_CUTOFF_DATE: "2026-09-02",
  processFujikuraForwardShadowSourceEvent: longShadow,
  replayFujikuraForwardShadowDay: vi.fn(() => ({ replayedEvents: 0, mismatches: 0, invalidPayloads: 0 })),
}));

vi.mock("./fujikuraMorningBreakdownShortShadowEngine", () => ({
  processFujikuraMorningShortShadowSourceEvent: shortShadow,
}));

import { processForwardShadowSourceEvent } from "./forwardShadow";

const input = {
  sourceEventId: "5803-dispatch:1",
  candle: {
    symbol: "5803", tradeDate: "2026-09-17", candleTime: "10:00",
    open: 100, high: 101, low: 99, close: 100, volume: 100,
  },
  board: null,
};

vi.mock("./retiredSixStrategies", () => ({ retireSixShadowStrategyVersions: vi.fn() }));
vi.mock("./aiDailyForecastShadowEngine", () => ({ processAiDailyForecastShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));
vi.mock("./bollingerDirectionalShadowEngine", () => ({ processBollingerDirectionalShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));

describe("legacy source delivery retired", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not call retired engines, even when they would throw", async () => {
    longShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    shortShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    await expect(processForwardShadowSourceEvent(input)).resolves.toMatchObject({ skipped: "legacy_shadow_retired_2026_10_17" });
    expect(longShadow).not.toHaveBeenCalled();
    expect(shortShadow).not.toHaveBeenCalled();
  });
});
