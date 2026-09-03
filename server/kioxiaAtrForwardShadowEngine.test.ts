import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  failRtForwardShadowEvent: vi.fn(async data => memory.claims.set(`${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`, "error")),
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
  applyKioxiaAtrForwardTransition,
  emptyKioxiaAtrForwardState,
} from "./kioxiaAtrForwardShadow";
import {
  KIOXIA_ATR_FORWARD_EVALUATION_START_DATE,
  KIOXIA_ATR_FORWARD_LEARNING_CUTOFF_DATE,
  processKioxiaAtrForwardShadowSourceEvent,
  replayKioxiaAtrForwardShadowDay,
} from "./kioxiaAtrForwardShadowEngine";
import {
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  sha256Stable,
} from "./runtimeIdentity";

function board(currentPrice: number) {
  return {
    currentPrice,
    asks: [{ price: currentPrice + 1, qty: 1_000 }],
    bids: [{ price: currentPrice - 1, qty: 1_000 }],
    overSellQty: 0,
    underBuyQty: 0,
    marketOrderBuyQty: 0,
    marketOrderSellQty: 0,
  };
}

function seededState() {
  const state = emptyKioxiaAtrForwardState();
  state.tradeDate = "2026-09-07";
  state.candles = Array.from({ length: 29 }, (_, index) => {
    const close = 999 + index * 0.02;
    return {
      time: `09:${String(31 + index).padStart(2, "0")}`,
      open: index === 0 ? 995 : close - 0.05,
      high: close + 0.8,
      low: close - 3,
      close,
      volume: 100,
    };
  });
  return state;
}

function entryInput(sourceEventId = "kioxia-atr:entry") {
  return {
    sourceEventId,
    candle: {
      symbol: "285A", tradeDate: "2026-09-07", candleTime: "10:00",
      open: 999, high: 1_003, low: 998, close: 1_002, volume: 200,
    },
    board: board(1_002.25),
  };
}

describe("285A第2独立前向きシャドーエンジン", () => {
  beforeEach(() => {
    memory.states.clear();
    memory.claims.clear();
    memory.trades.length = 0;
    memory.events.length = 0;
    memory.versions.length = 0;
  });

  it("現行・8035・5803・第1案と別version/状態で2評価方式を一度だけ保存する", async () => {
    const sentinels = [FORWARD_STRATEGY_VERSION, FUJIKURA_FORWARD_STRATEGY_VERSION, KIOXIA_FORWARD_STRATEGY_VERSION]
      .map(version => [`${version}:signal_quality`, { stateJson: { untouched: version } }] as const);
    for (const [key, value] of sentinels) memory.states.set(key, value);
    for (const mode of ["signal_quality", "capital_constrained"] as const) {
      memory.states.set(`${KIOXIA_ATR_FORWARD_STRATEGY_VERSION}:${mode}`, { stateJson: seededState() });
    }

    await processKioxiaAtrForwardShadowSourceEvent(entryInput());
    await processKioxiaAtrForwardShadowSourceEvent(entryInput());

    expect(memory.trades).toHaveLength(2);
    expect(memory.trades.every(item => item.strategyVersion === KIOXIA_ATR_FORWARD_STRATEGY_VERSION)).toBe(true);
    expect(memory.trades.find(item => item.evaluationMode === "signal_quality")).toMatchObject({
      entryPrice: "1002.2500",
      theoreticalSignalPrice: "1002.0000",
      shares: 100,
      slPct: "0.8000",
      tpPct: "1.6000",
    });
    expect(memory.trades.find(item => item.evaluationMode === "capital_constrained")?.shares).toBe(2_600);
    expect(memory.events).toHaveLength(2);
    for (const [key, value] of sentinels) expect(memory.states.get(key)).toBe(value);
    expect(memory.versions[0]).toMatchObject({
      versionId: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
      learningCutoffDate: KIOXIA_ATR_FORWARD_LEARNING_CUTOFF_DATE,
      evaluationStartDate: KIOXIA_ATR_FORWARD_EVALUATION_START_DATE,
      configJson: expect.objectContaining({
        candidateKey: "285a_current_five_routes_atr036_route_daily_end",
        orderInstructionConnection: false,
        currentTradeTableConnection: false,
      }),
    });
  });

  it("当日payloadを同じ純粋コアへ再生すると第2案の状態ハッシュと一致する", () => {
    const sourceEvent = {
      sourceEventId: "replay:atr:1",
      status: "processed",
      resultAction: "none",
      payloadJson: {
        symbol: "285A", tradeDate: "2026-09-07", candleTime: "09:00",
        open: 1_000, high: 1_001, low: 999, close: 1_000, volume: 100,
        board: board(1_000),
      },
    };
    const initial = emptyKioxiaAtrForwardState();
    initial.tradeDate = "2026-09-07";
    const storedEvents = (["signal_quality", "capital_constrained"] as const).map(mode => {
      const transition = applyKioxiaAtrForwardTransition(initial, {
        sourceEventId: sourceEvent.sourceEventId,
        candle: sourceEvent.payloadJson,
        board: sourceEvent.payloadJson.board,
      }, mode);
      return {
        strategyVersion: KIOXIA_ATR_FORWARD_STRATEGY_VERSION,
        sourceEventId: sourceEvent.sourceEventId,
        evaluationMode: mode,
        resultType: transition.resultType,
        stateHashBefore: sha256Stable(initial),
        stateHashAfter: sha256Stable(transition.nextState),
      };
    });
    expect(replayKioxiaAtrForwardShadowDay([sourceEvent], storedEvents)).toMatchObject({
      replayedEvents: 2,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });

  it("通常rt_trades・OrderBridge・Windows Executorへ構造的に接続しない", () => {
    const engineSource = readFileSync(new URL("./kioxiaAtrForwardShadowEngine.ts", import.meta.url), "utf8");
    const specSource = readFileSync(new URL("./kioxiaAtrForwardShadow.ts", import.meta.url), "utf8");
    for (const source of [engineSource, specSource]) {
      expect(source).not.toContain("./orderBridge");
      expect(source).not.toContain("insertRtTrade(");
      expect(source).not.toContain("kabu_board_relay");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade(");
    expect(engineSource).toContain("orderInstructionCreated: false");
    expect(engineSource).toContain("acquireRtForwardShadowStateLock(");
    expect(engineSource).toContain("releaseRtForwardShadowStateLock(");
  });
});
