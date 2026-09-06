import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  SUMCO_TIME_15_VERSION,
  SUMCO_VOLUME_110_VERSION,
  sha256Stable,
} from "./runtimeIdentity";
import {
  auditSumcoForwardShadowDay,
  processSumcoForwardShadowSourceEvent,
  resetSumcoForwardVersionCacheForTest,
} from "./sumcoForwardShadowEngine";
import {
  applySumcoVolume110Transition,
  createEmptySumcoForwardState,
} from "./sumcoForwardShadow";

const tradeDate = "2026-09-08";

function prefix(index: number) {
  return {
    sourceEventId: `prefix-${index}`,
    candle: {
      symbol: "3436",
      tradeDate,
      candleTime: `09:${String(index).padStart(2, "0")}`,
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
      symbol: "3436",
      tradeDate,
      candleTime: "09:30",
      open: 100,
      high: 100.1,
      low: 98.4,
      close: 98.5,
      volume: 110,
    },
    board: null,
  };
}

describe("3436 A/B independent persistent shadows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.trades.length = 0;
    memory.versions.length = 0;
    memory.failNextStateKey = null;
    resetSumcoForwardVersionCacheForTest();
  });

  it("非3436と収集開始日前はversion・state・event・tradeを作らない", async () => {
    await expect(processSumcoForwardShadowSourceEvent({
      ...prefix(0),
      candle: { ...prefix(0).candle, symbol: "6526" },
    })).resolves.toEqual({ skipped: "non_3436_symbol" });
    await expect(processSumcoForwardShadowSourceEvent({
      ...prefix(0),
      candle: { ...prefix(0).candle, tradeDate: "2026-09-04" },
    })).resolves.toEqual({ skipped: "before_collection_start" });
    expect(memory.versions).toHaveLength(0);
    expect(memory.states.size).toBe(0);
    expect(memory.events.size).toBe(0);
    expect(memory.trades).toHaveLength(0);
  });

  it("同じ3436イベントをA/B×2評価方式へ配信しversion・state・tradeを分離する", async () => {
    for (let index = 0; index < 30; index += 1) await processSumcoForwardShadowSourceEvent(prefix(index));
    await processSumcoForwardShadowSourceEvent(signal());

    expect(new Set(memory.versions.map(version => version.versionId))).toEqual(new Set([
      SUMCO_VOLUME_110_VERSION,
      SUMCO_TIME_15_VERSION,
    ]));
    expect(memory.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ versionId: SUMCO_VOLUME_110_VERSION, eligibleForAdoption: true, status: "monitoring" }),
      expect.objectContaining({ versionId: SUMCO_TIME_15_VERSION, eligibleForAdoption: true, status: "monitoring" }),
    ]));
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${SUMCO_VOLUME_110_VERSION}:signal_quality`,
      `${SUMCO_VOLUME_110_VERSION}:capital_constrained`,
      `${SUMCO_TIME_15_VERSION}:signal_quality`,
      `${SUMCO_TIME_15_VERSION}:capital_constrained`,
    ]));
    expect(memory.trades).toHaveLength(4);
    expect(memory.trades).toEqual(expect.arrayContaining([
      expect.objectContaining({ strategyVersion: SUMCO_VOLUME_110_VERSION, evaluationMode: "signal_quality", symbol: "3436", side: "short", shares: 100 }),
      expect.objectContaining({ strategyVersion: SUMCO_TIME_15_VERSION, evaluationMode: "signal_quality", symbol: "3436", side: "short", shares: 100 }),
    ]));
  });

  it("同一source event再送では完了済みA/Bを二重処理しない", async () => {
    const source = prefix(0);
    await processSumcoForwardShadowSourceEvent(source);
    const stateWrites = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processSumcoForwardShadowSourceEvent(source);
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(stateWrites);
    expect(dbMock.claimOrRetryRtForwardShadowEvent).toHaveBeenCalledTimes(8);
  });

  it("Aだけが失敗してもBを完了し、再送ではAだけを再試行する", async () => {
    memory.failNextStateKey = `${SUMCO_VOLUME_110_VERSION}:signal_quality`;
    const source = prefix(0);
    await expect(processSumcoForwardShadowSourceEvent(source)).rejects.toThrow("sumco_forward_shadow_partial_failure");
    expect(memory.states.has(`${SUMCO_TIME_15_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${SUMCO_TIME_15_VERSION}:capital_constrained`)).toBe(true);
    const bWritesBeforeRetry = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SUMCO_TIME_15_VERSION).length;

    await expect(processSumcoForwardShadowSourceEvent(source)).resolves.toMatchObject({ skipped: false });
    const bWritesAfterRetry = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SUMCO_TIME_15_VERSION).length;
    expect(bWritesAfterRetry).toBe(bWritesBeforeRetry);
    expect(memory.states.has(`${SUMCO_VOLUME_110_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${SUMCO_VOLUME_110_VERSION}:capital_constrained`)).toBe(true);
  });

  it("Aのcapitalだけ失敗した場合も完了済みA-signalとBを再実行しない", async () => {
    memory.failNextStateKey = `${SUMCO_VOLUME_110_VERSION}:capital_constrained`;
    const source = prefix(0);
    await expect(processSumcoForwardShadowSourceEvent(source)).rejects.toThrow("sumco_forward_shadow_partial_failure");
    const aSignalWritesBefore = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SUMCO_VOLUME_110_VERSION && input.evaluationMode === "signal_quality").length;
    const bWritesBefore = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SUMCO_TIME_15_VERSION).length;

    await expect(processSumcoForwardShadowSourceEvent(source)).resolves.toMatchObject({ skipped: false });
    const aSignalWritesAfter = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SUMCO_VOLUME_110_VERSION && input.evaluationMode === "signal_quality").length;
    const bWritesAfter = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === SUMCO_TIME_15_VERSION).length;
    expect(aSignalWritesAfter).toBe(aSignalWritesBefore);
    expect(bWritesAfter).toBe(bWritesBefore);
    expect(memory.states.has(`${SUMCO_VOLUME_110_VERSION}:capital_constrained`)).toBe(true);
  });

  it("A/Bは注文モジュール・通常取引テーブルへ接続しない", () => {
    const engineSource = readFileSync(new URL("./sumcoForwardShadowEngine.ts", import.meta.url), "utf8");
    const pureSource = readFileSync(new URL("./sumcoForwardShadow.ts", import.meta.url), "utf8");
    for (const source of [engineSource, pureSource]) {
      expect(source).not.toContain("orderBridge");
      expect(source).not.toContain("OrderExecutor");
      expect(source).not.toContain("insertTrade(");
      expect(source).not.toContain("rtTrades");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade");
  });

  it("固定版再生は保存eventのVOLUME110 state hashと一致する", () => {
    const sources = [...Array.from({ length: 30 }, (_, index) => prefix(index)), signal()];
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
      let state = createEmptySumcoForwardState("volume_110");
      for (const item of sources) {
        const normalizedBefore = state.tradeDate === item.candle.tradeDate
          ? state
          : { ...createEmptySumcoForwardState("volume_110"), tradeDate: item.candle.tradeDate };
        const stateHashBefore = sha256Stable(normalizedBefore);
        const transition = applySumcoVolume110Transition(state, item, mode);
        const stateHashAfter = sha256Stable(transition.nextState);
        storedEvents.push({
          strategyVersion: SUMCO_VOLUME_110_VERSION,
          sourceEventId: item.sourceEventId,
          evaluationMode: mode,
          resultType: transition.resultType,
          stateHashBefore,
          stateHashAfter,
        });
        state = transition.nextState;
      }
    }
    expect(auditSumcoForwardShadowDay(sourceEvents, storedEvents, "volume_110")).toEqual({
      replayedEvents: 62,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });
});
