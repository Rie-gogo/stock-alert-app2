import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const memory = vi.hoisted(() => ({
  states: new Map<string, { stateJson: unknown; stateHash: string }>(),
  events: new Map<string, "processing" | "processed" | "error">(),
  trades: [] as Array<Record<string, unknown>>,
  versions: [] as Array<Record<string, unknown>>,
  failNextStateKey: null as string | null,
}));

const dbMock = vi.hoisted(() => ({
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  claimOrRetryRtForwardShadowEvent: vi.fn(async (input: { data: { strategyVersion: string; sourceEventId: string; evaluationMode: string } }) => {
    const key = `${input.data.strategyVersion}:${input.data.sourceEventId}:${input.data.evaluationMode}`;
    const status = memory.events.get(key);
    if (status === "processed") return "completed";
    if (status === "processing") return "busy";
    memory.events.set(key, "processing");
    return "claimed";
  }),
  closeRtForwardShadowTrade: vi.fn(async () => undefined),
  failRtForwardShadowEvent: vi.fn(async (input: { strategyVersion: string; sourceEventId: string; evaluationMode: string }) => {
    memory.events.set(`${input.strategyVersion}:${input.sourceEventId}:${input.evaluationMode}`, "error");
  }),
  getRtForwardShadowState: vi.fn(async (input: { strategyVersion: string; evaluationMode: string }) => (
    memory.states.get(`${input.strategyVersion}:${input.evaluationMode}`) ?? null
  )),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring" })),
  insertRtForwardShadowTrade: vi.fn(async (input: Record<string, unknown>) => {
    memory.trades.push(input);
  }),
  releaseRtForwardShadowStateLock: vi.fn(async () => undefined),
  updateRtForwardShadowEvent: vi.fn(async (input: { strategyVersion: string; sourceEventId: string; evaluationMode: string }) => {
    memory.events.set(`${input.strategyVersion}:${input.sourceEventId}:${input.evaluationMode}`, "processed");
  }),
  upsertRtForwardShadowState: vi.fn(async (input: { strategyVersion: string; evaluationMode: string; stateJson: unknown; stateHash: string }) => {
    const key = `${input.strategyVersion}:${input.evaluationMode}`;
    if (memory.failNextStateKey === key) {
      memory.failNextStateKey = null;
      throw new Error("injected_state_write_failure");
    }
    memory.states.set(key, { stateJson: input.stateJson, stateHash: input.stateHash });
  }),
  upsertRtStrategyVersion: vi.fn(async (input: Record<string, unknown>) => {
    memory.versions.push(input);
  }),
}));

vi.mock("./db", () => dbMock);

import {
  TAIYO_BOARD_DEMAND_VERSION,
  TAIYO_RR2_PROTECT_VERSION,
  sha256Stable,
} from "./runtimeIdentity";
import {
  auditTaiyoForwardShadowDay,
  processTaiyoForwardShadowSourceEvent,
  resetTaiyoForwardVersionCacheForTest,
} from "./taiyoForwardShadowEngine";
import {
  applyTaiyoBoardDemandTransition,
  createEmptyTaiyoForwardState,
} from "./taiyoForwardShadow";

const tradeDate = "2026-09-08";

function prefix(index: number) {
  return {
    sourceEventId: `prefix-${index}`,
    candle: {
      symbol: "6976",
      tradeDate,
      candleTime: `09:${String(25 + index).padStart(2, "0")}`,
      open: 100,
      high: 100.2,
      low: 99.8,
      close: 100,
      volume: 100,
    },
    board: null,
  };
}

function signal() {
  return {
    sourceEventId: "signal",
    candle: {
      symbol: "6976",
      tradeDate,
      candleTime: "09:45",
      open: 100.1,
      high: 101.2,
      low: 100,
      close: 101,
      volume: 100,
    },
    board: null,
  };
}

function confirmation() {
  return {
    sourceEventId: "confirm",
    candle: {
      symbol: "6976",
      tradeDate,
      candleTime: "09:46",
      open: 101,
      high: 101.6,
      low: 100.9,
      close: 101.5,
      volume: 100,
    },
    board: {
      asks: [{ price: 101.6, qty: 100 }, { price: 101.7, qty: 100 }],
      bids: [{ price: 101.4, qty: 150 }, { price: 101.3, qty: 150 }],
      overSellQty: 0,
      underBuyQty: 0,
    },
    currentAudit: {
      engineSequence: 22,
      resultType: "no_signal",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "before",
      stateHashAfter: "after",
      causalityStatus: "causal",
      causalityReason: "fixture",
      boardObservedAtMs: 900,
      relayAssembledAtMs: 1_000,
      relaySentAtMs: 1_100,
      cloudReceivedAtMs: 50_000,
      decisionStartedAtMs: 50_100,
      decisionCompletedAtMs: 50_200,
    },
  };
}

describe("6976 A/B 独立永続シャドー", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.trades.length = 0;
    memory.versions.length = 0;
    memory.failNextStateKey = null;
    resetTaiyoForwardVersionCacheForTest();
  });

  it("同じ6976イベントをA/B×2評価方式へ配信し、version・state・tradeを分離する", async () => {
    for (let index = 0; index < 20; index += 1) await processTaiyoForwardShadowSourceEvent(prefix(index));
    await processTaiyoForwardShadowSourceEvent(signal());
    await processTaiyoForwardShadowSourceEvent(confirmation());

    expect(new Set(memory.versions.map(version => version.versionId))).toEqual(new Set([
      TAIYO_BOARD_DEMAND_VERSION,
      TAIYO_RR2_PROTECT_VERSION,
    ]));
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${TAIYO_BOARD_DEMAND_VERSION}:signal_quality`,
      `${TAIYO_BOARD_DEMAND_VERSION}:capital_constrained`,
      `${TAIYO_RR2_PROTECT_VERSION}:signal_quality`,
      `${TAIYO_RR2_PROTECT_VERSION}:capital_constrained`,
    ]));
    expect(memory.trades).toHaveLength(4);
    expect(memory.trades.filter(trade => trade.strategyVersion === TAIYO_BOARD_DEMAND_VERSION)).toHaveLength(2);
    expect(memory.trades.filter(trade => trade.strategyVersion === TAIYO_RR2_PROTECT_VERSION)).toHaveLength(2);
    expect(memory.trades.filter(trade => trade.evaluationMode === "signal_quality"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ shares: 100 }), expect.objectContaining({ shares: 100 })]));
  });

  it("同一source event再送では完了済みA/Bを二重処理しない", async () => {
    const event = prefix(0);
    await processTaiyoForwardShadowSourceEvent(event);
    const stateWrites = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processTaiyoForwardShadowSourceEvent(event);
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(stateWrites);
    expect(dbMock.claimOrRetryRtForwardShadowEvent).toHaveBeenCalledTimes(8);
  });

  it("Aだけが失敗してもBを完了し、再送ではAだけを再試行する", async () => {
    memory.failNextStateKey = `${TAIYO_BOARD_DEMAND_VERSION}:signal_quality`;
    const event = prefix(0);
    await expect(processTaiyoForwardShadowSourceEvent(event)).rejects.toThrow("taiyo_forward_shadow_partial_failure");
    expect(memory.states.has(`${TAIYO_RR2_PROTECT_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${TAIYO_RR2_PROTECT_VERSION}:capital_constrained`)).toBe(true);
    const rr2WritesBeforeRetry = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === TAIYO_RR2_PROTECT_VERSION).length;

    await expect(processTaiyoForwardShadowSourceEvent(event)).resolves.toMatchObject({ skipped: false });
    const rr2WritesAfterRetry = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === TAIYO_RR2_PROTECT_VERSION).length;
    expect(rr2WritesAfterRetry).toBe(rr2WritesBeforeRetry);
    expect(memory.states.has(`${TAIYO_BOARD_DEMAND_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${TAIYO_BOARD_DEMAND_VERSION}:capital_constrained`)).toBe(true);
  });

  it("A/Bは注文モジュール・通常取引テーブルへ接続しない", () => {
    const engineSource = readFileSync(new URL("./taiyoForwardShadowEngine.ts", import.meta.url), "utf8");
    const pureSource = readFileSync(new URL("./taiyoForwardShadow.ts", import.meta.url), "utf8");
    for (const source of [engineSource, pureSource]) {
      expect(source).not.toContain("orderBridge");
      expect(source).not.toContain("OrderExecutor");
      expect(source).not.toContain("insertTrade(");
      expect(source).not.toContain("rtTrades");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade");
  });

  it("固定版再生はboard observedAtとrelay/cloud同一時計区間を取り込み実時hashと一致する", () => {
    const sources = [
      ...Array.from({ length: 20 }, (_, index) => prefix(index)),
      signal(),
      confirmation(),
    ];
    const sourceEvents = sources.map((item, index) => ({
      id: index + 1,
      sourceEventId: item.sourceEventId,
      status: "processed",
      resultAction: "none",
      payloadJson: { ...item.candle, board: item.board },
      relayReceivedAtMs: 1_000,
      relaySentAtMs: 1_100,
      cloudReceivedAtMs: 50_000,
    }));
    const decisionEvents = sources.map((item, index) => ({
      id: index + 1,
      sourceEventId: item.sourceEventId,
      resultType: "no_signal",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "current-before",
      stateHashAfter: "current-after",
      causalityStatus: "pass",
      causalityReason: "fixture",
      decisionStartedAtMs: 50_100,
      decisionCompletedAtMs: 50_200,
      resultJson: { availabilityTimeline: { boardObservedAtMs: 900 } },
    }));
    const storedEvents: Array<{
      strategyVersion: string;
      sourceEventId: string;
      evaluationMode: "signal_quality" | "capital_constrained";
      resultType: string;
      stateHashBefore: string;
      stateHashAfter: string;
    }> = [];
    for (const mode of ["signal_quality", "capital_constrained"] as const) {
      let state = createEmptyTaiyoForwardState("board_demand");
      for (const item of sources) {
        const currentAudit = {
          engineSequence: 1,
          resultType: "no_signal",
          routeId: null,
          marginUsedBefore: 0,
          marginUsedAfter: 0,
          stateHashBefore: "current-before",
          stateHashAfter: "current-after",
          causalityStatus: "pass",
          causalityReason: "fixture",
          boardObservedAtMs: 900,
          relayAssembledAtMs: 1_000,
          relaySentAtMs: 1_100,
          cloudReceivedAtMs: 50_000,
          decisionStartedAtMs: 50_100,
          decisionCompletedAtMs: 50_200,
        };
        const sourceInput = { ...item, currentAudit };
        const stateHashBefore = sha256Stable(state.tradeDate === item.candle.tradeDate
          ? state
          : { ...createEmptyTaiyoForwardState("board_demand"), tradeDate: item.candle.tradeDate });
        const transition = applyTaiyoBoardDemandTransition(state, sourceInput, mode);
        const stateHashAfter = sha256Stable(transition.nextState);
        storedEvents.push({
          strategyVersion: TAIYO_BOARD_DEMAND_VERSION,
          sourceEventId: item.sourceEventId,
          evaluationMode: mode,
          resultType: transition.resultType,
          stateHashBefore,
          stateHashAfter,
        });
        state = transition.nextState;
      }
    }
    expect(auditTaiyoForwardShadowDay(sourceEvents, storedEvents, decisionEvents, "board_demand")).toEqual({
      replayedEvents: 44,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });
});
