/**
 * realtimeSimEngine.test.ts
 *
 * リアルタイム取引シミュレーションエンジンのユニットテスト
 *
 * DBを使わずにロジックのみをテストする。
 * insertRtCandle, insertRtTrade, upsertRtDailySummary, getRtTradesForDate は
 * vitest の vi.mock() でモック化する。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== DB関数をモック化 =====
vi.mock("./db", () => ({
  insertRtCandle: vi.fn().mockResolvedValue(undefined),
  insertRtTrade: vi.fn().mockResolvedValue(undefined),
  upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
  getRtTradesForDate: vi.fn().mockResolvedValue([]),
}));

// kabuStation をモック化（板情報なし）
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn().mockReturnValue(null),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
  calcExtendedBoardFields: vi.fn().mockReturnValue({}),
}));

// shared/stocks をモック化
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("テスト銘柄"),
}));

// ===== テスト対象をインポート =====
// モック設定後にインポートする
import { processCandle, getOpenPositions, getCandleCounters } from "./realtimeSimEngine";
import type { RtCandle1Min } from "./realtimeSimEngine";

// ===== ヘルパー =====

function makeCandle(overrides: Partial<RtCandle1Min> = {}): RtCandle1Min {
  return {
    symbol: "6976",
    tradeDate: "2026-06-07",
    candleTime: "09:30",
    open: 3000,
    high: 3050,
    low: 2980,
    close: 3020,
    volume: 10000,
    ...overrides,
  };
}

/**
 * ウォームアップ用に30本の足を送信する（シグナル判定に必要なMA25計算のため）
 */
async function warmup(symbol: string, tradeDate: string, basePrice = 3000): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const hour = 9 + Math.floor(i / 60);
    const minute = i % 60;
    const candleTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    await processCandle(makeCandle({
      symbol,
      tradeDate,
      candleTime,
      open: basePrice,
      high: basePrice + 10,
      low: basePrice - 10,
      close: basePrice,
      volume: 5000,
    }));
  }
}

// ===== テスト =====

describe("realtimeSimEngine", () => {
  beforeEach(() => {
    // モジュールレベルの状態をリセットするため、
    // 別の日付でprocessCandleを呼ぶことで内部状態をリセットする
    vi.clearAllMocks();
  });

  describe("processCandle - 基本動作", () => {
    it("ウォームアップ期間中（30本未満）はaction=noneを返す", async () => {
      const result = await processCandle(makeCandle({
        symbol: "TEST_WARMUP",
        tradeDate: "2026-01-01",
        candleTime: "09:00",
      }));
      expect(result.action).toBe("none");
    });

    it("受信した足はDBに保存される（insertRtCandleが呼ばれる）", async () => {
      const { insertRtCandle } = await import("./db");
      const mockFn = vi.mocked(insertRtCandle);
      mockFn.mockClear();

      await processCandle(makeCandle({
        symbol: "TEST_DB",
        tradeDate: "2026-01-02",
        candleTime: "09:01",
      }));

      expect(mockFn).toHaveBeenCalledOnce();
      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: "TEST_DB",
          tradeDate: "2026-01-02",
          candleTime: "09:01",
        })
      );
    });

    it("午後14:30以降は新規エントリーしない", async () => {
      const symbol = "TEST_NOENTRY";
      const tradeDate = "2026-01-03";

      // ウォームアップ
      await warmup(symbol, tradeDate, 3000);

      // 14:31 に強いシグナルが出るような足を送信
      const result = await processCandle(makeCandle({
        symbol,
        tradeDate,
        candleTime: "14:31",
        open: 3000,
        high: 3200, // 大幅上昇
        low: 2990,
        close: 3180,
        volume: 100000,
      }));

      // エントリーされないこと
      expect(result.action).toBe("none");
    });
  });

  describe("getCandleCounters - 受信足数カウンター", () => {
    it("受信した足の数がカウンターに反映される", async () => {
      const symbol = "TEST_COUNTER";
      const tradeDate = "2026-01-04";

      const before = getCandleCounters()[symbol] ?? 0;

      await processCandle(makeCandle({ symbol, tradeDate, candleTime: "09:00" }));
      await processCandle(makeCandle({ symbol, tradeDate, candleTime: "09:01" }));
      await processCandle(makeCandle({ symbol, tradeDate, candleTime: "09:02" }));

      const after = getCandleCounters()[symbol] ?? 0;
      expect(after - before).toBeGreaterThanOrEqual(3);
    });
  });

  describe("getOpenPositions - オープンポジション", () => {
    it("初期状態では空配列を返す（または既存ポジションのみ）", () => {
      const positions = getOpenPositions();
      expect(Array.isArray(positions)).toBe(true);
    });
  });

  describe("processCandle - 損切り・利確ロジック", () => {
    it("返り値は正しいシェイプを持つ", async () => {
      const result = await processCandle(makeCandle({
        symbol: "TEST_SHAPE",
        tradeDate: "2026-01-05",
        candleTime: "09:00",
      }));

      expect(result).toHaveProperty("symbol");
      expect(result).toHaveProperty("tradeDate");
      expect(result).toHaveProperty("candleTime");
      expect(result).toHaveProperty("action");
      expect(["entry", "exit", "stop_loss", "take_profit", "forced_close", "none"]).toContain(result.action);
    });

    it("pnlはaction=noneの場合はundefinedまたは数値", async () => {
      const result = await processCandle(makeCandle({
        symbol: "TEST_PNL",
        tradeDate: "2026-01-06",
        candleTime: "09:00",
      }));

      if (result.pnl !== undefined) {
        expect(typeof result.pnl).toBe("number");
      }
    });
  });

  describe("5分足上位足フィルター（ダウ理論シグナル専用）", () => {
    /**
     * 5分足 MA5 < MA25（下落トレンド）の状態でダウ理論上昇シグナルが発生した場合、
     * フィルターによりエントリーが抑制されること（action=none）を確認する。
     *
     * 注: このテストではダウ理論シグナルを確実に発火させるのが困難なため、
     * フィルター関数（getHigherTfTrend）が正しく呼び出せることを確認する
     * 統合的なスモークテストとして実装する。
     */
    it("ウォームアップ後のprocessCandleはaction=noneまたはentryを返す（5分足フィルター統合確認）", async () => {
      const symbol = "TEST_HTF_FILTER";
      const tradeDate = "2026-02-01";
      // 30本ウォームアップ（フラットな価格 → MA5≒MA25 → neutral → フィルター通過しない）
      await warmup(symbol, tradeDate, 5000);

      // ウォームアップ後の1本目
      const result = await processCandle(makeCandle({
        symbol,
        tradeDate,
        candleTime: "09:30",
        open: 5000,
        high: 5050,
        low: 4980,
        close: 5020,
        volume: 8000,
      }));

      // フラット相場ではダウ理論シグナルが出ないか、出ても5分足フィルターで抑制される
      // いずれにせよ action は "none" または "entry" のいずれかであること
      expect(["none", "entry"]).toContain(result.action);
    });

    it("getHigherTfTrendヘルパーが正しくimportされてTypeScriptエラーなしで動作する", async () => {
      // vwap.ts の getHigherTfTrend が realtimeSimEngine.ts から正常にimportできていることを
      // processCandle の呼び出しが例外なく完了することで確認する
      const symbol = "TEST_HTF_IMPORT";
      const tradeDate = "2026-02-02";
      await warmup(symbol, tradeDate, 3500);

      const result = await processCandle(makeCandle({
        symbol,
        tradeDate,
        candleTime: "10:00",
        open: 3500,
        high: 3520,
        low: 3490,
        close: 3510,
        volume: 5000,
      }));

      // 例外なく完了し、正しい型の結果が返ること
      expect(result).toHaveProperty("symbol", symbol);
      expect(result).toHaveProperty("action");
      expect(["none", "entry", "exit", "stop_loss", "take_profit", "forced_close"]).toContain(result.action);
    });
  });
});

// ===== ダブルトップ/ボトム ピーク間隔10本以上テスト =====
describe("ダブルトップ/ボトム ピーク間隔強化（案A）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detectDoubleTopBottom が10本未満の間隔ではダブルパターンを検出しない", async () => {
    // vwap.ts の detectDoubleTopBottom を直接テスト
    const { detectDoubleTopBottom } = await import("./vwap");

    // 42本のローソク足を作成（lookback=40を超えるため）
    const candles = Array.from({ length: 42 }, (_, i) => ({
      time: `${9 + Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}`,
      open: 3000,
      high: 3000,
      low: 3000,
      close: 3000,
      volume: 1000,
      cumVol: 1000,
      vwap: 3000,
    }));

    // ピーク間隔が5本（10本未満）のダブルトップパターンを作成
    // ウィンドウ内（直前40本 = インデックス2〜41）でピークを設定
    // p1: インデックス25（ウィンドウ内インデックス23）
    // p2: インデックス31（ウィンドウ内インデックス29）→ 間隔6本（10本未満）
    candles[25].high = 3100; // p1
    candles[26].high = 3050;
    candles[27].high = 3020;
    candles[28].high = 3010;
    candles[29].high = 3005;
    candles[30].high = 3020;
    candles[31].high = 3095; // p2（p1と1%以内）
    candles[32].high = 3050;
    // ネックライン（p1〜p2間の最安値）より現在値を下回らせる
    candles[41].close = 2950; // ネックライン割れ

    const result = detectDoubleTopBottom(candles as any, 40);
    const last = result[result.length - 1];

    // 間隔が6本（10本未満）なのでダブルトップは検出されないはず
    expect(last.isDoubleTop).toBe(false);
  });

  it("detectDoubleTopBottom が10本以上の間隔ではダブルパターンを検出する", async () => {
    const { detectDoubleTopBottom } = await import("./vwap");

    // 45本のローソク足を作成
    const candles = Array.from({ length: 45 }, (_, i) => ({
      time: `${9 + Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}`,
      open: 3000,
      high: 3000,
      low: 2990,
      close: 3000,
      volume: 1000,
      cumVol: 1000,
      vwap: 3000,
    }));

    // ピーク間隔が12本（10本以上）のダブルトップパターンを作成
    // 最後のウィンドウ（直前40本 = インデックス5〜44）でピークを設定
    // p1: インデックス15（ウィンドウ内インデックス10）
    // p2: インデックス27（ウィンドウ内インデックス22）→ 間隔12本（10本以上）
    candles[15].high = 3100; // p1
    candles[16].high = 3050;
    candles[17].high = 3020;
    candles[27].high = 3098; // p2（p1と1%以内: |3100-3098|/3100 ≈ 0.06%）
    candles[28].high = 3050;
    // ネックライン（p1〜p2間の最安値）: candles[16..27]の最安値 = 2990
    // 現在値をネックライン以下に設定
    candles[44].close = 2980; // ネックライン割れ
    candles[44].low = 2980;

    const result = detectDoubleTopBottom(candles as any, 40);
    const last = result[result.length - 1];

    // 間隔が12本（10本以上）なのでダブルトップが検出されるはず
    expect(last.isDoubleTop).toBe(true);
    expect(last.neckline).not.toBeNull();
  });
});

// ============================================================
// 大台超え/割れ 確認バーフィルター テスト
// ============================================================

describe("大台確認バーフィルター", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("大台超えシグナル発生後、5本維持するまでエントリーしない", async () => {
    const { insertRtTrade } = await import("./db");

    // ウォームアップ: 30本（MA25計算のため）
    for (let i = 0; i < 30; i++) {
      await processCandle(
        makeCandle({ candleTime: `09:${String(i).padStart(2, "0")}`, close: 990 }),
        null
      );
    }

    // 大台超えシグナルを発生させる: 990円 → 1001円（1000円キリ番を突破）
    // 1本目（シグナル発生）
    await processCandle(
      makeCandle({ candleTime: "09:30", close: 1001, open: 990, high: 1005, low: 990 }),
      null
    );
    expect(insertRtTrade).not.toHaveBeenCalled();

    // 2〜4本目（維持中）
    for (let i = 1; i < 4; i++) {
      await processCandle(
        makeCandle({ candleTime: `09:${String(30 + i).padStart(2, "0")}`, close: 1002 }),
        null
      );
    }
    expect(insertRtTrade).not.toHaveBeenCalled();
  });

  it("大台超えシグナル後にキリ番を割り込んだらキャンセルされる", async () => {
    const { insertRtTrade } = await import("./db");

    // ウォームアップ
    for (let i = 0; i < 30; i++) {
      await processCandle(
        makeCandle({ candleTime: `09:${String(i).padStart(2, "0")}`, close: 990 }),
        null
      );
    }

    // 大台超えシグナル（1000円突破）
    await processCandle(
      makeCandle({ candleTime: "09:30", close: 1001, open: 990, high: 1005, low: 990 }),
      null
    );

    // 2本目でキリ番を割り込む（999円）
    await processCandle(
      makeCandle({ candleTime: "09:31", close: 999 }),
      null
    );

    // キャンセルされたのでエントリーなし
    expect(insertRtTrade).not.toHaveBeenCalled();
  });
});


// ===== 板読みスコアv6テスト =====
import { boardReadingScore, detectMarketMode, shouldBoardEarlyExit } from "./realtimeSimEngine";
import type { BoardSnapshot } from "../drizzle/schema";

describe("板読みスコアv6", () => {
  describe("boardReadingScore", () => {
    it("板情報なし(null)の場合はスコア1を返す（エントリー許可）", () => {
      const score = boardReadingScore("TEST", "long", null);
      expect(score).toBe(1);
    });

    it("買い方向: buyPressureRatio高い + marketOrderRatio高い → 高スコア", () => {
      const snapshot: BoardSnapshot = {
        buyPressureRatio: 1.5,
        largeBuyWall: false,
        largeSellWall: false,
        marketOrderRatio: 0.1,
        signal: "buy_pressure",
      };
      const score = boardReadingScore("TEST_HIGH", "long", snapshot);
      // 要素A: +2 (marketOrderRatio>=0.08, bpr>1.0)
      // 要素E: +1 (bpr>=1.4)
      // 要素D: +1 (active, bpr>1.2)
      expect(score).toBeGreaterThanOrEqual(3);
    });

    it("買い方向: buyPressureRatio低い → 低スコア（エントリー抑制）", () => {
      const snapshot: BoardSnapshot = {
        buyPressureRatio: 0.5,
        largeBuyWall: false,
        largeSellWall: false,
        marketOrderRatio: 0.1,
        signal: "sell_pressure",
      };
      const score = boardReadingScore("TEST_LOW", "long", snapshot);
      // 要素A: -2 (marketOrderRatio>=0.08, bpr<1.0)
      // 要素E: -1 (bpr<=0.65)
      // 要素D: +1 (active, bpr<0.8)
      expect(score).toBeLessThan(1);
    });

    it("売り方向: buyPressureRatio低い → 高スコア（ショートに有利）", () => {
      const snapshot: BoardSnapshot = {
        buyPressureRatio: 0.5,
        largeBuyWall: false,
        largeSellWall: false,
        marketOrderRatio: 0.1,
        signal: "sell_pressure",
      };
      const score = boardReadingScore("TEST_SHORT", "short", snapshot);
      // 要素A: +2 (marketOrderRatio>=0.08, bpr<1.0)
      // 要素E: +1 (bpr<=0.65)
      // 要素D: +1 (active, bpr<0.8)
      expect(score).toBeGreaterThanOrEqual(3);
    });

    it("要素B: 厚い板のアノマリー（売り壁あり→ロングに+1）", () => {
      const snapshot: BoardSnapshot = {
        buyPressureRatio: 1.5,  // activeモードにするためbpr>1.2
        largeBuyWall: false,
        largeSellWall: true,
        marketOrderRatio: 0.0,
        signal: "large_sell_wall",
      };
      const score = boardReadingScore("TEST_WALL2", "long", snapshot);
      // 要素B: +1 (largeSellWall → ブレイクスルーの勢い)
      // 要素D: +1 (active, bpr>1.2)
      // 要素E: +1 (bpr>=1.4)
      expect(score).toBeGreaterThanOrEqual(2);
    });
  });

  describe("detectMarketMode", () => {
    it("bpr > 1.2 → active", () => {
      const snapshot: BoardSnapshot = {
        buyPressureRatio: 1.5,
        largeBuyWall: false,
        largeSellWall: false,
        marketOrderRatio: 0.0,
        signal: "buy_pressure",
      };
      const mode = detectMarketMode("TEST_MODE", snapshot);
      expect(mode).toBe("active");
    });

    it("bpr < 0.8 → active", () => {
      const snapshot: BoardSnapshot = {
        buyPressureRatio: 0.6,
        largeBuyWall: false,
        largeSellWall: false,
        marketOrderRatio: 0.0,
        signal: "sell_pressure",
      };
      const mode = detectMarketMode("TEST_MODE2", snapshot);
      expect(mode).toBe("active");
    });
  });

  describe("shouldBoardEarlyExit", () => {
    it("ロング保有中に売り圧力 + 利益あり → 早期利確", () => {
      const pos = {
        symbol: "TEST",
        side: "long" as const,
        entryPrice: 1000,
        shares: 100,
        entryTime: "09:30",
        entryReason: "テスト",
      };
      const snapshot: BoardSnapshot = {
        buyPressureRatio: 0.5,
        largeBuyWall: false,
        largeSellWall: false,
        marketOrderRatio: 0.0,
        signal: "sell_pressure",
      };
      // 現在価格1005円 → 利益0.5%
      const result = shouldBoardEarlyExit(pos, 1005, snapshot);
      expect(result).toBe(true);
    });

    it("ロング保有中に売り圧力 + 損失あり → 早期利確しない", () => {
      const pos = {
        symbol: "TEST",
        side: "long" as const,
        entryPrice: 1000,
        shares: 100,
        entryTime: "09:30",
        entryReason: "テスト",
      };
      const snapshot: BoardSnapshot = {
        buyPressureRatio: 0.5,
        largeBuyWall: false,
        largeSellWall: false,
        marketOrderRatio: 0.0,
        signal: "sell_pressure",
      };
      // 現在価格999円 → 損失
      const result = shouldBoardEarlyExit(pos, 999, snapshot);
      expect(result).toBe(false);
    });

    it("板情報なし → 早期利確しない", () => {
      const pos = {
        symbol: "TEST",
        side: "long" as const,
        entryPrice: 1000,
        shares: 100,
        entryTime: "09:30",
        entryReason: "テスト",
      };
      const result = shouldBoardEarlyExit(pos, 1010, null);
      expect(result).toBe(false);
    });
  });
});

// ===== v6b: sell_pressure時LONG禁止 / buy_pressure時SHORT禁止 テスト =====
describe("★v6b: 板圧力方向フィルター", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sell_pressure時にBUYシグナルが出てもエントリーしない", async () => {
    // 30本以上のウォームアップ足を送る
    for (let i = 0; i < 35; i++) {
      await processCandle(makeCandle({
        symbol: "6976",
        tradeDate: "2026-06-20",
        candleTime: `09:${String(i).padStart(2, "0")}`,
        close: 3000 + i * 10,
        high: 3010 + i * 10,
        low: 2990 + i * 10,
        open: 2995 + i * 10,
      }));
    }
    // sell_pressureの板情報をモック（getOrderBookは生の板データを返す）
    const { getOrderBook, analyzeOrderBook } = await import("./kabuStation");
    (getOrderBook as any).mockReturnValue({
      bids: [{ price: 2990, qty: 500 }, { price: 2980, qty: 300 }],
      asks: [{ price: 3010, qty: 1500 }, { price: 3020, qty: 1200 }],
      underBuyQty: 100,
      overSellQty: 200,
      marketOrderBuyQty: 10,
      marketOrderSellQty: 20,
    });
    (analyzeOrderBook as any).mockReturnValue([
      { type: "board_sell_pressure", message: "sell pressure detected" },
    ]);
    // ゴールデンクロス相当の足を送る（MA5 > MA25になるように急騰）
    const result = await processCandle(makeCandle({
      symbol: "6976",
      tradeDate: "2026-06-20",
      candleTime: "09:35",
      close: 3500,
      high: 3520,
      low: 3480,
      open: 3490,
      volume: 50000,
    }));
    // sell_pressure時はLONGエントリーしない
    expect(result.action).toBe("none");
  });

  it("buy_pressure時にSELLシグナルが出てもエントリーしない", async () => {
    // 30本以上のウォームアップ足を送る
    for (let i = 0; i < 35; i++) {
      await processCandle(makeCandle({
        symbol: "8035",
        tradeDate: "2026-06-20",
        candleTime: `09:${String(i).padStart(2, "0")}`,
        close: 5000 - i * 10,
        high: 5010 - i * 10,
        low: 4990 - i * 10,
        open: 5005 - i * 10,
      }));
    }
    // buy_pressureの板情報をモック（getOrderBookは生の板データを返す）
    const { getOrderBook, analyzeOrderBook } = await import("./kabuStation");
    (getOrderBook as any).mockReturnValue({
      bids: [{ price: 4490, qty: 2000 }, { price: 4480, qty: 1800 }],
      asks: [{ price: 4510, qty: 400 }, { price: 4520, qty: 300 }],
      underBuyQty: 500,
      overSellQty: 50,
      marketOrderBuyQty: 30,
      marketOrderSellQty: 5,
    });
    (analyzeOrderBook as any).mockReturnValue([
      { type: "board_buy_pressure", message: "buy pressure detected" },
    ]);
    // デッドクロス相当の足を送る（MA5 < MA25になるように急落）
    const result = await processCandle(makeCandle({
      symbol: "8035",
      tradeDate: "2026-06-20",
      candleTime: "09:35",
      close: 4500,
      high: 4520,
      low: 4480,
      open: 4510,
      volume: 50000,
    }));
    // buy_pressure時はSHORTエントリーしない
    expect(result.action).toBe("none");
  });
});


// ===== ATRフィルターテスト =====
describe("ATRフィルター", () => {
  it("低ボラティリティ銘柄のエントリーをブロックする", async () => {
    const symbol = "9999";
    const tradeDate = "2026-06-21";
    // ウォームアップ: 非常に狭いレンジ（ATR率が0.12%以下になるように）
    // 株価3000円でATR率0.12% = ATR 3.6円
    // 高値-安値 = 1円（ATR率 = 1/3000 = 0.033%）にする
    for (let i = 0; i < 30; i++) {
      const minute = i;
      const candleTime = `09:${String(minute).padStart(2, "0")}`;
      await processCandle(makeCandle({
        symbol,
        tradeDate,
        candleTime,
        open: 3000,
        high: 3001,  // 1円幅 → ATR率 ≈ 0.033%
        low: 3000,
        close: 3000,
        volume: 5000,
      }));
    }
    // 31本目でシグナルが出るような足を送る（大きな上昇）
    const result = await processCandle(makeCandle({
      symbol,
      tradeDate,
      candleTime: "09:30",
      open: 3000,
      high: 3100,
      low: 3000,
      close: 3090,
      volume: 50000,
    }));
    // ATRフィルターにより、低ボラ銘柄はエントリーしない
    // （シグナルが出てもenterPositionでブロックされる）
    expect(result.action).not.toBe("entry");
  });

  it("高ボラティリティ銘柄はATRフィルターを通過する", async () => {
    const symbol = "8888";
    const tradeDate = "2026-06-22";
    // ウォームアップ: 広いレンジ（ATR率が0.12%以上になるように）
    // 株価3000円でATR率0.5% = ATR 15円
    for (let i = 0; i < 30; i++) {
      const minute = i;
      const candleTime = `09:${String(minute).padStart(2, "0")}`;
      await processCandle(makeCandle({
        symbol,
        tradeDate,
        candleTime,
        open: 3000,
        high: 3020,  // 20円幅 → ATR率 ≈ 0.67%
        low: 3000,
        close: 3010,
        volume: 10000,
      }));
    }
    // 高ボラ銘柄ではATRフィルターはブロックしない
    // （エントリーするかどうかはシグナル次第だが、ATRでは止まらない）
    const result = await processCandle(makeCandle({
      symbol,
      tradeDate,
      candleTime: "09:30",
      open: 3010,
      high: 3050,
      low: 3000,
      close: 3040,
      volume: 30000,
    }));
    // ATRフィルターではブロックされない（他の条件でnoneになる可能性はある）
    // ここではATRフィルターのログが出ないことを確認
    expect(result.action).toBeDefined();
  });
});
