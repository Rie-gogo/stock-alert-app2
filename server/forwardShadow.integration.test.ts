import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  states: new Map<string, any>(),
  claims: new Set<string>(),
  trades: [] as any[],
  events: [] as any[],
}));

vi.mock("./db", () => ({
  upsertRtStrategyVersion: vi.fn(),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring", statusReason: null })),
  updateRtStrategyVersionStatus: vi.fn(),
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  releaseRtForwardShadowStateLock: vi.fn(),
  getRtForwardShadowState: vi.fn(async ({ strategyVersion, evaluationMode }) => memory.states.get(`${strategyVersion}:${evaluationMode}`) ?? null),
  upsertRtForwardShadowState: vi.fn(async data => memory.states.set(`${data.strategyVersion}:${data.evaluationMode}`, { ...data })),
  claimOrRetryRtForwardShadowEvent: vi.fn(async ({ data }) => {
    const key = `${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`;
    if (memory.claims.has(key)) return "completed";
    memory.claims.add(key);
    memory.events.push({ ...data });
    return "claimed";
  }),
  failRtForwardShadowEvent: vi.fn(),
  updateRtForwardShadowEvent: vi.fn(async data => {
    const target = memory.events.find(item => item.strategyVersion === data.strategyVersion
      && item.sourceEventId === data.sourceEventId
      && item.evaluationMode === data.evaluationMode);
    Object.assign(target, data);
  }),
  insertRtForwardShadowTrade: vi.fn(async data => memory.trades.push({ ...data })),
  closeRtForwardShadowTrade: vi.fn(async data => {
    const target = memory.trades.find(item => item.strategyVersion === data.strategyVersion
      && item.evaluationMode === data.evaluationMode
      && item.entrySourceEventId === data.entrySourceEventId);
    Object.assign(target, data);
  }),
  getRtForwardShadowTrades: vi.fn(async () => memory.trades),
}));

import { processForwardShadowSourceEvent } from "./forwardShadow";
import {
  FORWARD_STRATEGY_VERSION,
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  TEL_CURRENT_PARITY_VERSION,
  TEL_EXECUTABLE_DEPTH_VERSION,
  TEL_EXECUTABLE_CONFIRM_VERSION,
} from "./runtimeIdentity";

function minuteTime(index: number): string {
  const total = 9 * 60 + 40 + index;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

describe("8035未見データ前向きシャドー統合", () => {
  beforeEach(() => {
    memory.states.clear();
    memory.claims.clear();
    memory.trades.length = 0;
    memory.events.length = 0;
  });

  it("共通判定コアのシグナルを受信時点板現在値で2つの独立方式へ一度だけ約定する", async () => {
    for (let index = 0; index < 20; index += 1) {
      const time = minuteTime(index);
      await processForwardShadowSourceEvent({
        sourceEventId: `session:${index + 1}`,
        candle: {
          symbol: "8035", tradeDate: "2026-09-03", candleTime: time,
          open: 100, high: 100.1, low: 99.9, close: 100, volume: 100,
        },
        board: { currentPrice: 100 },
      });
    }

    await processForwardShadowSourceEvent({
      sourceEventId: "session:21",
      candle: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:00",
        open: 100, high: 101.1, low: 99.9, close: 101, volume: 200,
      },
      board: { currentPrice: 101 },
    });
    expect(memory.trades).toHaveLength(0);

    await processForwardShadowSourceEvent({
      sourceEventId: "session:22",
      candle: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:01",
        open: 101.2, high: 101.3, low: 101.1, close: 101.25, volume: 100,
      },
      board: { currentPrice: 101.22 },
    });
    expect(memory.trades).toHaveLength(2);
    expect(memory.trades.find(item => item.evaluationMode === "signal_quality")).toMatchObject({
      strategyVersion: FORWARD_STRATEGY_VERSION,
      entryPrice: "101.2200",
      theoreticalSignalPrice: "101.0000",
      shares: 100,
    });
    expect(memory.trades.find(item => item.evaluationMode === "capital_constrained")?.shares).toBeGreaterThan(100);

    await processForwardShadowSourceEvent({
      sourceEventId: "session:23",
      candle: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:02",
        open: 101.3, high: 102.6, low: 101.2, close: 102.5, volume: 100,
      },
      board: { currentPrice: 102.5 },
    });
    expect(memory.trades.every(item => item.exitReason === "take_profit")).toBe(true);
    expect(memory.states.get(`${FORWARD_STRATEGY_VERSION}:signal_quality`).stateJson.position).toBeNull();
    expect(memory.states.get(`${FORWARD_STRATEGY_VERSION}:capital_constrained`).stateJson.position).toBeNull();

    const eventCount = memory.events.length;
    await processForwardShadowSourceEvent({
      sourceEventId: "session:23",
      candle: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:02",
        open: 101.3, high: 102.6, low: 101.2, close: 102.5, volume: 100,
      },
      board: { currentPrice: 102.5 },
    });
    expect(memory.events).toHaveLength(eventCount);
  });

  it("9月7日以降は既存8035・現行parity・旧A・depth新版を別version・別2評価状態で並走する", async () => {
    for (let index = 0; index < 30; index += 1) {
      await processForwardShadowSourceEvent({
        sourceEventId: `triple:${index + 1}`,
        candle: {
          symbol: "8035", tradeDate: "2026-09-07", candleTime: minuteTime(index),
          open: 100, high: 100.1, low: 99.9, close: 100, volume: 100,
        },
        board: { currentPrice: 100 },
        currentAudit: {
          engineSequence: index + 1, resultType: "no_signal", routeId: null,
          marginUsedBefore: 0, marginUsedAfter: 0,
          stateHashBefore: "before", stateHashAfter: "after",
          causalityStatus: "pass", causalityReason: "test",
        },
      });
    }
    await processForwardShadowSourceEvent({
      sourceEventId: "triple:31",
      candle: {
        symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:10",
        open: 100, high: 101.1, low: 99.9, close: 101, volume: 200,
      },
        board: { currentPrice: 101, asks: [{ price: 101.02, qty: 100_000 }], bids: [{ price: 100.98, qty: 100_000 }] },
        currentAudit: {
          engineSequence: 31, resultType: "entry", routeId: "8035_open_direction_breakout_long",
          marginUsedBefore: 0, marginUsedAfter: 2_700_000,
          stateHashBefore: "before", stateHashAfter: "after",
          causalityStatus: "violation", causalityReason: "bar_close_fill",
          boardObservedAtMs: 1_000, relayAssembledAtMs: 1_000, relaySentAtMs: 1_050, cloudReceivedAtMs: 1_100,
          decisionStartedAtMs: 1_100, decisionCompletedAtMs: 1_200,
      },
    });
    await processForwardShadowSourceEvent({
      sourceEventId: "triple:32",
      candle: {
        symbol: "8035", tradeDate: "2026-09-07", candleTime: "10:11",
        open: 101, high: 101.2, low: 100.9, close: 101.1, volume: 100,
      },
        board: { currentPrice: 101.05, asks: [{ price: 101.05, qty: 100_000 }], bids: [{ price: 101.03, qty: 100_000 }] },
        currentAudit: {
        engineSequence: 32, resultType: "hold", routeId: null,
        marginUsedBefore: 2_700_000, marginUsedAfter: 2_700_000,
          stateHashBefore: "before", stateHashAfter: "after",
          causalityStatus: "pass", causalityReason: "no_fill_price_used",
          boardObservedAtMs: 2_000, relayAssembledAtMs: 2_000, relaySentAtMs: 2_050, cloudReceivedAtMs: 2_100,
          decisionStartedAtMs: 2_100, decisionCompletedAtMs: 2_200,
      },
    });

    const versions = new Set(memory.trades.map(item => item.strategyVersion));
    expect(versions).toEqual(new Set([
      FORWARD_STRATEGY_VERSION,
      TEL_CURRENT_PARITY_VERSION,
      TEL_EXECUTABLE_CONFIRM_VERSION,
      TEL_EXECUTABLE_DEPTH_VERSION,
    ]));
    for (const version of versions) {
      expect(memory.trades.filter(item => item.strategyVersion === version)).toHaveLength(2);
      expect(memory.states.has(`${version}:signal_quality`)).toBe(true);
      expect(memory.states.has(`${version}:capital_constrained`)).toBe(true);
    }
  });

  it("9984現行source eventをA/Bの別version・別2評価状態へ同時配信する", async () => {
    for (let index = 0; index < 20; index += 1) {
      await processForwardShadowSourceEvent({
        sourceEventId: `softbank:${index + 1}`,
        candle: {
          symbol: "9984", tradeDate: "2026-09-07", candleTime: minuteTime(index),
          open: 98.95 + index * 0.1, high: 99.05 + index * 0.1,
          low: 98.9 + index * 0.1, close: 99 + index * 0.1, volume: 100,
        },
        board: null,
      });
    }
    await processForwardShadowSourceEvent({
      sourceEventId: "softbank:signal",
      candle: {
        symbol: "9984", tradeDate: "2026-09-07", candleTime: "10:00",
        open: 102.4, high: 103.1, low: 102.3, close: 103, volume: 200,
      },
      board: null,
    });
    await processForwardShadowSourceEvent({
      sourceEventId: "softbank:confirm",
      candle: {
        symbol: "9984", tradeDate: "2026-09-07", candleTime: "10:01",
        open: 103, high: 103.2, low: 102.8, close: 103.1, volume: 100,
      },
      board: { asks: [{ price: 102.9, qty: 100 }] },
      currentAudit: {
        engineSequence: 22, resultType: "no_signal", routeId: null,
        marginUsedBefore: 0, marginUsedAfter: 0,
        stateHashBefore: "before", stateHashAfter: "after",
        causalityStatus: "pass", causalityReason: "test",
        boardObservedAtMs: 1_000, relayAssembledAtMs: 1_050, relaySentAtMs: 1_100,
        cloudReceivedAtMs: 50_000, decisionStartedAtMs: 50_050, decisionCompletedAtMs: 50_200,
      },
    });

    expect(new Set(memory.trades.map(item => item.strategyVersion))).toEqual(new Set([
      SOFTBANK_DEPTH_CONFIRM_VERSION,
      SOFTBANK_RR2_PROTECT_VERSION,
    ]));
    expect(memory.trades).toHaveLength(4);
    for (const version of [SOFTBANK_DEPTH_CONFIRM_VERSION, SOFTBANK_RR2_PROTECT_VERSION]) {
      expect(memory.trades.filter(item => item.strategyVersion === version)).toHaveLength(2);
      expect(memory.states.has(`${version}:signal_quality`)).toBe(true);
      expect(memory.states.has(`${version}:capital_constrained`)).toBe(true);
    }
  });

  it("6976候補B source eventをA/Bの別version・別2評価状態へ同時配信する", async () => {
    for (let index = 0; index < 20; index += 1) {
      await processForwardShadowSourceEvent({
        sourceEventId: `taiyo:${index + 1}`,
        candle: {
          symbol: "6976",
          tradeDate: "2026-09-08",
          candleTime: `09:${String(25 + index).padStart(2, "0")}`,
          open: 100,
          high: 100.2,
          low: 99.8,
          close: 100,
          volume: 100,
        },
        board: null,
      });
    }
    await processForwardShadowSourceEvent({
      sourceEventId: "taiyo:signal",
      candle: {
        symbol: "6976", tradeDate: "2026-09-08", candleTime: "09:45",
        open: 100.1, high: 101.2, low: 100, close: 101, volume: 100,
      },
      board: null,
    });
    await processForwardShadowSourceEvent({
      sourceEventId: "taiyo:confirm",
      candle: {
        symbol: "6976", tradeDate: "2026-09-08", candleTime: "09:46",
        open: 101, high: 101.6, low: 100.9, close: 101.5, volume: 100,
      },
      board: {
        asks: [{ price: 101.6, qty: 100 }, { price: 101.7, qty: 100 }],
        bids: [{ price: 101.4, qty: 150 }, { price: 101.3, qty: 150 }],
        overSellQty: 0,
        underBuyQty: 0,
      },
      currentAudit: {
        engineSequence: 22, resultType: "no_signal", routeId: null,
        marginUsedBefore: 0, marginUsedAfter: 0,
        stateHashBefore: "before", stateHashAfter: "after",
        causalityStatus: "pass", causalityReason: "test",
        boardObservedAtMs: 1_000, relayAssembledAtMs: 1_050, relaySentAtMs: 1_100,
        cloudReceivedAtMs: 50_000, decisionStartedAtMs: 50_050, decisionCompletedAtMs: 50_200,
      },
    });

    expect(new Set(memory.trades.map(item => item.strategyVersion))).toEqual(new Set([
      TAIYO_BOARD_DEMAND_VERSION,
      TAIYO_RR2_PROTECT_VERSION,
    ]));
    expect(memory.trades).toHaveLength(4);
    for (const version of [TAIYO_BOARD_DEMAND_VERSION, TAIYO_RR2_PROTECT_VERSION]) {
      expect(memory.trades.filter(item => item.strategyVersion === version)).toHaveLength(2);
      expect(memory.states.has(`${version}:signal_quality`)).toBe(true);
      expect(memory.states.has(`${version}:capital_constrained`)).toBe(true);
    }
  });
});
