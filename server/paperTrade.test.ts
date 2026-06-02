import { describe, expect, it } from "vitest";
import { computePaperTradePnl } from "./db";
import { MAX_CONCURRENT_POSITIONS } from "../shared/stocks";

describe("computePaperTradePnl", () => {
  it("買建（long）が値上がりしたとき利益になる", () => {
    // 2800円で100株買い、2850円で決済 → +5,000円
    const pnl = computePaperTradePnl({
      side: "long",
      entryPrice: 2800,
      exitPrice: 2850,
      quantity: 100,
    });
    expect(pnl).toBe(5000);
  });

  it("買建（long）が値下がりしたとき損失になる", () => {
    // 2800円で100株買い、2750円で決済 → -5,000円
    const pnl = computePaperTradePnl({
      side: "long",
      entryPrice: 2800,
      exitPrice: 2750,
      quantity: 100,
    });
    expect(pnl).toBe(-5000);
  });

  it("空売り（short）が値下がりしたとき利益になる", () => {
    // 2800円で100株空売り、2750円で買い戻し → +5,000円
    const pnl = computePaperTradePnl({
      side: "short",
      entryPrice: 2800,
      exitPrice: 2750,
      quantity: 100,
    });
    expect(pnl).toBe(5000);
  });

  it("空売り（short）が値上がりしたとき損失になる", () => {
    // 2800円で100株空売り、2850円で買い戻し → -5,000円
    const pnl = computePaperTradePnl({
      side: "short",
      entryPrice: 2800,
      exitPrice: 2850,
      quantity: 100,
    });
    expect(pnl).toBe(-5000);
  });

  it("端数は円単位に丸められる", () => {
    // 100.5円差 × 3株 = 301.5 → 302（四捨五入）
    const pnl = computePaperTradePnl({
      side: "long",
      entryPrice: 1000,
      exitPrice: 1100.5,
      quantity: 3,
    });
    expect(pnl).toBe(302);
  });

  it("建値と決済値が同じなら損益はゼロ", () => {
    const pnl = computePaperTradePnl({
      side: "long",
      entryPrice: 2800,
      exitPrice: 2800,
      quantity: 100,
    });
    expect(pnl).toBe(0);
  });
});

describe("MAX_CONCURRENT_POSITIONS", () => {
  it("同時保有上限は3銘柄である", () => {
    expect(MAX_CONCURRENT_POSITIONS).toBe(3);
  });
});
