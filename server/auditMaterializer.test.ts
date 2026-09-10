import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  acquireRtNamedWorkerLock: vi.fn(async () => true),
  getRtAuditTradeDateFinality: vi.fn(async () => null),
  getRtAuditTradeDateWatermark: vi.fn(async () => ({
    source: { count: 10, maxId: 10, processed: 10, processing: 0, failed: 0 },
    decision: { count: 10, maxId: 10 },
    candidateOutbox: { processed: 10, pending: 0, processing: 0, retryableError: 0, terminal: 0 },
    shadowOutbox: { count: 10, processed: 10, pending: 0, processing: 0, error: 0 },
    unresolvedGaps: 0,
    latestUpstreamCreatedAt: new Date("2026-09-07T06:50:00Z"),
  })),
  getRtDailyAuditMaterialization: vi.fn(async () => null),
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
  materializePortfolioBundleForDate: vi.fn(async () => ({ status: "processing" as const })),
}));
const parityMock = vi.hoisted(() => ({
  compareTelCurrentParityForDate: vi.fn(async () => ({ skipped: false, processed: 10, matched: 10, mismatched: 0 })),
}));
const candidateOutcomeParityMock = vi.hoisted(() => ({
  compareCurrentCandidateOutcomesForDate: vi.fn(async () => ({ matched: 8, mismatched: 2, incomplete: 0 })),
}));
const outcomeMock = vi.hoisted(() => ({
  buildOutcomeLabelsForDate: vi.fn(async () => ({ labels: 1, completed: 1, blocked: 0 })),
  buildDivergenceHypotheses: vi.fn(async () => ({ hypotheses: [] })),
}));
const forwardReplayMock = vi.hoisted(() => ({
  materializeNextForwardReplayForDate: vi.fn(async () => ({ status: "complete" as const, completedVersions: 19 })),
}));
const discoPortfolioMock = vi.hoisted(() => ({
  buildDiscoShortPortfolioComparisonForDate: vi.fn(async () => ({ scenarios: {} })),
}));

vi.mock("./db", () => dbMock);
vi.mock("./portfolioAudit", () => ({
  ALL_CANDIDATE_RECEIPT_PORTFOLIO_VERSION: "receipt-v2",
  ALL_CANDIDATE_MINUTE_PORTFOLIO_VERSION: "minute-v2",
  PORTFOLIO_BUNDLE_COMPONENT: "portfolio_bundle",
  PORTFOLIO_MATERIALIZATION_VERSION: "portfolio-materialization-p0-v1",
  materializePortfolioBundleForDate: portfolioMock.materializePortfolioBundleForDate,
}));
vi.mock("./telParityComparison", () => parityMock);
vi.mock("./currentCandidateOutcomeParity", () => ({
  CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT: "current_candidate_outcome_parity",
  CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION: "current-vs-signal-quality-outcome-v1",
  compareCurrentCandidateOutcomesForDate: candidateOutcomeParityMock.compareCurrentCandidateOutcomesForDate,
}));
vi.mock("./outcomeDivergenceAudit", () => outcomeMock);
vi.mock("./forwardReplayMaterializer", () => forwardReplayMock);
vi.mock("./discoOpeningShortPortfolioComparison", () => ({
  DISCO_SHORT_PORTFOLIO_COMPONENT: "disco_short_portfolio_comparison",
  DISCO_SHORT_PORTFOLIO_VERSION: "position-b-10-symbol-891m-v1",
  buildDiscoShortPortfolioComparisonForDate: discoPortfolioMock.buildDiscoShortPortfolioComparisonForDate,
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

function snapshot(component: string, version: string, resultJson: unknown = {}) {
  return { component, version, status: "complete", sourceDecisionCount: 10, resultJson };
}

describe("P0 audit materializer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getRtDailyAuditMaterialization.mockResolvedValue(null);
    dbMock.getRtAuditTradeDateFinality.mockResolvedValue(null);
    dbMock.acquireRtNamedWorkerLock.mockResolvedValue(true);
    portfolioMock.materializePortfolioBundleForDate.mockResolvedValue({ status: "processing" });
    forwardReplayMock.materializeNextForwardReplayForDate.mockResolvedValue({ status: "complete", completedVersions: 19 });
  });

  it("portfolio batchが未完了なら同じ実行でparity/outcomeへ進まない", async () => {
    const result = await materializeNextAuditComponentForDate("2026-09-07", {
      now: new Date("2026-09-07T07:00:00Z"),
    });
    expect(result).toMatchObject({ status: "processing", component: "portfolio_bundle" });
    expect(parityMock.compareTelCurrentParityForDate).not.toHaveBeenCalled();
    expect(candidateOutcomeParityMock.compareCurrentCandidateOutcomesForDate).not.toHaveBeenCalled();
    expect(outcomeMock.buildOutcomeLabelsForDate).not.toHaveBeenCalled();
  });

  it("TEL parity後はcurrent対virtualの結果差監査だけをmaterializeする", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(async ({ component }) => {
      if (component === "portfolio_bundle") return snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", { status: "complete" });
      if (component === TEL_PARITY_MATERIALIZATION_COMPONENT) return snapshot(component, TEL_PARITY_MATERIALIZATION_VERSION);
      return null;
    });
    const result = await materializeNextAuditComponentForDate("2026-09-07", {
      now: new Date("2026-09-08T00:00:00Z"),
    });
    expect(result).toMatchObject({ status: "processing", component: CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT });
    expect(candidateOutcomeParityMock.compareCurrentCandidateOutcomesForDate).toHaveBeenCalledWith("2026-09-07");
    expect(forwardReplayMock.materializeNextForwardReplayForDate).not.toHaveBeenCalled();
  });

  it("完成済みportfolioを再計算せず、欠けているparity一つだけをmaterializeする", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(async ({ component }) => {
      if (component === "portfolio_bundle") return snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", { status: "complete" });
      return null;
    });
    const result = await materializeNextAuditComponentForDate("2026-09-07", {
      now: new Date("2026-09-08T00:00:00Z"),
    });
    expect(result).toMatchObject({ status: "processing", component: TEL_PARITY_MATERIALIZATION_COMPONENT });
    expect(portfolioMock.materializePortfolioBundleForDate).not.toHaveBeenCalled();
    expect(parityMock.compareTelCurrentParityForDate).toHaveBeenCalledTimes(1);
    expect(outcomeMock.buildOutcomeLabelsForDate).not.toHaveBeenCalled();
  });

  it("parity後はforward replay一つだけを進め、outcomeへ同時に進まない", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(async ({ component }) => {
      if (component === "portfolio_bundle") return snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", { status: "complete" });
      if (component === TEL_PARITY_MATERIALIZATION_COMPONENT) return snapshot(component, TEL_PARITY_MATERIALIZATION_VERSION);
      if (component === CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT) return snapshot(component, CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION);
      return null;
    });
    forwardReplayMock.materializeNextForwardReplayForDate.mockResolvedValue({
      status: "processing",
      version: "candidate-version",
      completedVersions: 1,
      totalVersions: 19,
      result: {},
    });
    const result = await materializeNextAuditComponentForDate("2026-09-07", {
      now: new Date("2026-09-08T00:00:00Z"),
    });
    expect(result).toMatchObject({ status: "processing", component: "forward_strategy_replay" });
    expect(outcomeMock.buildOutcomeLabelsForDate).not.toHaveBeenCalled();
  });

  it("forward replay完了後は6146の10銘柄統合比較だけをmaterializeする", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(async ({ component }) => {
      if (component === "portfolio_bundle") return snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", { status: "complete" });
      if (component === TEL_PARITY_MATERIALIZATION_COMPONENT) return snapshot(component, TEL_PARITY_MATERIALIZATION_VERSION);
      if (component === CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT) return snapshot(component, CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION);
      return null;
    });
    const result = await materializeNextAuditComponentForDate("2026-09-07", {
      now: new Date("2026-09-08T00:00:00Z"),
    });
    expect(result).toMatchObject({ status: "processing", component: DISCO_SHORT_PORTFOLIO_COMPONENT });
    expect(discoPortfolioMock.buildDiscoShortPortfolioComparisonForDate).toHaveBeenCalledWith("2026-09-07");
    expect(outcomeMock.buildOutcomeLabelsForDate).not.toHaveBeenCalled();
  });

  it("全component完成後は重いbuilderを一切呼ばずcompleteを返す", async () => {
    dbMock.getRtDailyAuditMaterialization.mockImplementation(async ({ component }) => {
      if (component === "portfolio_bundle") return snapshot("portfolio_bundle", "portfolio-materialization-p0-v1", { status: "complete" });
      if (component === TEL_PARITY_MATERIALIZATION_COMPONENT) return snapshot(component, TEL_PARITY_MATERIALIZATION_VERSION);
      if (component === CURRENT_CANDIDATE_OUTCOME_PARITY_COMPONENT) return snapshot(component, CURRENT_CANDIDATE_OUTCOME_PARITY_VERSION);
      if (component === DISCO_SHORT_PORTFOLIO_COMPONENT) return snapshot(component, DISCO_SHORT_PORTFOLIO_VERSION);
      if (component === OUTCOME_LABELS_MATERIALIZATION_COMPONENT) return snapshot(component, OUTCOME_LABELS_MATERIALIZATION_VERSION);
      if (component === DIVERGENCE_MATERIALIZATION_COMPONENT) return snapshot(component, DIVERGENCE_MATERIALIZATION_VERSION);
      return null;
    });
    const result = await materializeNextAuditComponentForDate("2026-09-07", {
      now: new Date("2026-09-08T00:00:00Z"),
    });
    expect(result).toMatchObject({ status: "complete", component: "all" });
    expect(portfolioMock.materializePortfolioBundleForDate).not.toHaveBeenCalled();
    expect(parityMock.compareTelCurrentParityForDate).not.toHaveBeenCalled();
    expect(candidateOutcomeParityMock.compareCurrentCandidateOutcomesForDate).not.toHaveBeenCalled();
    expect(outcomeMock.buildOutcomeLabelsForDate).not.toHaveBeenCalled();
    expect(outcomeMock.buildDivergenceHypotheses).not.toHaveBeenCalled();
  });

  it("closed後にwatermarkが変化した場合は全snapshotをreopenedへ戻す", async () => {
    dbMock.getRtAuditTradeDateFinality.mockResolvedValue({
      tradeDate: "2026-09-07",
      status: "closed",
      watermarkHash: "old-watermark",
      closedAt: new Date("2026-09-07T07:00:00Z"),
    });

    const result = await materializeNextAuditComponentForDate("2026-09-07", {
      now: new Date("2026-09-08T00:00:00Z"),
    });

    expect(dbMock.reopenRtAuditMaterializationsForTradeDate).toHaveBeenCalledWith("2026-09-07");
    expect(dbMock.upsertRtAuditTradeDateFinality).toHaveBeenCalledWith(expect.objectContaining({
      tradeDate: "2026-09-07",
      status: "closed",
      reason: "watermark_changed_then_revalidated",
    }));
    expect(result).toMatchObject({ status: "processing", component: "portfolio_bundle" });
  });

  it("別materializerがlease中なら重いbuilderを呼ばずworker_busyを返す", async () => {
    dbMock.acquireRtNamedWorkerLock.mockResolvedValue(false);
    const result = await materializeNextAuditComponentForDate("2026-09-07");
    expect(result).toEqual({ status: "worker_busy", component: "none" });
    expect(portfolioMock.materializePortfolioBundleForDate).not.toHaveBeenCalled();
    expect(parityMock.compareTelCurrentParityForDate).not.toHaveBeenCalled();
  });
});
