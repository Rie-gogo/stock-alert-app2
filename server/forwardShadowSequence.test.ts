import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const queue = vi.hoisted(() => ({ items: [] as any[] }));
const dbMock = vi.hoisted(() => ({
  enqueueRtShadowDispatch: vi.fn(async () => undefined),
  claimNextRtShadowDispatch: vi.fn(async () => queue.items.shift() ?? null),
  completeRtShadowDispatch: vi.fn(async () => undefined),
  failRtShadowDispatch: vi.fn(async () => undefined),
}));
const processMock = vi.hoisted(() => vi.fn(async (input: any) => ({ sourceEventId: input.sourceEventId })));
vi.mock("./db", () => dbMock);
vi.mock("./forwardShadow", () => ({ processForwardShadowSourceEvent: processMock }));

import { drainForwardShadowDispatchQueue, enqueueAndDrainForwardShadow } from "./forwardShadowSequence";

describe("engineSequence順シャドーdispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queue.items.length = 0;
  });

  it("DB先頭claimのengineSequence順に処理して完了保存する", async () => {
    queue.items.push(
      { id: 1, sourceEventId: "e1", engineSequence: 1, inputJson: { sourceEventId: "e1" } },
      { id: 2, sourceEventId: "e2", engineSequence: 2, inputJson: { sourceEventId: "e2" } },
    );
    const result = await drainForwardShadowDispatchQueue();
    expect(result).toEqual({ processedEngineSequences: [1, 2], stoppedReason: "empty_or_claimed" });
    expect(processMock.mock.calls.map(call => call[0].sourceEventId)).toEqual(["e1", "e2"]);
    expect(dbMock.completeRtShadowDispatch).toHaveBeenCalledTimes(2);
  });

  it("現行監査連番が無ければenqueueせず明示スキップする", async () => {
    const result = await enqueueAndDrainForwardShadow({ sourceEventId: "missing", currentAudit: null } as any);
    expect(result.skipped).toBe(true);
    expect(dbMock.enqueueRtShadowDispatch).not.toHaveBeenCalled();
  });

  it("DB claimはattempt_countのCAS条件で複数workerの同時取得を防ぐ", () => {
    const source = readFileSync(new URL("./db.ts", import.meta.url), "utf8");
    expect(source).toContain("eq(rtShadowDispatchQueue.attemptCount, row.attemptCount)");
  });
});
