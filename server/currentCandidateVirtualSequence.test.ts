import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const drainMock = vi.hoisted(() => vi.fn());

vi.mock("./realtimeDecisionAudit", () => ({
  drainCurrentCandidateVirtualQueue: drainMock,
}));

import {
  REALTIME_CANDIDATE_DRAIN_LIMITS,
  scheduleCurrentCandidateVirtualDrain,
} from "./currentCandidateVirtualSequence";

describe("受信直後candidate/virtual worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it("HTTP経路とは別timerでbounded drainを開始する", async () => {
    drainMock.mockResolvedValue({
      processedEngineSequences: [],
      terminalizedRows: 0,
      stoppedReason: "empty_or_claimed",
    });

    scheduleCurrentCandidateVirtualDrain();
    expect(drainMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);

    expect(drainMock).toHaveBeenCalledWith(REALTIME_CANDIDATE_DRAIN_LIMITS);
    expect(drainMock).toHaveBeenCalledTimes(1);
  });

  it("処理上限で止まった場合は小分けの次batchを自動継続する", async () => {
    drainMock
      .mockResolvedValueOnce({ processedEngineSequences: [1], terminalizedRows: 0, stoppedReason: "max_batch" })
      .mockResolvedValueOnce({ processedEngineSequences: [], terminalizedRows: 0, stoppedReason: "empty_or_claimed" });

    scheduleCurrentCandidateVirtualDrain();
    await vi.runAllTimersAsync();

    expect(drainMock).toHaveBeenCalledTimes(2);
  });

  it("別workerがlock中でも250ms後に再試行して取りこぼさない", async () => {
    drainMock
      .mockResolvedValueOnce({ processedEngineSequences: [], terminalizedRows: 0, stoppedReason: "worker_busy" })
      .mockResolvedValueOnce({ processedEngineSequences: [], terminalizedRows: 0, stoppedReason: "empty_or_claimed" });

    scheduleCurrentCandidateVirtualDrain();
    await vi.advanceTimersByTimeAsync(0);
    expect(drainMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(drainMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(drainMock).toHaveBeenCalledTimes(2);
  });
});
