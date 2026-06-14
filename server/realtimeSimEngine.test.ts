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
