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
  getStockName: vi.fn((symbol: string) => symbol === "5803" ? "フジクラ" : "村田製作所"),
  TARGET_STOCKS: [
    { symbol: "5803", ticker: "5803.T", name: "フジクラ", basePrice: 5000, sector: "非鉄金属" },
    { symbol: "6981", ticker: "6981.T", name: "村田製作所", basePrice: 8100, sector: "電子部品" },
  ],
  TRADE_EXCLUDED_SYMBOLS: new Set([]),
  ACTIVE_ENTRY_SYMBOLS: new Set(["5803", "6981"]),
}));

import { getRtCandles } from "./db";
import { processCandle } from "./realtimeSimEngine";

const dates = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"];
const allMurataCompleteDates = [
  "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-25", "2026-06-26", "2026-06-29", "2026-06-30",
  "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-06", "2026-07-07", "2026-07-09", "2026-07-10", "2026-07-13",
  "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24",
  "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-08-03", "2026-08-06", "2026-08-07", "2026-08-10",
  "2026-08-13", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-26",
];

async function replay(symbol: "5803" | "6981", replayDates = dates) {
  const events: Array<{ date: string; time: string; action: string; reason?: string; pnl?: number }> = [];
  let processedRows = 0;
  for (const tradeDate of replayDates) {
    const rows = await getRtCandles(symbol, tradeDate);
    for (const row of rows) {
      currentSnapshot = (row.boardSnapshot as Snapshot | null) ?? null;
      const result = await processCandle({
        symbol,
        tradeDate,
        candleTime: row.candleTime,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: row.volume,
      });
      processedRows++;
      if (result.action !== "none") {
        events.push({ date: tradeDate, time: row.candleTime, action: result.action, reason: result.reason, pnl: result.pnl });
      }
    }
  }
  const entries = events.filter(event => event.action === "entry");
  const exits = events.filter(event => event.pnl !== undefined);
  const wins = exits.filter(event => (event.pnl ?? 0) > 0).length;
  const losses = exits.filter(event => (event.pnl ?? 0) < 0).length;
  const pnl = exits.reduce((sum, event) => sum + (event.pnl ?? 0), 0);
  return { processedRows, events, entries, exits, wins, losses, pnl };
}

describe("5803・6981専用経路 保存KABU 5営業日・未来情報なし再生", () => {
  it("5803は候補C＋安値反転LONG＋高値失速SHORTだけを発火する", async () => {
    const result = await replay("5803");
    console.log("5803_5D_CAUSAL_REPLAY", JSON.stringify(result));
    expect(result.processedRows).toBeGreaterThan(1_500);
    expect(result.entries).toHaveLength(10);
    expect(result.exits).toHaveLength(10);
    expect(result.wins).toBe(8);
    expect(result.losses).toBe(2);
    expect(result.pnl).toBe(115_646);
    expect(result.entries.every(event => /後場安値更新SHORT|安値反転ブレイクLONG|高値失速ブレイクSHORT/.test(event.reason ?? ""))).toBe(true);
  }, 60_000);

  it("6981は安値反転LONG＋寄り付きSHORTだけを発火する", async () => {
    const result = await replay("6981");
    console.log("6981_5D_CAUSAL_REPLAY", JSON.stringify(result));
    expect(result.processedRows).toBeGreaterThan(1_500);
    expect(result.entries).toHaveLength(2);
    expect(result.exits).toHaveLength(2);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(0);
    expect(result.pnl).toBe(73_246);
    expect(result.entries.every(event => /安値反転ブレイクLONG|寄り付きブレイクSHORT/.test(event.reason ?? ""))).toBe(true);
  }, 60_000);

  it("6981寄り付きSHORTはMA8二本傾き-0.15%以上の3損失日を停止する", async () => {
    const blockedDates = ["2026-07-15", "2026-07-21", "2026-08-26"];
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    try {
      const result = await replay("6981", blockedDates);
      const openingShortEntries = result.entries.filter(event => event.reason?.startsWith("寄り付きブレイクSHORT"));
      expect(result.processedRows).toBeGreaterThan(900);
      expect(openingShortEntries).toHaveLength(0);
      for (const tradeDate of blockedDates) {
        expect(logs.some(message =>
          message.includes("6981 寄り付きブレイクSHORT: MA8二本傾き") && message.includes(tradeDate)
        )).toBe(true);
      }
    } finally {
      logSpy.mockRestore();
    }
  }, 60_000);

  it("6981寄り付きSHORTは全40完全保存日で8件7勝1敗・+217,803円を維持する", async () => {
    const result = await replay("6981", allMurataCompleteDates);
    const openingShortPnls: number[] = [];
    let activeEntryReason: string | undefined;

    for (const event of result.events) {
      if (event.action === "entry") {
        activeEntryReason = event.reason;
      } else if (event.pnl !== undefined) {
        if (activeEntryReason?.startsWith("寄り付きブレイクSHORT")) {
          openingShortPnls.push(event.pnl);
        }
        activeEntryReason = undefined;
      }
    }

    expect(result.processedRows).toBeGreaterThan(13_000);
    expect(openingShortPnls).toHaveLength(8);
    expect(openingShortPnls.filter(pnl => pnl > 0)).toHaveLength(7);
    expect(openingShortPnls.filter(pnl => pnl < 0)).toHaveLength(1);
    expect(openingShortPnls.reduce((sum, pnl) => sum + pnl, 0)).toBe(217_803);
  }, 120_000);
});
