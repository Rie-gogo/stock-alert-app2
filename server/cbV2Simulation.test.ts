import { describe, it, expect } from "vitest";
import {
  runCBv2DailySimulation,
  formatCBv2Report,
  detectCBv2Candidates,
  runCBv2StateMachine,
  calcMA5,
  calcDistancePct,
} from "./cbV2Simulation";
import type { CBv2Candidate, CandleData } from "./cbV2Simulation";

// ============================================================
// ヘルパー
// ============================================================

function makeCandle(time: string, open: number, high: number, low: number, close: number, volume = 1000): CandleData {
  return { candleTime: time, open, high, low, close, volume };
}

function makeTimeStr(hour: number, min: number): string {
  return `${hour.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")}`;
}

// ============================================================
// calcMA5 テスト
// ============================================================

describe("calcMA5", () => {
  it("5本未満ではnullを返す", () => {
    const candles = [
      makeCandle("09:00", 100, 105, 95, 100),
      makeCandle("09:01", 100, 105, 95, 102),
      makeCandle("09:02", 100, 105, 95, 104),
      makeCandle("09:03", 100, 105, 95, 106),
    ];
    expect(calcMA5(candles, 3)).toBeNull();
  });

  it("5本以上で正しく計算する", () => {
    const candles = [
      makeCandle("09:00", 100, 105, 95, 100),
      makeCandle("09:01", 100, 105, 95, 102),
      makeCandle("09:02", 100, 105, 95, 104),
      makeCandle("09:03", 100, 105, 95, 106),
      makeCandle("09:04", 100, 105, 95, 108),
    ];
    // MA5 = (100+102+104+106+108)/5 = 104
    expect(calcMA5(candles, 4)).toBe(104);
  });
});

// ============================================================
// calcDistancePct テスト
// ============================================================

describe("calcDistancePct", () => {
  it("正しい乖離率を計算する", () => {
    // 49500円 vs 50000円 → 1.0%
    expect(calcDistancePct(49500, 50000)).toBeCloseTo(1.0, 1);
  });

  it("0%の場合", () => {
    expect(calcDistancePct(50000, 50000)).toBe(0);
  });
});

// ============================================================
// detectCBv2Candidates テスト
// ============================================================

describe("detectCBv2Candidates", () => {
  it("signalBlocksからSHORT候補を正しく検出する", () => {
    const candles: CandleData[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(makeCandle(makeTimeStr(9, i), 49500, 49600, 49400, 49500));
    }
    // 09:10の足の安値を49300に設定
    candles[10] = makeCandle("09:10", 49500, 49600, 49300, 49450);

    const signalBlocks = [{
      time: "09:10",
      symbol: "8035",
      price: 49450,
      reason: "大台乖離率フィルター: 乖離1.10%>0.8% → SHORTブロック (キリ番50000円, 大台確認(5本維持): 50000円下抜け)",
    }];

    const candidates = detectCBv2Candidates(candles, signalBlocks);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].symbol).toBe("8035");
    expect(candidates[0].roundLevel).toBe(50000);
    expect(candidates[0].distancePct).toBeCloseTo(1.10, 1);
    expect(candidates[0].impulseLow).toBe(49300);
  });

  it("LONGブロックは無視する", () => {
    const candles = [makeCandle("09:10", 50500, 50600, 50400, 50550)];
    const signalBlocks = [{
      time: "09:10",
      symbol: "8035",
      price: 50550,
      reason: "大台乖離率フィルター: 乖離1.10%>0.8% → LONGブロック (キリ番50000円, ...)",
    }];

    // detectCBv2Candidatesは全ブロックを処理するが、
    // runCBv2DailySimulationでSHORTフィルターをかける
    // ここではキリ番が抽出できることを確認
    const candidates = detectCBv2Candidates(candles, signalBlocks);
    expect(candidates).toHaveLength(1); // LONGでもキリ番は抽出される
  });
});

// ============================================================
// runCBv2StateMachine テスト
// ============================================================

describe("runCBv2StateMachine", () => {
  it("全ステートをクリアしてエントリー→TP決済する", () => {
    // シナリオ: 49500でブロック → 反発 → 戻り高値形成 → 一度価格がMA5の上に出る → 5MA下クロス → 再ブレイク → エントリー → TP
    const candles: CandleData[] = [];
    // 09:00-09:09: ベースライン（MA5計算用）
    for (let i = 0; i < 10; i++) {
      candles.push(makeCandle(makeTimeStr(9, i), 49800, 49900, 49700, 49800));
    }
    // 09:10: ブロック足（impulseLow = 49300）
    candles.push(makeCandle("09:10", 49500, 49600, 49300, 49450));
    // 09:11: 反発開始（0.2%以上 = 49300 * 1.002 = 49398.6）→ close=49500で反発確認
    candles.push(makeCandle("09:11", 49400, 49550, 49350, 49500));
    // 09:12: 高値更新
    candles.push(makeCandle("09:12", 49500, 49650, 49450, 49600));
    // 09:13: 高値未更新1本目
    candles.push(makeCandle("09:13", 49600, 49620, 49500, 49550));
    // 09:14: 高値未更新2本目 → ステート2完了
    candles.push(makeCandle("09:14", 49550, 49600, 49480, 49520));
    // MA5 at idx14 = (49450+49500+49600+49550+49520)/5 = 49524
    // close=49520 < MA5=49524 → prevMA5AbovePrice=true
    // 09:15: 価格がMA5の上に出る（prevMA5AbovePrice=falseになる）
    // MA5 at idx15 = (49500+49600+49550+49520+49600)/5 = 49554
    candles.push(makeCandle("09:15", 49520, 49650, 49500, 49600));
    // 09:16: 5MA下クロス（価格が5MAを下回る）
    // MA5 at idx16 = (49600+49550+49520+49600+49300)/5 = 49514
    candles.push(makeCandle("09:16", 49600, 49620, 49250, 49300));
    // 09:17: 再ブレイク（close < impulseLow=49300）
    candles.push(makeCandle("09:17", 49300, 49350, 49150, 49200));
    // 09:18: エントリー足（次足始値）
    candles.push(makeCandle("09:18", 49200, 49250, 49100, 49150));
    // 09:19-09:26: 下落してTP到達（TP = 49200 * (1-0.015) = 48462）
    for (let i = 19; i <= 26; i++) {
      const price = 49200 - (i - 18) * 100;
      candles.push(makeCandle(makeTimeStr(9, i), price, price + 50, price - 100, price - 50));
    }

    const candidate: CBv2Candidate = {
      symbol: "8035",
      blockTime: "09:10",
      blockPrice: 49450,
      roundLevel: 50000,
      distancePct: 1.10,
      impulseLow: 49300,
    };

    const trade = runCBv2StateMachine(candles, candidate);
    expect(trade).not.toBeNull();
    expect(trade!.symbol).toBe("8035");
    expect(trade!.entryPrice).toBe(49200); // 09:18の始値
    expect(trade!.exitReason).toBe("TP");
    expect(trade!.pnl).toBeGreaterThan(0);
  });

  it("タイムアウト（20本以内に条件未成立）でnullを返す", () => {
    // 20本以上横ばいで反発しないケース
    const candles: CandleData[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(makeCandle(makeTimeStr(9, i), 49500, 49520, 49480, 49500));
    }
    // ブロック足
    candles[10] = makeCandle("09:10", 49500, 49520, 49480, 49500);

    const candidate: CBv2Candidate = {
      symbol: "8035",
      blockTime: "09:10",
      blockPrice: 49500,
      roundLevel: 50000,
      distancePct: 1.0,
      impulseLow: 49480, // 反発に必要: 49480 * 1.002 = 49578.96 → 到達しない
    };

    const trade = runCBv2StateMachine(candles, candidate);
    expect(trade).toBeNull();
  });

  it("SL決済が正しく動作する", () => {
    const candles: CandleData[] = [];
    // ベースライン
    for (let i = 0; i < 10; i++) {
      candles.push(makeCandle(makeTimeStr(9, i), 49800, 49900, 49700, 49800));
    }
    // 09:10: ブロック足
    candles.push(makeCandle("09:10", 49500, 49600, 49300, 49450));
    // 09:11: 反発
    candles.push(makeCandle("09:11", 49400, 49600, 49350, 49500));
    // 09:12: 高値更新
    candles.push(makeCandle("09:12", 49500, 49650, 49450, 49600));
    // 09:13: 高値未更新1
    candles.push(makeCandle("09:13", 49600, 49620, 49500, 49550));
    // 09:14: 高値未更新2 → ステート2完了
    candles.push(makeCandle("09:14", 49550, 49600, 49480, 49520));
    // 09:15: 価格がMA5の上に出る
    candles.push(makeCandle("09:15", 49520, 49650, 49500, 49600));
    // 09:16: 5MA下クロス
    candles.push(makeCandle("09:16", 49600, 49620, 49250, 49300));
    // 09:17: 再ブレイク（close < impulseLow=49300）
    candles.push(makeCandle("09:17", 49300, 49350, 49150, 49200));
    // 09:18: エントリー足
    candles.push(makeCandle("09:18", 49200, 49250, 49150, 49220));
    // 09:19: 急反発でSL到達（SL = 49200 * 1.005 = 49446）
    candles.push(makeCandle("09:19", 49220, 49500, 49200, 49450));

    const candidate: CBv2Candidate = {
      symbol: "8035",
      blockTime: "09:10",
      blockPrice: 49450,
      roundLevel: 50000,
      distancePct: 1.10,
      impulseLow: 49300,
    };

    const trade = runCBv2StateMachine(candles, candidate);
    expect(trade).not.toBeNull();
    expect(trade!.exitReason).toBe("SL");
    expect(trade!.pnl).toBeLessThan(0);
  });
});

// ============================================================
// runCBv2DailySimulation テスト
// ============================================================

describe("runCBv2DailySimulation", () => {
  it("SHORTブロックがない場合は候補0を返す", () => {
    const result = runCBv2DailySimulation("2026-07-17", [], []);
    expect(result.candidates).toBe(0);
    expect(result.entries).toBe(0);
    expect(result.trades).toHaveLength(0);
  });

  it("LONGブロックのみの場合は候補0を返す", () => {
    const candles = [
      { symbol: "8035", candleTime: "09:10", open: "50500", high: "50600", low: "50400", close: "50550", volume: 1000 },
    ];
    const signalBlocks = [{
      time: "09:10",
      symbol: "8035",
      price: 50550,
      reason: "大台乖離率フィルター: 乖離1.10%>0.8% → LONGブロック (キリ番50000円, ...)",
    }];

    const result = runCBv2DailySimulation("2026-07-17", candles, signalBlocks);
    expect(result.candidates).toBe(0); // SHORTフィルターで除外
  });
});

// ============================================================
// formatCBv2Report テスト
// ============================================================

describe("formatCBv2Report", () => {
  it("候補0の場合は簡潔なメッセージを返す", () => {
    const result = {
      tradeDate: "2026-07-17",
      candidates: 0,
      entries: 0,
      timeouts: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      pf: 0,
      trades: [],
      caseB: { candidates: 0, entries: 0, timeouts: 0, wins: 0, losses: 0, totalPnl: 0, pf: 0 },
    };
    const report = formatCBv2Report(result);
    expect(report).toContain("候補なし");
  });

  it("取引がある場合はCase V2-AとV2-Bの両方を含む", () => {
    const result = {
      tradeDate: "2026-07-17",
      candidates: 3,
      entries: 2,
      timeouts: 1,
      wins: 1,
      losses: 1,
      totalPnl: 15000,
      pf: 1.5,
      trades: [{
        symbol: "8035",
        blockTime: "09:10",
        entryTime: "09:17",
        entryPrice: 49250,
        exitTime: "09:30",
        exitPrice: 48511,
        pnl: 45000,
        exitReason: "TP" as const,
        holdBars: 13,
        delayBars: 7,
        roundLevel: 50000,
        distancePct: 1.10,
      }],
      caseB: { candidates: 2, entries: 1, timeouts: 1, wins: 1, losses: 0, totalPnl: 45000, pf: Infinity },
    };
    const report = formatCBv2Report(result);
    expect(report).toContain("Case V2-A");
    expect(report).toContain("Case V2-B");
    expect(report).toContain("8035");
    expect(report).toContain("取引詳細");
  });
});
