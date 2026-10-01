import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const memory = vi.hoisted(() => ({
  states: new Map<string, { stateJson: unknown; stateHash: string }>(),
  events: new Map<string, "processing" | "processed" | "error">(),
  versions: [] as Array<Record<string, unknown>>,
}));

const dbMock = vi.hoisted(() => ({
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  claimOrRetryRtForwardShadowEvent: vi.fn(async (input: { data: { strategyVersion: string; sourceEventId: string; evaluationMode: string } }) => {
    const key = `${input.data.strategyVersion}:${input.data.sourceEventId}:${input.data.evaluationMode}`;
    if (memory.events.get(key) === "processed") return "completed";
    if (memory.events.get(key) === "processing") return "busy";
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
  insertRtForwardShadowTrade: vi.fn(async () => undefined),
  releaseRtForwardShadowStateLock: vi.fn(async () => undefined),
  updateRtForwardShadowEvent: vi.fn(async (input: { strategyVersion: string; sourceEventId: string; evaluationMode: string }) => {
    memory.events.set(`${input.strategyVersion}:${input.sourceEventId}:${input.evaluationMode}`, "processed");
  }),
  upsertRtForwardShadowState: vi.fn(async (input: { strategyVersion: string; evaluationMode: string; stateJson: unknown; stateHash: string }) => {
    memory.states.set(`${input.strategyVersion}:${input.evaluationMode}`, { stateJson: input.stateJson, stateHash: input.stateHash });
  }),
  upsertRtStrategyVersion: vi.fn(async (input: Record<string, unknown>) => {
    memory.versions.push(input);
  }),
}));

vi.mock("./db", () => dbMock);

import {
  ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION,
  ADVANTEST_SHORT_BODY008_DEPTH_VERSION,
} from "./runtimeIdentity";
import {
  processAdvantestForwardShadowSourceEvent,
  resetAdvantestForwardVersionCacheForTest,
} from "./advantestForwardShadowEngine";

function event(sourceEventId = "6857-source") {
  return {
    sourceEventId,
    candle: {
      symbol: "6857",
      tradeDate: "2026-10-02",
      candleTime: "09:30",
      open: 100,
      high: 100.2,
      low: 99.9,
      close: 100.1,
      volume: 100,
    },
    board: null,
  };
}

describe("6857 A/B 独立forward-shadow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.versions.length = 0;
    resetAdvantestForwardVersionCacheForTest();
  });

  it("同じ6857イベントを2案×2評価方式へ配信しversion・stateを分離する", async () => {
    await processAdvantestForwardShadowSourceEvent(event());
    expect(new Set(memory.versions.map(version => version.versionId))).toEqual(new Set([
      ADVANTEST_SHORT_BODY008_DEPTH_VERSION,
      ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION,
    ]));
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${ADVANTEST_SHORT_BODY008_DEPTH_VERSION}:signal_quality`,
      `${ADVANTEST_SHORT_BODY008_DEPTH_VERSION}:capital_constrained`,
      `${ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION}:signal_quality`,
      `${ADVANTEST_CONTINUATION_LONG_DEPTH_VERSION}:capital_constrained`,
    ]));
    expect(memory.versions.every(version => version.automaticAdoption !== true)).toBe(true);
  });

  it("同一source event再送では完了済みの2案を二重処理しない", async () => {
    const source = event("duplicate");
    await processAdvantestForwardShadowSourceEvent(source);
    const writes = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processAdvantestForwardShadowSourceEvent(source);
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(writes);
  });

  it("注文経路と通常取引へ接続しない", () => {
    const engineSource = readFileSync(new URL("./advantestForwardShadowEngine.ts", import.meta.url), "utf8");
    const pureSource = readFileSync(new URL("./advantestForwardShadow.ts", import.meta.url), "utf8");
    for (const source of [engineSource, pureSource]) {
      expect(source).not.toContain("orderBridge");
      expect(source).not.toContain("OrderExecutor");
      expect(source).not.toContain("insertTrade(");
      expect(source).not.toContain("rtTrades");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade");
  });
});
