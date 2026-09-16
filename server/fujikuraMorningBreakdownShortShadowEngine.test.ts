import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  states: new Map<string, { stateJson: unknown; stateHash: string }>(),
  events: new Map<string, "processing" | "processed" | "error">(),
  trades: [] as Array<Record<string, unknown>>,
  versions: [] as Array<Record<string, unknown>>,
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
    memory.states.set(`${input.strategyVersion}:${input.evaluationMode}`, {
      stateJson: input.stateJson,
      stateHash: input.stateHash,
    });
  }),
  upsertRtStrategyVersion: vi.fn(async (input: Record<string, unknown>) => {
    memory.versions.push(input);
  }),
}));

vi.mock("./db", () => dbMock);

import type { ForwardEvaluationMode, ForwardSourceEventInput } from "./forwardShadow";
import {
  FUJIKURA_MORNING_SHORT_VERSION,
  sha256Stable,
} from "./runtimeIdentity";
import {
  applyFujikuraMorningShortTransition,
  createEmptyFujikuraMorningShortState,
  normalizeFujikuraMorningShortState,
} from "./fujikuraMorningBreakdownShortShadow";
import {
  auditFujikuraMorningShortShadowDay,
  processFujikuraMorningShortShadowSourceEvent,
  resetFujikuraMorningShortVersionCacheForTest,
} from "./fujikuraMorningBreakdownShortShadowEngine";

const tradeDate = "2026-09-17";

function audit() {
  return {
    engineSequence: 1,
    resultType: "none",
    routeId: null,
    marginUsedBefore: 0,
    marginUsedAfter: 0,
    stateHashBefore: "baseline-before",
    stateHashAfter: "baseline-after",
    causalityStatus: "causal",
    causalityReason: "ok",
    boardObservedAtMs: 900,
    relayAssembledAtMs: 1_000,
    relaySentAtMs: 1_010,
    cloudReceivedAtMs: 2_000,
    decisionStartedAtMs: 2_005,
    decisionCompletedAtMs: 2_010,
  };
}

function board(bidPrice = 98.42) {
  return {
    buyPressureRatio: 0.6,
    signal: "neutral",
    bids: [{ price: bidPrice, qty: 100_000 }],
    asks: [{ price: bidPrice + 0.02, qty: 100_000 }],
  };
}

function source(index: number, overrides: Partial<ForwardSourceEventInput> = {}): ForwardSourceEventInput {
  const minute = 25 + index;
  const close = 100 - index * 0.02;
  const base: ForwardSourceEventInput = {
    sourceEventId: `5803:${index}`,
    candle: {
      symbol: "5803",
      tradeDate,
      candleTime: `09:${String(minute).padStart(2, "0")}`,
      open: close + 0.02,
      high: index === 0 ? 101 : close + 0.1,
      low: close - 0.1,
      close,
      volume: 100,
    },
    board: board(),
    currentAudit: audit(),
  };
  return {
    ...base,
    ...overrides,
    candle: { ...base.candle, ...(overrides.candle ?? {}) },
    currentAudit: { ...base.currentAudit!, ...(overrides.currentAudit ?? {}) },
  };
}

function sources() {
  const prefix = Array.from({ length: 20 }, (_, index) => source(index));
  const signal = source(20, {
    sourceEventId: "5803:signal",
    candle: {
      symbol: "5803",
      tradeDate,
      candleTime: "09:45",
      open: 99,
      high: 99.05,
      low: 98.4,
      close: 98.5,
      volume: 120,
    },
  });
  const entry = source(21, {
    sourceEventId: "5803:entry",
    candle: {
      symbol: "5803",
      tradeDate,
      candleTime: "09:46",
      open: 98.45,
      high: 98.5,
      low: 98.3,
      close: 98.4,
      volume: 100,
    },
    board: board(98.42),
  });
  return [...prefix, signal, entry];
}

describe("5803前場SHORT persistent shadow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.trades.length = 0;
    memory.versions.length = 0;
    resetFujikuraMorningShortVersionCacheForTest();
  });

  it("対象外銘柄と収集開始日前は何も保存しない", async () => {
    await expect(processFujikuraMorningShortShadowSourceEvent({
      ...source(0),
      candle: { ...source(0).candle, symbol: "6146" },
    })).resolves.toEqual({ skipped: "non_5803_symbol" });
    await expect(processFujikuraMorningShortShadowSourceEvent({
      ...source(0),
      candle: { ...source(0).candle, tradeDate: "2026-09-16" },
    })).resolves.toEqual({ skipped: "before_collection_start" });
    expect(memory.versions).toHaveLength(0);
    expect(memory.states.size).toBe(0);
    expect(memory.events.size).toBe(0);
    expect(memory.trades).toHaveLength(0);
  });

  it("採用不可の独立versionとして2評価方式へ保存し、同一eventを二重処理しない", async () => {
    for (const item of sources()) await processFujikuraMorningShortShadowSourceEvent(item);
    expect(memory.versions).toEqual([
      expect.objectContaining({
        versionId: FUJIKURA_MORNING_SHORT_VERSION,
        evaluationPurpose: "candidate",
        eligibleForAdoption: false,
        status: "monitoring",
      }),
    ]);
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${FUJIKURA_MORNING_SHORT_VERSION}:signal_quality`,
      `${FUJIKURA_MORNING_SHORT_VERSION}:capital_constrained`,
    ]));
    expect(memory.trades).toHaveLength(2);
    expect(memory.trades).toEqual(expect.arrayContaining([
      expect.objectContaining({
        strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
        evaluationMode: "signal_quality",
        symbol: "5803",
        side: "short",
        shares: 100,
      }),
      expect.objectContaining({
        strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
        evaluationMode: "capital_constrained",
        symbol: "5803",
        side: "short",
      }),
    ]));

    const writes = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processFujikuraMorningShortShadowSourceEvent(sources().at(-1)!);
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(writes);
  });

  it("保存sourceとrealtime decisionからclock-safe板を復元して固定版再生が一致する", () => {
    const inputs = sources();
    const sourceEvents = inputs.map(item => ({
      sourceEventId: item.sourceEventId,
      status: "processed",
      resultAction: "none",
      payloadJson: { ...item.candle, board: item.board },
      relayReceivedAtMs: item.currentAudit!.relayAssembledAtMs,
      relaySentAtMs: item.currentAudit!.relaySentAtMs,
      cloudReceivedAtMs: item.currentAudit!.cloudReceivedAtMs,
    }));
    const decisionEvents = inputs.map((item, index) => ({
      id: index + 1,
      sourceEventId: item.sourceEventId,
      resultType: item.currentAudit!.resultType,
      routeId: item.currentAudit!.routeId,
      marginUsedBefore: item.currentAudit!.marginUsedBefore,
      marginUsedAfter: item.currentAudit!.marginUsedAfter,
      stateHashBefore: item.currentAudit!.stateHashBefore,
      stateHashAfter: item.currentAudit!.stateHashAfter,
      causalityStatus: item.currentAudit!.causalityStatus,
      causalityReason: item.currentAudit!.causalityReason,
      decisionStartedAtMs: item.currentAudit!.decisionStartedAtMs,
      decisionCompletedAtMs: item.currentAudit!.decisionCompletedAtMs,
      resultJson: { availabilityTimeline: { boardObservedAtMs: item.currentAudit!.boardObservedAtMs } },
    }));
    const storedEvents: Array<{
      strategyVersion: string;
      sourceEventId: string;
      evaluationMode: ForwardEvaluationMode;
      resultType: string;
      stateHashBefore: string;
      stateHashAfter: string;
    }> = [];
    for (const mode of ["signal_quality", "capital_constrained"] as const) {
      let state = createEmptyFujikuraMorningShortState();
      for (const item of inputs) {
        state = normalizeFujikuraMorningShortState(state, item.candle.tradeDate);
        const stateHashBefore = sha256Stable(state);
        const transition = applyFujikuraMorningShortTransition(state, item, mode);
        const stateHashAfter = sha256Stable(transition.nextState);
        storedEvents.push({
          strategyVersion: FUJIKURA_MORNING_SHORT_VERSION,
          sourceEventId: item.sourceEventId,
          evaluationMode: mode,
          resultType: transition.resultType,
          stateHashBefore,
          stateHashAfter,
        });
        state = transition.nextState;
      }
    }
    expect(auditFujikuraMorningShortShadowDay(sourceEvents, storedEvents, decisionEvents)).toEqual({
      replayedEvents: inputs.length * 2,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });

  it("注文モジュールと通常取引テーブルへ接続しない", () => {
    const engineSource = readFileSync(new URL("./fujikuraMorningBreakdownShortShadowEngine.ts", import.meta.url), "utf8");
    const pureSource = readFileSync(new URL("./fujikuraMorningBreakdownShortShadow.ts", import.meta.url), "utf8");
    for (const sourceText of [engineSource, pureSource]) {
      expect(sourceText).not.toContain("orderBridge");
      expect(sourceText).not.toContain("OrderExecutor");
      expect(sourceText).not.toContain("insertTrade(");
      expect(sourceText).not.toContain("rtTrades");
      expect(sourceText).not.toContain("orderInstructions");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade");
  });
});
