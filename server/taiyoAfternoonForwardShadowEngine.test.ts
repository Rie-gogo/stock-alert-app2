import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForwardSourceEventInput } from "./forwardShadow";

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
  TAIYO_AFTERNOON_DEPTH_VERSION,
  TAIYO_AFTERNOON_RR2_VERSION,
  sha256Stable,
} from "./runtimeIdentity";
import {
  auditTaiyoAfternoonForwardShadowDay,
  processTaiyoAfternoonForwardShadowSourceEvent,
  resetTaiyoAfternoonForwardVersionCacheForTest,
} from "./taiyoAfternoonForwardShadowEngine";
import {
  applyTaiyoAfternoonDepthTransition,
  createEmptyTaiyoAfternoonState,
} from "./taiyoAfternoonForwardShadow";

const tradeDate = "2026-09-08";

function audit(sequence: number): NonNullable<ForwardSourceEventInput["currentAudit"]> {
  return {
    engineSequence: sequence,
    resultType: "none",
    routeId: null,
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    stateHashBefore: "before",
    stateHashAfter: "after",
    causalityStatus: "pass",
    causalityReason: "test",
    boardObservedAtMs: 1_000 + sequence * 1_000,
    relayAssembledAtMs: 1_050 + sequence * 1_000,
    relaySentAtMs: 1_100 + sequence * 1_000,
    cloudReceivedAtMs: 50_000 + sequence * 1_000,
    decisionStartedAtMs: 50_050 + sequence * 1_000,
    decisionCompletedAtMs: 50_100 + sequence * 1_000,
  };
}

function event(input: {
  id: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  board?: unknown;
  sequence: number;
}): ForwardSourceEventInput {
  return {
    sourceEventId: input.id,
    candle: { symbol: "6976", tradeDate, candleTime: input.time, open: input.open, high: input.high, low: input.low, close: input.close, volume: input.volume },
    board: input.board ?? null,
    currentAudit: audit(input.sequence),
  };
}

function signalSources(): ForwardSourceEventInput[] {
  const sources: ForwardSourceEventInput[] = [];
  for (let index = 0; index < 20; index += 1) {
    sources.push(event({
      id: `morning-${index}`,
      time: `11:${String(index).padStart(2, "0")}`,
      open: index === 0 ? 100 : 104,
      high: 104.2,
      low: index === 0 ? 99.8 : 103.8,
      close: 104,
      volume: 100,
      sequence: index + 1,
    }));
  }
  for (let index = 0; index < 9; index += 1) {
    const close = 103 - index * 0.25;
    sources.push(event({
      id: `afternoon-${index}`,
      time: `12:${String(50 + index).padStart(2, "0")}`,
      open: close + 0.1,
      high: close + 0.2,
      low: close - 0.1,
      close,
      volume: 100,
      sequence: 21 + index,
    }));
  }
  sources.push(event({ id: "trigger", time: "13:00", open: 100.9, high: 101, low: 100.1, close: 100.2, volume: 150, sequence: 30 }));
  sources.push(event({ id: "confirm", time: "13:01", open: 99.8, high: 99.9, low: 98.9, close: 99, volume: 120, sequence: 31 }));
  sources.push(event({
    id: "depth-entry",
    time: "13:02",
    open: 98.98,
    high: 99.1,
    low: 98.8,
    close: 98.95,
    volume: 100,
    board: { bids: [{ price: 98.96, qty: 60 }, { price: 98.94, qty: 40 }], asks: [{ price: 98.98, qty: 100 }] },
    sequence: 32,
  }));
  return sources;
}

describe("6976 afternoon short A/B independent persistent shadows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.trades.length = 0;
    memory.versions.length = 0;
    memory.failNextStateKey = null;
    resetTaiyoAfternoonForwardVersionCacheForTest();
  });

  it("rejects non-6976 symbols and collection dates before 2026-09-07 without DB writes", async () => {
    const source = signalSources()[0];
    await expect(processTaiyoAfternoonForwardShadowSourceEvent({
      ...source,
      candle: { ...source.candle, symbol: "3436" },
    })).resolves.toEqual({ skipped: "non_6976_symbol" });
    await expect(processTaiyoAfternoonForwardShadowSourceEvent({
      ...source,
      candle: { ...source.candle, tradeDate: "2026-09-04" },
    })).resolves.toEqual({ skipped: "before_collection_start" });
    expect(memory.versions).toHaveLength(0);
    expect(memory.states.size).toBe(0);
    expect(memory.events.size).toBe(0);
    expect(memory.trades).toHaveLength(0);
  });

  it("dispatches the same events to A/B x two modes with separate versions, state, and trades", async () => {
    for (const source of signalSources()) await processTaiyoAfternoonForwardShadowSourceEvent(source);
    expect(new Set(memory.versions.map(version => version.versionId))).toEqual(new Set([
      TAIYO_AFTERNOON_RR2_VERSION,
      TAIYO_AFTERNOON_DEPTH_VERSION,
    ]));
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${TAIYO_AFTERNOON_RR2_VERSION}:signal_quality`,
      `${TAIYO_AFTERNOON_RR2_VERSION}:capital_constrained`,
      `${TAIYO_AFTERNOON_DEPTH_VERSION}:signal_quality`,
      `${TAIYO_AFTERNOON_DEPTH_VERSION}:capital_constrained`,
    ]));
    expect(memory.trades).toHaveLength(4);
    expect(memory.trades).toEqual(expect.arrayContaining([
      expect.objectContaining({ strategyVersion: TAIYO_AFTERNOON_RR2_VERSION, evaluationMode: "signal_quality", symbol: "6976", side: "short", shares: 100, entryPrice: "99" }),
      expect.objectContaining({ strategyVersion: TAIYO_AFTERNOON_DEPTH_VERSION, evaluationMode: "signal_quality", symbol: "6976", side: "short" }),
    ]));
  });

  it("does not process completed A/B modes twice for the same source event", async () => {
    const source = signalSources()[0];
    await processTaiyoAfternoonForwardShadowSourceEvent(source);
    const stateWrites = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processTaiyoAfternoonForwardShadowSourceEvent(source);
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(stateWrites);
    expect(dbMock.claimOrRetryRtForwardShadowEvent).toHaveBeenCalledTimes(8);
  });

  it("completes depth when RR2 fails and retries only failed RR2 mode on resend", async () => {
    memory.failNextStateKey = `${TAIYO_AFTERNOON_RR2_VERSION}:signal_quality`;
    const source = signalSources()[0];
    await expect(processTaiyoAfternoonForwardShadowSourceEvent(source)).rejects.toThrow("taiyo_afternoon_forward_shadow_partial_failure");
    const depthWritesBefore = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === TAIYO_AFTERNOON_DEPTH_VERSION).length;
    await expect(processTaiyoAfternoonForwardShadowSourceEvent(source)).resolves.toMatchObject({ skipped: false });
    const depthWritesAfter = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === TAIYO_AFTERNOON_DEPTH_VERSION).length;
    expect(depthWritesAfter).toBe(depthWritesBefore);
    expect(memory.states.has(`${TAIYO_AFTERNOON_RR2_VERSION}:signal_quality`)).toBe(true);
    expect(memory.states.has(`${TAIYO_AFTERNOON_RR2_VERSION}:capital_constrained`)).toBe(true);
  });

  it("does not rerun completed RR2 signal mode or depth variant when RR2 capital mode fails", async () => {
    memory.failNextStateKey = `${TAIYO_AFTERNOON_RR2_VERSION}:capital_constrained`;
    const source = signalSources()[0];
    await expect(processTaiyoAfternoonForwardShadowSourceEvent(source)).rejects.toThrow("taiyo_afternoon_forward_shadow_partial_failure");
    const rr2SignalBefore = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === TAIYO_AFTERNOON_RR2_VERSION && input.evaluationMode === "signal_quality").length;
    const depthBefore = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === TAIYO_AFTERNOON_DEPTH_VERSION).length;
    await processTaiyoAfternoonForwardShadowSourceEvent(source);
    const rr2SignalAfter = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === TAIYO_AFTERNOON_RR2_VERSION && input.evaluationMode === "signal_quality").length;
    const depthAfter = dbMock.upsertRtForwardShadowState.mock.calls
      .filter(([input]) => input.strategyVersion === TAIYO_AFTERNOON_DEPTH_VERSION).length;
    expect(rr2SignalAfter).toBe(rr2SignalBefore);
    expect(depthAfter).toBe(depthBefore);
  });

  it("replays the depth version with decision and relay clocks without state-hash mismatch", () => {
    const sources = signalSources();
    const sourceEvents = sources.map(item => ({
      sourceEventId: item.sourceEventId,
      status: "processed",
      resultAction: "none",
      payloadJson: { ...item.candle, board: item.board },
      relayReceivedAtMs: item.currentAudit?.relayAssembledAtMs,
      relaySentAtMs: item.currentAudit?.relaySentAtMs,
      cloudReceivedAtMs: item.currentAudit?.cloudReceivedAtMs,
    }));
    const decisions = sources.map((item, index) => ({
      id: index + 1,
      sourceEventId: item.sourceEventId,
      resultType: "none",
      routeId: null,
      marginUsedBefore: 0,
      marginUsedAfter: 0,
      stateHashBefore: "before",
      stateHashAfter: "after",
      causalityStatus: "pass",
      causalityReason: "test",
      decisionStartedAtMs: item.currentAudit?.decisionStartedAtMs ?? 0,
      decisionCompletedAtMs: item.currentAudit?.decisionCompletedAtMs ?? 0,
      resultJson: { availabilityTimeline: { boardObservedAtMs: item.currentAudit?.boardObservedAtMs ?? null } },
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
      let state = createEmptyTaiyoAfternoonState("depth_execution");
      for (const item of sources) {
        const normalizedBefore = state.tradeDate === item.candle.tradeDate
          ? state
          : { ...createEmptyTaiyoAfternoonState("depth_execution"), tradeDate: item.candle.tradeDate };
        const stateHashBefore = sha256Stable(normalizedBefore);
        const transition = applyTaiyoAfternoonDepthTransition(state, item, mode);
        const stateHashAfter = sha256Stable(transition.nextState);
        storedEvents.push({
          strategyVersion: TAIYO_AFTERNOON_DEPTH_VERSION,
          sourceEventId: item.sourceEventId,
          evaluationMode: mode,
          resultType: transition.resultType,
          stateHashBefore,
          stateHashAfter,
        });
        state = transition.nextState;
      }
    }
    expect(auditTaiyoAfternoonForwardShadowDay(sourceEvents, storedEvents, decisions, "depth_execution")).toEqual({
      replayedEvents: sources.length * 2,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });

  it("has no normal trade or order execution dependency", () => {
    const engineSource = readFileSync(new URL("./taiyoAfternoonForwardShadowEngine.ts", import.meta.url), "utf8");
    const pureSource = readFileSync(new URL("./taiyoAfternoonForwardShadow.ts", import.meta.url), "utf8");
    for (const source of [engineSource, pureSource]) {
      expect(source).not.toContain("orderBridge");
      expect(source).not.toContain("OrderExecutor");
      expect(source).not.toContain("insertTrade(");
      expect(source).not.toContain("rtTrades");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade");
  });
});
