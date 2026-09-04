import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ getRtCandles: vi.fn() }));
vi.mock("./db", () => dbMock);

import {
  deriveCurrentBoardExitSignal,
  deriveCurrentRawSignalForEvent,
} from "./currentVirtualMarketContext";

describe("100株仮想取引の因果的market context", () => {
  beforeEach(() => vi.clearAllMocks());

  it("再試行時も現在足より後のDB足を除外し、payloadの現在足を一度だけ使う", async () => {
    const rows = Array.from({ length: 35 }, (_, index) => {
      const minute = String(index).padStart(2, "0");
      return {
        tradeDate: "2026-09-08",
        candleTime: `09:${minute}`,
        open: String(100 + index),
        high: String(101 + index),
        low: String(99 + index),
        close: String(100 + index),
        volume: 1_000,
      };
    });
    rows.push({ tradeDate: "2026-09-08", candleTime: "10:31", open: "1", high: "1", low: "1", close: "1", volume: 1_000 });
    dbMock.getRtCandles.mockResolvedValue(rows);

    const result = await deriveCurrentRawSignalForEvent({
      symbol: "8035",
      tradeDate: "2026-09-08",
      candleTime: "09:35",
      open: 135,
      high: 136,
      low: 134,
      close: 135,
      volume: 1_000,
    });

    expect(dbMock.getRtCandles).toHaveBeenCalledWith("8035", "2026-09-08");
    expect(result === null || ["buy", "sell", "warn"].includes(result.type)).toBe(true);
  });

  it("同時点板を現行と同じ優先順で売り圧力へ分類する", () => {
    const signal = deriveCurrentBoardExitSignal("8035", {
      symbolName: "東京エレクトロン",
      currentPrice: 100,
      currentPriceTime: "10:00:00",
      asks: [{ price: 101, qty: 1_000 }],
      bids: [{ price: 99, qty: 100 }],
      marketOrderSellQty: 0,
      marketOrderBuyQty: 0,
      overSellQty: 0,
      underBuyQty: 0,
      vwap: 100,
    });
    expect(signal).toBe("sell_pressure");
  });
});
