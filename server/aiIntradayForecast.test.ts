import { describe, expect, it } from "vitest";
import {
  AI_DAILY_FORECAST_SYMBOLS,
  buildQuantBaseline,
  type AiDailyForecastInput,
} from "./aiDailyForecastService";
import {
  _aiIntradayForecastTest,
  aiIntradayForecastInputHash,
  validateAiIntradayForecastOutput,
  type AiIntradayForecastInput,
} from "./aiIntradayForecastService";

const bars = Array.from({ length: 6 }, (_, index) => ({
  tradeDate: `2026-10-0${index + 1}`,
  open: 100 + index,
  high: 103 + index,
  low: 99 + index,
  close: 102 + index,
  volume: 1_000,
  barCount: 300,
  distinctMinuteCount: 300,
  firstTime: "09:00",
  lastTime: "15:29",
  duplicateMinuteCount: 0,
  maxGapMinutes: 0,
  usable: true,
  qualityReasons: [],
}));
const priorData: AiDailyForecastInput = {
  tradeDate: "2026-10-09",
  dataCutoffDate: "2026-10-08",
  capturedAtMs: 1,
  macroSnapshot: null,
  macroSnapshotId: null,
  inputQuality: "verified",
  qualityReasonCodes: [],
  symbols: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
    symbol,
    dailyBars: bars,
    baseline: buildQuantBaseline(symbol, bars),
  })),
};
const forecast = (symbol: string) => ({
  symbol,
  direction: "up",
  forecastLow: 98,
  forecastHigh: 108,
  zoneType: "pullback",
  zoneLow: 99,
  zoneHigh: 102,
  confirmPrice: 102,
  firstTarget: 105,
  stretchTarget: 108,
  baselineDecision: "maintained",
  aiAdjustment: {
    reason: "causal checkpoint evidence retained",
    exceptionReason: null,
  },
  rationale: "Only checkpoint data and prior behavior were used",
  evidenceUsed: ["checkpoint candles"],
  macroAgreement: "aligned",
  confidenceBasis: ["completed candles"],
});
const intradayInput = {
  tradeDate: "2026-10-09",
  checkpoint: "10:00",
  cutoffCandleTime: "09:59",
  effectiveFrom: "10:00",
  validUntil: "10:14",
  capturedAtMs: 1,
  morningSourceSnapshotId: "morning",
  morningInputHash: "hash",
  morningForecast: {},
  previousIntradayForecast: null,
  priorData,
  currentSession: { symbols: [], nikkei225Mini: {} },
  learning: [],
  inputQuality: "verified",
  qualityReasonCodes: [],
} as unknown as AiIntradayForecastInput;
const control = (symbol: string) => ({
  symbol,
  planDecision: "maintained",
  changeReason: "No causal contradiction at checkpoint",
  entryWindowStart: "10:00",
  entryWindowEnd: "10:14",
  forceExitTime: "15:20",
  openPositionAction: "keep",
  learningEvidenceUsed: ["prior closed shadow performance"],
});

describe("AI intraday forecast causal contract", () => {
  it("waits until both source processing and shadow materialization are complete", () => {
    const base = {
      tradeDate: "2026-10-09",
      checkpoint: "10:00" as const,
      cutoffCandleTime: "09:59",
      source: {
        count: 10,
        processed: 10,
        processing: 0,
        failed: 0,
        latestCandleTime: "09:59",
      },
      shadow: {
        count: 10,
        processed: 9,
        pending: 1,
        processing: 0,
        error: 0,
        latestProcessedCandleTime: "09:58",
      },
    };
    expect(
      _aiIntradayForecastTest.classifyAiIntradayCheckpointMaterialization(base)
        .status
    ).toBe("pending");
    expect(
      _aiIntradayForecastTest.classifyAiIntradayCheckpointMaterialization({
        ...base,
        shadow: {
          ...base.shadow,
          processed: 10,
          pending: 0,
          latestProcessedCandleTime: "09:59",
        },
      }).status
    ).toBe("complete");
  });
  it("activates a newly ingested plan only after its engine sequence boundary", () => {
    const validationJson = {
      activationAudit: { activationAfterEngineSequence: 120 },
    };
    expect(
      _aiIntradayForecastTest.isAiIntradaySnapshotCausallyAvailable(
        validationJson,
        120
      )
    ).toBe(false);
    expect(
      _aiIntradayForecastTest.isAiIntradaySnapshotCausallyAvailable(
        validationJson,
        121
      )
    ).toBe(true);
    expect(
      _aiIntradayForecastTest.isAiIntradaySnapshotCausallyAvailable(
        validationJson,
        null
      )
    ).toBe(false);
    expect(
      _aiIntradayForecastTest.isAiIntradaySnapshotCausallyAvailable({}, null)
    ).toBe(true);
  });
  it("marks only symbols whose first target was reached before activation", () => {
    const output = {
      forecast: {
        forecasts: AI_DAILY_FORECAST_SYMBOLS.map(forecast),
        marketSummary: "checkpoint",
        globalReasonCodes: ["causal_checkpoint_only"],
      },
      controls: AI_DAILY_FORECAST_SYMBOLS.map(control),
      checkpointSummary: "No look-ahead data used",
    };
    const audit = _aiIntradayForecastTest.buildAiIntradayActivationAudit({
      output,
      activationAfterEngineSequence: 120,
      events: [
        {
          engineSequence: 118,
          symbol: "285A",
          candleTime: "10:06",
          high: 106,
          low: 100,
        },
        {
          engineSequence: 119,
          symbol: "3436",
          candleTime: "10:07",
          high: 104,
          low: 100,
        },
      ],
    });
    expect(audit.symbols.find(item => item.symbol === "285A")).toMatchObject({
      firstTargetReachedBeforeActivation: true,
      entryDisposition: "missed_move_no_entry",
    });
    expect(audit.symbols.find(item => item.symbol === "3436")).toMatchObject({
      firstTargetReachedBeforeActivation: false,
      entryDisposition: "eligible_after_activation",
    });
  });
  it("uses 09:14 as the causal cutoff for the first 09:15 v6 checkpoint", () => {
    expect(_aiIntradayForecastTest.checkpointSpec["09:15"]).toEqual({
      cutoff: "09:14",
      effectiveFrom: "09:15",
      validUntil: "09:29",
    });
    expect(_aiIntradayForecastTest.checkpointSpec["09:45"]).toEqual({
      cutoff: "09:44",
      effectiveFrom: "09:45",
      validUntil: "09:59",
    });
    expect(_aiIntradayForecastTest.checkpointSpec["13:30"]).toEqual({
      cutoff: "13:29",
      effectiveFrom: "13:30",
      validUntil: "13:59",
    });
  });
  it("uses only minutes completed before each checkpoint and excludes the lunch break", () => {
    const expected = _aiIntradayForecastTest.expectedSessionMinutes("12:34");
    expect(expected[0]).toBe("09:00");
    expect(expected.at(-1)).toBe("12:34");
    expect(expected).not.toContain("11:30");
    expect(expected).not.toContain("12:29");
  });
  it("retains only complete causal five-minute buckets", () => {
    const candles = [
      "09:00",
      "09:01",
      "09:02",
      "09:03",
      "09:04",
      "09:05",
      "09:06",
      "09:08",
      "09:09",
    ].map((candleTime, index) => ({
      candleTime,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 1_000,
    }));
    const completed = _aiIntradayForecastTest.completedFiveMinuteBars(candles);
    expect(completed).toHaveLength(1);
    expect(completed[0]?.candleTime).toBe("09:04");
  });
  it("accepts exactly ten bounded plans and rejects a window outside the checkpoint", () => {
    const output = {
      forecast: {
        forecasts: AI_DAILY_FORECAST_SYMBOLS.map(forecast),
        marketSummary: "checkpoint",
        globalReasonCodes: ["causal_checkpoint_only"],
      },
      controls: AI_DAILY_FORECAST_SYMBOLS.map(control),
      checkpointSummary: "No look-ahead data used",
    };
    expect(validateAiIntradayForecastOutput(output, intradayInput).valid).toBe(
      true
    );
    output.controls[0]!.entryWindowStart = "09:59";
    const result = validateAiIntradayForecastOutput(output, intradayInput);
    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain(
      "entry_window_outside_checkpoint:285A"
    );
  });
  it("limits the 11:30 bridge plan to 12:30–12:34 and rejects a new morning entry", () => {
    const bridgeInput = {
      ...intradayInput,
      checkpoint: "11:30",
      cutoffCandleTime: "11:29",
      effectiveFrom: "11:30",
      validUntil: "12:34",
    } as AiIntradayForecastInput;
    const output = {
      forecast: {
        forecasts: AI_DAILY_FORECAST_SYMBOLS.map(forecast),
        marketSummary: "bridge",
        globalReasonCodes: ["causal_checkpoint_only"],
      },
      controls: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
        ...control(symbol),
        planDecision: "disabled" as const,
        entryPolicy: "manage_only" as const,
        entryWindowStart: "12:30",
        entryWindowEnd: "12:34",
      })),
      checkpointSummary: "Lunch bridge only",
    };
    expect(validateAiIntradayForecastOutput(output, bridgeInput).valid).toBe(
      true
    );
    output.controls[0]!.entryWindowStart = "11:30";
    const rejected = validateAiIntradayForecastOutput(output, bridgeInput);
    expect(rejected.valid).toBe(false);
    expect(rejected.reasonCodes).toContain(
      "1130_bridge_entry_window_invalid:285A"
    );
  });
  it("passes checkpoint-causal multiple AI trades and open positions without mode mixing", () => {
    const journal = _aiIntradayForecastTest.buildAiSessionTradeJournal({
      trades: [
        {
          id: 1,
          strategyVersion: "candidate-8035-ai-adaptive-forecast-v5",
          evaluationMode: "signal_quality",
          symbol: "8035",
          side: "long",
          entryTradeDate: "2026-10-09",
          entryCandleTime: "09:01",
          entrySourceEventId: "entry-one",
          signalCandleTime: "09:00",
          entryPrice: "100",
          shares: 100,
          exitTradeDate: "2026-10-09",
          exitCandleTime: "09:10",
          exitSourceEventId: "exit-one",
          exitPrice: "104",
          pnl: 400,
          realizedR: "1",
          exitReason: "first_target",
        },
        {
          id: 2,
          strategyVersion: "candidate-8035-ai-adaptive-forecast-v5",
          evaluationMode: "signal_quality",
          symbol: "8035",
          side: "short",
          entryTradeDate: "2026-10-09",
          entryCandleTime: "10:01",
          entrySourceEventId: "entry-two",
          signalCandleTime: "10:00",
          entryPrice: "105",
          shares: 100,
          exitTradeDate: null,
          exitCandleTime: null,
          exitSourceEventId: null,
          exitPrice: null,
          pnl: null,
          realizedR: null,
          exitReason: null,
        },
        {
          id: 3,
          strategyVersion: "candidate-8035-ai-adaptive-forecast-v5",
          evaluationMode: "capital_constrained",
          symbol: "8035",
          side: "long",
          entryTradeDate: "2026-10-09",
          entryCandleTime: "09:01",
          entrySourceEventId: "entry-capital",
          signalCandleTime: "09:00",
          entryPrice: "100",
          shares: 200,
          exitTradeDate: "2026-10-09",
          exitCandleTime: "09:10",
          exitSourceEventId: "exit-capital",
          exitPrice: "104",
          pnl: 800,
          realizedR: "1",
          exitReason: "first_target",
        },
      ] as never[],
      events: [
        {
          strategyVersion: "candidate-8035-ai-adaptive-forecast-v5",
          evaluationMode: "signal_quality",
          sourceEventId: "entry-one",
          decisionJson: { plan: { sourceSnapshotId: "plan-0830" } },
        },
        {
          strategyVersion: "candidate-8035-ai-adaptive-forecast-v5",
          evaluationMode: "signal_quality",
          sourceEventId: "entry-two",
          decisionJson: { plan: { sourceSnapshotId: "plan-1000" } },
        },
      ] as never[],
      candlesBySymbol: new Map([
        [
          "8035",
          [
            {
              candleTime: "09:01",
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 1,
            },
            {
              candleTime: "09:10",
              open: 103,
              high: 105,
              low: 102,
              close: 104,
              volume: 1,
            },
            {
              candleTime: "10:01",
              open: 105,
              high: 106,
              low: 104,
              close: 105,
              volume: 1,
            },
            {
              candleTime: "10:02",
              open: 104,
              high: 105,
              low: 102,
              close: 103,
              volume: 1,
            },
          ],
        ],
      ]),
      cutoffCandleTime: "10:02",
    });
    const signalRows = journal.filter(
      (row: any) => row.evaluationMode === "signal_quality"
    );
    expect(signalRows).toHaveLength(2);
    expect(signalRows[0]).toMatchObject({
      entryKind: "initial",
      isOpeningTrade: true,
      planId: "plan-0830",
      statusAtCheckpoint: "closed",
      mfePct: 5,
    });
    expect(signalRows[1]).toMatchObject({
      entryKind: "reentry",
      planId: "plan-1000",
      statusAtCheckpoint: "open",
      exitTime: null,
    });
    expect(
      journal.find((row: any) => row.evaluationMode === "capital_constrained")
    ).toMatchObject({ entryKind: "initial", shares: 200 });
  });
  it("feeds closed losses and their exit reasons into later AI inputs without changing parameters automatically", () => {
    const performance = _aiIntradayForecastTest.summarizeLearning(
      [
        {
          id: 1,
          symbol: "8035",
          entryTradeDate: "2026-10-08",
          entryCandleTime: "10:01",
          exitCandleTime: "10:12",
          side: "long",
          pnl: -12_000,
          realizedR: "-1",
          exitReason: "stop_loss",
        },
        {
          id: 2,
          symbol: "8035",
          entryTradeDate: "2026-10-09",
          entryCandleTime: "09:45",
          exitCandleTime: "10:05",
          side: "short",
          pnl: 8_000,
          realizedR: "0.7",
          exitReason: "first_target",
        },
      ] as never[],
      "8035"
    );
    expect(performance.all).toMatchObject({
      closedTrades: 2,
      wins: 1,
      losses: 1,
      totalPnl: -4_000,
    });
    expect(performance.recentLosses[0]).toMatchObject({
      tradeDate: "2026-10-08",
      exitReason: "stop_loss",
      pnl: -12_000,
    });
  });

  it("classifies every 09:00–09:29 entry as opening trade from its actual entry time", () => {
    const times = ["09:00", "09:01", "09:29", "09:30"];
    const journal = _aiIntradayForecastTest.buildAiSessionTradeJournal({
      trades: times.map((entryCandleTime, index) => ({
        id: index + 1,
        strategyVersion: "candidate-8035-ai-adaptive-forecast-v5",
        evaluationMode: "signal_quality",
        symbol: "8035",
        side: "long",
        entryTradeDate: "2026-10-09",
        entryCandleTime,
        entrySourceEventId: `entry-${entryCandleTime}`,
        signalCandleTime: "09:00",
        entryPrice: "100",
        exitTradeDate: null,
        exitCandleTime: null,
        exitSourceEventId: null,
        exitPrice: null,
        pnl: null,
        realizedR: null,
        exitReason: null,
      })) as never[],
      events: [] as never[],
      candlesBySymbol: new Map([
        [
          "8035",
          times.map(candleTime => ({
            candleTime,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1,
          })),
        ],
      ]),
      cutoffCandleTime: "09:30",
    });
    expect(journal.map(row => row.isOpeningTrade)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("uses the full causal holding interval for closed-trade MFE/MAE and excludes exit-after data", () => {
    const journal = _aiIntradayForecastTest.buildAiSessionTradeJournal({
      trades: [
        {
          id: 1,
          strategyVersion: "candidate-8035-ai-adaptive-forecast-v5",
          evaluationMode: "signal_quality",
          symbol: "8035",
          side: "long",
          entryTradeDate: "2026-10-09",
          entryCandleTime: "09:01",
          entrySourceEventId: "entry",
          signalCandleTime: "09:01",
          entryPrice: "100",
          exitTradeDate: "2026-10-09",
          exitCandleTime: "09:10",
          exitSourceEventId: "exit",
          exitPrice: "104",
          pnl: 400,
          realizedR: "1",
          exitReason: "first_target",
        },
      ] as never[],
      events: [] as never[],
      candlesBySymbol: new Map([
        [
          "8035",
          [
            {
              candleTime: "09:01",
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 1,
            },
            {
              candleTime: "09:10",
              open: 104,
              high: 110,
              low: 98,
              close: 104,
              volume: 1,
            },
            // These large post-exit values must not influence a 09:01–09:10 trade.
            {
              candleTime: "10:59",
              open: 104,
              high: 250,
              low: 10,
              close: 200,
              volume: 1,
            },
          ],
        ],
      ]),
      cutoffCandleTime: "10:59",
    });
    expect(journal[0]).toMatchObject({
      mfePct: 10,
      maePct: -2,
      mfeMaeQuality: "degraded",
    });
  });

  it("uses only candles through the checkpoint for an open trade's MFE/MAE", () => {
    const journal = _aiIntradayForecastTest.buildAiSessionTradeJournal({
      trades: [
        {
          id: 1,
          strategyVersion: "candidate-8035-ai-adaptive-forecast-v5",
          evaluationMode: "signal_quality",
          symbol: "8035",
          side: "long",
          entryTradeDate: "2026-10-09",
          entryCandleTime: "09:01",
          entrySourceEventId: "entry",
          signalCandleTime: "09:01",
          entryPrice: "100",
          exitTradeDate: null,
          exitCandleTime: null,
          exitSourceEventId: null,
          exitPrice: null,
          pnl: null,
          realizedR: null,
          exitReason: null,
        },
      ] as never[],
      events: [] as never[],
      candlesBySymbol: new Map([
        [
          "8035",
          [
            {
              candleTime: "09:01",
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 1,
            },
            {
              candleTime: "10:59",
              open: 101,
              high: 110,
              low: 90,
              close: 101,
              volume: 1,
            },
            // checkpoint after-data must never be read.
            {
              candleTime: "11:00",
              open: 101,
              high: 300,
              low: 1,
              close: 200,
              volume: 1,
            },
          ],
        ],
      ]),
      cutoffCandleTime: "10:59",
    });
    expect(journal[0]).toMatchObject({
      statusAtCheckpoint: "open",
      mfePct: 10,
      maePct: -10,
      mfeMaeQuality: "degraded",
    });
  });

  it("requires same-day signal_quality trade evidence while preserving capital mode as execution audit", () => {
    const output = {
      forecast: {
        forecasts: AI_DAILY_FORECAST_SYMBOLS.map(forecast),
        marketSummary: "checkpoint",
        globalReasonCodes: ["causal_checkpoint_only"],
      },
      controls: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
        ...control(symbol),
        learningEvidenceUsed:
          symbol === "8035"
            ? ["session_trade:signal_quality:entry-one"]
            : ["no_same_day_strategy_trade"],
      })),
      checkpointSummary:
        "Same-day strategy trade was reviewed without auto-reversal",
    };
    const withSessionTrade = {
      ...intradayInput,
      aiSessionStrategyJournal: [
        { symbol: "8035", entrySourceEventId: "entry-one" },
      ],
    } as AiIntradayForecastInput;
    expect(
      validateAiIntradayForecastOutput(output, withSessionTrade).valid
    ).toBe(true);
    output.controls.find(item => item.symbol === "8035")!.learningEvidenceUsed =
      ["no_same_day_strategy_trade"];
    const rejected = validateAiIntradayForecastOutput(output, withSessionTrade);
    expect(rejected.valid).toBe(false);
    expect(rejected.reasonCodes).toContain(
      "session_trade_evidence_missing:8035:session_trade:signal_quality:entry-one"
    );
  });
});

it("round-trips separate position management and rejects unknown causal evidence", () => {
  const management = {
    planId: "management-1",
    positionId: "8035:long:entry-1",
    symbol: "8035",
    side: "long",
    basedOnEventId: "observed",
    action: "hold",
    protectiveStop: 99,
    validUntil: "10:30",
    reason: "context",
    knowledgeIds: [],
  };
  const output = {
    forecast: {
      forecasts: AI_DAILY_FORECAST_SYMBOLS.map(forecast),
      marketSummary: "checkpoint",
      globalReasonCodes: ["causal"],
    },
    controls: AI_DAILY_FORECAST_SYMBOLS.map(control),
    checkpointSummary: "management separated",
    managementPlans: [management],
  };
  const input = {
    ...intradayInput,
    aiCurrentPositions: [
      {
        symbol: "8035",
        side: "long",
        entrySourceEventId: "entry-1",
        positionId: management.positionId,
      },
    ],
    managementDecisionEvents: [{ symbol: "8035", sourceEventId: "observed" }],
  } as AiIntradayForecastInput;
  const result = validateAiIntradayForecastOutput(output, input);
  expect(result.valid).toBe(true);
  expect(result.output?.managementPlans).toEqual([management]);
  const bad = validateAiIntradayForecastOutput(
    {
      ...output,
      managementPlans: [
        { ...management, basedOnEventId: "future", knowledgeIds: ["unknown"] },
      ],
    },
    input
  );
  expect(bad.reasonCodes).toContain("management_basis_event_unknown:future");
  expect(bad.reasonCodes).toContain("management_knowledge_unknown:unknown");
});
