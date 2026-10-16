import { afterEach, describe, expect, it, vi } from "vitest";
import * as database from "./db";
import * as daily from "./aiDailyForecastService";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { AI_DAILY_FORECAST_SYMBOLS } from "./aiDailyForecastService";
import {
  selectAiIntradayProcessedCutoff,
  assertAiIntradayCutoffNotAfterArrival,
  prepareAiIntradayForecastInput,
  buildAiIntradayForecastInput,
  ingestAiIntradayForecastSubmission,
  aiIntradayForecastInputHash,
  _aiIntradayForecastTest as helpers,
  type AiIntradayForecastInput,
} from "./aiIntradayForecastService";

const rowsAt = (candleTime: string, shadowStatus = "processed") =>
  AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
    candleTime,
    symbol,
    sourceStatus: "processed",
    shadowStatus,
  }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function mockInputDatabase() {
  const dialect = new MySqlDialect();
  const filters: unknown[][] = [];
  const source = {
    count: 20,
    processed: 20,
    processing: 0,
    failed: 0,
    latestCandleTime: "14:07",
  };
  const shadow = {
    count: 20,
    processed: 20,
    pending: 0,
    processing: 0,
    error: 0,
    latestProcessedCandleTime: "14:07",
  };
  const candles = ["13:59", "14:07", "14:08"].flatMap(candleTime =>
    AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
      symbol,
      candleTime,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 100,
    }))
  );
  const pendingResults = [
    [...rowsAt("13:59"), ...rowsAt("14:07"), ...rowsAt("14:08", "pending")],
    [source],
    [shadow],
    candles,
    [],
    [],
    [],
    [source],
    [shadow],
  ];
  const db = {
    select: vi.fn(() => {
      let result = pendingResults.shift() ?? [];
      const chain: any = {
        from: () => chain,
        leftJoin: () => chain,
        innerJoin: () => chain,
        where: (condition: any) => {
          const params = dialect.sqlToQuery(condition).params;
          filters.push(params);
          if (result === candles) {
            const cutoff = params.at(-1) as string;
            result = candles.filter(row => row.candleTime <= cutoff);
          }
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: any, reject: any) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    }),
  };
  vi.spyOn(database, "getDb").mockResolvedValue(db as any);
  vi.spyOn(daily, "getLatestAiDailyForecastSnapshot").mockResolvedValue({
    sourceSnapshotId: "morning",
    inputHash: "morning-hash",
    forecastJson: {},
    qualityStatus: "verified",
  } as any);
  vi.spyOn(daily, "buildAiDailyForecastInput").mockResolvedValue({
    tradeDate: "2026-10-16",
    dataCutoffDate: "2026-10-15",
    qualityReasonCodes: [],
    symbols: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
      symbol,
      baseline: daily.buildQuantBaseline(symbol, []),
      dailyBars: [],
    })),
    latestLearningReview: {},
  } as any);
  return { filters, pendingResults, db };
}

describe("prepare frozen input", () => {
  it("persists the delayed label and blocks a missed move at the ingest activation boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T14:10:00+09:00"));
    vi.stubEnv("AI_DAILY_FORECAST_INGEST_KEY", "a".repeat(32));
    const { pendingResults, db } = mockInputDatabase();
    const frozen = await prepareAiIntradayForecastInput({
      tradeDate: "2026-10-16",
      checkpoint: "14:00",
    });
    pendingResults.push(
      [{ engineSequence: 120 }] as any,
      [
        {
          engineSequence: 100,
          symbol: AI_DAILY_FORECAST_SYMBOLS[0],
          candleTime: "14:04",
          inputJson: { candle: { high: 106, low: 100 } },
        },
      ] as any,
      [],
      []
    );
    let saved: any;
    (db as any).insert = () => ({
      values: async (data: any) => {
        saved = data;
        pendingResults.push([data] as any);
      },
    });
    const forecasts = AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
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
      aiAdjustment: { reason: "causal evidence", exceptionReason: null },
      rationale: "processed candles",
      evidenceUsed: ["checkpoint candles"],
      macroAgreement: "aligned",
      confidenceBasis: ["completed candles"],
    }));
    const submission: Parameters<typeof ingestAiIntradayForecastSubmission>[0] =
      {
        sourceRevisionId: "ai-intraday-forecast:2026-10-16:1400:test",
        tradeDate: frozen.tradeDate,
        checkpoint: frozen.checkpoint,
        morningSourceSnapshotId: frozen.morningSourceSnapshotId,
        capturedAtMs: frozen.capturedAtMs,
        sourceMode: "manual_dry_run",
        inputHash: frozen.inputHash!,
        frozenInput: frozen,
        inputSnapshotToken: frozen.inputSnapshotToken,
        generatorId: "test",
        promptVersion: "test",
        aiFinalForecast: {
          forecast: {
            forecasts,
            marketSummary: "checkpoint",
            globalReasonCodes: ["causal"],
          },
          controls: AI_DAILY_FORECAST_SYMBOLS.map(symbol => ({
            symbol,
            planDecision: "maintained",
            changeReason: "causal checkpoint",
            entryWindowStart: "14:10",
            entryWindowEnd: "14:29",
            forceExitTime: "15:20",
            openPositionAction: "keep",
            learningEvidenceUsed: ["prior evidence"],
          })),
          checkpointSummary: "latest processed candles",
        },
      };
    const changed = {
      ...frozen,
      cutoffCandleTime: "14:08",
      materializationWatermark: {
        ...frozen.materializationWatermark!,
        cutoffCandleTime: "14:08",
      },
    };
    changed.inputHash = aiIntradayForecastInputHash(changed);
    await expect(
      ingestAiIntradayForecastSubmission({
        ...submission,
        inputHash: changed.inputHash,
        frozenInput: changed,
      })
    ).rejects.toThrow("ai_intraday_input_snapshot_signature_invalid");
    const future = {
      ...changed,
      cutoffCandleTime: "14:11",
      materializationWatermark: {
        ...changed.materializationWatermark,
        cutoffCandleTime: "14:11",
      },
    };
    future.inputHash = aiIntradayForecastInputHash(future);
    future.inputSnapshotToken = helpers.signAiIntradayInputSnapshot(future);
    await expect(
      ingestAiIntradayForecastSubmission({
        ...submission,
        inputHash: future.inputHash,
        frozenInput: future,
        inputSnapshotToken: future.inputSnapshotToken,
      })
    ).rejects.toThrow("ai_intraday_cutoff_after_arrival");
    await ingestAiIntradayForecastSubmission(submission);
    expect(saved.cutoffCandleTime).toBe("14:07");
    expect(saved.validationJson.cutoffMode).toBe("delayed_latest_processed");
    expect(saved.validationJson.delayMinutes).toBe(8);
    expect(saved.inputJson).toEqual(frozen);
    expect(
      saved.validationJson.activationAudit.symbols[0].entryDisposition
    ).toBe("missed_move_no_entry");
    expect(
      helpers.isAiIntradaySnapshotCausallyAvailable(saved.validationJson, 120)
    ).toBe(false);
    expect(
      helpers.isAiIntradaySnapshotCausallyAvailable(saved.validationJson, 121)
    ).toBe(true);
  });
  it("keeps on-time market input and output decisions identical to the fixed-cutoff builder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T14:00:00+09:00"));
    vi.stubEnv("AI_DAILY_FORECAST_INGEST_KEY", "a".repeat(32));
    const legacyDb = mockInputDatabase();
    legacyDb.pendingResults.splice(0, 3);
    legacyDb.pendingResults.splice(-2);
    const legacy = await buildAiIntradayForecastInput({
      tradeDate: "2026-10-16",
      checkpoint: "14:00",
      capturedAtMs: Date.now(),
    });
    mockInputDatabase();
    const frozen = await prepareAiIntradayForecastInput({
      tradeDate: "2026-10-16",
      checkpoint: "14:00",
    });
    const {
      cutoffMode,
      delayMinutes,
      remainingMinutes,
      materializationWatermark,
      inputSnapshotToken,
      inputHash,
      ...marketInput
    } = frozen;
    const { inputHash: legacyHash, ...legacyMarketInput } = legacy;
    expect(marketInput).toEqual(legacyMarketInput);
    expect(cutoffMode).toBe("fixed_checkpoint");
    expect(delayMinutes).toBe(0);
  });
  it("keeps the existing pending error when the fixed cutoff is not materialized", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T14:10:00+09:00"));
    const { pendingResults } = mockInputDatabase();
    pendingResults[0] = rowsAt("13:59", "pending") as any;
    pendingResults[2] = [
      {
        count: 20,
        processed: 19,
        pending: 1,
        processing: 0,
        error: 0,
        latestProcessedCandleTime: "13:58",
      },
    ] as any;
    await expect(
      prepareAiIntradayForecastInput({
        tradeDate: "2026-10-16",
        checkpoint: "14:00",
      })
    ).rejects.toThrow("ai_intraday_materialization_pending");
  });
  it("bounds every same-day input query at the chosen cutoff and preserves the signed freeze", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T14:10:00+09:00"));
    vi.stubEnv("AI_DAILY_FORECAST_INGEST_KEY", "a".repeat(32));
    const { filters, pendingResults } = mockInputDatabase();
    const frozen = await prepareAiIntradayForecastInput({
      tradeDate: "2026-10-16",
      checkpoint: "14:00",
    });
    expect(frozen.cutoffCandleTime).toBe("14:07");
    expect(frozen.cutoffMode).toBe("delayed_latest_processed");
    expect(frozen.delayMinutes).toBe(8);
    expect(frozen.remainingMinutes).toBe(19);
    expect(frozen.validUntil).toBe("14:29");
    expect(
      frozen.currentSession.symbols.every(
        row => row.summary.lastTime === "14:07"
      )
    ).toBe(true);
    expect(
      [1, 2, 3, 4, 7, 8].every(index => filters[index].includes("14:07"))
    ).toBe(true);
    expect(pendingResults).toHaveLength(0);
    expect(
      helpers.verifyAiIntradayInputSnapshotToken(
        frozen,
        frozen.inputSnapshotToken
      )
    ).toBe(true);
    vi.setSystemTime(new Date("2026-10-16T14:12:00+09:00"));
    expect(
      helpers.verifyAiIntradayInputSnapshotToken(
        frozen,
        frozen.inputSnapshotToken
      )
    ).toBe(true);
  });
});

describe("latest processed cutoff", () => {
  it("keeps the fixed cutoff on time and freezes at 14:07 despite later pending bars", () => {
    const rows = [
      "13:59",
      "14:00",
      "14:01",
      "14:02",
      "14:03",
      "14:04",
      "14:05",
      "14:06",
      "14:07",
    ].flatMap(time => rowsAt(time));
    rows.push(...rowsAt("14:08", "pending"), ...rowsAt("14:09"));
    expect(
      selectAiIntradayProcessedCutoff({
        checkpoint: "14:00",
        nowTime: "14:00",
        rows,
      })
    ).toBe("13:59");
    expect(
      selectAiIntradayProcessedCutoff({
        checkpoint: "14:00",
        nowTime: "14:10",
        rows,
      })
    ).toBe("14:07");
  });
  it("does not advance past missing dispatch or unprocessed source", () => {
    for (const row of [
      { ...rowsAt("14:00")[0], shadowStatus: null },
      { ...rowsAt("14:00")[0], sourceStatus: "processing" },
    ]) {
      expect(
        selectAiIntradayProcessedCutoff({
          checkpoint: "14:00",
          nowTime: "14:10",
          rows: [...rowsAt("13:59"), row, ...rowsAt("14:07")],
        })
      ).toBe("13:59");
    }
  });
  it("keeps pending fixed cutoff for the existing materialization gate and excludes validUntil", () => {
    expect(
      selectAiIntradayProcessedCutoff({
        checkpoint: "14:00",
        nowTime: "14:30",
        rows: [...rowsAt("13:59", "pending"), ...rowsAt("14:07")],
      })
    ).toBe("13:59");
    expect(
      selectAiIntradayProcessedCutoff({
        checkpoint: "14:00",
        nowTime: "14:30",
        rows: [...rowsAt("14:28"), ...rowsAt("14:29")],
      })
    ).toBe("14:28");
  });
  it("signs the frozen cutoff and rejects tampering", () => {
    vi.stubEnv("AI_DAILY_FORECAST_INGEST_KEY", "a".repeat(32));
    try {
      const input = {
        tradeDate: "2026-10-16",
        checkpoint: "14:00",
        cutoffCandleTime: "14:07",
        capturedAtMs: 1,
        inputHash: "hash",
      } as AiIntradayForecastInput;
      const token = helpers.signAiIntradayInputSnapshot(input);
      expect(helpers.verifyAiIntradayInputSnapshotToken(input, token)).toBe(
        true
      );
      expect(
        helpers.verifyAiIntradayInputSnapshotToken(
          { ...input, cutoffCandleTime: "14:08" },
          token
        )
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("rejects a cutoff after arrival, including a future date", () => {
    const arrival = Date.parse("2026-10-16T14:10:00+09:00");
    expect(() =>
      assertAiIntradayCutoffNotAfterArrival("2026-10-16", "14:10", arrival)
    ).not.toThrow();
    expect(() =>
      assertAiIntradayCutoffNotAfterArrival("2026-10-16", "14:11", arrival)
    ).toThrow("ai_intraday_cutoff_after_arrival");
    expect(() =>
      assertAiIntradayCutoffNotAfterArrival("2026-10-17", "13:59", arrival)
    ).toThrow();
  });
});
