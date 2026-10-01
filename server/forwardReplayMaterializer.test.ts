import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getRtDailyAuditMaterializationsForComponent: vi.fn(async () => []),
  getRtForwardShadowEventsForDateAndStrategy: vi.fn(async () => [{ id: 1 }]),
  getRtRealtimeDecisionEventsForDateAndSymbol: vi.fn(async () => [{ id: 1 }]),
  getRtSourceEventsForDateAndSymbol: vi.fn(async () => [{ id: 1 }]),
  upsertRtDailyAuditMaterialization: vi.fn(async input => input),
}));
const replayMock = vi.hoisted(() => vi.fn(() => ({ replayedEvents: 1, mismatches: 0, invalidPayloads: 0 })));

vi.mock("./db", () => dbMock);
vi.mock("./forwardShadow", () => ({ replayForwardShadowDay: replayMock }));
vi.mock("./fujikuraForwardShadowEngine", () => ({ replayFujikuraForwardShadowDay: replayMock }));
vi.mock("./fujikuraMorningBreakdownShortShadowEngine", () => ({ auditFujikuraMorningShortShadowDay: replayMock }));
vi.mock("./kioxiaForwardShadowEngine", () => ({ replayKioxiaForwardShadowDay: replayMock }));
vi.mock("./kioxiaAtrForwardShadowEngine", () => ({ replayKioxiaAtrForwardShadowDay: replayMock }));
vi.mock("./kioxiaReversalLongReopenEngine", () => ({ auditKioxiaReversalLongReopenDay: replayMock }));
vi.mock("./kioxiaCurrentReversalLongExactEngine", () => ({ auditKioxiaCurrentReversalLongExactDay: replayMock }));
vi.mock("./telExecutableConfirmEngine", () => ({ auditTelExecutableConfirmDay: replayMock }));
vi.mock("./telExecutableConfirmDepthEngine", () => ({ auditTelExecutableConfirmDepthDay: replayMock }));
vi.mock("./softbankForwardShadowEngine", () => ({ auditSoftbankForwardShadowDay: replayMock }));
vi.mock("./taiyoForwardShadowEngine", () => ({ auditTaiyoForwardShadowDay: replayMock }));
vi.mock("./taiyoAfternoonForwardShadowEngine", () => ({ auditTaiyoAfternoonForwardShadowDay: replayMock }));
vi.mock("./taiyoAfternoonLongForwardShadowEngine", () => ({ auditTaiyoAfternoonLongForwardShadowDay: replayMock }));
vi.mock("./socionextForwardShadowEngine", () => ({ auditSocionextForwardShadowDay: replayMock }));
vi.mock("./sumcoForwardShadowEngine", () => ({ auditSumcoForwardShadowDay: replayMock }));
vi.mock("./discoOpeningShortForwardShadowEngine", () => ({ auditDiscoOpeningShortForwardShadowDay: replayMock }));
vi.mock("./discoConfirmedLongForwardShadowEngine", () => ({ auditDiscoConfirmedLongForwardShadowDay: replayMock }));
vi.mock("./murataIndependentShadowEngine", () => ({ auditMurataIndependentShadowDay: replayMock }));

import { FORWARD_STRATEGY_VERSION } from "./runtimeIdentity";
import {
  FORWARD_REPLAY_MATERIALIZATION_COMPONENT,
  FORWARD_REPLAY_DEFINITIONS,
  materializeNextForwardReplayForDate,
} from "./forwardReplayMaterializer";

describe("forward strategy replay materializer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getRtDailyAuditMaterializationsForComponent.mockResolvedValue([]);
  });

  it("一回で先頭の1 strategyVersionだけを銘柄限定入力からmaterializeする", async () => {
    const result = await materializeNextForwardReplayForDate({
      tradeDate: "2026-09-07",
      processedThroughEngineSequence: 6454,
      sourceDecisionCount: 6454,
    });

    expect(result).toMatchObject({
      status: "processing",
      version: FORWARD_STRATEGY_VERSION,
      completedVersions: 1,
      totalVersions: FORWARD_REPLAY_DEFINITIONS.length,
    });
    expect(replayMock).toHaveBeenCalledTimes(1);
    expect(dbMock.getRtSourceEventsForDateAndSymbol).toHaveBeenCalledWith({ tradeDate: "2026-09-07", symbol: "8035" });
    expect(dbMock.upsertRtDailyAuditMaterialization).toHaveBeenCalledWith(expect.objectContaining({
      component: FORWARD_REPLAY_MATERIALIZATION_COMPONENT,
      version: FORWARD_STRATEGY_VERSION,
      status: "complete",
      sourceDecisionCount: 6454,
    }));
  });

  it("全登録versionが同じ元件数で完了済みなら重い入力を読まずcompleteを返す", async () => {
    const first = await materializeNextForwardReplayForDate({
      tradeDate: "2026-09-07",
      processedThroughEngineSequence: 6454,
      sourceDecisionCount: 6454,
    });
    const firstVersion = first.status === "processing" ? first.version : "";
    const rows = Array.from({ length: FORWARD_REPLAY_DEFINITIONS.length }, (_, index) => ({
      version: index === 0 ? firstVersion : `complete-${index}`,
      status: "complete",
      sourceDecisionCount: 6454,
    }));
    // 実際の登録version名を得るため、各回で返されたversionを既存一覧へ蓄積する。
    for (let index = 1; index < FORWARD_REPLAY_DEFINITIONS.length; index += 1) {
      dbMock.getRtDailyAuditMaterializationsForComponent.mockResolvedValue(rows.slice(0, index));
      const next = await materializeNextForwardReplayForDate({
        tradeDate: "2026-09-07",
        processedThroughEngineSequence: 6454,
        sourceDecisionCount: 6454,
      });
      if (next.status === "processing") rows[index].version = next.version;
    }
    dbMock.getRtDailyAuditMaterializationsForComponent.mockResolvedValue(rows);
    vi.clearAllMocks();
    dbMock.getRtDailyAuditMaterializationsForComponent.mockResolvedValue(rows);
    const complete = await materializeNextForwardReplayForDate({
      tradeDate: "2026-09-07",
      processedThroughEngineSequence: 6454,
      sourceDecisionCount: 6454,
    });

    expect(complete).toEqual({ status: "complete", completedVersions: FORWARD_REPLAY_DEFINITIONS.length });
    expect(dbMock.getRtSourceEventsForDateAndSymbol).not.toHaveBeenCalled();
    expect(replayMock).not.toHaveBeenCalled();
  });
});
