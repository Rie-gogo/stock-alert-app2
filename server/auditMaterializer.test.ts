import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  acquireRtNamedWorkerLock: vi.fn(async () => true),
  getRtAuditTradeDateFinality: vi.fn(async () => null),
  getRtAuditTradeDateWatermark: vi.fn(async () => ({
    source: { count: 10, maxId: 10, processed: 10, processing: 0, failed: 0 },
    decision: { count: 10, maxId: 10 },
    candidateOutbox: {
      processed: 10,
      pending: 0,
      processing: 0,
      retryableError: 0,
      terminal: 0,
    },
    shadowOutbox: {
      count: 10,
      processed: 10,
      pending: 0,
      processing: 0,
      error: 0,
    },
    unresolvedGaps: 0,
    latestUpstreamCreatedAt: new Date("2026-10-07T06:50:00Z"),
  })),
  getRtDailyAuditMaterialization: vi.fn(async () => null),
  getRtMarketContextEventsForDate: vi.fn(async () => []),
  getLatestRtPremarketContextSnapshot: vi.fn(async () => null),
  getRtPortfolioMaterializationProgress: vi.fn(async () => ({
    processedThroughEngineSequence: 10,
    sourceDecisionCount: 10,
  })),
  reopenRtAuditMaterializationsForTradeDate: vi.fn(),
  releaseRtNamedWorkerLock: vi.fn(),
  upsertRtAuditTradeDateFinality: vi.fn(async input => ({ id: 1, ...input })),
  upsertRtDailyAuditMaterialization: vi.fn(async input => input),
}));
const portfolioMock = vi.hoisted(() => ({
  materializePortfolioBundleForDate: vi.fn(async () => ({
    status: "processing" as const,
  })),
}));
const parityMock = vi.hoisted(() => ({
  compareTelCurrentParityForDate: vi.fn(async () => ({
    skipped: false,
    processed: 10,
    matched: 10,
    mismatched: 0,
  })),
}));
const candidateOutcomeParityMock = vi.hoisted(() => ({
  compareCurrentCandidateOutcomesForDate: vi.fn(async () => ({
    matched: 8,
    mismatched: 2,
    incomplete: 0,
  })),
}));
const outcomeMock = vi.hoisted(() => ({
  buildOutcomeLabelsForDate: vi.fn(async () => ({
    labels: 1,
    completed: 1,
    blocked: 0,
  })),
  buildDivergenceHypotheses: vi.fn(async () => ({ hypotheses: [] })),
}));
const forwardReplayMock = vi.hoisted(() => ({
  materializeNextForwardReplayForDate: vi.fn(async () => ({
    status: "complete" as const,
    completedVersions: 19,
  })),
}));
const discoPortfolioMock = vi.hoisted(() => ({
  buildDiscoShortPortfolioComparisonForDate: vi.fn(async () => ({
    scenarios: {},
  })),
}));
const multiSymbolMonitoringMock = vi.hoisted(() => ({
  materializeMultiSymbolMonitoringForDate: vi.fn(async () => ({
    ready: true,
    incompleteReason: null,
    summary: {
      plans: 33,
      signals: 10,
      completedTrades: 10,
      openTrades: 0,
      missingTrades: 0,
    },
  })),
}));
const tenSymbolSelectorMock = vi.hoisted(() => ({
  materializeTenSymbolSelectorFeatureForDate: vi.fn(async () => ({
    created: false,
    result: {},
  })),
  materializeTenSymbolNextDaySelectorResultForDate: vi.fn(async () => ({
    created: false,
    result: {},
  })),
  materializeTenSymbolNextDaySelectorForSourceDate: vi.fn(async () => ({
    created: false,
    targetDate: "2026-10-08",
    result: {},
  })),
}));
const routeGranularMonitoringMock = vi.hoisted(() => ({
  materializeRouteGranularMonitoringForDate: vi.fn(async () => ({
    ready: true,
    incompleteReason: null,
  })),
}));
const routeGranularSelectorMock = vi.hoisted(() => ({
  materializeRouteGranularSelectorResultForDate: vi.fn(async () => ({
    created: false,
    result: {},
  })),
  materializeRouteGranularSelectorForSourceDate: vi.fn(async () => ({
    created: false,
    targetDate: "2026-10-08",
    result: {},
  })),
}));
const contextPerformanceMock = vi.hoisted(() => ({
  materializeMarketContextPerformanceForDate: vi.fn(async () => ({
    created: false,
    result: {},
  })),
}));

vi.mock("./db", () => dbMock);
vi.mock("./portfolioAudit", () => ({
  ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION: "receipt-v2",
  ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION: "minute-v2",
  PORTFOLIO_BUNDLE_COMPONENT: "portfolio_bundle",
  PORTFOLIO_MATERIALIZATION_VERSION: "portfolio-materialization-p0-v1",
  materializePortfolioBundleForDate:
    portfolioMock.materializePortfolioBundleForDate,
}));
vi.mock("./telParityComparison", () => parityMock);
vi.mock("./currentCandidateOutcomeParity", () => ({
  CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT:
    "current_candidate_outcome_parity",
  CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION:
    "current-vs-signal-quality-outcome-v1",
  compareCurrentCandidateOutcomesForDate:
    candidateOutcomeParityMock.compareCurrentCandidateOutcomesForDate,
}));
vi.mock("./outcomeDivergenceAudit", () => outcomeMock);
vi.mock("./forwardReplayMaterializer", () => forwardReplayMock);
vi.mock("./discoOpeningShortPortfolioComparison", () => ({
  DISCO_SHORT_PORTFOLIO_COMPONENT: "disco_short_portfolio_comparison",
  DISCO_SHORT_PORTFOLIO_VERSION: "position-b-10-symbol-891m-v1",
  buildDiscoShortPortfolioComparisonForDate:
    discoPortfolioMock.buildDiscoShortPortfolioComparisonForDate,
}));
vi.mock("./multiSymbolMonitoringMaterializer", () => ({
  MULTI_SYMBOL_MONITORING_COMPONENT: "monitoring_trend_10_symbols",
  MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION:
    "monitoring-trend-10-symbols-daily-v1",
  materializeMultiSymbolMonitoringForDate:
    multiSymbolMonitoringMock.materializeMultiSymbolMonitoringForDate,
}));
vi.mock("./tenSymbolNextDaySelector", () => ({
  TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT: "ten_symbol_selector_feature",
  TEN_SYMBOL_SELECTOR_RESULT_COMPONENT: "ten_symbol_next_day_selector_result",
  TEN_SYMBOL_SELECTOR_SNAPSHOT_COMPONENT: "ten_symbol_next_day_selector",
  TEN_SYMBOL_SELECTOR_VERSION: "ten-symbol-technical-regime-v2",
  materializeTenSymbolSelectorFeatureForDate:
    tenSymbolSelectorMock.materializeTenSymbolSelectorFeatureForDate,
  materializeTenSymbolNextDaySelectorResultForDate:
    tenSymbolSelectorMock.materializeTenSymbolNextDaySelectorResultForDate,
  materializeTenSymbolNextDaySelectorForSourceDate:
    tenSymbolSelectorMock.materializeTenSymbolNextDaySelectorForSourceDate,
}));
vi.mock("./routeGranularMonitoringMaterializer", () => ({
  ROUTE_GRANULAR_MONITORING_COMPONENT: "monitoring_route_granular_10_symbols",
  ROUTE_GRANULAR_MONITORING_VERSION: "monitoring-route-granular-10-symbols-v1",
  ROUTE_GRANULAR_MONITORING_START_DATE: "2026-10-02",
  materializeRouteGranularMonitoringForDate:
    routeGranularMonitoringMock.materializeRouteGranularMonitoringForDate,
}));
vi.mock("./routeGranularNextDaySelector", () => ({
  ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT:
    "route_granular_next_day_selector_result",
  ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT:
    "route_granular_next_day_selector",
  ROUTE_GRANULAR_SELECTOR_VERSION:
    "route-granular-technical-regime-authority-v5-market-affinity",
  materializeRouteGranularSelectorResultForDate:
    routeGranularSelectorMock.materializeRouteGranularSelectorResultForDate,
  materializeRouteGranularSelectorForSourceDate:
    routeGranularSelectorMock.materializeRouteGranularSelectorForSourceDate,
}));
vi.mock("./marketContextPerformanceSelector", () => ({
  MARKET_CONTEXT_PERFORMANCE_COMPONENT: "market_context_performance_snapshot",
  MARKET_CONTEXT_PERFORMANCE_VERSION: "market-context-performance-snapshot-v1",
  materializeMarketContextPerformanceForDate:
    contextPerformanceMock.materializeMarketContextPerformanceForDate,
}));

import {
  DIVERGENCE_MATERIALIZATION_COMPONENT,
  DIVERGENCE_MATERIALIZATION_VERSION,
  OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
  OUTCOME_LABELS_MATERIALIZATION_VERSION,
  TEL_PARITY_MATERIALIZATION_COMPONENT,
  TEL_PARITY_MATERIALIZATION_VERSION,
  materializeNextAuditComponentForDate,
} from "./auditMaterializer";
import {
  CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
  CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION,
} from "./currentCandidateOutcomeParity";
import {
  DISCO_SHORT_PORTFOLIO_COMPONENT,
  DISCO_SHORT_PORTFOLIO_VERSION,
} from "./discoOpeningShortPortfolioComparison";
import {
  MULTI_SYMBOL_MONITORING_COMPONENT,
  MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION,
} from "./multiSymbolMonitoringMaterializer";
import {
  TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
  TEN_SYMBOL_SELECTOR_RESULT_COMPONENT,
  TEN_SYMBOL_SELECTOR_SNAPSHOT_COMPONENT,
  TEN_SYMBOL_SELECTOR_VERSION,
} from "./tenSymbolNextDaySelector";
import {
  ROUTE_GRANULAR_MONITORING_COMPONENT,
  ROUTE_GRANULAR_MONITORING_VERSION,
} from "./routeGranularMonitoringMaterializer";
import {
  ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT,
  ROUTE_GRANULAR_SELECTOR_SNAPSHOT_COMPONENT,
  ROUTE_GRANULAR_SELECTOR_VERSION,
} from "./routeGranularNextDaySelector";
import {
  MARKET_CONTEXT_PERFORMANCE_COMPONENT,
  MARKET_CONTEXT_PERFORMANCE_VERSION,
} from "./marketContextPerformanceSelector";

function snapshot(
  component: string,
  version: string,
  resultJson: unknown = {}
) {
  return {
    component,
    version,
    status: "complete",
    sourceDecisionCount: 10,
    resultJson,
  };
}

function completedCore(component: string) {
  return (
    new Map<string, any>([
      [
        "portfolio_bundle",
        snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", {
          status: "complete",
        }),
      ],
      [
        TEL_PARITY_MATERIALIZATION_COMPONENT,
        snapshot(
          TEL_PARITY_MATERIALIZATION_COMPONENT,
          TEL_PARITY_MATERIALIZATION_VERSION
        ),
      ],
      [
        CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
        snapshot(
          CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
          CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION
        ),
      ],
      [
        DISCO_SHORT_PORTFOLIO_COMPONENT,
        snapshot(
          DISCO_SHORT_PORTFOLIO_COMPONENT,
          DISCO_SHORT_PORTFOLIO_VERSION
        ),
      ],
      [
        OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
        snapshot(
          OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
          OUTCOME_LABELS_MATERIALIZATION_VERSION
        ),
      ],
      [
        DIVERGENCE_MATERIALIZATION_COMPONENT,
        snapshot(
          DIVERGENCE_MATERIALIZATION_COMPONENT,
          DIVERGENCE_MATERIALIZATION_VERSION
        ),
      ],
      [
        MULTI_SYMBOL_MONITORING_COMPONENT,
        snapshot(
          MULTI_SYMBOL_MONITORING_COMPONENT,
          MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION
        ),
      ],
    ]).get(component) ?? null
  );
}

function closeAllCurrentStages(component: string) {
  return (
    new Map<string, any>([
      [
        "portfolio_bundle",
        snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", {
          status: "complete",
        }),
      ],
      [
        TEL_PARITY_MATERIALIZATION_COMPONENT,
        snapshot(
          TEL_PARITY_MATERIALIZATION_COMPONENT,
          TEL_PARITY_MATERIALIZATION_VERSION
        ),
      ],
      [
        CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
        snapshot(
          CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
          CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION
        ),
      ],
      [
        DISCO_SHORT_PORTFOLIO_COMPONENT,
        snapshot(
          DISCO_SHORT_PORTFOLIO_COMPONENT,
          DISCO_SHORT_PORTFOLIO_VERSION
        ),
      ],
      [
        OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
        snapshot(
          OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
          OUTCOME_LABELS_MATERIALIZATION_VERSION
        ),
      ],
      [
        DIVERGENCE_MATERIALIZATION_COMPONENT,
        snapshot(
          DIVERGENCE_MATERIALIZATION_COMPONENT,
          DIVERGENCE_MATERIALIZATION_VERSION
        ),
      ],
      [
        MULTI_SYMBOL_MONITORING_COMPONENT,
        snapshot(
          MULTI_SYMBOL_MONITORING_COMPONENT,
          MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION
        ),
      ],
      [
        TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
        snapshot(
          TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
          TEN_SYMBOL_SELECTOR_VERSION
        ),
      ],
      [
        TEN_SYMBOL_SELECTOR_RESULT_COMPONENT,
        snapshot(
          TEN_SYMBOL_SELECTOR_RESULT_COMPONENT,
          TEN_SYMBOL_SELECTOR_VERSION
        ),
      ],
      [
        ROUTE_GRANULAR_MONITORING_COMPONENT,
        snapshot(
          ROUTE_GRANULAR_MONITORING_COMPONENT,
          ROUTE_GRANULAR_MONITORING_VERSION
        ),
      ],
      [
        ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT,
        snapshot(
          ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT,
          ROUTE_GRANULAR_SELECTOR_VERSION
        ),
      ],
      [
        MARKET_CONTEXT_PERFORMANCE_COMPONENT,
        snapshot(
          MARKET_CONTEXT_PERFORMANCE_COMPONENT,
          MARKET_CONTEXT_PERFORMANCE_VERSION
        ),
      ],
    ]).get(component) ?? null
  );
}

describe("bounded closed-date audit materializer after legacy 285A retirement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getRtDailyAuditMaterialization.mockResolvedValue(null);
    dbMock.getRtAuditTradeDateFinality.mockResolvedValue(null);
    dbMock.acquireRtNamedWorkerLock.mockResolvedValue(true);
    portfolioMock.materializePortfolioBundleForDate.mockResolvedValue({
      status: "processing",
    });
    forwardReplayMock.materializeNextForwardReplayForDate.mockResolvedValue({
      status: "complete",
      completedVersions: 19,
    });
    tenSymbolSelectorMock.materializeTenSymbolNextDaySelectorForSourceDate.mockResolvedValue(
      { created: false, targetDate: "2026-10-08", result: {} }
    );
    routeGranularSelectorMock.materializeRouteGranularSelectorForSourceDate.mockResolvedValue(
      { created: false, targetDate: "2026-10-08", result: {} }
    );
  });

  it("keeps the one-heavy-component heartbeat bound before the closed core finishes", async () => {
    const result = await materializeNextAuditComponentForDate("2026-10-07", {
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(result).toMatchObject({
      status: "processing",
      component: "portfolio_bundle",
    });
    expect(parityMock.compareTelCurrentParityForDate).not.toHaveBeenCalled();
    expect(
      tenSymbolSelectorMock.materializeTenSymbolSelectorFeatureForDate
    ).not.toHaveBeenCalled();
  });

  it("moves directly from the completed core to the ten-symbol feature without requiring retired 285A rows", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(
      async ({ component }: any) => completedCore(component)
    );
    const result = await materializeNextAuditComponentForDate("2026-10-07", {
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(result).toMatchObject({
      status: "processing",
      component: TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
    });
    expect(
      tenSymbolSelectorMock.materializeTenSymbolSelectorFeatureForDate
    ).toHaveBeenCalledWith(
      expect.objectContaining({ tradeDate: "2026-10-07" })
    );
    expect(
      routeGranularMonitoringMock.materializeRouteGranularMonitoringForDate
    ).not.toHaveBeenCalled();
  });

  it("moves from closed ten-symbol snapshots to route-granular monitoring without retired 285A stages", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(
      async ({ component }: any) => {
        const map = new Map<string, any>([
          [
            "portfolio_bundle",
            snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", {
              status: "complete",
            }),
          ],
          [
            TEL_PARITY_MATERIALIZATION_COMPONENT,
            snapshot(
              TEL_PARITY_MATERIALIZATION_COMPONENT,
              TEL_PARITY_MATERIALIZATION_VERSION
            ),
          ],
          [
            CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
            snapshot(
              CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
              CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION
            ),
          ],
          [
            DISCO_SHORT_PORTFOLIO_COMPONENT,
            snapshot(
              DISCO_SHORT_PORTFOLIO_COMPONENT,
              DISCO_SHORT_PORTFOLIO_VERSION
            ),
          ],
          [
            OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
            snapshot(
              OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
              OUTCOME_LABELS_MATERIALIZATION_VERSION
            ),
          ],
          [
            DIVERGENCE_MATERIALIZATION_COMPONENT,
            snapshot(
              DIVERGENCE_MATERIALIZATION_COMPONENT,
              DIVERGENCE_MATERIALIZATION_VERSION
            ),
          ],
          [
            MULTI_SYMBOL_MONITORING_COMPONENT,
            snapshot(
              MULTI_SYMBOL_MONITORING_COMPONENT,
              MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION
            ),
          ],
          [
            TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
            snapshot(
              TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
              TEN_SYMBOL_SELECTOR_VERSION
            ),
          ],
          [
            TEN_SYMBOL_SELECTOR_RESULT_COMPONENT,
            snapshot(
              TEN_SYMBOL_SELECTOR_RESULT_COMPONENT,
              TEN_SYMBOL_SELECTOR_VERSION
            ),
          ],
        ]);
        return map.get(component) ?? null;
      }
    );
    const result = await materializeNextAuditComponentForDate("2026-10-07", {
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(result).toMatchObject({
      status: "processing",
      component: ROUTE_GRANULAR_MONITORING_COMPONENT,
    });
    expect(
      routeGranularMonitoringMock.materializeRouteGranularMonitoringForDate
    ).toHaveBeenCalledWith("2026-10-07");
  });

  it("moves from closed route-granular snapshots to v4 performance evidence", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(
      async ({ component }: any) => {
        const map = new Map<string, any>([
          [
            "portfolio_bundle",
            snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", {
              status: "complete",
            }),
          ],
          [
            TEL_PARITY_MATERIALIZATION_COMPONENT,
            snapshot(
              TEL_PARITY_MATERIALIZATION_COMPONENT,
              TEL_PARITY_MATERIALIZATION_VERSION
            ),
          ],
          [
            CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
            snapshot(
              CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT,
              CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION
            ),
          ],
          [
            DISCO_SHORT_PORTFOLIO_COMPONENT,
            snapshot(
              DISCO_SHORT_PORTFOLIO_COMPONENT,
              DISCO_SHORT_PORTFOLIO_VERSION
            ),
          ],
          [
            OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
            snapshot(
              OUTCOME_LABELS_MATERIALIZATION_COMPONENT,
              OUTCOME_LABELS_MATERIALIZATION_VERSION
            ),
          ],
          [
            DIVERGENCE_MATERIALIZATION_COMPONENT,
            snapshot(
              DIVERGENCE_MATERIALIZATION_COMPONENT,
              DIVERGENCE_MATERIALIZATION_VERSION
            ),
          ],
          [
            MULTI_SYMBOL_MONITORING_COMPONENT,
            snapshot(
              MULTI_SYMBOL_MONITORING_COMPONENT,
              MULTI_SYMBOL_MONITORING_MATERIALIZATION_VERSION
            ),
          ],
          [
            TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
            snapshot(
              TEN_SYMBOL_SELECTOR_FEATURE_COMPONENT,
              TEN_SYMBOL_SELECTOR_VERSION
            ),
          ],
          [
            TEN_SYMBOL_SELECTOR_RESULT_COMPONENT,
            snapshot(
              TEN_SYMBOL_SELECTOR_RESULT_COMPONENT,
              TEN_SYMBOL_SELECTOR_VERSION
            ),
          ],
          [
            ROUTE_GRANULAR_MONITORING_COMPONENT,
            snapshot(
              ROUTE_GRANULAR_MONITORING_COMPONENT,
              ROUTE_GRANULAR_MONITORING_VERSION
            ),
          ],
          [
            ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT,
            snapshot(
              ROUTE_GRANULAR_SELECTOR_RESULT_COMPONENT,
              ROUTE_GRANULAR_SELECTOR_VERSION
            ),
          ],
        ]);
        return map.get(component) ?? null;
      }
    );
    const result = await materializeNextAuditComponentForDate("2026-10-07", {
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(result).toMatchObject({
      status: "processing",
      component: MARKET_CONTEXT_PERFORMANCE_COMPONENT,
    });
    expect(
      contextPerformanceMock.materializeMarketContextPerformanceForDate
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        tradeDate: "2026-10-07",
        frozenMarketEventResults: [],
        frozenPremarketResult: null,
      })
    );
  });

  it("returns complete without a heavy rebuild once all retained stages are complete", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(
      async ({ component }: any) => closeAllCurrentStages(component)
    );
    const result = await materializeNextAuditComponentForDate("2026-10-07", {
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(result).toMatchObject({ status: "complete", component: "all" });
    expect(
      tenSymbolSelectorMock.materializeTenSymbolSelectorFeatureForDate
    ).not.toHaveBeenCalled();
    expect(
      routeGranularMonitoringMock.materializeRouteGranularMonitoringForDate
    ).not.toHaveBeenCalled();
    expect(
      contextPerformanceMock.materializeMarketContextPerformanceForDate
    ).not.toHaveBeenCalled();
  });

  it("reopens all retained snapshots only when the closed-date watermark changes", async () => {
    dbMock.getRtAuditTradeDateFinality.mockResolvedValue({
      tradeDate: "2026-10-07",
      status: "closed",
      watermarkHash: "old-watermark",
      closedAt: new Date("2026-10-07T07:00:00Z"),
    });
    const result = await materializeNextAuditComponentForDate("2026-10-07", {
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(
      dbMock.reopenRtAuditMaterializationsForTradeDate
    ).toHaveBeenCalledWith("2026-10-07");
    expect(result).toMatchObject({
      status: "processing",
      component: "portfolio_bundle",
    });
  });

  it("does not start a heavy component when another audit worker holds the lease", async () => {
    dbMock.acquireRtNamedWorkerLock.mockResolvedValue(false);
    const result = await materializeNextAuditComponentForDate("2026-10-07");
    expect(result).toEqual({ status: "worker_busy", component: "none" });
    expect(
      portfolioMock.materializePortfolioBundleForDate
    ).not.toHaveBeenCalled();
  });
});
