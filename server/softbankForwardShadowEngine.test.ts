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
  SOFTBANK_DEPTH_CONFIRM_VERSION,
  SOFTBANK_RR2_PROTECT_VERSION,
} from "./runtimeIdentity";
import {
  processSoftbankForwardShadowSourceEvent,
  resetSoftbankForwardVersionCacheForTest,
} from "./softbankForwardShadowEngine";

function source(index: number) {
  const minute = 20 + index;
  const close = 99 + index * 0.1;
  return {
    sourceEventId: `source-${index}`,
    candle: {
      symbol: "9984",
      tradeDate: "2026-09-07",
      candleTime: `09:${String(minute).padStart(2, "0")}`,
      open: close - 0.05,
      high: close + 0.05,
      low: close - 0.1,
      close,
      volume: 100,
    },
    board: null,
  };
}

describe("9984 A/B 独立永続シャドー", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.trades.length = 0;
    memory.versions.length = 0;
    memory.failNextStateKey = null;
    resetSoftbankForwardVersionCacheForTest();
  });

  it("同じ9984イベントをA/B×2評価方式へ配信し、version・state・tradeを分離する", async () => {
    for (let index = 0; index < 20; index += 1) {
      await processSoftbankForwardShadowSourceEvent(source(index));
    }
    await processSoftbankForwardShadowSourceEvent({
      sourceEventId: "signal",
      candle: {
        symbol: "9984", tradeDate: "2026-09-07", candleTime: "09:40",
        open: 102.4, high: 103.1, low: 102.3, close: 103, volume: 200,
      },
      board: null,
    });
    await processSoftbankForwardShadowSourceEvent({
      sourceEventId: "confirm",
      candle: {
        symbol: "9984", tradeDate: "2026-09-07", candleTime: "09:41",
        open: 103, high: 103.2, low: 102.8, close: 103.1, volume: 120,
      },
      board: { asks: [{ price: 102.9, qty: 100 }] },
      currentAudit: {
        engineSequence: 22,
        resultType: "no_signal",
        routeId: null,
        marginUsedBefore: 0,
        marginUsedAfter: 0,
        stateHashBefore: "before",
        stateHashAfter: "after",
        causalityStatus: "pass",
        causalityReason: "available_at_decision",
        boardObservedAtMs: 900,
        relayAssembledAtMs: 1_000,
        relaySentAtMs: 1_100,
        cloudReceivedAtMs: 50_000,
        decisionStartedAtMs: 50_050,
        decisionCompletedAtMs: 50_200,
      },
    });

    expect(new Set(memory.versions.map(version => version.versionId))).toEqual(new Set([
      SOFTBANK_DEPTH_CONFIRM_VERSION,
      SOFTBANK_RR2_PROTECT_VERSION,
    ]));
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${SOFTBANK_DEPTH_CONFIRM_VERSION}:signal_quality`,
      `${SOFTBANK_DEPTH_CONFIRM_VERSION}:capital_constrained`,
      `${SOFTBANK_RR2_PROTECT_VERSION}:signal_quality`,
      `${SOFTBANK_RR2_PROTECT_VERSION}:capital_constrained`,
    ]));
    expect(memory.trades).toHaveLength(4);
    expect(memory.trades.filter(trade => trade.strategyVersion === SOFTBANK_DEPTH_CONFIRM_VERSION)).toHaveLength(2);
    expect(memory.trades.filter(trade => trade.strategyVersion === SOFTBANK_RR2_PROTECT_VERSION)).toHaveLength(2);
    expect(memory.trades.filter(trade => trade.evaluationMode === "signal_quality"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ shares: 100 }), expect.objectContaining({ shares: 100 })]));
  });

  it("同一source event再送では完了済みA/Bを二重処理しない", async () => {
    const event = source(0);
    await processSoftbankForwardShadowSourceEvent(event);
    const stateWrites = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processSoftbankForwardShadowSourceEvent(event);
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(stateWrites);
    expect(dbMock.claimOrRetryRtForwardShadowEvent).toHaveBeenCalledTimes(8);
  });

  it("Aだけが失敗してもBを完了し、再送ではAだけを再試行する", async () => {
    memory.failNextStateKey = `${SOFTBANK_DEPTH_CONFIRM_VERSION}:signal_quality`;
    const event = source(0);
    await expect(processSoftbankForwardShadowSourceEvent(event))
      .rejects.toThrow("softbank_forward_shadow_partial_failure");
    expect(memory.states.has(`${SOFTBANK_RR2_PROTECT_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${SOFTBANK_RR2_PROTECT_VERSION}:capital_constrained`)).toBe(true);
    const rr2WritesBeforeRetry = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SOFTBANK_RR2_PROTECT_VERSION).length;

    await expect(processSoftbankForwardShadowSourceEvent(event)).resolves.toMatchObject({ skipped: false });
    const rr2WritesAfterRetry = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SOFTBANK_RR2_PROTECT_VERSION).length;
    expect(rr2WritesAfterRetry).toBe(rr2WritesBeforeRetry);
    expect(memory.states.has(`${SOFTBANK_DEPTH_CONFIRM_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${SOFTBANK_DEPTH_CONFIRM_VERSION}:capital_constrained`)).toBe(true);
  });

  it("A/Bは注文モジュール・通常取引テーブルへ接続しない", () => {
    const engineSource = readFileSync(new URL("./softbankForwardShadowEngine.ts", import.meta.url), "utf8");
    const pureSource = readFileSync(new URL("./softbankForwardShadow.ts", import.meta.url), "utf8");
    for (const source of [engineSource, pureSource]) {
      expect(source).not.toContain("orderBridge");
      expect(source).not.toContain("OrderExecutor");
      expect(source).not.toContain("insertTrade(");
      expect(source).not.toContain("rtTrades");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade");
  });
});
