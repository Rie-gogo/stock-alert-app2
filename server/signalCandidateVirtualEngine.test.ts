import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ trades: [] as any[] }));
const dbMock = vi.hoisted(() => ({
  getOpenRtSignalCandidateTrades: vi.fn(async () => memory.trades.filter(trade => !trade.completed)),
  upsertRtSignalCandidateTrade: vi.fn(async (input: any) => {
    const index = memory.trades.findIndex(trade => trade.candidateId === input.candidateId);
    const value = { id: index >= 0 ? memory.trades[index].id : memory.trades.length + 1, ...input };
    if (index >= 0) memory.trades[index] = value;
    else memory.trades.push(value);
    return value;
  }),
}));
vi.mock("./db", () => dbMock);

import { processSignalQualityVirtualTradesForEvent } from "./signalCandidateVirtualEngine";

const candle = (time: string, open: number, high: number, low: number, close: number) => ({
  symbol: "8035", tradeDate: "2026-09-07", candleTime: time, open, high, low, close, volume: 1_000,
});

describe("全candidate 100株signal_quality仮想取引", () => {
  beforeEach(() => {
    memory.trades.length = 0;
    vi.clearAllMocks();
  });

  it("margin_block候補も100株で開き、同一足SL/TP接触はSLを優先する", async () => {
    const candidate = {
      id: 1,
      candidateVersion: "current-10-symbol-candidates-v1",
      sourceEventId: "entry:1",
      engineSequence: 1,
      tradeDate: "2026-09-07",
      candleTime: "10:00",
      symbol: "8035",
      routeId: "telShortBreak",
      side: "long",
      signalReason: "匿名fixture",
      theoreticalEntryPrice: "100",
      realtimeDecision: "margin_block",
      slPct: "0.6",
      tpPct: "1.2",
      maxHoldingMinutes: 20,
      capitalShares: 100,
      requiredMargin: 10_000,
      inputJson: { routeSpec: { sessionExitTime: "11:27", maxHoldingMinutes: 20, timeExitPriceMode: "next_bar_open" } },
    } as any;
    await processSignalQualityVirtualTradesForEvent({ sourceEventId: "entry:1", candle: candle("10:00", 100, 100, 100, 100) as any, candidate });
    await processSignalQualityVirtualTradesForEvent({ sourceEventId: "next:1", candle: candle("10:01", 100, 102, 98, 100) as any, candidate: null });
    expect(memory.trades).toHaveLength(1);
    expect(memory.trades[0]).toMatchObject({
      shares: 100,
      completed: true,
      exitReason: "stop_loss",
      exitPrice: "99.4",
      pnl: -60,
    });
  });

  it("routeで許可されたraw signal反転をSL/TP後・時間出口前に適用する", async () => {
    memory.trades.push({
      id: 1,
      virtualEngineVersion: "current-signal-quality-100-v1",
      candidateId: 1,
      entrySourceEventId: "entry:signal",
      tradeDate: "2026-09-07",
      symbol: "8035",
      routeId: "generic_long",
      side: "long",
      entryCandleTime: "10:00",
      entryPrice: "100",
      shares: 100,
      slPct: "1",
      tpPct: "2",
      maxHoldingMinutes: 30,
      stateJson: { routeSpec: { usesSignalReversalExit: true, usesBoardEarlyExit: true }, armedAt: null, mfePct: 0, maePct: 0 },
      completed: false,
    });

    await processSignalQualityVirtualTradesForEvent({
      sourceEventId: "signal:1",
      candle: candle("10:01", 100.2, 100.4, 100.1, 100.2) as any,
      candidate: null,
      rawSignal: { type: "sell", reason: "匿名反転" },
      boardSignal: "neutral",
    });

    expect(memory.trades[0]).toMatchObject({
      completed: true,
      exitPrice: "100.2",
      exitReason: "signal_reversal:匿名反転",
      pnl: 20,
    });
  });

  it("routeで許可された同時点board逆圧力を最低利益率到達後だけ早期利確へ使う", async () => {
    memory.trades.push({
      id: 1,
      virtualEngineVersion: "current-signal-quality-100-v1",
      candidateId: 2,
      entrySourceEventId: "entry:board",
      tradeDate: "2026-09-07",
      symbol: "8035",
      routeId: "generic_short",
      side: "short",
      entryCandleTime: "10:00",
      entryPrice: "100",
      shares: 100,
      slPct: "1",
      tpPct: "2",
      maxHoldingMinutes: 30,
      stateJson: { routeSpec: { usesSignalReversalExit: true, usesBoardEarlyExit: true }, armedAt: null, mfePct: 0, maePct: 0 },
      completed: false,
    });

    await processSignalQualityVirtualTradesForEvent({
      sourceEventId: "board:1",
      candle: candle("10:01", 99.9, 99.95, 99.8, 99.9) as any,
      candidate: null,
      rawSignal: null,
      boardSignal: "buy_pressure",
    });

    expect(memory.trades[0]).toMatchObject({
      completed: true,
      exitPrice: "99.9",
      exitReason: "board_early_exit:buy_pressure",
      pnl: 10,
    });
    expect(memory.trades[0].stateJson.lastMarketContext).toEqual({
      sourceEventId: "board:1",
      rawSignal: null,
      boardSignal: "buy_pressure",
    });
  });
});
