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

describe("5803 LONG・新SHORTシャドー独立ディスパッチ", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    longShadow.mockResolvedValue({ strategyVersion: "long" });
    shortShadow.mockResolvedValue({ strategyVersion: "short" });
  });

  it("同じ5803 source eventを両経路へ渡す", async () => {
    await expect(processForwardShadowSourceEvent(input)).resolves.toMatchObject({
      skipped: false,
      symbol: "5803",
      evaluations: [{ strategyVersion: "long" }, { strategyVersion: "short" }],
    });
    expect(longShadow).toHaveBeenCalledWith(input);
    expect(shortShadow).toHaveBeenCalledWith(input);
  });

  it("一方が失敗しても他方を実行し、親event再試行用エラーに集約する", async () => {
    shortShadow.mockRejectedValueOnce(new Error("short-temporary"));
    await expect(processForwardShadowSourceEvent(input)).rejects.toThrow("fujikura_forward_shadow_partial_failure");
    expect(longShadow).toHaveBeenCalledOnce();
    expect(shortShadow).toHaveBeenCalledOnce();
  });
});
