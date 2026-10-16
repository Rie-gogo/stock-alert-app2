import { beforeEach, describe, expect, it, vi } from "vitest";

const firstShadow = vi.hoisted(() => vi.fn());
const secondShadow = vi.hoisted(() => vi.fn());
const reopenShadow = vi.hoisted(() => vi.fn());

vi.mock("./kioxiaForwardShadowEngine", () => ({
  KIOXIA_FORWARD_EVALUATION_START_DATE: "2026-09-04",
  KIOXIA_FORWARD_LEARNING_CUTOFF_DATE: "2026-09-03",
  processKioxiaForwardShadowSourceEvent: firstShadow,
  replayKioxiaForwardShadowDay: vi.fn(() => ({ replayedEvents: 0, mismatches: 0, invalidPayloads: 0 })),
}));

vi.mock("./kioxiaAtrForwardShadowEngine", () => ({
  KIOXIA_ATR_FORWARD_EVALUATION_START_DATE: "2026-09-07",
  KIOXIA_ATR_FORWARD_LEARNING_CUTOFF_DATE: "2026-09-03",
  processKioxiaAtrForwardShadowSourceEvent: secondShadow,
  replayKioxiaAtrForwardShadowDay: vi.fn(() => ({ replayedEvents: 0, mismatches: 0, invalidPayloads: 0 })),
}));
vi.mock("./kioxiaCurrentReversalLongExactEngine", () => ({ processKioxiaCurrentReversalLongExactReopenSourceEvent: reopenShadow }));

import { processForwardShadowSourceEvent } from "./forwardShadow";

const input = {
  sourceEventId: "kioxia-dispatch:1",
  candle: {
    symbol: "285A", tradeDate: "2026-10-02", candleTime: "10:00",
    open: 1_000, high: 1_001, low: 999, close: 1_000, volume: 100,
  },
  board: { currentPrice: 1_000 },
};

vi.mock("./retiredSixStrategies", () => ({ retireSixShadowStrategyVersions: vi.fn() }));
vi.mock("./aiDailyForecastShadowEngine", () => ({ processAiDailyForecastShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));
vi.mock("./bollingerDirectionalShadowEngine", () => ({ processBollingerDirectionalShadowSourceEvent: vi.fn(async () => ({ skipped: false })) }));

describe("legacy source delivery retired", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not call retired engines, even when they would throw", async () => {
    firstShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    secondShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    reopenShadow.mockImplementation(() => { throw new Error("retired engine must not run"); });
    await expect(processForwardShadowSourceEvent(input)).resolves.toMatchObject({ skipped: "legacy_shadow_retired_2026_10_17" });
    expect(firstShadow).not.toHaveBeenCalled();
    expect(secondShadow).not.toHaveBeenCalled();
    expect(reopenShadow).not.toHaveBeenCalled();
  });
});
