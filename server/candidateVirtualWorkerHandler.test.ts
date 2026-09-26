import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(async () => ({ isCron: true })),
  drain: vi.fn(),
  drainForwardShadow: vi.fn(async () => ({ processedEngineSequences: [], stoppedReason: "empty_or_claimed" })),
  materialize: vi.fn(async () => ({ status: "processing", component: "portfolio_bundle" })),
  backfill: vi.fn(async () => ({ status: "complete" })),
}));

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: mocks.authenticateRequest } }));
vi.mock("./realtimeDecisionAudit", () => ({ drainCurrentCandidateVirtualQueue: mocks.drain }));
vi.mock("./forwardShadowSequence", () => ({ drainForwardShadowDispatchQueue: mocks.drainForwardShadow }));
vi.mock("./auditMaterializer", () => ({ materializeNextAuditComponentForDate: mocks.materialize }));
vi.mock("./multiSymbolMonitoringMaterializer", () => ({
  materializeNextMissingMultiSymbolMonitoringDate: mocks.backfill,
}));

import { candidateVirtualWorkerHandler } from "./candidateVirtualWorkerHandler";

function response() {
  const res: any = {
    statusCode: 200,
    status: vi.fn((code: number) => { res.statusCode = code; return res; }),
    json: vi.fn((body: unknown) => body),
  };
  return res;
}

describe("candidate virtual worker comparison-platform handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.materialize.mockResolvedValue({ status: "processing", component: "portfolio_bundle" });
  });

  it("queueが空まで追い付いた時だけ同日のportfolio materializationを前進させる", async () => {
    mocks.drain.mockResolvedValue({ processedEngineSequences: [1], terminalizedRows: 0, stoppedReason: "empty_or_claimed" });
    const res = response();
    await candidateVirtualWorkerHandler({} as any, res);
    expect(mocks.drainForwardShadow).toHaveBeenCalledWith({ maxRows: 50, maxDurationMs: 5_000 });
    expect(mocks.materialize).toHaveBeenCalledTimes(1);
    expect(mocks.materialize.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      forwardShadow: expect.objectContaining({ stoppedReason: "empty_or_claimed" }),
      materialization: expect.objectContaining({ component: "portfolio_bundle" }),
    }));
  });

  it("queueが残る場合は比較生成よりcandidate/virtual追随を優先する", async () => {
    mocks.drain.mockResolvedValue({ processedEngineSequences: [1], terminalizedRows: 0, stoppedReason: "max_batch" });
    const res = response();
    await candidateVirtualWorkerHandler({} as any, res);
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("forward shadow queueが残る場合も未完成portfolioを生成しない", async () => {
    mocks.drainForwardShadow.mockResolvedValueOnce({ processedEngineSequences: [1], stoppedReason: "max_batch" });
    mocks.drain.mockResolvedValue({ processedEngineSequences: [], terminalizedRows: 0, stoppedReason: "empty_or_claimed" });
    const res = response();
    await candidateVirtualWorkerHandler({} as any, res);
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      forwardShadow: expect.objectContaining({ stoppedReason: "max_batch" }),
      materialization: expect.objectContaining({ status: "deferred_until_candidate_queue_caught_up" }),
    }));
  });

  it("当日の全監査完了後だけ過去snapshotを高々1日backfillする", async () => {
    mocks.drain.mockResolvedValue({ processedEngineSequences: [], terminalizedRows: 0, stoppedReason: "empty_or_claimed" });
    mocks.materialize.mockResolvedValueOnce({ status: "complete", component: "all" });
    const res = response();
    await candidateVirtualWorkerHandler({} as any, res);
    expect(mocks.backfill).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      monitoringBackfill: expect.objectContaining({ status: "complete" }),
    }));
  });
});
