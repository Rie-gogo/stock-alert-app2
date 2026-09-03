import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  states: new Map<string, any>(),
  claims: new Map<string, "pending" | "error" | "completed">(),
  trades: [] as any[],
  events: [] as any[],
  versions: [] as any[],
}));

vi.mock("./db", () => ({
  upsertRtStrategyVersion: vi.fn(async data => memory.versions.push(data)),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring", statusReason: null })),
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  releaseRtForwardShadowStateLock: vi.fn(),
  getRtForwardShadowState: vi.fn(async ({ strategyVersion, evaluationMode }) => memory.states.get(`${strategyVersion}:${evaluationMode}`) ?? null),
  upsertRtForwardShadowState: vi.fn(async data => memory.states.set(`${data.strategyVersion}:${data.evaluationMode}`, { ...data })),
  claimOrRetryRtForwardShadowEvent: vi.fn(async ({ data }) => {
    const key = `${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`;
    const status = memory.claims.get(key);
    if (status === "pending" || status === "completed") return "completed";
    memory.claims.set(key, "pending");
    memory.events.push({ ...data });
    return "claimed";
  }),
  failRtForwardShadowEvent: vi.fn(async data => {
    memory.claims.set(`${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`, "error");
  }),
  updateRtForwardShadowEvent: vi.fn(async data => {
    const target = memory.events.find(item => item.strategyVersion === data.strategyVersion
      && item.sourceEventId === data.sourceEventId
      && item.evaluationMode === data.evaluationMode);
    Object.assign(target, data);
    memory.claims.set(`${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`, "completed");
  }),
  insertRtForwardShadowTrade: vi.fn(async data => memory.trades.push({ ...data })),
  closeRtForwardShadowTrade: vi.fn(async data => {
    const target = memory.trades.find(item => item.strategyVersion === data.strategyVersion
      && item.evaluationMode === data.evaluationMode
      && item.entrySourceEventId === data.entrySourceEventId);
    Object.assign(target, data);
  }),
}));

import {
  KIOXIA_FORWARD_EVALUATION_START_DATE,
  KIOXIA_FORWARD_LEARNING_CUTOFF_DATE,
  applyKioxiaForwardTransition,
  processKioxiaForwardShadowSourceEvent,
  replayKioxiaForwardShadowDay,
  type KioxiaForwardShadowState,
} from "./kioxiaForwardShadowEngine";
import {
  FORWARD_STRATEGY_VERSION,
  FUJIKURA_FORWARD_STRATEGY_VERSION,
  KIOXIA_FORWARD_STRATEGY_VERSION,
  sha256Stable,
} from "./runtimeIdentity";

function baseState(overrides: Partial<KioxiaForwardShadowState> = {}): KioxiaForwardShadowState {
  return {
    tradeDate: "2026-09-04",
    candles: [],
    position: null,
    dailySlotConsumed: false,
    stopped: false,
    lastSourceEventId: null,
    lastResultType: null,
    lastActions: [],
    ...overrides,
  };
}

function entryHistory() {
  return Array.from({ length: 20 }, (_, index) => {
    const close = 995 + index * 0.02;
    return {
      time: `09:${String(45 + index).padStart(2, "0")}`,
      open: close - 0.05,
      high: close + 2,
      low: close - 2,
      close,
      volume: 100,
    };
  });
}

function entryInput(sourceEventId = "kioxia:entry") {
  return {
    sourceEventId,
    candle: {
      symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:05",
      open: 998.8, high: 1_003, low: 999, close: 1_001, volume: 200,
    },
    board: { currentPrice: 1_001.25 },
  };
}

describe("285A独立前向きシャドーエンジン", () => {
  beforeEach(() => {
    memory.states.clear();
    memory.claims.clear();
    memory.trades.length = 0;
    memory.events.length = 0;
    memory.versions.length = 0;
  });

  it("8035・5803とは別version・別状態で、100株全発火と単独可変株数を受信時点価格へ一度だけ保存する", async () => {
    const telSentinel = { stateJson: { untouched: "8035" } };
    const fujikuraSentinel = { stateJson: { untouched: "5803" } };
    memory.states.set(`${FORWARD_STRATEGY_VERSION}:signal_quality`, telSentinel);
    memory.states.set(`${FUJIKURA_FORWARD_STRATEGY_VERSION}:signal_quality`, fujikuraSentinel);
    for (const mode of ["signal_quality", "capital_constrained"] as const) {
      memory.states.set(`${KIOXIA_FORWARD_STRATEGY_VERSION}:${mode}`, { stateJson: baseState({ candles: entryHistory() }) });
    }

    await processKioxiaForwardShadowSourceEvent(entryInput());
    await processKioxiaForwardShadowSourceEvent(entryInput());

    expect(memory.trades).toHaveLength(2);
    expect(memory.trades.every(item => item.strategyVersion === KIOXIA_FORWARD_STRATEGY_VERSION)).toBe(true);
    expect(memory.trades.find(item => item.evaluationMode === "signal_quality")).toMatchObject({
      entryPrice: "1001.2500",
      theoreticalSignalPrice: "1001.0000",
      shares: 100,
      slPct: "0.8000",
      tpPct: "1.6000",
    });
    expect(memory.trades.find(item => item.evaluationMode === "capital_constrained")?.shares).toBe(2_600);
    expect(memory.events).toHaveLength(2);
    expect(memory.events.every(item => item.strategyVersion === KIOXIA_FORWARD_STRATEGY_VERSION)).toBe(true);
    expect(memory.states.get(`${FORWARD_STRATEGY_VERSION}:signal_quality`)).toBe(telSentinel);
    expect(memory.states.get(`${FUJIKURA_FORWARD_STRATEGY_VERSION}:signal_quality`)).toBe(fujikuraSentinel);
    expect(memory.versions[0]).toMatchObject({
      versionId: KIOXIA_FORWARD_STRATEGY_VERSION,
      learningCutoffDate: KIOXIA_FORWARD_LEARNING_CUTOFF_DATE,
      evaluationStartDate: KIOXIA_FORWARD_EVALUATION_START_DATE,
      configJson: expect.objectContaining({
        candidateKey: "285a_confirmed_morning_long_ma8_momentum_protection",
        orderInstructionConnection: false,
      }),
    });
  });

  it("日付切替時は旧日の発火済み状態とポジションを引き継がない", async () => {
    for (const mode of ["signal_quality", "capital_constrained"] as const) {
      memory.states.set(`${KIOXIA_FORWARD_STRATEGY_VERSION}:${mode}`, {
        stateJson: baseState({ tradeDate: "2026-09-04", dailySlotConsumed: true, position: {
          side: "long",
          entrySourceEventId: "old:entry",
          signalTime: "10:00",
          entryTime: "10:00",
          theoreticalSignalPrice: 1_000,
          entryPrice: 1_000,
          shares: 100,
          slPct: 0.8,
          tpPct: 1.6,
          profitProtectionArmedAtSourceEventId: null,
        } }),
      });
    }
    await processKioxiaForwardShadowSourceEvent({
      sourceEventId: "new-day:1",
      candle: {
        symbol: "285A", tradeDate: "2026-09-07", candleTime: "09:00",
        open: 1_000, high: 1_001, low: 999, close: 1_000, volume: 100,
      },
      board: { currentPrice: 1_000 },
    });
    for (const mode of ["signal_quality", "capital_constrained"] as const) {
      const saved = memory.states.get(`${KIOXIA_FORWARD_STRATEGY_VERSION}:${mode}`).stateJson;
      expect(saved).toMatchObject({ tradeDate: "2026-09-07", dailySlotConsumed: false, position: null });
      expect(saved.candles).toHaveLength(1);
    }
  });

  it("MA8失速保護決済を通常取引ではなくstrategyVersion別シャドー取引へ保存する", async () => {
    for (const mode of ["signal_quality", "capital_constrained"] as const) {
      const shares = mode === "signal_quality" ? 100 : 2_600;
      const position = {
        side: "long" as const,
        entrySourceEventId: `armed:${mode}`,
        signalTime: "09:50",
        entryTime: "09:50",
        theoreticalSignalPrice: 1_000,
        entryPrice: 1_000,
        shares,
        slPct: 0.8,
        tpPct: 1.6,
        profitProtectionArmedAtSourceEventId: "arm:event",
      };
      memory.states.set(`${KIOXIA_FORWARD_STRATEGY_VERSION}:${mode}`, {
        stateJson: baseState({
          candles: [
            { time: "09:51", open: 1_015, high: 1_016, low: 1_014, close: 1_015, volume: 100 },
            { time: "09:52", open: 1_015, high: 1_016, low: 1_014, close: 1_015, volume: 100 },
            ...Array.from({ length: 6 }, (_, index) => ({ time: `09:${53 + index}`, open: 1_015, high: 1_016, low: 1_014, close: 1_015, volume: 100 })),
            { time: "09:59", open: 1_002, high: 1_003, low: 1_001, close: 1_002, volume: 100 },
          ],
          position,
          dailySlotConsumed: true,
        }),
      });
      memory.trades.push({
        strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
        evaluationMode: mode,
        entrySourceEventId: position.entrySourceEventId,
      });
    }

    await processKioxiaForwardShadowSourceEvent({
      sourceEventId: "protect:exit",
      candle: {
        symbol: "285A", tradeDate: "2026-09-04", candleTime: "10:00",
        open: 1_002, high: 1_003, low: 1_001, close: 1_002, volume: 100,
      },
      board: { currentPrice: 1_001.5 },
    });

    expect(memory.trades).toHaveLength(2);
    expect(memory.trades.every(item => item.exitReason === "ma8_momentum_protection")).toBe(true);
    expect(memory.trades.find(item => item.evaluationMode === "signal_quality")).toMatchObject({
      exitPrice: "1001.5000",
      pnl: 150,
    });
  });

  it("当日payloadを同じ純粋コアへ再生すると285A別versionの状態ハッシュと一致する", () => {
    const sourceEvent = {
      sourceEventId: "replay:1",
      status: "processed",
      resultAction: "none",
      payloadJson: {
        symbol: "285A", tradeDate: "2026-09-04", candleTime: "09:00",
        open: 1_000, high: 1_001, low: 999, close: 1_000, volume: 100,
        board: { currentPrice: 1_000 },
      },
    };
    const initial = baseState();
    const storedEvents = (["signal_quality", "capital_constrained"] as const).map(mode => {
      const transition = applyKioxiaForwardTransition(initial, {
        sourceEventId: sourceEvent.sourceEventId,
        candle: sourceEvent.payloadJson,
        board: sourceEvent.payloadJson.board,
      }, mode);
      return {
        strategyVersion: KIOXIA_FORWARD_STRATEGY_VERSION,
        sourceEventId: sourceEvent.sourceEventId,
        evaluationMode: mode,
        resultType: transition.resultType,
        stateHashBefore: sha256Stable(initial),
        stateHashAfter: sha256Stable(transition.nextState),
      };
    });
    expect(replayKioxiaForwardShadowDay([sourceEvent], storedEvents)).toMatchObject({
      replayedEvents: 2,
      mismatches: 0,
      invalidPayloads: 0,
    });
  });

  it("注文生成・通常rt_trades・Windows Executorへ構造的に接続しない", () => {
    const engineSource = readFileSync(new URL("./kioxiaForwardShadowEngine.ts", import.meta.url), "utf8");
    const specSource = readFileSync(new URL("./kioxiaForwardShadow.ts", import.meta.url), "utf8");
    for (const source of [engineSource, specSource]) {
      expect(source).not.toContain("./orderBridge");
      expect(source).not.toContain("insertRtTrade(");
      expect(source).not.toContain("kabu_board_relay");
    }
    expect(engineSource).toContain("insertRtForwardShadowTrade(");
    expect(engineSource).toContain("orderInstructionCreated: false");
    expect(engineSource).toContain("acquireRtForwardShadowStateLock(");
    expect(engineSource).toContain("releaseRtForwardShadowStateLock(");
  });
});
