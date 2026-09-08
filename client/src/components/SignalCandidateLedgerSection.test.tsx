import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  shouldEnableSignalCandidateLedgerQuery,
  SignalCandidateLedgerTable,
  type SignalCandidateLedgerRow,
} from "./SignalCandidateLedgerSection";

function row(input: { id: number; time: string; symbol: string; decision: "accepted" | "margin_block"; pnl: number }): SignalCandidateLedgerRow {
  return {
    candidateId: input.id,
    candidateVersion: "current-10-symbol-candidates-v1",
    virtualEngineVersion: "current-10-symbol-signal-quality-v1",
    sourceEventId: `source:${input.id}`,
    engineSequence: input.id,
    tradeDate: "2026-09-08",
    candleTime: input.time,
    symbol: input.symbol,
    symbolName: input.symbol === "5803" ? "フジクラ" : "ソフトバンクグループ",
    routeId: input.symbol === "5803" ? "lowReversalBreakLong" : "softbankBreakoutLong",
    logicName: input.symbol === "5803" ? "安値反転ブレイクLONG" : "ソフトバンクG 10本高値更新LONG",
    side: "long",
    signalReason: input.id === 1 ? "<script>alert('x')</script>" : "保存済みKABUシグナル",
    realtimeDecision: input.decision,
    capitalShares: 1000,
    requiredMargin: 5_000_000,
    marginUsedBefore: 0,
    marginLimit: 8_910_000,
    blockReasonCode: input.decision === "margin_block" ? "realtime_margin_limit" : null,
    blockReasonLabel: input.decision === "margin_block" ? "現行の証拠金上限超過" : null,
    blockerSourceEventId: null,
    blockerAvailability: input.decision === "margin_block" ? "not_recorded" : "not_applicable",
    theoreticalEntryPrice: 5000,
    signalQualityShares: 100,
    slPct: 0.5,
    tpPct: 1,
    maxHoldingMinutes: 30,
    sessionExitTime: "11:27",
    profitProtectionJson: null,
    entryObservedAtMs: 1,
    decisionAtMs: 2,
    virtualTrade: {
      status: "completed",
      completed: true,
      entryCandleTime: input.time,
      entryPrice: 5000,
      shares: 100,
      exitCandleTime: "10:00",
      exitPrice: 5010,
      exitReasonCode: "take_profit",
      exitReasonDetail: null,
      pnl: input.pnl,
      outcome: input.pnl > 0 ? "win" : input.pnl < 0 ? "loss" : "draw",
      realizedR: 1,
      mfePct: 0.5,
      maePct: 0.1,
    },
    audit: {
      overallStatus: "complete",
      candidatePhase: { status: "complete", attemptCount: 1, hasUnresolvedGap: false, missingReason: null },
      virtualPhase: { status: "complete", attemptCount: 1, hasUnresolvedGap: false, missingReason: null },
      hasAnyGap: false,
      hasUnresolvedGap: false,
      gapReasonCodes: [],
    },
    portfolioAudit: {
      actualReceipt: { status: "complete", activeGeneration: 1, decision: "accepted", blockerSourceEventId: null, blockerSymbol: null, marginUsedBefore: 0, marginUsedAfter: 5_000_000 },
      minuteNormalized: { status: "complete", activeGeneration: 1, decision: "margin_block", blockerSourceEventId: "blocker", blockerSymbol: "285A", marginUsedBefore: 8_000_000, marginUsedAfter: 8_000_000 },
    },
  };
}

describe("SignalCandidateLedgerTable", () => {
  it("未認証または認証確認中はprotected queryを実行しない", () => {
    expect(shouldEnableSignalCandidateLedgerQuery({ authLoading: true, isAuthenticated: true })).toBe(false);
    expect(shouldEnableSignalCandidateLedgerQuery({ authLoading: false, isAuthenticated: false })).toBe(false);
    expect(shouldEnableSignalCandidateLedgerQuery({ authLoading: false, isAuthenticated: true })).toBe(true);
  });

  it("実HTML tableと列見出しで全行の時刻・銘柄・ロジック・判断・損益を読める", () => {
    const html = renderToStaticMarkup(
      <SignalCandidateLedgerTable rows={[
        row({ id: 1, time: "09:46", symbol: "5803", decision: "accepted", pnl: 2654 }),
        row({ id: 2, time: "09:48", symbol: "9984", decision: "margin_block", pnl: 1953 }),
      ]} />,
    );

    expect(html).toContain("<table");
    expect(html).toContain('aria-label="全シグナル監査台帳"');
    expect(html).toContain('scope="col"');
    expect(html).toContain("09:46");
    expect(html).toContain("5803");
    expect(html).toContain("安値反転ブレイクLONG");
    expect(html).toContain("accepted");
    expect(html).toContain("+2,654円");
    expect(html).toContain("09:48");
    expect(html).toContain("9984");
    expect(html).toContain("margin_block");
    expect(html).toContain("+1,953円");
    expect(html).toContain("実受信順");
    expect(html).toContain("同一分固定順");
  });

  it("signalReasonをHTMLとして実行せずテキストへescapeする", () => {
    const html = renderToStaticMarkup(
      <SignalCandidateLedgerTable rows={[row({ id: 1, time: "09:46", symbol: "5803", decision: "accepted", pnl: 0 })]} />,
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;");
  });
});
