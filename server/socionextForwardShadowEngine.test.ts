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
  SOCIONEXT_CONFIRM_STRENGTH_VERSION,
  SOCIONEXT_INITIAL_STRENGTH_VERSION,
  sha256Stable,
} from "./runtimeIdentity";
import {
  auditSocionextForwardShadowDay,
  processSocionextForwardShadowSourceEvent,
  resetSocionextForwardVersionCacheForTest,
} from "./socionextForwardShadowEngine";
import {
  applySocionextInitialStrengthTransition,
  createEmptySocionextForwardState,
} from "./socionextForwardShadow";

const tradeDate = "2026-09-08";

function timeAt(index: number) {
  const minute = 10 + index;
  return `09:${String(minute).padStart(2, "0")}`;
}

function prefix(index: number) {
  return {
    sourceEventId: `prefix-${index}`,
    candle: {
      symbol: "6526",
      tradeDate,
      candleTime: timeAt(index),
      open: index === 0 ? 100 : 99.9,
      high: 99.95,
      low: 99.85,
      close: 99.9,
      volume: 100,
    },
    board: null,
  };
}

function signal() {
  return {
    sourceEventId: "signal",
    candle: {
      symbol: "6526",
      tradeDate,
      candleTime: "09:30",
      open: 100.2,
      high: 100.55,
      low: 100.15,
      close: 100.5,
      volume: 200,
    },
    board: null,
  };
}

function confirmation() {
  return {
    sourceEventId: "confirm",
    candle: {
      symbol: "6526",
      tradeDate,
      candleTime: "09:31",
      open: 100.5,
      high: 100.7,
      low: 100.45,
      close: 100.6,
      volume: 100,
    },
    board: null,
  };
}

describe("6526 A/B independent persistent shadows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.trades.length = 0;
    memory.versions.length = 0;
    memory.failNextStateKey = null;
    resetSocionextForwardVersionCacheForTest();
  });

  it("同じ6526イベントをA/B×2評価方式へ配信し、version・state・trade・採用適格性を分離する", async () => {
    for (let index = 0; index < 20; index += 1) await processSocionextForwardShadowSourceEvent(prefix(index));
    await processSocionextForwardShadowSourceEvent(signal());
    await processSocionextForwardShadowSourceEvent(confirmation());

    expect(new Set(memory.versions.map(version => version.versionId))).toEqual(new Set([
      SOCIONEXT_INITIAL_STRENGTH_VERSION,
      SOCIONEXT_CONFIRM_STRENGTH_VERSION,
    ]));
    expect(memory.versions.find(version => version.versionId === SOCIONEXT_INITIAL_STRENGTH_VERSION))
      .toEqual(expect.objectContaining({ eligibleForAdoption: false, status: "monitoring" }));
    expect(memory.versions.find(version => version.versionId === SOCIONEXT_CONFIRM_STRENGTH_VERSION))
      .toEqual(expect.objectContaining({ eligibleForAdoption: true, status: "monitoring" }));
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${SOCIONEXT_INITIAL_STRENGTH_VERSION}:signal_quality`,
      `${SOCIONEXT_INITIAL_STRENGTH_VERSION}:capital_constrained`,
      `${SOCIONEXT_CONFIRM_STRENGTH_VERSION}:signal_quality`,
      `${SOCIONEXT_CONFIRM_STRENGTH_VERSION}:capital_constrained`,
    ]));
    expect(memory.trades).toHaveLength(4);
    expect(memory.trades.filter(trade => trade.evaluationMode === "signal_quality"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ shares: 100 }), expect.objectContaining({ shares: 100 })]));
  });

  it("同一source event再送では完了済みA/Bを二重処理しない", async () => {
    const source = prefix(0);
    await processSocionextForwardShadowSourceEvent(source);
    const stateWrites = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processSocionextForwardShadowSourceEvent(source);
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(stateWrites);
    expect(dbMock.claimOrRetryRtForwardShadowEvent).toHaveBeenCalledTimes(8);
  });

  it("Aだけが失敗してもBを完了し、再送ではAだけを再試行する", async () => {
    memory.failNextStateKey = `${SOCIONEXT_INITIAL_STRENGTH_VERSION}:signal_quality`;
    const source = prefix(0);
    await expect(processSocionextForwardShadowSourceEvent(source)).rejects.toThrow("socionext_forward_shadow_partial_failure");
    expect(memory.states.has(`${SOCIONEXT_CONFIRM_STRENGTH_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${SOCIONEXT_CONFIRM_STRENGTH_VERSION}:capital_constrained`)).toBe(true);
    const bWritesBeforeRetry = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SOCIONEXT_CONFIRM_STRENGTH_VERSION).length;

    await expect(processSocionextForwardShadowSourceEvent(source)).resolves.toMatchObject({ skipped: false });
    const bWritesAfterRetry = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SOCIONEXT_CONFIRM_STRENGTH_VERSION).length;
    expect(bWritesAfterRetry).toBe(bWritesBeforeRetry);
    expect(memory.states.has(`${SOCIONEXT_INITIAL_STRENGTH_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${SOCIONEXT_INITIAL_STRENGTH_VERSION}:capital_constrained`)).toBe(true);
  });

  it("Aのcapitalだけ失敗した場合も完了済みsignal_qualityとBを再実行しない", async () => {
    memory.failNextStateKey = `${SOCIONEXT_INITIAL_STRENGTH_VERSION}:capital_constrained`;
    const source = prefix(0);
    await expect(processSocionextForwardShadowSourceEvent(source)).rejects.toThrow("socionext_forward_shadow_partial_failure");
    expect(memory.states.has(`${SOCIONEXT_INITIAL_STRENGTH_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${SOCIONEXT_INITIAL_STRENGTH_VERSION}:capital_constrained`)).toBe(false);
    const completedWritesBefore = dbMock.upsertRtForwardShadowState.mock.calls.length;
    const aSignalWritesBefore = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SOCIONEXT_INITIAL_STRENGTH_VERSION && input.evaluationMode === "signal_quality").length;
    const bWritesBefore = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SOCIONEXT_CONFIRM_STRENGTH_VERSION).length;

    await expect(processSocionextForwardShadowSourceEvent(source)).resolves.toMatchObject({ skipped: false });
    const aSignalWritesAfter = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SOCIONEXT_INITIAL_STRENGTH_VERSION && input.evaluationMode === "signal_quality").length;
    const bWritesAfter = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SOCIONEXT_CONFIRM_STRENGTH_VERSION).length;
    expect(aSignalWritesAfter).toBe(aSignalWritesBefore);
    expect(bWritesAfter).toBe(bWritesBefore);
    expect(dbMock.upsertRtForwardShadowState.mock.calls.length).toBe(completedWritesBefore + 1);
    expect(memory.states.has(`${SOCIONEXT_INITIAL_STRENGTH_VERSION}:capital_constrained`)).toBe(true);
  });

  it("A/Bは注文モジュール・通常取引テーブルへ接続しない", () => {
    const engineSource = readFileSync(new URL("./socionextForwardShadowEngine.ts", import.meta.url), "utf8");
    const pureSource = readFileSync(new URL("./socionextForwardShadow.ts", import.meta.url), "utf8");
    for (const source of [engineSource, pureSource]) {
      expect(source).not.toContain("orderBridge");
      expect(source).not.toContain("OrderExecutor");
      expect(source).not.toContain("insertTrade(");
      expect(source).not.toContain("rtTrades");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade");
  });

  it("固定版再生は保存eventのA案state hashと一致する", () => {
    const sources = [...Array.from({ length: 20 }, (_, index) => prefix(index)), signal(), confirmation()];
    const sourceEvents = sources.map(item => ({
      sourceEventId: item.sourceEventId,
      status: "processed",
      resultAction: "none",
      payloadJson: { ...item.candle, board: item.board },
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
      let state = createEmptySocionextForwardState("initial_strength");
      for (const item of sources) {
        const normalizedBefore = state.tradeDate === item.candle.tradeDate
          ? state
          : { ...createEmptySocionextForwardState("initial_strength"), tradeDate: item.candle.tradeDate };
        const stateHashBefore = sha256Stable(normalizedBefore);
        const transition = applySocionextInitialStrengthTransition(state, item, mode);
        const stateHashAfter = sha256Stable(transition.nextState);
        storedEvents.push({
          strategyVersion: SOCIONEXT_INITIAL_STRENGTH_VERSION,
          sourceEventId: item.sourceEventId,
          evaluationMode: mode,
          resultType: transition.resultType,
          stateHashBefore,
          stateHashAfter,
        });
        state = transition.nextState;
      }
    }
    expect(auditSocionextForwardShadowDay(sourceEvents, storedEvents, "initial_strength")).toEqual({
      replayedEvents: 44,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });
});
