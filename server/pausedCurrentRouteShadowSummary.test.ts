import { describe, expect, it } from "vitest";
import { buildPausedCurrentRouteShadowSummary } from "./pausedCurrentRouteShadowSummary";

describe("paused current route shadow summary", () => {
  it("keeps one row for every generic paused route and aggregates completed 100-share outcomes", () => {
    const rows = buildPausedCurrentRouteShadowSummary({
      asOfDate: "2026-09-18",
      candidates: [
        { id: 1, tradeDate: "2026-09-16", symbol: "285A", routeId: "trendShort", realtimeDecision: "shadow_only" },
        { id: 2, tradeDate: "2026-09-17", symbol: "285A", routeId: "trendShort", realtimeDecision: "shadow_only" },
        { id: 3, tradeDate: "2026-09-18", symbol: "285A", routeId: "trendShort", realtimeDecision: "margin_block" },
        { id: 4, tradeDate: "2026-09-18", symbol: "5803", routeId: "lowReversalBreakLong", realtimeDecision: "shadow_only" },
        { id: 5, tradeDate: "2026-09-17", symbol: "285A", routeId: "trendShort", realtimeDecision: "shadow_only" },
      ] as any,
      trades: [
        { candidateId: 1, completed: true, pnl: "1200" },
        { candidateId: 2, completed: true, pnl: "-400" },
        { candidateId: 3, completed: true, pnl: "9999" },
        { candidateId: 4, completed: false, pnl: null },
        { candidateId: 5, completed: true, pnl: "9999" },
      ] as any,
    });

    expect(rows).toHaveLength(10);
    expect(rows.find(row => row.symbol === "285A" && row.routeId === "trendShort")).toMatchObject({
      signals: 2,
      openedVirtualTrades: 2,
      closedTrades: 2,
      wins: 1,
      losses: 1,
      draws: 0,
      winRatePct: 50,
      pnl: 800,
    });
    expect(rows.find(row => row.symbol === "5803" && row.routeId === "lowReversalBreakLong")).toMatchObject({
      signals: 1,
      openedVirtualTrades: 1,
      openTrades: 1,
      closedTrades: 0,
      winRatePct: null,
      pnl: 0,
    });
  });
});
