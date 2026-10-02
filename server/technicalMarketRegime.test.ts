import { describe, expect, it } from "vitest";
import { buildTechnicalMarketRegimeTimeline, classifyTechnicalMarketRegime, TECHNICAL_MARKET_REGIME_VERSION } from "./technicalMarketRegime";

function wrapper(index: number, direction: "up" | "down" | "flat" = "up", overrides: Record<string, unknown> = {}) {
  const signed = direction === "up" ? 1 : direction === "down" ? -1 : 0;
  const close = 100 + signed * index;
  const open = close - signed * 0.7;
  const high = Math.max(open, close) + 1;
  const low = Math.min(open, close) - 1;
  const ma20 = close - signed * 3;
  const ma50 = close - signed * 6;
  return {
    featureEligible: true,
    provenanceStatus: "verified",
    features: {
      open, high, low, close,
      atr14Pct: 1 + index * 0.01,
      movingAverages: {
        "5": { value: close - signed, slopePct: signed * 0.3 },
        "20": { value: ma20, slopePct: signed * 0.2 },
        "25": { value: close - signed * 4, slopePct: signed * 0.15 },
        "50": { value: ma50, slopePct: signed * 0.1 },
      },
      bollinger20: { percentB: direction === "up" ? 85 : direction === "down" ? 15 : 50, bandwidthPct: 5 + index * 0.02 },
      volumeRatio: { to20: 10 },
      intraday: {
        sixtyMinute: { slopePct: signed * 0.4 },
        sessionBars60: Array.from({ length: 5 }, (_, hour) => ({ close: close + signed * hour * 0.1 })),
      },
      ...overrides,
    },
  };
}

function universe(current: unknown) {
  return Object.fromEntries(["285A", "3436", "5803", "6146", "6526", "6857", "6976", "6981", "8035", "9984"].map(symbol => [symbol, current]));
}

describe("technical market regime", () => {
  it("uses daily MA, Dow, DMI/ADX, hourly bars, Bollinger/ATR and breadth to permit only trend-aligned routes", () => {
    const history = Array.from({ length: 35 }, (_, index) => wrapper(index + 1, "up"));
    const current = wrapper(40, "up", { atr14Pct: 3, bollinger20: { percentB: 92, bandwidthPct: 12 } });
    const result = classifyTechnicalMarketRegime({ current, history, universeCurrent: universe(current) });
    expect(result.version).toBe(TECHNICAL_MARKET_REGIME_VERSION);
    expect(result.eligible).toBe(true);
    expect(result.trend).toBe("up");
    expect(result.setup).toBe("up_breakout");
    expect(result.allowedDirections).toEqual(["long"]);
    expect(result.indicators).toMatchObject({ dowUp: true, breadth: { label: "bullish" } });
    expect(result.evidence.map(item => item.name)).toEqual(expect.arrayContaining(["daily_ma_alignment", "dow_high_low_structure", "directional_movement", "hourly_trend", "daily_candle", "ten_symbol_breadth"]));
  });

  it("classifies the mirrored bearish state without using a profit result", () => {
    const history = Array.from({ length: 35 }, (_, index) => wrapper(index + 1, "down"));
    const current = wrapper(40, "down", { atr14Pct: 3, bollinger20: { percentB: 8, bandwidthPct: 12 } });
    const result = classifyTechnicalMarketRegime({ current, history, universeCurrent: universe(current) });
    expect(result.trend).toBe("down");
    expect(result.setup).toBe("down_breakout");
    expect(result.allowedDirections).toEqual(["short"]);
    expect(result.indicators).toMatchObject({ dowDown: true, breadth: { label: "bearish" } });
  });

  it("keeps an earlier state unchanged when a future row is appended", () => {
    const symbols = ["285A"];
    const rows = Array.from({ length: 20 }, (_, index) => ({ tradeDate: `2026-09-${String(index + 1).padStart(2, "0")}`, featuresBySymbol: { "285A": wrapper(index + 1, "up") } }));
    const withoutFuture = buildTechnicalMarketRegimeTimeline(rows, symbols);
    const withFuture = buildTechnicalMarketRegimeTimeline([...rows, { tradeDate: "2026-09-30", featuresBySymbol: { "285A": wrapper(50, "down") } }], symbols);
    expect(withFuture["2026-09-20"]["285A"]).toEqual(withoutFuture["2026-09-20"]["285A"]);
  });

  it("fails closed when provenance or OHLC is unavailable", () => {
    const current = { ...wrapper(1), provenanceStatus: "unknown" };
    const result = classifyTechnicalMarketRegime({ current, history: [], universeCurrent: { "285A": current } });
    expect(result).toMatchObject({ eligible: false, setup: "unknown", allowedDirections: [], confidence: "unavailable" });
  });
});
