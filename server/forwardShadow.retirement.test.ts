import "./aiDailyForecastShadowEngine";
import "zod";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  states: new Map<string, any>(),
  claims: new Set<string>(),
  events: [] as any[],
  trades: [] as any[],
  queue: [] as any[],
  completed: [] as number[],
  metrics: [] as any[],
  legacy: vi.fn(async (..._args: any[]) => ({ skipped: "mock_legacy_result" })),
}));
vi.mock("./retiredSixStrategies", () => ({
  retireSixShadowStrategyVersions: vi.fn(),
}));
vi.mock("./db", () => ({
  claimNextRtShadowDispatch: vi.fn(async () => memory.queue.shift() ?? null),
  completeRtShadowDispatch: vi.fn(async (d: any) => {
    memory.completed.push(d.id);
  }),
  failRtShadowDispatch: vi.fn(),
  upsertRtStrategyVersion: vi.fn(),
  updateRtStrategyVersionStatus: vi.fn(),
  getRtStrategyVersion: vi.fn(async () => ({ status: "monitoring" })),
  acquireRtForwardShadowStateLock: vi.fn(async () => true),
  releaseRtForwardShadowStateLock: vi.fn(),
  getRtForwardShadowState: vi.fn(
    async (d: any) =>
      memory.states.get(`${d.strategyVersion}:${d.evaluationMode}`) ?? null
  ),
  upsertRtForwardShadowState: vi.fn(async (d: any) =>
    memory.states.set(
      `${d.strategyVersion}:${d.evaluationMode}`,
      structuredClone(d)
    )
  ),
  claimOrRetryRtForwardShadowEvent: vi.fn(async ({ data }: any) => {
    const key = `${data.strategyVersion}:${data.sourceEventId}:${data.evaluationMode}`;
    if (memory.claims.has(key)) return "completed";
    memory.claims.add(key);
    memory.events.push(structuredClone(data));
    return "claimed";
  }),
  updateRtForwardShadowEvent: vi.fn(async (d: any) =>
    Object.assign(
      memory.events.find(
        e =>
          e.strategyVersion === d.strategyVersion &&
          e.sourceEventId === d.sourceEventId &&
          e.evaluationMode === d.evaluationMode
      ),
      structuredClone(d)
    )
  ),
  failRtForwardShadowEvent: vi.fn(),
  insertRtForwardShadowTrade: vi.fn(async (d: any) =>
    memory.trades.push(structuredClone(d))
  ),
  closeRtForwardShadowTrade: vi.fn(async (d: any) =>
    Object.assign(
      memory.trades.find(
        t =>
          t.strategyVersion === d.strategyVersion &&
          t.evaluationMode === d.evaluationMode &&
          t.entrySourceEventId === d.entrySourceEventId
      ),
      structuredClone(d)
    )
  ),
  getLatestRtPremarketContextSnapshot: vi.fn(async () => ({
    sourceSnapshotId: "synthetic:premarket",
    qualityStatus: "verified",
    regimeState: "up",
    confidence: "high",
  })),
}));
vi.mock("./aiDailyForecastService", () => ({
  AI_DAILY_FORECAST_SYMBOLS: [
    "285A",
    "3436",
    "5803",
    "6146",
    "6526",
    "6857",
    "6976",
    "6981",
    "8035",
    "9984",
  ],
  getAiDailyForecastDashboard: vi.fn(async (tradeDate: string) => ({
    revisions: [],
    snapshot: {
      sourceSnapshotId: `synthetic:ai:${tradeDate}`,
      qualityStatus: "verified",
      inputJson: {
        learningApplicationAudit: {
          learningMode: "cold_start",
          learningApplied: false,
        },
      },
      forecastJson: {
        aiFinalForecast: {
          forecasts: [
            "285A",
            "3436",
            "5803",
            "6146",
            "6526",
            "6857",
            "6976",
            "6981",
            "8035",
            "9984",
          ].map(symbol => ({
            symbol,
            direction: "up",
            forecastLow: 94,
            forecastHigh: 120,
            zoneLow: 97,
            zoneHigh: 102,
            confirmPrice: 102,
            firstTarget: 110,
            stretchTarget: 118,
          })),
        },
        quantBaseline: [
          "285A",
          "3436",
          "5803",
          "6146",
          "6526",
          "6857",
          "6976",
          "6981",
          "8035",
          "9984",
        ].map(symbol => ({ symbol, atr5: 4 })),
      },
    },
  })),
}));
vi.mock("./aiIntradayForecastService", () => ({
  selectEffectiveAiIntradayPlan: () => null,
  AI_INTRADAY_CHECKPOINTS: [],
  getAiForecastPlanRevision: vi.fn(async () => "synthetic-revision"),
  getAiIntradayPlanCandidates: vi.fn(async () => []),
}));
vi.mock("./telCurrentParityEngine", () => ({
  processTelCurrentParitySourceEvent: memory.legacy,
}));
vi.mock("./telExecutableConfirmEngine", () => ({
  processTelExecutableConfirmSourceEvent: memory.legacy,
}));
vi.mock("./kioxiaForwardShadowEngine", () => ({
  processKioxiaForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./kioxiaAtrForwardShadowEngine", () => ({
  processKioxiaAtrForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./kioxiaCurrentReversalLongExactEngine", () => ({
  processKioxiaCurrentReversalLongExactReopenSourceEvent: memory.legacy,
}));
vi.mock("./fujikuraForwardShadowEngine", () => ({
  processFujikuraForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./fujikuraMorningBreakdownShortShadowEngine", () => ({
  processFujikuraMorningShortShadowSourceEvent: memory.legacy,
}));
vi.mock("./murataIndependentShadowEngine", () => ({
  processMurataIndependentShadowSourceEvent: memory.legacy,
}));
vi.mock("./softbankForwardShadowEngine", () => ({
  processSoftbankForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./advantestForwardShadowEngine", () => ({
  processAdvantestForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./taiyoForwardShadowEngine", () => ({
  processTaiyoForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./taiyoAfternoonLongForwardShadowEngine", () => ({
  processTaiyoAfternoonLongForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./socionextForwardShadowEngine", () => ({
  processSocionextForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./sumcoForwardShadowEngine", () => ({
  processSumcoForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./discoOpeningShortForwardShadowEngine", () => ({
  processDiscoOpeningShortForwardShadowSourceEvent: memory.legacy,
}));
vi.mock("./discoConfirmedLongForwardShadowEngine", () => ({
  processDiscoConfirmedLongForwardShadowSourceEvent: memory.legacy,
}));

import { processForwardShadowSourceEvent } from "./forwardShadow";
import { retireSixShadowStrategyVersions } from "./retiredSixStrategies";
import { processKioxiaAtrForwardShadowSourceEvent } from "./kioxiaAtrForwardShadowEngine";
import type { ForwardSourceEventInput } from "./forwardShadow";
import { getRuntimeIdentity } from "./runtimeIdentity";
import {
  createEmptyBollingerDirectionalState,
  buildBollingerDirectionalPlan,
  calculateBollingerBands,
} from "./bollingerDirectionalShadow";

import * as db from "./db";
import * as forward from "./forwardShadow";
import { drainForwardShadowDispatchQueue } from "./forwardShadowSequence";

beforeAll(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterAll(() => {
  writeFileSync(
    "analysis/retire-A-verification-results.json",
    JSON.stringify(memory.metrics, null, 2)
  );
  vi.restoreAllMocks();
});
const symbols = [
  "285A",
  "3436",
  "5803",
  "6146",
  "6526",
  "6857",
  "6976",
  "6981",
  "8035",
  "9984",
];
function source(symbol: string, tradeDate: string, index: number): any {
  const close =
    index < 25
      ? index % 2
        ? 102
        : 98
      : index < 29
        ? 96
        : index < 35
          ? 103
          : index < 40
            ? 112
            : 94;
  const total = index === 44 ? 15 * 60 + 20 : 9 * 60 + 21 + index;
  return {
    sourceEventId: `synthetic:${tradeDate}:${symbol}:${index}`,
    candle: {
      symbol,
      tradeDate,
      candleTime: `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
      open: close - 0.05,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 10000,
    },
    board: {
      currentPrice: close,
      asks: [{ price: close + 0.05, qty: 100000 }],
      bids: [{ price: close - 0.05, qty: 100000 }],
    },
    currentAudit: {
      engineSequence: index + 1,
      marginUsedBefore: 0,
      boardObservedAtMs: 1000,
      relayAssembledAtMs: 1100,
      cloudReceivedAtMs: 1200,
      decisionCompletedAtMs: 1300,
      boardObservationBasis: "relay_websocket_received_at_ms",
    },
  };
}
function reset() {
  memory.states.clear();
  memory.claims.clear();
  memory.events.length = 0;
  memory.trades.length = 0;
  memory.legacy.mockClear();
}
const active = (version: string) =>
  version.includes("bollinger-directional") || version.includes("ai-adaptive");
async function seedPendingBollinger(symbol: string, date: string) {
  // Synthetic restored pending signals exercise entry and exit persistence for every variant/mode.
  // Signal-generation filters themselves are covered by bollingerDirectionalShadow.test.ts.
  const { bollingerDirectionalStrategyVersion } = await import(
    "./bollingerDirectionalShadowEngine"
  );
  const plan = buildBollingerDirectionalPlan({
    tradeDate: date,
    snapshot: {
      sourceSnapshotId: "synthetic:premarket",
      qualityStatus: "verified",
      regimeState: "up",
      confidence: "high",
    },
  });
  for (const variant of [
    "fixed_stop_140_cooldown_30",
    "fixed_stop_140_cooldown_30_sma20_dynamic_gap060_v3",
    "fixed_stop_140_cooldown_30_sma20_slope_gap060",
    "fixed_stop_140_cooldown_30_sma20_slope_bbwidth5_gap060",
    "fixed_stop_140_cooldown_30_sma10_slope_gap050",
  ] as const) {
    for (const evaluationMode of ["signal_quality", "capital_constrained"]) {
      const state = createEmptyBollingerDirectionalState(plan, variant);
      state.candles = Array.from({ length: 20 }, (_, i) => ({
        sourceEventId: `seed:${date}:${symbol}:${i}`,
        candleTime: `09:${String(i).padStart(2, "0")}`,
        open: i % 2 ? 102 : 98,
        high: 103,
        low: 97,
        close: i % 2 ? 102 : 98,
        volume: 10000,
      }));
      const bands = calculateBollingerBands(state.candles)!;
      state.pending = {
        side: "long",
        touchSourceEventId: `seed:${date}:${symbol}:touch`,
        touchTime: "09:20",
        touchPrice: 95,
        touchBand: 96,
        bands,
        movingAverage: null,
        entryQualification: "premarket_direction",
      };
      const strategyVersion = bollingerDirectionalStrategyVersion(
        symbol as any,
        variant
      );
      memory.states.set(`${strategyVersion}:${evaluationMode}`, {
        strategyVersion,
        evaluationMode,
        stateJson: state,
      });
    }
  }
}
async function replay(dispatch: typeof before, replaySymbol: string) {
  reset();
  const results = [];
  for (const date of ["2026-10-14", "2026-10-15", "2026-10-16"]) {
    await seedPendingBollinger(replaySymbol, date);
    for (let i = 0; i < 45; i++)
      for (const symbol of [replaySymbol]) {
        const result = await dispatch(source(symbol, date, i));
        results.push({
          bollinger: result.bollingerDirectionalShadow,
          ai: result.aiDailyForecastShadow,
        });
      }
  }
  return structuredClone({
    results,
    events: memory.events.filter(e => active(e.strategyVersion)),
    trades: memory.trades.filter(e => active(e.strategyVersion)),
    states: [...memory.states].filter(([k]) => active(k)),
  });
}
describe("legacy retirement A", () => {
  it.each(symbols)(
    "preserves %s active results, hashes, events and trades",
    async symbol => {
      const expected = await replay(before, symbol);
      expect(memory.legacy.mock.calls.length).toBeGreaterThan(0);
      const actual = await replay(processForwardShadowSourceEvent, symbol);
      expect(memory.legacy).not.toHaveBeenCalled();
      expect(actual).toEqual(expected);
      expect(actual.events.length).toBeGreaterThan(1350);
      expect(
        actual.trades.some(
          t => t.strategyVersion.includes("ai-adaptive") && t.exitSourceEventId
        )
      ).toBe(true);
      const bbVersions = [
        ...new Set(
          actual.events
            .filter(e => e.strategyVersion.includes("bollinger-directional"))
            .map(e => e.strategyVersion)
        ),
      ];
      expect(bbVersions).toHaveLength(5);
      for (const version of bbVersions)
        for (const mode of ["signal_quality", "capital_constrained"]) {
          expect(
            actual.trades.some(
              t =>
                t.strategyVersion === version &&
                t.evaluationMode === mode &&
                t.exitSourceEventId
            )
          ).toBe(true);
        }
      memory.metrics.push({
        type: "identity",
        symbol,
        sources: actual.results.length,
        events: actual.events.length,
        trades: actual.trades.length,
        states: actual.states.length,
        differences: 0,
      });
      console.log(
        "IDENTITY",
        JSON.stringify({
          symbol,
          sources: actual.results.length,
          events: actual.events.length,
          trades: actual.trades.length,
          states: actual.states.length,
          differences: 0,
          versions: [...new Set(actual.events.map(e => e.strategyVersion))]
            .length,
        })
      );
    },
    120000
  );
  it("keeps AI and Bollinger errors isolated in both directions", async () => {
    const bollinger = await import("./bollingerDirectionalShadowEngine");
    const ai = await import("./aiDailyForecastShadowEngine");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const failing of ["ai", "bollinger"]) {
      reset();
      const b = vi.spyOn(
        bollinger,
        "processBollingerDirectionalShadowSourceEvent"
      );
      const a = vi.spyOn(ai, "processAiDailyForecastShadowSourceEvent");
      (failing === "ai" ? a : b).mockRejectedValueOnce(
        new Error("synthetic_failure")
      );
      const result: any = await processForwardShadowSourceEvent(
        source("285A", "2026-10-16", 0)
      );
      expect(
        result[
          failing === "ai"
            ? "aiDailyForecastShadow"
            : "bollingerDirectionalShadow"
        ].skipped
      ).toBe("isolated_error");
      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
      expect(memory.events.length).toBeGreaterThan(0);
      a.mockRestore();
      b.mockRestore();
    }
    quiet.mockRestore();
  });
  it("retires every legacy symbol and honors existing internal skip flags", async () => {
    reset();
    for (const symbol of [...symbols, "7203"]) {
      const result = await processForwardShadowSourceEvent({
        ...source(symbol, "2026-10-16", 0),
        internalSkipAiDailyForecastShadow: true,
        internalSkipBollingerDirectionalShadow: true,
      });
      expect(result).toEqual({ skipped: "legacy_shadow_retired_2026_10_17" });
    }
    expect(memory.legacy).not.toHaveBeenCalled();
    expect(memory.events).toHaveLength(0);
  });
  it("drains a mixed 20-symbol queue faster under simulated legacy IO", async () => {
    const timings: Record<string, number[]> = { before: [], after: [] };
    memory.legacy.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return { skipped: "mock_legacy_result" };
    });
    for (let round = 0; round < 3; round++)
      for (const [label, dispatch] of [
        ["before", before],
        ["after", processForwardShadowSourceEvent],
      ] as const) {
        reset();
        memory.completed.length = 0;
        const mixed = [
          ...symbols,
          "7203",
          "6758",
          "8306",
          "6501",
          "8058",
          "9432",
          "6861",
          "9983",
          "4063",
          "4502",
        ];
        memory.queue = Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          engineSequence: i + 1,
          inputJson: source(mixed[i % 20], "2026-10-16", Math.floor(i / 20)),
        }));
        const spy = vi
          .spyOn(forward, "processForwardShadowSourceEvent")
          .mockImplementation(dispatch);
        const start = performance.now();
        const result = await drainForwardShadowDispatchQueue({
          maxRows: 101,
          maxDurationMs: 60000,
        });
        timings[label].push((performance.now() - start) / 100);
        spy.mockRestore();
        expect(result.processedEngineSequences).toHaveLength(100);
        expect(memory.completed).toHaveLength(100);
        expect(result.stoppedReason).toBe("empty_or_claimed");
        if (label === "after") expect(memory.legacy).not.toHaveBeenCalled();
      }
    memory.legacy.mockImplementation(async () => ({
      skipped: "mock_legacy_result",
    }));
    const mean = (values: number[]) =>
      values.reduce((a, b) => a + b, 0) / values.length;
    memory.metrics.push({
      type: "queue",
      beforeMsPerEvent: mean(timings.before),
      afterMsPerEvent: mean(timings.after),
      samples: timings,
      rowsPerRun: 100,
      rounds: 3,
      legacyIoDelayMs: 1,
    });
    console.log(
      "QUEUE_BENCHMARK",
      JSON.stringify({
        beforeMsPerEvent: mean(timings.before),
        afterMsPerEvent: mean(timings.after),
        samples: timings,
        rowsPerRun: 100,
        rounds: 3,
        legacyIoDelayMs: 1,
      })
    );
    expect(mean(timings.after)).toBeLessThan(mean(timings.before));
    expect(db.failRtShadowDispatch).not.toHaveBeenCalled();
  }, 120000);
  it("retains baseline identity", () =>
    expect(getRuntimeIdentity().tradingLogicMatchesBaseline).toBe(true));
});

async function before(
  input: ForwardSourceEventInput
): Promise<Record<string, unknown>> {
  await retireSixShadowStrategyVersions();
  if (
    !input.internalSkipAiDailyForecastShadow &&
    [
      "285A",
      "3436",
      "5803",
      "6146",
      "6526",
      "6857",
      "6976",
      "6981",
      "8035",
      "9984",
    ].includes(input.candle.symbol)
  ) {
    const base: Record<string, unknown> = await before({
      ...input,
      internalSkipAiDailyForecastShadow: true,
    });
    const result: Record<string, unknown> = { ...base };
    try {
      const { processAiDailyForecastShadowSourceEvent } = await import(
        "./aiDailyForecastShadowEngine"
      );
      result.aiDailyForecastShadow =
        await processAiDailyForecastShadowSourceEvent(input);
    } catch (error) {
      // AI監視専用shadowの障害は、既存shadow・通常engine・order pathを停止させない。
      console.error(
        "[AiDailyForecastShadow] 独立shadow評価に失敗。既存処理は継続します:",
        error
      );
      result.aiDailyForecastShadow = {
        skipped: "isolated_error" as const,
        error: String(error),
      };
    }
    return result;
  }
  if (
    !input.internalSkipBollingerDirectionalShadow &&
    [
      "285A",
      "3436",
      "5803",
      "6146",
      "6526",
      "6857",
      "6976",
      "6981",
      "8035",
      "9984",
    ].includes(input.candle.symbol)
  ) {
    const base: Record<string, unknown> = await before({
      ...input,
      internalSkipBollingerDirectionalShadow: true,
    });
    const result: Record<string, unknown> = { ...base };
    try {
      const { processBollingerDirectionalShadowSourceEvent } = await import(
        "./bollingerDirectionalShadowEngine"
      );
      result.bollingerDirectionalShadow =
        await processBollingerDirectionalShadowSourceEvent(input);
    } catch (error) {
      // 新規監視専用shadowの障害で、既存shadow dispatchを止めない。
      console.error(
        "[BollingerDirectionalShadow] 独立shadow評価に失敗。既存shadowは継続します:",
        error
      );
      result.bollingerDirectionalShadow = {
        skipped: "isolated_error" as const,
        error: String(error),
      };
    }
    return result;
  }
  const engineInput: ForwardSourceEventInput =
    input.internalSkipBollingerDirectionalShadow
      ? (({
          internalSkipBollingerDirectionalShadow: _skipBollinger,
          internalSkipAiDailyForecastShadow: _skipAiForecast,
          ...rest
        }) => rest)(input)
      : input;
  if (input.candle.symbol === "8035" && !input.internalSkipTelParity) {
    const { processTelCurrentParitySourceEvent } = await import(
      "./telCurrentParityEngine"
    );
    const { processTelExecutableConfirmSourceEvent } = await import(
      "./telExecutableConfirmEngine"
    );
    const evaluations: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (const evaluate of [
      () => before({ ...input, internalSkipTelParity: true }),
      () =>
        processTelCurrentParitySourceEvent(
          engineInput,
          engineInput.currentAudit?.marginUsedBefore ?? 0
        ),
      () => processTelExecutableConfirmSourceEvent(engineInput),
    ]) {
      try {
        evaluations.push(await evaluate());
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `tel_forward_shadow_partial_failure:${errors.join(" | ")}`
      );
    }
    return { skipped: false as const, symbol: "8035", evaluations };
  }
  input = engineInput;
  if (input.candle.symbol === "285A") {
    const { processKioxiaForwardShadowSourceEvent } = await import(
      "./kioxiaForwardShadowEngine"
    );
    const { processKioxiaCurrentReversalLongExactReopenSourceEvent } =
      await import("./kioxiaCurrentReversalLongExactEngine");
    const evaluations: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (const evaluate of [
      processKioxiaForwardShadowSourceEvent,
      processKioxiaAtrForwardShadowSourceEvent,
      processKioxiaCurrentReversalLongExactReopenSourceEvent,
    ]) {
      try {
        evaluations.push(await evaluate(input));
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `kioxia_forward_shadow_partial_failure:${errors.join(" | ")}`
      );
    }
    return { skipped: false as const, symbol: "285A", evaluations };
  }
  if (input.candle.symbol === "5803") {
    const { processFujikuraForwardShadowSourceEvent } = await import(
      "./fujikuraForwardShadowEngine"
    );
    const { processFujikuraMorningShortShadowSourceEvent } = await import(
      "./fujikuraMorningBreakdownShortShadowEngine"
    );
    const evaluations: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (const evaluate of [
      processFujikuraForwardShadowSourceEvent,
      processFujikuraMorningShortShadowSourceEvent,
    ]) {
      try {
        evaluations.push(await evaluate(input));
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (errors.length > 0)
      throw new Error(
        `fujikura_forward_shadow_partial_failure:${errors.join(" | ")}`
      );
    return { skipped: false as const, symbol: "5803", evaluations };
  }
  if (input.candle.symbol === "6981") {
    const { processMurataIndependentShadowSourceEvent } = await import(
      "./murataIndependentShadowEngine"
    );
    return processMurataIndependentShadowSourceEvent(input);
  }
  if (input.candle.symbol === "9984") {
    const { processSoftbankForwardShadowSourceEvent } = await import(
      "./softbankForwardShadowEngine"
    );
    return processSoftbankForwardShadowSourceEvent(input);
  }
  if (input.candle.symbol === "6857") {
    const { processAdvantestForwardShadowSourceEvent } = await import(
      "./advantestForwardShadowEngine"
    );
    return processAdvantestForwardShadowSourceEvent(input);
  }
  if (input.candle.symbol === "6976") {
    const { processTaiyoForwardShadowSourceEvent } = await import(
      "./taiyoForwardShadowEngine"
    );
    const { processTaiyoAfternoonLongForwardShadowSourceEvent } = await import(
      "./taiyoAfternoonLongForwardShadowEngine"
    );
    const evaluations: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    try {
      evaluations.push(await processTaiyoForwardShadowSourceEvent(input));
    } catch (error) {
      errors.push(`candidate_b_long:${String(error)}`);
    }
    try {
      evaluations.push(
        await processTaiyoAfternoonLongForwardShadowSourceEvent(input)
      );
    } catch (error) {
      errors.push(`afternoon_long:${String(error)}`);
    }
    if (errors.length > 0)
      throw new Error(
        `taiyo_forward_shadow_partial_failure:${errors.join(" | ")}`
      );
    return { skipped: false as const, symbol: "6976", evaluations };
  }
  if (input.candle.symbol === "6526") {
    const { processSocionextForwardShadowSourceEvent } = await import(
      "./socionextForwardShadowEngine"
    );
    return processSocionextForwardShadowSourceEvent(input);
  }
  if (input.candle.symbol === "3436") {
    const { processSumcoForwardShadowSourceEvent } = await import(
      "./sumcoForwardShadowEngine"
    );
    return processSumcoForwardShadowSourceEvent(input);
  }
  if (input.candle.symbol === "6146") {
    const { processDiscoOpeningShortForwardShadowSourceEvent } = await import(
      "./discoOpeningShortForwardShadowEngine"
    );
    const { processDiscoConfirmedLongForwardShadowSourceEvent } = await import(
      "./discoConfirmedLongForwardShadowEngine"
    );
    const evaluations: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    for (const [label, evaluate] of [
      ["opening_short", processDiscoOpeningShortForwardShadowSourceEvent],
      ["confirmed_long", processDiscoConfirmedLongForwardShadowSourceEvent],
    ] as const) {
      try {
        evaluations.push(await evaluate(input));
      } catch (error) {
        errors.push(`${label}:${String(error)}`);
      }
    }
    if (errors.length > 0)
      throw new Error(
        `disco_forward_shadow_partial_failure:${errors.join(" | ")}`
      );
    return { skipped: false as const, symbol: "6146", evaluations };
  }
  return { skipped: "mock_legacy_forward_shadow" };
}
