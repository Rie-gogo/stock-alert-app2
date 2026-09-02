import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  states: new Map<string, any>(),
  claims: new Set<string>(),
  trades: [] as any[],
  events: [] as any[],
}));

vi.mock("./db", () => ({
  upsertRtStrategyVersion: vi.fn(),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring", statusReason: null })),
  updateRtStrategyVersionStatus: vi.fn(),
  getRtForwardShadowState: vi.fn(async ({ evaluationMode }) => memory.states.get(evaluationMode) ?? null),
  upsertRtForwardShadowState: vi.fn(async data => memory.states.set(data.evaluationMode, { ...data })),
  claimRtForwardShadowEvent: vi.fn(async data => {
    const key = `${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`;
    if (memory.claims.has(key)) return false;
    memory.claims.add(key);
    memory.events.push({ ...data });
    return true;
  }),
  updateRtForwardShadowEvent: vi.fn(async data => {
    const target = memory.events.find(item => item.strategyVersion === data.strategyVersion
      && item.sourceEventId === data.sourceEventId
      && item.evaluationMode === data.evaluationMode);
    Object.assign(target, data);
  }),
  insertRtForwardShadowTrade: vi.fn(async data => memory.trades.push({ ...data })),
  closeRtForwardShadowTrade: vi.fn(async data => {
    const target = memory.trades.find(item => item.strategyVersion === data.strategyVersion
      && item.evaluationMode === data.evaluationMode
      && item.entrySourceEventId === data.entrySourceEventId);
    Object.assign(target, data);
  }),
  getRtForwardShadowTrades: vi.fn(async () => memory.trades),
}));

import { processForwardShadowSourceEvent } from "./forwardShadow";

function minuteTime(index: number): string {
  const total = 9 * 60 + 40 + index;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

describe("8035未見データ前向きシャドー統合", () => {
  beforeEach(() => {
    memory.states.clear();
    memory.claims.clear();
    memory.trades.length = 0;
    memory.events.length = 0;
  });

  it("共通判定コアのシグナルを次足始値で2つの独立方式へ一度だけ約定する", async () => {
    for (let index = 0; index < 20; index += 1) {
      const time = minuteTime(index);
      await processForwardShadowSourceEvent({
        sourceEventId: `session:${index + 1}`,
        candle: {
          symbol: "8035", tradeDate: "2026-09-03", candleTime: time,
          open: 100, high: 100.1, low: 99.9, close: 100, volume: 100,
        },
        board: null,
      });
    }

    await processForwardShadowSourceEvent({
      sourceEventId: "session:21",
      candle: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:00",
        open: 100, high: 101.1, low: 99.9, close: 101, volume: 200,
      },
      board: null,
    });
    expect(memory.trades).toHaveLength(0);

    await processForwardShadowSourceEvent({
      sourceEventId: "session:22",
      candle: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:01",
        open: 101.2, high: 101.3, low: 101.1, close: 101.25, volume: 100,
      },
      board: null,
    });
    expect(memory.trades).toHaveLength(2);
    expect(memory.trades.find(item => item.evaluationMode === "signal_quality")).toMatchObject({
      entryPrice: "101.2000",
      theoreticalSignalPrice: "101.0000",
      shares: 100,
    });
    expect(memory.trades.find(item => item.evaluationMode === "capital_constrained")?.shares).toBeGreaterThan(100);

    await processForwardShadowSourceEvent({
      sourceEventId: "session:23",
      candle: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:02",
        open: 101.3, high: 102.6, low: 101.2, close: 102.5, volume: 100,
      },
      board: null,
    });
    expect(memory.trades.every(item => item.exitReason === "take_profit")).toBe(true);
    expect(memory.states.get("signal_quality").stateJson.position).toBeNull();
    expect(memory.states.get("capital_constrained").stateJson.position).toBeNull();

    const eventCount = memory.events.length;
    await processForwardShadowSourceEvent({
      sourceEventId: "session:23",
      candle: {
        symbol: "8035", tradeDate: "2026-09-03", candleTime: "10:02",
        open: 101.3, high: 102.6, low: 101.2, close: 102.5, volume: 100,
      },
      board: null,
    });
    expect(memory.events).toHaveLength(eventCount);
  });
});
