/**
 * rtDashboard.test.ts
 *
 * realtimeSimEngineのダッシュボード機能のユニットテスト
 */
import { describe, it, expect, beforeEach } from "vitest";

// ===== getDashboardStatus のモック検証 =====
describe("getDashboardStatus", () => {
  it("should return the correct structure", async () => {
    const { getDashboardStatus } = await import("./realtimeSimEngine");
    const status = getDashboardStatus();

    expect(status).toHaveProperty("lastCandleReceivedAt");
    expect(status).toHaveProperty("currentTradeDate");
    expect(status).toHaveProperty("totalCandlesReceived");
    expect(status).toHaveProperty("openPositionCount");
    expect(status).toHaveProperty("symbolPnl");
    expect(status).toHaveProperty("totalPnl");
    expect(status).toHaveProperty("candleCounters");
    expect(status).toHaveProperty("signalHistory");
  });

  it("should return numeric totalPnl", async () => {
    const { getDashboardStatus } = await import("./realtimeSimEngine");
    const status = getDashboardStatus();

    expect(typeof status.totalPnl).toBe("number");
    expect(typeof status.totalCandlesReceived).toBe("number");
    expect(typeof status.openPositionCount).toBe("number");
  });

  it("should return symbolPnl as Record<string, number>", async () => {
    const { getDashboardStatus } = await import("./realtimeSimEngine");
    const status = getDashboardStatus();

    expect(typeof status.symbolPnl).toBe("object");
    for (const [key, val] of Object.entries(status.symbolPnl)) {
      expect(typeof key).toBe("string");
      expect(typeof val).toBe("number");
    }
  });

  it("should return signalHistory as array", async () => {
    const { getDashboardStatus } = await import("./realtimeSimEngine");
    const status = getDashboardStatus();

    expect(Array.isArray(status.signalHistory)).toBe(true);
  });
});

// ===== getOpenPositions のモック検証 =====
describe("getOpenPositions", () => {
  it("should return an array", async () => {
    const { getOpenPositions } = await import("./realtimeSimEngine");
    const positions = getOpenPositions();

    expect(Array.isArray(positions)).toBe(true);
  });

  it("each position should have required fields", async () => {
    const { getOpenPositions } = await import("./realtimeSimEngine");
    const positions = getOpenPositions();

    for (const pos of positions) {
      expect(pos).toHaveProperty("symbol");
      expect(pos).toHaveProperty("side");
      expect(pos).toHaveProperty("entryPrice");
      expect(pos).toHaveProperty("shares");
      expect(pos).toHaveProperty("entryTime");
      expect(typeof pos.symbol).toBe("string");
      expect(["long", "short"]).toContain(pos.side);
      expect(typeof pos.entryPrice).toBe("number");
      expect(typeof pos.shares).toBe("number");
    }
  });
});

// ===== totalPnl計算の整合性 =====
describe("totalPnl consistency", () => {
  it("totalPnl should equal sum of symbolPnl values", async () => {
    const { getDashboardStatus } = await import("./realtimeSimEngine");
    const status = getDashboardStatus();

    const sumFromSymbols = Object.values(status.symbolPnl).reduce((sum, v) => sum + v, 0);
    expect(status.totalPnl).toBeCloseTo(sumFromSymbols, 2);
  });
});
