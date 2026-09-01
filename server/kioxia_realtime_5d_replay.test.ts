import { describe, expect, it, vi } from "vitest";

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  [key: string]: unknown;
};

let currentSnapshot: Snapshot | null = null;

function makeBook(snapshot: Snapshot | null) {
  if (!snapshot) return null;
  const bpr = Math.max(0.01, Number(snapshot.buyPressureRatio ?? 1));
  const ask = 10_000;
  return {
    bids: [{ price: 1, qty: Math.round(ask * bpr) }],
    asks: [{ price: 1, qty: ask }],
    underBuyQty: 0,
    overSellQty: 0,
    marketOrderBuyQty: 0,
    marketOrderSellQty: 0,
  };
}

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    ...actual,
    insertRtCandle: vi.fn().mockResolvedValue(undefined),
    insertRtTrade: vi.fn().mockResolvedValue(undefined),
    upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
    getRtTradesForDate: vi.fn().mockResolvedValue([]),
    getRtCandlesAllForDate: vi.fn().mockResolvedValue([]),
    getRtOpenPositionsFromDb: vi.fn().mockResolvedValue([]),
    insertScore0Block: vi.fn().mockResolvedValue(undefined),
    upsertKioxiaConfirmedMorningLongEvent: vi.fn().mockResolvedValue(undefined),
    upsertKioxiaShortGuardEvent: vi.fn().mockResolvedValue(undefined),
    getKioxiaShortGuardEventsForDate: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn(() => makeBook(currentSnapshot)),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn(() => currentSnapshot ?? {}),
  getAggregatedBoardStats: vi.fn().mockReturnValue(null),
  clearBoardRingBuffer: vi.fn(),
}));

vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn((symbol: string) => symbol),
  TARGET_STOCKS: [{ symbol: "285A", ticker: "285A.T", name: "キオクシア", basePrice: 10000, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["285A"]),
}));

import { getRtCandles } from "./db";
import { processCandle } from "./realtimeSimEngine";

const dates = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"];

describe("キオクシア(285A) 専用5方式の保存KABU 5営業日再生", () => {
  it("汎用経路を使わず、保存1分足・板スナップショットを時刻順に処理する", async () => {
    const events: Array<{ date: string; time: string; action: string; reason?: string; pnl?: number }> = [];
    let processedRows = 0;

    for (const tradeDate of dates) {
      const rows = await getRtCandles("285A", tradeDate) as Array<Record<string, unknown>>;
      for (const row of rows) {
        currentSnapshot = (row.boardSnapshot as Snapshot | null) ?? null;
        const result = await processCandle({
          symbol: "285A",
          tradeDate,
          candleTime: String(row.candleTime),
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume),
        });
        processedRows++;
        if (result.action !== "none") events.push({ date: tradeDate, time: String(row.candleTime), action: result.action, reason: result.reason, pnl: result.pnl });
      }
    }

    console.log("KIOXIA_EXCLUSIVE_5D", JSON.stringify({ processedRows, events }));
    expect(processedRows).toBeGreaterThan(1_500);
    const entries = events.filter(event => event.action === "entry");
    expect(entries).toHaveLength(12);
    expect(entries.filter(entry => entry.reason?.startsWith("キオクシア確認型前場LONG"))).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.reason).toMatch(/キオクシア確認型前場LONG|反転LONG|反転SHORT|順張りSHORT|大台確認|大台割れ/);
      expect(entry.reason).not.toMatch(/安値更新即|押し目確認/);
    }
  }, 120_000);
});
