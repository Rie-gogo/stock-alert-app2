import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(async () => true),
  release: vi.fn(async () => undefined),
  watermark: vi.fn(),
  drainShadow: vi.fn(),
  drainCandidate: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock("./db", () => ({
  acquireRtNamedWorkerLock: mocks.acquire,
  releaseRtNamedWorkerLock: mocks.release,
  getRtAuditTradeDateWatermark: mocks.watermark,
}));
vi.mock("./forwardShadowSequence", () => ({
  drainForwardShadowDispatchQueue: mocks.drainShadow,
}));
vi.mock("./realtimeDecisionAudit", () => ({
  drainCurrentCandidateVirtualQueue: mocks.drainCandidate,
}));
vi.mock("./auditMaterializer", () => ({
  materializeNextAuditComponentForDate: mocks.materialize,
}));

import {
  finalizeClosedTradeDateTail,
  isClosedTradeDateWatermarkReady,
} from "./closedTradeDateTailDrain";

function watermark(overrides: Record<string, unknown> = {}) {
  const base = {
    source: { count: 3, maxId: 3, processed: 3, processing: 0, failed: 0 },
    decision: { count: 3, maxId: 3 },
    candidateOutbox: {
      processed: 3,
      pending: 0,
      processing: 0,
      retryableError: 0,
      terminal: 0,
    },
    shadowOutbox: {
      count: 3,
      processed: 3,
      pending: 0,
      processing: 0,
      error: 0,
    },
    unresolvedGaps: 0,
    latestUpstreamCreatedAt: new Date("2026-10-09T07:00:00.000Z"),
  };
  return { ...base, ...overrides } as any;
}

describe("closed trade-date tail drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquire.mockResolvedValue(true);
    mocks.watermark.mockResolvedValue(watermark());
    mocks.drainShadow.mockResolvedValue({
      processedEngineSequences: [],
      stoppedReason: "empty_or_claimed",
    });
    mocks.drainCandidate.mockResolvedValue({
      processedEngineSequences: [],
      terminalizedRows: 0,
      stoppedReason: "empty_or_claimed",
    });
    mocks.materialize.mockResolvedValue({
      status: "complete",
      component: "all",
    });
  });

  it("最後のsource event後でも既存queue workerを繰り返し、空になってから一度だけsnapshotを前進する", async () => {
    mocks.drainShadow
      .mockResolvedValueOnce({
        processedEngineSequences: [11, 12],
        stoppedReason: "max_batch",
      })
      .mockResolvedValueOnce({
        processedEngineSequences: [],
        stoppedReason: "empty_or_claimed",
      });
    mocks.drainCandidate.mockResolvedValue({
      processedEngineSequences: [],
      terminalizedRows: 0,
      stoppedReason: "empty_or_claimed",
    });

    const result = await finalizeClosedTradeDateTail({
      tradeDate: "2026-10-09",
      now: new Date("2026-10-09T07:31:00.000Z"),
      limits: { materializationPauseMs: 0 },
    });

    expect(result.status).toBe("complete");
    expect(result.queue.forwardShadow.map(row => row.processed)).toEqual([
      2, 0,
    ]);
    expect(mocks.drainCandidate).toHaveBeenCalledTimes(2);
    expect(mocks.materialize).toHaveBeenCalledTimes(1);
    expect(mocks.materialize).toHaveBeenCalledWith(
      "2026-10-09",
      expect.objectContaining({ now: expect.any(Date) })
    );
  });

  it("pendingが残る間はsnapshotを一切生成しない", async () => {
    mocks.drainShadow.mockResolvedValue({
      processedEngineSequences: [],
      stoppedReason: "empty_or_claimed",
    });
    mocks.drainCandidate.mockResolvedValue({
      processedEngineSequences: [],
      terminalizedRows: 0,
      stoppedReason: "empty_or_claimed",
    });
    mocks.watermark.mockResolvedValue(
      watermark({
        shadowOutbox: {
          count: 3,
          processed: 2,
          pending: 1,
          processing: 0,
          error: 0,
        },
      })
    );

    const result = await finalizeClosedTradeDateTail({
      tradeDate: "2026-10-09",
    });

    expect(result.status).toBe("queue_incomplete");
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("同時tail-drainはnamed leaseで片方だけを許可し、queueを二重処理しない", async () => {
    mocks.acquire.mockResolvedValue(false);

    const result = await finalizeClosedTradeDateTail({
      tradeDate: "2026-10-09",
    });

    expect(result.status).toBe("worker_busy");
    expect(mocks.drainShadow).not.toHaveBeenCalled();
    expect(mocks.drainCandidate).not.toHaveBeenCalled();
    expect(mocks.materialize).not.toHaveBeenCalled();
  });

  it("candidateの一時失敗はbounded backoff後に再開し、既存terminal扱いを変更しない", async () => {
    mocks.drainShadow.mockResolvedValue({
      processedEngineSequences: [],
      stoppedReason: "empty_or_claimed",
    });
    mocks.drainCandidate
      .mockResolvedValueOnce({
        processedEngineSequences: [],
        terminalizedRows: 0,
        stoppedReason: "retryable_error",
      })
      .mockResolvedValueOnce({
        processedEngineSequences: [],
        terminalizedRows: 1,
        stoppedReason: "empty_or_claimed",
      });

    const result = await finalizeClosedTradeDateTail({
      tradeDate: "2026-10-09",
      limits: { retryBackoffMs: 0, materializationPauseMs: 0 },
    });

    expect(result.status).toBe("complete");
    expect(mocks.drainCandidate).toHaveBeenCalledTimes(2);
    expect(result.queue.candidateVirtual[1]?.terminalizedRows).toBe(1);
  });

  it("shadow一時失敗も既存queueのerror保存後にbounded backoffで再開する", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.drainShadow
      .mockRejectedValueOnce(new Error("temporary_shadow_failure"))
      .mockResolvedValueOnce({
        processedEngineSequences: [],
        stoppedReason: "empty_or_claimed",
      });

    const result = await finalizeClosedTradeDateTail({
      tradeDate: "2026-10-09",
      limits: { retryBackoffMs: 0, materializationPauseMs: 0 },
    });

    expect(result.status).toBe("complete");
    expect(mocks.drainShadow).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it("同じ完了済みdrainを再実行してもworkerは空queueだけを読み、snapshotを再作成しない", async () => {
    const first = await finalizeClosedTradeDateTail({
      tradeDate: "2026-10-09",
      limits: { materializationPauseMs: 0 },
    });
    mocks.materialize.mockClear();
    const second = await finalizeClosedTradeDateTail({
      tradeDate: "2026-10-09",
      limits: { materializationPauseMs: 0 },
    });

    expect(first.status).toBe("complete");
    expect(second.status).toBe("complete");
    expect(mocks.drainShadow).toHaveBeenCalledTimes(2);
    expect(mocks.materialize).toHaveBeenCalledTimes(1);
  });

  it("watermark helperはretryable/error/pendingをfinality不適格として扱う", () => {
    expect(isClosedTradeDateWatermarkReady(watermark())).toBe(true);
    expect(
      isClosedTradeDateWatermarkReady(
        watermark({
          candidateOutbox: {
            processed: 2,
            pending: 0,
            processing: 0,
            retryableError: 1,
            terminal: 0,
          },
        })
      )
    ).toBe(false);
  });
});
