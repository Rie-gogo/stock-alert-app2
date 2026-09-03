import { beforeEach, describe, expect, it, vi } from "vitest";

const firstShadow = vi.hoisted(() => vi.fn());
const secondShadow = vi.hoisted(() => vi.fn());

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

import { processForwardShadowSourceEvent } from "./forwardShadow";

const input = {
  sourceEventId: "kioxia-dispatch:1",
  candle: {
    symbol: "285A", tradeDate: "2026-09-07", candleTime: "10:00",
    open: 1_000, high: 1_001, low: 999, close: 1_000, volume: 100,
  },
  board: { currentPrice: 1_000 },
};

describe("285A第1・第2シャドー独立ディスパッチ", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firstShadow.mockResolvedValue({ strategyVersion: "first" });
    secondShadow.mockResolvedValue({ strategyVersion: "second" });
  });

  it("同一受信を第1・第2へ各1回渡し、別結果として返す", async () => {
    const result = await processForwardShadowSourceEvent(input);
    expect(firstShadow).toHaveBeenCalledOnce();
    expect(secondShadow).toHaveBeenCalledOnce();
    expect(firstShadow).toHaveBeenCalledWith(input);
    expect(secondShadow).toHaveBeenCalledWith(input);
    expect(result).toMatchObject({
      skipped: false,
      symbol: "285A",
      evaluations: [{ strategyVersion: "first" }, { strategyVersion: "second" }],
    });
  });

  it("第1案が失敗しても第2案を実行し、親イベント再試行用の集約エラーを返す", async () => {
    firstShadow.mockRejectedValueOnce(new Error("first-temporary"));
    await expect(processForwardShadowSourceEvent(input)).rejects.toThrow("kioxia_forward_shadow_partial_failure");
    expect(firstShadow).toHaveBeenCalledOnce();
    expect(secondShadow).toHaveBeenCalledOnce();
  });
});
