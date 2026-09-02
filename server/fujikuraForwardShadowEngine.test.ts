import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const memory = vi.hoisted(() => ({
  states: new Map<string, any>(),
  claims: new Map<string, "pending" | "error" | "completed">(),
  trades: [] as any[],
  events: [] as any[],
  versions: [] as any[],
}));

vi.mock("./db", () => ({
  upsertRtStrategyVersion: vi.fn(async data => memory.versions.push(data)),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring", statusReason: null })),
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  releaseRtForwardShadowStateLock: vi.fn(),
  getRtForwardShadowState: vi.fn(async ({ strategyVersion, evaluationMode }) => memory.states.get(`${strategyVersion}:${evaluationMode}`) ?? null),
  upsertRtForwardShadowState: vi.fn(async data => memory.states.set(`${data.strategyVersion}:${data.evaluationMode}`, { ...data })),
  claimOrRetryRtForwardShadowEvent: vi.fn(async ({ data }) => {
    const key = `${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`;
    const status = memory.claims.get(key);
    if (status === "pending" || status === "completed") return "completed";
    memory.claims.set(key, "pending");
    memory.events.push({ ...data });
    return "claimed";
  }),
  failRtForwardShadowEvent: vi.fn(async data => {
    memory.claims.set(`${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`, "error");
  }),
  updateRtForwardShadowEvent: vi.fn(async data => {
    const target = memory.events.find(item => item.strategyVersion === data.strategyVersion
      && item.sourceEventId === data.sourceEventId
      && item.evaluationMode === data.evaluationMode);
    Object.assign(target, data);
    memory.claims.set(`${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`, "completed");
  }),
  insertRtForwardShadowTrade: vi.fn(async data => memory.trades.push({ ...data })),
  closeRtForwardShadowTrade: vi.fn(async data => {
    const target = memory.trades.find(item => item.strategyVersion === data.strategyVersion
      && item.evaluationMode === data.evaluationMode
      && item.entrySourceEventId === data.entrySourceEventId);
    Object.assign(target, data);
  }),
}));

import {
  applyFujikuraForwardTransition,
  calculateFujikuraExitForTest,
  processFujikuraForwardShadowSourceEvent,
  replayFujikuraForwardShadowDay,
  type FujikuraForwardShadowState,
} from "./fujikuraForwardShadowEngine";
import { FUJIKURA_FORWARD_STRATEGY_VERSION, FORWARD_STRATEGY_VERSION, sha256Stable } from "./runtimeIdentity";

function timeAt(index: number): string {
  const total = 9 * 60 + 45 + index;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function board(currentPrice: number, bpr = 0.65) {
  return {
    currentPrice,
    asks: [{ price: currentPrice + 0.5, qty: 1_000 }],
    bids: [{ price: currentPrice - 0.5, qty: Math.round(1_000 * bpr) }],
    overSellQty: 0,
    underBuyQty: 0,
  };
}

describe("5803 A＋B 独立前向きシャドー", () => {
  beforeEach(() => {
    memory.states.clear();
    memory.claims.clear();
    memory.trades.length = 0;
    memory.events.length = 0;
    memory.versions.length = 0;
  });

  it("8035とは別version・別状態で、BPR0.70以下の確認後に受信時点価格で2方式へentryする", async () => {
    const telSentinel = { stateJson: { untouched: true } };
    memory.states.set(`${FORWARD_STRATEGY_VERSION}:signal_quality`, telSentinel);
    for (let index = 0; index < 20; index += 1) {
      const close = 995 + index * 0.2;
      await processFujikuraForwardShadowSourceEvent({
        sourceEventId: `f-session:${index + 1}`,
        candle: {
          symbol: "5803", tradeDate: "2026-09-03", candleTime: timeAt(index),
          open: index === 0 ? 1_000 : close - 0.1,
          high: close + 0.2,
          low: index === 0 ? 994 : close - 0.3,
          close,
          volume: 100,
        },
        board: board(close),
      });
    }
    await processFujikuraForwardShadowSourceEvent({
      sourceEventId: "f-session:21",
      candle: {
        symbol: "5803", tradeDate: "2026-09-03", candleTime: "10:05",
        open: 999.5, high: 1_001, low: 999.4, close: 1_000.5, volume: 200,
      },
      board: board(1_000.5),
    });
    expect(memory.trades).toHaveLength(0);
    await processFujikuraForwardShadowSourceEvent({
      sourceEventId: "f-session:22",
      candle: {
        symbol: "5803", tradeDate: "2026-09-03", candleTime: "10:06",
        open: 1_000.6, high: 1_001.1, low: 1_000.5, close: 1_000.8, volume: 100,
      },
      board: board(1_000.75, 0.65),
    });

    expect(memory.trades).toHaveLength(2);
    expect(memory.trades.every(item => item.strategyVersion === FUJIKURA_FORWARD_STRATEGY_VERSION)).toBe(true);
    expect(memory.trades.find(item => item.evaluationMode === "signal_quality")).toMatchObject({
      entryPrice: "1000.7500",
      theoreticalSignalPrice: "1000.8000",
      shares: 100,
      slPct: "0.5000",
      tpPct: "1.0000",
    });
    expect(memory.trades.find(item => item.evaluationMode === "capital_constrained")?.shares).toBeGreaterThan(100);
    expect(memory.states.get(`${FORWARD_STRATEGY_VERSION}:signal_quality`)).toBe(telSentinel);
  });

  it("+0.5%発動足では決済せず、次イベント以降+0.3%戻りを窓下げ不利価格で保護決済する", async () => {
    const state: FujikuraForwardShadowState = {
      tradeDate: "2026-09-03",
      candles: [],
      pendingEntry: null,
      position: {
        side: "long",
        entrySourceEventId: "entry:1",
        signalTime: "10:00",
        entryTime: "10:01",
        theoreticalSignalPrice: 1_000,
        entryPrice: 1_000,
        shares: 100,
        slPct: 0.5,
        tpPct: 1.0,
        profitProtectionArmedAtSourceEventId: null,
      },
      dailySlotConsumed: true,
      stopped: false,
      lastSourceEventId: null,
      lastResultType: null,
      lastActions: [],
    };
    const armed = applyFujikuraForwardTransition(state, {
      sourceEventId: "bar:1",
      candle: { symbol: "5803", tradeDate: "2026-09-03", candleTime: "10:02", open: 1_001, high: 1_006, low: 1_000, close: 1_005, volume: 100 },
      board: board(1_005),
    }, "signal_quality");
    expect(armed.resultType).toBe("hold");
    expect(armed.nextState.position?.profitProtectionArmedAtSourceEventId).toBe("bar:1");

    const protectedExit = calculateFujikuraExitForTest(armed.nextState.position!, {
      symbol: "5803", tradeDate: "2026-09-03", candleTime: "10:03", open: 1_002, high: 1_004, low: 1_001, close: 1_002, volume: 100,
    }, "bar:2");
    expect(protectedExit).toEqual({ price: 1_002, reason: "profit_protection" });
  });

  it("BPRが0.70を超える確認は日次枠を消費せず拒否する", () => {
    const state: FujikuraForwardShadowState = {
      tradeDate: "2026-09-03",
      candles: [],
      pendingEntry: {
        triggerClose: 1_000,
        signalSourceEventId: "signal:1",
        signalTime: "10:00",
        theoreticalSignalPrice: 1_000,
        metrics: {},
      },
      position: null,
      dailySlotConsumed: false,
      stopped: false,
      lastSourceEventId: null,
      lastResultType: null,
      lastActions: [],
    };
    const transition = applyFujikuraForwardTransition(state, {
      sourceEventId: "confirm:1",
      candle: { symbol: "5803", tradeDate: "2026-09-03", candleTime: "10:01", open: 1_000, high: 1_002, low: 999, close: 1_001, volume: 100 },
      board: board(1_001, 0.71),
    }, "signal_quality");
    expect(transition.resultType).toBe("rejected");
    expect(transition.nextState.dailySlotConsumed).toBe(false);
    expect(transition.nextState.position).toBeNull();
  });

  it("注文生成・通常rt_tradesへ構造的に接続しない", () => {
    const source = readFileSync(new URL("./fujikuraForwardShadowEngine.ts", import.meta.url), "utf8");
    expect(source).not.toContain("./orderBridge");
    expect(source).not.toContain("insertRtTrade(");
    expect(source).toContain("insertRtForwardShadowTrade(");
    expect(source).toContain("acquireRtForwardShadowStateLock(");
    expect(source).toContain("finally {");
    expect(source).toContain("releaseRtForwardShadowStateLock(");
  });

  it("当日payloadを同じ純粋コアへ再生すると5803別versionの実時状態ハッシュと一致する", () => {
    const sourceEvent = {
      sourceEventId: "replay:1",
      status: "processed",
      resultAction: "none",
      payloadJson: {
        symbol: "5803", tradeDate: "2026-09-03", candleTime: "09:45",
        open: 1_000, high: 1_001, low: 999, close: 1_000, volume: 100,
        board: board(1_000),
      },
    };
    const initialState: FujikuraForwardShadowState = {
      tradeDate: null,
      candles: [],
      pendingEntry: null,
      position: null,
      dailySlotConsumed: false,
      stopped: false,
      lastSourceEventId: null,
      lastResultType: null,
      lastActions: [],
    };
    const normalized = { ...initialState, tradeDate: "2026-09-03" };
    const storedEvents = (["signal_quality", "capital_constrained"] as const).map(mode => {
      const transition = applyFujikuraForwardTransition(normalized, {
        sourceEventId: sourceEvent.sourceEventId,
        candle: sourceEvent.payloadJson,
        board: sourceEvent.payloadJson.board,
      }, mode);
      return {
        strategyVersion: FUJIKURA_FORWARD_STRATEGY_VERSION,
        sourceEventId: sourceEvent.sourceEventId,
        evaluationMode: mode,
        resultType: transition.resultType,
        stateHashBefore: sha256Stable(normalized),
        stateHashAfter: sha256Stable(transition.nextState),
      };
    });
    expect(replayFujikuraForwardShadowDay([sourceEvent], storedEvents)).toMatchObject({
      replayedEvents: 2,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });
});
