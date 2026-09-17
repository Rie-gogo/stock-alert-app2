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
  failRtForwardShadowEvent: vi.fn(async () => undefined),
  getRtForwardShadowState: vi.fn(async (input: { strategyVersion: string; evaluationMode: string }) => (
    memory.states.get(`${input.strategyVersion}:${input.evaluationMode}`) ?? null
  )),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring" })),
  insertRtForwardShadowTrade: vi.fn(async (input: Record<string, unknown>) => memory.trades.push(input)),
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
  upsertRtStrategyVersion: vi.fn(async (input: Record<string, unknown>) => memory.versions.push(input)),
}));

vi.mock("./db", () => dbMock);

import {
  DISCO_LONG_PRIOR_THREE_B_VERSION,
  DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
} from "./runtimeIdentity";
import {
  processDiscoConfirmedLongForwardShadowSourceEvent,
  resetDiscoConfirmedLongForwardVersionCacheForTest,
} from "./discoConfirmedLongForwardShadowEngine";

function source(symbol = "6146", tradeDate = "2026-09-18") {
  return {
    sourceEventId: `${symbol}:${tradeDate}:09:00`,
    candle: {
      symbol,
      tradeDate,
      candleTime: "09:00",
      open: 60_000,
      high: 60_060,
      low: 59_940,
      close: 60_000,
      volume: 100,
    },
    board: null,
  };
}

describe("6146確認型LONG A/B persistent shadow wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memory.states.clear();
    memory.events.clear();
    memory.trades.length = 0;
    memory.versions.length = 0;
    resetDiscoConfirmedLongForwardVersionCacheForTest();
  });

  it("非6146と収集開始日前はDBへ書かない", async () => {
    await expect(processDiscoConfirmedLongForwardShadowSourceEvent(source("3436")))
      .resolves.toEqual({ skipped: "non_6146_symbol" });
    await expect(processDiscoConfirmedLongForwardShadowSourceEvent(source("6146", "2026-09-17")))
      .resolves.toEqual({ skipped: "before_collection_start" });
    expect(memory.versions).toHaveLength(0);
    expect(memory.states.size).toBe(0);
  });

  it("同じイベントをLONG A/B×2評価方式へ独立配信する", async () => {
    await expect(processDiscoConfirmedLongForwardShadowSourceEvent(source())).resolves.toMatchObject({
      skipped: false,
      symbol: "6146",
    });
    expect(new Set(memory.versions.map(version => version.versionId))).toEqual(new Set([
      DISCO_LONG_PROFIT_PROTECTION_A_VERSION,
      DISCO_LONG_PRIOR_THREE_B_VERSION,
    ]));
    expect(new Set(memory.states.keys())).toEqual(new Set([
      `${DISCO_LONG_PROFIT_PROTECTION_A_VERSION}:signal_quality`,
      `${DISCO_LONG_PROFIT_PROTECTION_A_VERSION}:capital_constrained`,
      `${DISCO_LONG_PRIOR_THREE_B_VERSION}:signal_quality`,
      `${DISCO_LONG_PRIOR_THREE_B_VERSION}:capital_constrained`,
    ]));
    expect(memory.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ evaluationPurpose: "candidate", eligibleForAdoption: true, status: "monitoring" }),
      expect.objectContaining({ evaluationPurpose: "candidate", eligibleForAdoption: true, status: "monitoring" }),
    ]));
  });

  it("同一source event再送は4状態を二重更新しない", async () => {
    const event = source();
    await processDiscoConfirmedLongForwardShadowSourceEvent(event);
    const writes = dbMock.upsertRtForwardShadowState.mock.calls.length;
    await processDiscoConfirmedLongForwardShadowSourceEvent(event);
    expect(dbMock.upsertRtForwardShadowState).toHaveBeenCalledTimes(writes);
    expect(dbMock.claimOrRetryRtForwardShadowEvent).toHaveBeenCalledTimes(8);
  });

  it("通常取引・注文経路へ接続しない", () => {
    const engineSource = readFileSync(new URL("./discoConfirmedLongForwardShadowEngine.ts", import.meta.url), "utf8");
    const pureSource = readFileSync(new URL("./discoConfirmedLongForwardShadow.ts", import.meta.url), "utf8");
    for (const body of [engineSource, pureSource]) {
      expect(body).not.toContain("orderBridge");
      expect(body).not.toContain("OrderExecutor");
      expect(body).not.toContain("insertTrade(");
      expect(body).not.toContain("rtTrades");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade");
  });
});
