import { describe, it, expect } from "vitest";
import {
  applyPortfolioRules,
  computeLotMultiplier,
  DEFAULT_PORTFOLIO_CONFIG,
  rankRecommendedSymbols,
  recommendForNextDay,
  timeToMinutes,
  type PerStockTrades,
  type SymbolScoreInput,
  type SymbolHistoryInput,
} from "./portfolio";
import type { TradeRecord } from "./simulation";

// テスト用の取引レコードを作るヘルパー
function open(time: string, type: "buy" | "short" = "buy"): TradeRecord {
  return { time, type, price: 1000, shares: 100, totalAmount: 100000 };
}
function close(time: string, profit: number, type: "sell" | "cover" = "sell"): TradeRecord {
  return { time, type, price: 1000, shares: 100, totalAmount: 100000, profit };
}

describe("timeToMinutes", () => {
  it("converts HH:MM to minutes", () => {
    expect(timeToMinutes("09:00")).toBe(540);
    expect(timeToMinutes("14:30")).toBe(870);
  });
  it("returns 0 for malformed input", () => {
    expect(timeToMinutes("")).toBe(0);
  });
});

describe("applyPortfolioRules - 同時保有上限", () => {
  it("同時保有が上限内なら全取引を採用する", () => {
    // 6526(半導体) と 8306(銀行) を別時間帯で保有 → 同時最大1
    const perStock: PerStockTrades[] = [
      { symbol: "6526", trades: [open("09:00"), close("10:00", 5000)] },
      { symbol: "8306", trades: [open("11:00"), close("12:00", 3000)] },
    ];
    const r = applyPortfolioRules(perStock);
    expect(r.acceptedProfit).toBe(8000);
    expect(r.acceptedTrades).toBe(2);
    expect(r.skippedTrades).toBe(0);
    expect(r.maxConcurrentObserved).toBe(1);
  });

  it("同時保有4銘柄目は上限(3)を超えるため見送る", () => {
    // 4銘柄すべて 09:00 に建て、ばらばらに決済（業種は全て異なるようにする）
    const perStock: PerStockTrades[] = [
      { symbol: "8306", trades: [open("09:00"), close("14:00", 1000)] }, // 銀行
      { symbol: "7011", trades: [open("09:00"), close("14:00", 2000)] }, // 機械
      { symbol: "4568", trades: [open("09:00"), close("14:00", 3000)] }, // 医薬
      { symbol: "7203", trades: [open("09:00"), close("14:00", 9999)] }, // 自動車（4銘柄目→見送り）
    ];
    const r = applyPortfolioRules(perStock);
    // 3銘柄ぶんだけ採用、4銘柄目(9999)は見送り
    expect(r.acceptedProfit).toBe(6000);
    expect(r.skippedProfit).toBe(9999);
    expect(r.maxConcurrentObserved).toBe(3);
    expect(r.rejectionsByConcurrency).toBe(1);
  });

  it("枠が空けば後続の取引を採用できる", () => {
    // 8306は早く決済 → 枠が空いて4銘柄目を受け入れ可能
    const perStock: PerStockTrades[] = [
      { symbol: "8306", trades: [open("09:00"), close("09:30", 1000)] }, // 銀行（早く決済）
      { symbol: "7011", trades: [open("09:00"), close("14:00", 2000)] }, // 機械
      { symbol: "4568", trades: [open("09:00"), close("14:00", 3000)] }, // 医薬
      { symbol: "7203", trades: [open("10:00"), close("14:00", 4000)] }, // 自動車（枠が空いた後に建て→採用）
    ];
    const r = applyPortfolioRules(perStock);
    expect(r.acceptedProfit).toBe(10000);
    expect(r.rejectionsByConcurrency).toBe(0);
  });
});

describe("applyPortfolioRules - 業種分散上限", () => {
  it("同一業種3銘柄目は上限(2)を超えるため見送る", () => {
    // 半導体3銘柄を同時に建てる → 3銘柄目は業種上限で見送り
    const perStock: PerStockTrades[] = [
      { symbol: "6526", trades: [open("09:00"), close("14:00", 1000)] }, // 半導体
      { symbol: "6920", trades: [open("09:00"), close("14:00", 2000)] }, // 半導体
      { symbol: "6857", trades: [open("09:00"), close("14:00", 9999)] }, // 半導体（3銘柄目→見送り）
    ];
    const r = applyPortfolioRules(perStock);
    expect(r.acceptedProfit).toBe(3000);
    expect(r.skippedProfit).toBe(9999);
    expect(r.rejectionsBySector).toBe(1);
  });
});

describe("rankRecommendedSymbols", () => {
  it("損益順に並べ、マイナス銘柄は推奨しない", () => {
    const inputs: SymbolScoreInput[] = [
      { symbol: "6526", name: "ソシオネクスト", profit: 5000, winCount: 3, lossCount: 1 },
      { symbol: "8306", name: "三菱UFJ", profit: -2000, winCount: 1, lossCount: 3 },
      { symbol: "7203", name: "トヨタ", profit: 3000, winCount: 2, lossCount: 1 },
    ];
    const ranked = rankRecommendedSymbols(inputs, 3);
    expect(ranked.length).toBe(2); // マイナスの8306は除外
    expect(ranked[0].symbol).toBe("6526");
    expect(ranked[1].symbol).toBe("7203");
  });

  it("業種分散の上限を守る（半導体は最大2銘柄）", () => {
    const inputs: SymbolScoreInput[] = [
      { symbol: "6526", name: "ソシオネクスト", profit: 9000, winCount: 3, lossCount: 0 }, // 半導体
      { symbol: "6920", name: "レーザーテック", profit: 8000, winCount: 3, lossCount: 0 }, // 半導体
      { symbol: "6857", name: "アドバンテスト", profit: 7000, winCount: 3, lossCount: 0 }, // 半導体（3銘柄目→除外）
      { symbol: "8306", name: "三菱UFJ", profit: 1000, winCount: 2, lossCount: 1 }, // 銀行
    ];
    const ranked = rankRecommendedSymbols(inputs, 3);
    const semis = ranked.filter((r) => r.sector === "半導体");
    expect(semis.length).toBe(2); // 半導体は2銘柄まで
    expect(ranked.some((r) => r.symbol === "8306")).toBe(true); // 銀行が繰り上がる
  });
});

describe("recommendForNextDay - 事前推奨（後知恵を避ける）", () => {
  it("直近の平均損益と勝率でスコアリングし、負け越し銘柄は推奨しない", () => {
    const history: SymbolHistoryInput[] = [
      { symbol: "3436", name: "SUMCO", appearances: 5, totalProfit: 50000, totalWin: 10, totalLoss: 3, avgWinRate: 0.75 }, // 半導体材料・好調
      { symbol: "6976", name: "太陽誘電", appearances: 5, totalProfit: 40000, totalWin: 8, totalLoss: 4, avgWinRate: 0.66 }, // 電子部品
      { symbol: "6723", name: "ルネサス", appearances: 5, totalProfit: -30000, totalWin: 2, totalLoss: 8, avgWinRate: 0.2 }, // 半導体・不調→除外
    ];
    const recs = recommendForNextDay(history, 3);
    expect(recs.length).toBe(2); // 負け越しのルネサスは除外
    expect(recs[0].symbol).toBe("3436");
    expect(recs[0].avgDailyProfit).toBeCloseTo(10000);
    expect(recs[0].reason).toContain("勝率");
  });

  it("業種分散の上限を守る（電子部品は最大2銘柄）", () => {
    const history: SymbolHistoryInput[] = [
      { symbol: "6976", name: "太陽誘電", appearances: 5, totalProfit: 50000, totalWin: 10, totalLoss: 2, avgWinRate: 0.8 }, // 電子部品
      { symbol: "6981", name: "村田製作所", appearances: 5, totalProfit: 40000, totalWin: 9, totalLoss: 3, avgWinRate: 0.75 }, // 電子部品
      { symbol: "3436", name: "SUMCO", appearances: 5, totalProfit: 30000, totalWin: 8, totalLoss: 4, avgWinRate: 0.66 }, // 半導体材料
    ];
    const recs = recommendForNextDay(history, 3);
    // 電子部品2銘柄 + 半導体材料1銘柄
    expect(recs.length).toBe(3);
    expect(recs.filter((r) => r.sector === "電子部品").length).toBe(2);
  });

  it("実績がなければ空配列を返す", () => {
    expect(recommendForNextDay([], 3)).toEqual([]);
  });
});

describe("applyPortfolioRules - デイリーストップ（検証済み最適値 -1.5万/利益保護なし）", () => {
  it("当日確定損益が-15,000円に達したら以降の新規建てを止める", () => {
    // 8306: -16,000円の決済でデイリーストップ発動 → 以降の7011建ては不採用
    const perStock: PerStockTrades[] = [
      { symbol: "8306", trades: [open("09:00"), close("10:00", -16000)] }, // 銀行: 大負け→停止発動
      { symbol: "7011", trades: [open("10:30"), close("11:30", 5000)] },   // 機械: 停止後に建て→見送り
    ];
    const r = applyPortfolioRules(perStock, {
      ...DEFAULT_PORTFOLIO_CONFIG,
      dailyLossLimit: 15000,
      dailyProfitTarget: 0,
    });
    expect(r.dailyStopTriggered).toBe(true);
    expect(r.dailyStopReason).toBe("loss_limit");
    expect(r.acceptedProfit).toBe(-16000); // 停止後の+5000は採用されない
  });

  it("停止ライン未達なら後続の取引も通常どおり採用する", () => {
    const perStock: PerStockTrades[] = [
      { symbol: "8306", trades: [open("09:00"), close("10:00", -10000)] }, // -10,000円（-15,000未達）
      { symbol: "7011", trades: [open("10:30"), close("11:30", 5000)] },
    ];
    const r = applyPortfolioRules(perStock, {
      ...DEFAULT_PORTFOLIO_CONFIG,
      dailyLossLimit: 15000,
      dailyProfitTarget: 0,
    });
    expect(r.dailyStopTriggered).toBe(false);
    expect(r.acceptedProfit).toBe(-5000);
  });

  it("利益保護=0（無効）のとき、利益が伸びても新規建ては止めない", () => {
    // 検証で利益保護はマイナスと判明したため、既定では無効である事を保証する
    const perStock: PerStockTrades[] = [
      { symbol: "8306", trades: [open("09:00"), close("10:00", 40000)] },
      { symbol: "7011", trades: [open("10:30"), close("11:30", 5000)] },
    ];
    const r = applyPortfolioRules(perStock, {
      ...DEFAULT_PORTFOLIO_CONFIG,
      dailyLossLimit: 15000,
      dailyProfitTarget: 0,
    });
    expect(r.dailyStopTriggered).toBe(false);
    expect(r.acceptedProfit).toBe(45000); // 両方採用
  });

  it("既定値(DEFAULT_PORTFOLIO_CONFIG)が検証済み最適値を維持している", () => {
    expect(DEFAULT_PORTFOLIO_CONFIG.dailyLossLimit).toBe(15000);
    expect(DEFAULT_PORTFOLIO_CONFIG.dailyProfitTarget).toBe(0);
    expect(DEFAULT_PORTFOLIO_CONFIG.momentumAllocation).toBe(true);
  });
});

describe("computeLotMultiplier - 動的資金配分（調子に応じたロット倍率）", () => {
  it("実績が薄い（登場2日未満）銘柄は標準1.0倍に固定する", () => {
    const m = computeLotMultiplier({
      symbol: "6981", name: "村田製作所", appearances: 1,
      totalProfit: 50000, totalWin: 5, totalLoss: 0, avgWinRate: 1.0,
    });
    expect(m).toBe(1.0);
  });

  it("好調銘柄（高い平均損益＋高勝率）はロットを厚くする（>1.0、上限1.5）", () => {
    const m = computeLotMultiplier({
      symbol: "6981", name: "村田製作所", appearances: 5,
      totalProfit: 150000, totalWin: 8, totalLoss: 2, avgWinRate: 0.8,
    });
    expect(m).toBeGreaterThan(1.0);
    expect(m).toBeLessThanOrEqual(1.5);
  });

  it("不調銘柄（マイナス平均損益）はロットを薄くする（<1.0、下限0.5）", () => {
    const m = computeLotMultiplier({
      symbol: "9107", name: "川崎汽船", appearances: 5,
      totalProfit: -80000, totalWin: 1, totalLoss: 6, avgWinRate: 0.14,
    });
    expect(m).toBeLessThan(1.0);
    expect(m).toBeGreaterThanOrEqual(0.5);
  });

  it("倍率は常に 0.5〜1.5 の範囲にクランプされる（極端な好調でも1.5まで）", () => {
    const m = computeLotMultiplier({
      symbol: "3436", name: "SUMCO", appearances: 10,
      totalProfit: 5_000_000, totalWin: 10, totalLoss: 0, avgWinRate: 1.0,
    });
    expect(m).toBeLessThanOrEqual(1.5);
    expect(m).toBeGreaterThanOrEqual(0.5);
  });

  it("平均損益ほぼ0・勝率0.5の中立銘柄は概ね1.0倍になる", () => {
    const m = computeLotMultiplier({
      symbol: "8306", name: "三菱UFJ", appearances: 5,
      totalProfit: 0, totalWin: 5, totalLoss: 5, avgWinRate: 0.5,
    });
    expect(m).toBeGreaterThan(0.95);
    expect(m).toBeLessThan(1.05);
  });
});
