import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({ getDb: vi.fn(), getRtRealtimeDecisionEventsForDateAndSymbol: vi.fn() }));
vi.mock("./db", () => dbMock);

import { getRuntimeIdentity, sha256Stable } from "./runtimeIdentity";
import { applyFujikuraCandidateVirtualRepair, hashFujikuraRepairReplayForTest, replayFujikuraCandidateVirtualRepairForTest } from "./fujikuraCandidateVirtualRepair";

function row(input: {
  id: number;
  time: string;
  descriptorStatus: "not_candidate" | "complete" | "error";
  resultType?: "rejected" | "no_signal";
  close?: number;
  rawSignal?: { type: "buy" | "sell"; reason: string } | null;
}) {
  const sourceEventId = `5803:${input.id}`;
  return {
    id: input.id,
    sourceEventId,
    sourceEventDbId: input.id,
    inputHash: `hash:${input.id}`,
    symbol: "5803",
    tradeDate: "2026-09-08",
    candleTime: input.time,
    routeId: input.descriptorStatus === "error" ? "high_fade_break_short" : null,
    resultType: input.resultType ?? "no_signal",
    candidateDescriptorStatus: input.descriptorStatus,
    candidateDescriptorJson: null,
    candidateVirtualInputJson: {
      sourceEvent: { id: input.id, sourceEventId, relayReceivedAtMs: 1_000 + input.id },
      candle: { symbol: "5803", tradeDate: "2026-09-08", candleTime: input.time, open: input.close ?? 13_000, high: (input.close ?? 13_000) + 5, low: (input.close ?? 13_000) - 5, close: input.close ?? 13_000, volume: 1000 },
      inputHash: `hash:${input.id}`,
      auditReason: null,
      candidateReason: input.descriptorStatus === "error"
        ? "証拠金使用率制限: 現在8641600円 + 候補2665000円 > 上限8910000円 (高値失速ブレイクSHORT: 1本確認、始値比+3.09%、5本安値更新、MA傾き-0.105%)"
        : null,
      resultType: input.resultType ?? "no_signal",
      latestTrade: null,
      marginUsedBefore: 8_000_000,
      decisionCompletedAtMs: 2_000 + input.id,
      rawSignal: input.rawSignal ?? null,
      boardSignal: "neutral",
      candidateDescriptorStatus: input.descriptorStatus,
      candidateDescriptor: null,
      candidateDescriptorError: input.descriptorStatus === "error" ? "candidate_side_missing" : null,
    },
  } as any;
}

describe("5803 candidate/virtual隔離修復", () => {
  beforeEach(() => vi.clearAllMocks());

  it("保存済みexternal routeIdだけでSHORTを復元し、二回replayが完全一致する", () => {
    const events = [
      row({ id: 10, time: "10:51", descriptorStatus: "error", resultType: "rejected", rawSignal: null }),
      row({ id: 11, time: "10:52", descriptorStatus: "not_candidate", close: 12_995 }),
      row({ id: 12, time: "11:27", descriptorStatus: "not_candidate", close: 12_980 }),
    ];
    const first = replayFujikuraCandidateVirtualRepairForTest(events);
    const second = replayFujikuraCandidateVirtualRepairForTest(events);
    expect(sha256Stable(first)).toBe(sha256Stable(second));
    expect(first.stats).toMatchObject({ candidateCount: 1, marginBlockCount: 1, virtualTradeCount: 1, completedTradeCount: 1, firstExitCandleTime: "11:27" });
    expect(first.candidates[0]).toMatchObject({ routeId: "highFadeBreakShort", side: "short", slPct: "0.6", tpPct: "1.5" });
    expect(first.trades[0]).toMatchObject({ completed: true, exitReasonCode: "session_exit_close_proxy", exitReasonDetail: null });
  });

  it("未知routeIdやside不一致を理由文字列から推測せず拒否する", () => {
    const event = row({ id: 20, time: "10:51", descriptorStatus: "error", resultType: "rejected", rawSignal: { type: "buy", reason: "高値失速ブレイクSHORT" } });
    expect(() => replayFujikuraCandidateVirtualRepairForTest([event])).toThrow(/repair_route_mapping_missing/);
  });

  it("本番切替はDB transaction境界だけを使用し、rollbackエラーを成功扱いしない", async () => {
    const stats = {
      candidateCount: 0,
      acceptedCount: 0,
      marginBlockCount: 0,
      virtualTradeCount: 0,
      completedTradeCount: 0,
      totalPnl: 0,
      firstExitCandleTime: null,
    };
    const inputHash = sha256Stable([]);
    const replayHash = hashFujikuraRepairReplayForTest({ candidates: [], trades: [], stats });
    const run = {
      runId: "repair-run",
      status: "verified",
      tradeDate: "2026-09-08",
      symbol: "5803",
      inputHash,
      replayHashA: replayHash,
      replayHashB: replayHash,
      ...stats,
      detailJson: { expectedSourceHash: getRuntimeIdentity().sourceTreeHash, stats },
    };
    const transaction = vi.fn(async () => { throw new Error("forced_transaction_rollback"); });
    const select = vi.fn()
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [run] }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) });
    dbMock.getRtRealtimeDecisionEventsForDateAndSymbol.mockResolvedValueOnce([]);
    dbMock.getDb.mockResolvedValueOnce({ select, transaction });
    await expect(applyFujikuraCandidateVirtualRepair("repair-run")).rejects.toThrow("forced_transaction_rollback");
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
