import { describe, expect, it } from "vitest";
import {
  AI_SHADOW_LEDGER_REPAIR_TRADE_DATE,
  buildAiShadowLedgerRepairPlanForTest,
  type AiShadowLedgerRepairSource,
} from "./aiShadowLedgerRepair";
import {
  RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS,
  sha256Stable,
} from "./runtimeIdentity";

const entries = {
  "285A": "20261013T235044Z-ebfda979c552:2685",
  "6526": "20261013T235044Z-ebfda979c552:2885",
  "6857": "20261013T235044Z-ebfda979c552:2929",
} as const;
const prices = { "285A": 15065, "6526": 2004, "6857": 40880 } as const;

function source(): AiShadowLedgerRepairSource {
  const modes = ["signal_quality", "capital_constrained"] as const;
  const symbols = ["285A", "6526", "6857"] as const;
  let id = 1;
  const trades = symbols.flatMap(symbol => modes.map(evaluationMode => ({
    id: id++,
    strategyVersion: RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS[symbol],
    evaluationMode,
    symbol,
    side: "long" as const,
    entrySourceEventId: entries[symbol],
    entryTradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE,
    entryPrice: String(prices[symbol]),
    shares: evaluationMode === "signal_quality" ? 100 : symbol === "6526" ? 1300 : 100,
    exitSourceEventId: null,
    exitTradeDate: null,
    exitCandleTime: null,
    exitPrice: null,
    exitReason: null,
    pnl: null,
    pnlAfterAdverseExit: null,
    realizedR: null,
    closedAt: null,
  })));
  const states = trades.map(trade => {
    const stateJson = {
      tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE,
      activePlanId: "ai-intraday-forecast:2026-10-14:1130:codex-v1",
      plan: {},
      touched: null,
      position: {
        side: "long",
        entrySourceEventId: trade.entrySourceEventId,
        entryPrice: Number(trade.entryPrice),
        stopPrice: Number(trade.entryPrice) - 100,
        initialRiskPerShare: 100,
        shares: trade.shares,
      },
      executedPlanIds: [],
      lastSourceEventId: "later-event-preserved",
      lastActions: [{ type: "hold" }],
    };
    return {
      id: trade.id,
      strategyVersion: trade.strategyVersion,
      evaluationMode: trade.evaluationMode,
      stateJson,
      stateHash: sha256Stable(stateJson),
      lastSourceEventId: "later-event-preserved",
    };
  });
  return {
    trades,
    states,
    queueRows: [
      { sourceEventId: "event-285a-1230", engineSequence: 1, tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE, symbol: "285A", inputJson: { candle: { tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE, candleTime: "12:30", open: 14910, high: 14995, low: 14880, close: 14885 } } },
      { sourceEventId: "event-6526-1300", engineSequence: 2, tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE, symbol: "6526", inputJson: { candle: { tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE, candleTime: "13:00", open: 1999.5, high: 2001, low: 1999.5, close: 2001 } } },
      { sourceEventId: "event-6857-1230", engineSequence: 3, tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE, symbol: "6857", inputJson: { candle: { tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE, candleTime: "12:30", open: 41040, high: 41170, low: 41040, close: 41090 } } },
    ],
    snapshot: {
      sourceRevisionId: "ai-intraday-forecast:2026-10-14:1130:codex-v1",
      tradeDate: AI_SHADOW_LEDGER_REPAIR_TRADE_DATE,
      checkpoint: "11:30",
      qualityStatus: "degraded",
      forecastJson: {
        aiFinalForecast: {
          forecast: { forecasts: [
            { symbol: "285A", direction: "down", firstTarget: 14800 },
            { symbol: "6526", direction: "up", firstTarget: 2012 },
            { symbol: "6857", direction: "up", firstTarget: 41020 },
          ] },
          controls: [
            { symbol: "285A", openPositionAction: "exit_next_event_if_direction_changed", forceExitTime: "13:00" },
            { symbol: "6526", openPositionAction: "tighten_only", forceExitTime: "13:00" },
            { symbol: "6857", openPositionAction: "tighten_only", forceExitTime: "13:00" },
          ],
        },
      },
    },
    versionStatuses: symbols.map(symbol => ({
      versionId: RETIRED_AI_FORECAST_REENTRY_V5_VERSIONS[symbol],
      status: "insufficient",
      statusReason: "historical open position",
    })),
  };
}

describe("AI shadow ledger repair", () => {
  it("builds the six deterministic causal exits without changing later state lineage", () => {
    const fixture = source();
    const first = buildAiShadowLedgerRepairPlanForTest(fixture);
    const second = buildAiShadowLedgerRepairPlanForTest(fixture);
    expect(first.status).toBe("pending");
    expect(first.updates).toHaveLength(6);
    expect(first.planHash).toBe(second.planHash);
    expect(first.updates.every(row => row.nextStateJson.position === null)).toBe(true);
    expect(first.updates.every(row => row.nextStateJson.lastSourceEventId === "later-event-preserved")).toBe(true);
    expect(first.summary.find(row => row.symbol === "6857" && row.evaluationMode === "signal_quality")).toMatchObject({
      exitCandleTime: "12:30",
      exitPrice: 41020,
      exitReason: "first_target",
      pnl: 14000,
    });
    expect(first.summary.find(row => row.symbol === "285A" && row.evaluationMode === "signal_quality")?.pnl).toBe(-18000);
    expect(first.summary.find(row => row.symbol === "6526" && row.evaluationMode === "capital_constrained")?.pnl).toBe(-3900);
  });

  it("fails closed if the persisted exit candle differs", () => {
    const fixture = source();
    const input = fixture.queueRows[0].inputJson as { candle: { close: number } };
    input.candle.close = 14890;
    expect(() => buildAiShadowLedgerRepairPlanForTest(fixture)).toThrow("repair_exit_candle_mismatch:285A:12:30");
  });

  it("fails closed on a partially closed ledger", () => {
    const fixture = source();
    fixture.trades[0].exitSourceEventId = "unexpected";
    expect(() => buildAiShadowLedgerRepairPlanForTest(fixture)).toThrow("repair_partial_trade_state:5");
  });
});


