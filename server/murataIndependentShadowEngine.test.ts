import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  states: new Map<string, { stateJson: unknown; stateHash: string }>(),
  events: new Map<string, "processing" | "processed" | "error">(),
  versions: [] as Array<Record<string, unknown>>,
  trades: [] as Array<Record<string, unknown>>,
}));
const dbMock = vi.hoisted(() => ({
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  claimOrRetryRtForwardShadowEvent: vi.fn(async (input: { data: { strategyVersion: string; sourceEventId: string; evaluationMode: string } }) => {
    const key = `${input.data.strategyVersion}:${input.data.sourceEventId}:${input.data.evaluationMode}`;
    const existing = memory.events.get(key);
    if (existing === "processed") return "completed";
    if (existing === "processing") return "busy";
    memory.events.set(key, "processing");
    return "claimed";
  }),
  closeRtForwardShadowTrade: vi.fn(async () => undefined),
  failRtForwardShadowEvent: vi.fn(async () => undefined),
  getRtForwardShadowState: vi.fn(async (input: { strategyVersion: string; evaluationMode: string }) => memory.states.get(`${input.strategyVersion}:${input.evaluationMode}`) ?? null),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring" })),
  insertRtForwardShadowTrade: vi.fn(async (input: Record<string, unknown>) => memory.trades.push(input)),
  releaseRtForwardShadowStateLock: vi.fn(async () => undefined),
  updateRtForwardShadowEvent: vi.fn(async (input: { strategyVersion: string; sourceEventId: string; evaluationMode: string }) => {
    memory.events.set(`${input.strategyVersion}:${input.sourceEventId}:${input.evaluationMode}`, "processed");
  }),
  upsertRtForwardShadowState: vi.fn(async (input: { strategyVersion: string; evaluationMode: string; stateJson: unknown; stateHash: string }) => {
    memory.states.set(`${input.strategyVersion}:${input.evaluationMode}`, { stateJson: input.stateJson, stateHash: input.stateHash });
  }),
  upsertRtStrategyVersion: vi.fn(async (input: Record<string, unknown>) => memory.versions.push(input)),
}));
vi.mock("./db", () => dbMock);

import type { ForwardSourceEventInput } from "./forwardShadow";
import {
  MURATA_DEEP_REVERSAL_LONG_VERSION,
  MURATA_MORNING_BREAKDOWN_SHORT_VERSION,
  sha256Stable,
} from "./runtimeIdentity";
import {
  auditMurataIndependentShadowDay,
  processMurataIndependentShadowSourceEvent,
  resetMurataIndependentShadowVersionCacheForTest,
} from "./murataIndependentShadowEngine";
import {
  applyMurataIndependentShadowTransition,
  createEmptyMurataIndependentShadowState,
  normalizeMurataIndependentShadowState,
} from "./murataIndependentShadow";

function source(id = "event:1"): ForwardSourceEventInput {
  return {
    sourceEventId: id,
    candle: {
      symbol: "6981", tradeDate: "2026-10-01", candleTime: "09:45",
      open: 100, high: 100.1, low: 99.9, close: 100, volume: 100,
      provenance: {
        relayVersion: "kabu-relay-provenance-v1", rawCandleTime: "09:45", barStartJst: "09:45", barEndJst: "09:46",
        valueSource: "ws_aggregated", isNoTrade: false, clockHealth: { timezone: "JST", monotonicAnomaly: false },
      },
    } as any,
    board: { bids: [{ price: 99.98, qty: 10_000 }], asks: [{ price: 100.02, qty: 10_000 }] },
    currentAudit: {
      engineSequence: 1, resultType: "no_signal", routeId: null, marginUsedBefore: 0, marginUsedAfter: 0,
      stateHashBefore: "current-before", stateHashAfter: "current-after", causalityStatus: "pass", causalityReason: "ok",
      boardObservedAtMs: 1_000, relayAssembledAtMs: 1_010, relaySentAtMs: 1_020, cloudReceivedAtMs: 1_030,
      decisionStartedAtMs: 1_040, decisionCompletedAtMs: 1_050,
    },
  };
}

describe("6981 independent forward-shadow persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.versions.length = 0;
    memory.trades.length = 0;
    resetMurataIndependentShadowVersionCacheForTest();
  });

  it("registers two manual-review versions with independent state and idempotent source-event processing", async () => {
    const first = await processMurataIndependentShadowSourceEvent(source());
    expect(first).toMatchObject({ skipped: false, strategyVersions: [MURATA_DEEP_REVERSAL_LONG_VERSION, MURATA_MORNING_BREAKDOWN_SHORT_VERSION] });
    expect(memory.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ versionId: MURATA_DEEP_REVERSAL_LONG_VERSION, strategyId: "candidate-6981-deep-reversal-long", eligibleForAdoption: false, status: "monitoring" }),
      expect.objectContaining({ versionId: MURATA_MORNING_BREAKDOWN_SHORT_VERSION, strategyId: "candidate-6981-morning-20bar-breakdown-short", eligibleForAdoption: false, status: "monitoring" }),
    ]));
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${MURATA_DEEP_REVERSAL_LONG_VERSION}:signal_quality`,
      `${MURATA_MORNING_BREAKDOWN_SHORT_VERSION}:signal_quality`,
    ]));
    const stateWrites = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processMurataIndependentShadowSourceEvent(source());
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(stateWrites);
  });

  it("does not create normal rt_trades or order instruction connections", () => {
    const engine = readFileSync(new URL("./murataIndependentShadowEngine.ts", import.meta.url), "utf8");
    const transition = readFileSync(new URL("./murataIndependentShadow.ts", import.meta.url), "utf8");
    for (const content of [engine, transition]) {
      expect(content).not.toContain("orderBridge");
      expect(content).not.toContain("OrderExecutor");
      expect(content).not.toContain("insertRtTrade(");
      expect(content).not.toContain("rtTrades");
      expect(content).not.toContain("orderInstructions");
    }
    expect(engine).toContain("insertRtForwardShadowTrade");
    expect(engine).toContain("not_applicable_no_891m_consumption");
  });

  it("replays a persisted source ledger deterministically without live writes", () => {
    const input = source("replay:1");
    const before = normalizeMurataIndependentShadowState(
      createEmptyMurataIndependentShadowState("deep_reversal_long"),
      "deep_reversal_long",
      input.candle.tradeDate,
    );
    const beforeHash = sha256Stable(before);
    const transition = applyMurataIndependentShadowTransition("deep_reversal_long", before, input);
    const afterHash = sha256Stable(transition.nextState);
    const result = auditMurataIndependentShadowDay([
      {
        sourceEventId: input.sourceEventId,
        status: "processed",
        resultAction: "none",
        payloadJson: { ...input.candle, board: input.board },
        relayReceivedAtMs: input.currentAudit!.relayAssembledAtMs,
        relaySentAtMs: input.currentAudit!.relaySentAtMs,
        cloudReceivedAtMs: input.currentAudit!.cloudReceivedAtMs,
      },
    ], [{
      strategyVersion: MURATA_DEEP_REVERSAL_LONG_VERSION,
      sourceEventId: input.sourceEventId,
      evaluationMode: "signal_quality",
      resultType: transition.resultType,
      stateHashBefore: beforeHash,
      stateHashAfter: afterHash,
    }], [{
      id: 1, sourceEventId: input.sourceEventId, resultType: "no_signal", routeId: null,
      marginUsedBefore: 0, marginUsedAfter: 0, stateHashBefore: "current-before", stateHashAfter: "current-after",
      causalityStatus: "pass", causalityReason: "ok", decisionStartedAtMs: 1_040, decisionCompletedAtMs: 1_050,
      resultJson: { availabilityTimeline: { boardObservedAtMs: 1_000 } },
    }], "deep_reversal_long");
    expect(result).toEqual({ replayedEvents: 1, mismatches: 0, invalidPayloads: 0 });
    expect(dbMock.upsertRtForwardShadowState).not.toHaveBeenCalled();
  });
});
