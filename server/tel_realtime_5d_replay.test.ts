import { describe, expect, it, vi } from "vitest";
import fixture from "../analysis/tel_5d_replay_fixture.json";

type Snapshot = {
  buyPressureRatio?: number;
  marketOrderRatio?: number;
  marketOrderDirection?: "buy" | "sell" | "neutral";
  signal?: "buy_pressure" | "sell_pressure" | "large_buy_wall" | "large_sell_wall" | "market_surge" | "neutral";
  largeBuyWall?: boolean;
  largeSellWall?: boolean;
  [key: string]: unknown;
};

type FixtureRow = {
  tradeDate: string;
  candleTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  boardSnapshot: Snapshot | string | null;
};

let currentSnapshot: Snapshot | null = null;

function makeBook(snapshot: Snapshot | null) {
  if (!snapshot) return null;
  const bpr = Math.max(0.01, Number(snapshot.buyPressureRatio ?? 1));
  const ask = 10_000;
  const bid = Math.round(ask * bpr);
  const base = ask + bid;
  const ratio = Math.min(0.9, Math.max(0, Number(snapshot.marketOrderRatio ?? 0)));
  const market = ratio > 0 ? Math.round((ratio * base) / (1 - ratio)) : 0;
  const direction = snapshot.marketOrderDirection ?? "neutral";
  return {
    bids: [{ price: 1, qty: bid }],
    asks: [{ price: 1, qty: ask }],
    underBuyQty: 0,
    overSellQty: 0,
    marketOrderBuyQty: direction === "buy" ? market : Math.floor(market / 2),
    marketOrderSellQty: direction === "sell" ? market : Math.ceil(market / 2),
  };
}

function boardSignals(snapshot: Snapshot | null) {
  if (!snapshot) return [];
  const result: Array<{ type: string }> = [];
  if (snapshot.signal === "buy_pressure") result.push({ type: "board_buy_pressure" });
  if (snapshot.signal === "sell_pressure") result.push({ type: "board_sell_pressure" });
  if (snapshot.signal === "market_surge") result.push({ type: "market_order_surge" });
  if (snapshot.largeBuyWall || snapshot.signal === "large_buy_wall") result.push({ type: "large_bid_wall" });
  if (snapshot.largeSellWall || snapshot.signal === "large_sell_wall") result.push({ type: "large_ask_wall" });
  return result;
}

vi.mock("./db", () => ({
  insertRtCandle: vi.fn().mockResolvedValue(undefined),
  insertRtTrade: vi.fn().mockResolvedValue(undefined),
  upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
  getRtTradesForDate: vi.fn().mockResolvedValue([]),
  getRtCandlesAllForDate: vi.fn().mockResolvedValue([]),
  getRtOpenPositionsFromDb: vi.fn().mockResolvedValue([]),
  insertScore0Block: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn(() => makeBook(currentSnapshot)),
  analyzeOrderBook: vi.fn(() => boardSignals(currentSnapshot)),
  calcExtendedBoardFields: vi.fn(() => currentSnapshot ?? {}),
  getAggregatedBoardStats: vi.fn(() => null),
  clearBoardRingBuffer: vi.fn(),
}));

vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("東京エレクトロン"),
  TARGET_STOCKS: [{ symbol: "8035", ticker: "8035.T", name: "東京エレクトロン", basePrice: 50000, sector: "半導体" }],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["8035"]),
}));

import { processCandle } from "./realtimeSimEngine";

describe("8035 始値方向付き短期ブレイク優先＋予備経路 5営業日・未来情報なし再生", () => {
  it("保存済み1分足と同時点の板情報だけを時刻順に処理して全取引を出力する", async () => {
    const rows = fixture as FixtureRow[];
    const events: Array<{ date: string; time: string; action: string; reason?: string; pnl?: number }> = [];

    for (const row of rows) {
      currentSnapshot = typeof row.boardSnapshot === "string"
        ? JSON.parse(row.boardSnapshot)
        : row.boardSnapshot;
      const result = await processCandle({
        symbol: "8035",
        tradeDate: row.tradeDate,
        candleTime: row.candleTime,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      });
      if (result.action !== "none") {
        events.push({
          date: row.tradeDate,
          time: row.candleTime,
          action: result.action,
          reason: result.reason,
          pnl: result.pnl,
        });
      }
    }

    console.log("8035_5D_CAUSAL_REPLAY", JSON.stringify(events));
    expect(rows).toHaveLength(1674);
    const entries = events.filter(event => event.action === "entry");
    const exits = events.filter(event => event.action !== "entry");
    const wins = exits.filter(event => (event.pnl ?? 0) > 0);
    const losses = exits.filter(event => (event.pnl ?? 0) < 0);
    expect(entries).toHaveLength(4);
    expect(exits).toHaveLength(4);
    expect(wins).toHaveLength(3);
    expect(losses).toHaveLength(1);
    expect(exits.reduce((sum, event) => sum + (event.pnl ?? 0), 0)).toBe(29564);
    expect(entries.every(event => event.reason?.startsWith("東京エレクトロン短期ブレイク"))).toBe(true);
  }, 60_000);
});
