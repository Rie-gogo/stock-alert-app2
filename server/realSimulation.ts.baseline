/**
 * realSimulation.ts
 * Yahoo Finance の実際の株価データを使ったシミュレーションエンジン
 * simulation.ts の架空データ生成を置き換える
 */
import { ENV } from "./_core/env";
import type { StockSimResult, TradeRecord, SignalRecord } from "./simulation";
import { TARGET_STOCKS } from "../shared/stocks";
import { applyPortfolioRules, rankRecommendedSymbols, type PerStockTrades, type SymbolScoreInput } from "./portfolio";
import { isVolumeConfirmed, trailingAvgVolume } from "./signalConfirmation";

// 共有定義からインポート（client/src/hooks/useRealMarketData.ts と同一ソース）
export const REAL_TARGET_STOCKS = TARGET_STOCKS.map((s) => ({
  symbol: s.symbol,
  ticker: s.ticker,
  name: s.name,
}));

/**
 * デイリーシミュレーション専用の10銘柄リスト
 * バックテスト結果（J-Quants 60営業日）と流動性・業種分散を考慮して選定。
 * shared/stocks.ts（監視ボード用20銘柄）とは独立して管理する。
 *
 * 選定基準:
 * 1. バックテスト上位（SUMCO/太陽誘電/村田製作所）
 * 2. 流動性最高水準（東京エレクトロン/三菱UFJ/ソニー）
 * 3. 業種分散（半導体/電子部品/銀行/機械/通信）
 */
export const SIMULATION_STOCKS = [
  { symbol: '3436', ticker: '3436.T', name: 'SUMCO' },               // バックテスト1位 +130,800円
  { symbol: '3778', ticker: '3778.T', name: 'さくらインターネット' }, // バックテスト2位 +105,100円（太陽誘電は損失超過のため除外）
  { symbol: '6981', ticker: '6981.T', name: '村田製作所' },          // バックテスト3位 +47,400円
  { symbol: '6758', ticker: '6758.T', name: 'ソニーグループ' },      // 電機・高流動性
  { symbol: '8306', ticker: '8306.T', name: '三菱UFJ FG' },         // 銀行・流動性最高水準
  { symbol: '8035', ticker: '8035.T', name: '東京エレクトロン' },    // 半導体主力・高流動性
  { symbol: '6857', ticker: '6857.T', name: 'アドバンテスト' },      // 半導体・出来高安定
  { symbol: '6920', ticker: '6920.T', name: 'レーザーテック' },      // 半導体・高ボラ有効活用
  { symbol: '7011', ticker: '7011.T', name: '三菱重工業' },          // 機械・業種分散
  { symbol: '9984', ticker: '9984.T', name: 'ソフトバンクグループ' },// 通信・投資
] as const;

// ---- テクニカル指標計算（stockData.tsと同一ロジック） ----

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    result[i] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return result;
}

function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
    if (i < data.length - 1) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
  }
  return result;
}

function calcBollinger(
  data: number[],
  period = 20,
  stdDevMult = 2
): { upper: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);

  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - avg) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = avg + stdDevMult * std;
    lower[i] = avg - stdDevMult * std;
  }
  return { upper, lower };
}

interface RealCandle {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5: number | null;
  ma25: number | null;
  rsi: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  flow: number | null;   // 売買圧力（歩み値・板の代替）: 直近10本の(終値位置 x 出来高)の合計
  slope: number | null;  // MA25の傾き（中期トレンド方向）
}

// ============================================================
// レジーム適応型戦略の定数（19営業日バックテストで検証済み）
// ============================================================
// 超ボラティリティ銘柄（材料で乱高下しやすい / 他群と値動き特性が異なる）はロットを大幅縮小して監視継続
// 出来高（流動性）重視の方針により除外はせず、損益貢献の小さい銘柄は極小ロットで参加させる
// 9107(川崎汽船): 海運株。半導体・ハイテク群と値動きの理屈が異なりトレンド系ロジックと相性が悪いため最小ロット化
// 6723/5803/8316/7203/5016: 20銘柄拡張時のバックテストでトレンド系ロジックと相性が悪く損失超過だったため最小ロット化（出来高は十分なため監視は継続）
const HIGH_VOL_SYMBOLS = new Set(["9984", "4568", "6526", "9107", "6723", "5803", "8316", "7203", "5016",
  "7011", "8306", "6758"]); // SBG・第一三共・ソシオネクスト・川崎決船・ルネサス・フジクラ・三井住友 FG・トヨタ・JX金属
                                  // + 三菱重工業(7011)・三菱UFJ FG(8306)・ソニーグループ(6758): バックテストで損失超過が判明したため極小ロットに変更
const LOT_NORMAL = 0.49;   // 通常銘柄の建玉比率（資金に対する割合）
const LOT_SMALL = 0.05;    // 超ボラ/低相性銘柄の建玉比率（極小）
const CIRCUIT_BREAKER = 20000;   // 1銘柄/日の確定損失がこの額に達したらその日は新規停止
const MAX_TRADES_PER_DAY = 4;    // 1銘柄/日の最大取引回数（機会を増やすため3→4）
const HIGH_VOL_DAY_THRESHOLD = 0.08; // 当日値幅がこの割合以上なら「超高ボラ日」= ショート禁止
const WARMUP_BARS = 10;           // 寄り後この本数はエントリーしない（15→10で機会を増やす）
// --- 損切り・トレイリング利確（早く損切り・利を伸ばす）---
const BREAKEVEN_TRIGGER = 0.005;  // 含み益が+0.5%を超えたら損切りを建値（同値）に引き上げる
const TRAIL_TRIGGER = 0.01;       // 含み益が+1.0%を超えたらトレイリング開始
const TRAIL_GAP = 0.005;          // ピークからこの幅(0.5%)下落したら利確
// --- 押し目買い（高値づかみ回避: 上昇トレンド中の一時的な押しを拾う）---
const PULLBACK_RSI = 45;          // 上昇トレンド中にRSIがこの値以下なら押し目候補
const PULLBACK_NEAR_MA = 0.004;   // 価格がMA25からこの範囲内(±0.4%)なら押し目とみなす
const MARKET_REGIME_THRESHOLD = 0.004; // 市場全体の地合い判定の閾値(±0.4%)
// --- 空売り（ショート）精度向上 ---
// デッドクロス単独の往復ビンタを避け、「下落トレンド中の戻り売り」を厳選する。
const SHORT_RSI_MIN = 55;          // 空売りはRSIがこの値以上（まだ高い=戻り）でのみ許可。売られすぎでの追い空売りを避ける
const SHORT_NEAR_MA = 0.004;       // 価格がMA25からこの範囲内(±0.4%)に戻った「戻り売り」場面を狙う
// --- 下落相場ブレイク売り（戻りが来ない下落相場で空売りを成立させる経路）---
const SHORT_BREAKDOWN_RSI_MIN = 35; // ブレイク売りはRSIがこの値より上でのみ許可（売られすぎの底値圏での飛び乗りを避ける）
// --- 空売りゴールデンクロスカバーの条件強化 ---
// バックテストでゴールデンクロス単独カバーは333回中250回負け(-491,700円)。
// 含み益ありかつRSIがこの値以上（底打ち反転の信頼度が高い）の場合のみゴールデンクロスカバーを許可する。
const SHORT_GC_COVER_RSI_MIN = 40;  // GCカバーは RSI>=40（底打ち反転のシグナル確認）かつ含み益ありの場合のみ
// --- ゴールデンクロス直後のショート禁止（クールダウン）---
// GC直後は上昇トレンド転換のシグナル。この直後にショートエントリーするのは、トレンドに逆行することになる。
// バックテストで「GC直後にショートした結果、引け値強制決済・空売り損切りが多発」したため、GC後のクールダウンを設ける。
const SHORT_GC_COOLDOWN_BARS = 15; // GC後この本数はショートエントリー禁止（約30分クールダウン）
// --- ショートポジションの最大保有時間 ---
// 引けまで持ち越しになるショートの大半が損失になる（引け値強制決済勝率 23.9%）。
// 一定時間内に利益が出なければ手仕まいし、「ダラダラ持ち続けて引けで大損」を防ぐ。
const SHORT_MAX_HOLD_BARS = 60; // ショートの最大保有時間（紀120分）。これを超えたら含み損でも手仕まい
// Phase 32スイープで最良値と判明（45本から変更、+2,700円改善）
// --- ショート専用損切り幅 ---
// J-Quants 60営業日バックテストで0.3%〜3.0%をスイープした結果、0.55%が最良（+122,250円）。
// その後マイナス取引全件分析（Phase 29）で0.50%が最良（+9,700円追加改善）と判明。
// ロングの損切り（DB設定: 1.5%）とは独立して管理する。
// ノイズ耐性と損失抑制のバランスを取った値。
export const SHORT_STOP_LOSS_PERCENT = 0.50; // ショート専用損切り幅（%）
// --- ロング専用損切り幅 ---
// J-Quants 60営楮日バックテストでスイープした結果、午後エントリー禁止と組み合わせてロング損切り幅は1.0%以上で横ばい。
// DB設定値（2.0%）をそのまま使用する。
// 注意: この定数は現在使用されていない（DB設定値が優先）。将来の参考用。
export const LONG_STOP_LOSS_PERCENT = 2.0; // ロング専用損切り幅（%）→DB設定値と同一
// --- 12時台（昂休み前後）エントリー抱制 ---
// 昼休み(11:30-12:30)前後は薄商いでダマシが多く、バックテストでて12時台は全敗だった。
const SUPPRESS_ENTRY_HOURS = new Set([12]); // この時間帯(時)は新規エントリーを抑制（決済は許可）
// --- 昼休み前強制決済（改善D）---
// J-Quants 60営楮日バックテストで「11:20全ポジション手仕まい」が最良（+246,850円）。
// 昼休み中のギャップダウンリスク（主因: 4/27さくらインターネット -68,000円）を排除するため。
export const LUNCH_EXIT_ALL_MINUTE = "11:20"; // この時刻以降はロング+ショートを強制決済（昼休みギャップリスク回避）
// --- 午後エントリー禁止 ---
// J-Quants 60営楮日バックテストで午後再参入（12:30以降）は-78,350円の大幅悪化。
// 11:20に全ポジション手仕まい後、午後は取引しない。
export const SUPPRESS_AFTERNOON_ENTRY = true; // 12:30以降の新規エントリーを禁止（午後は決済のみ）
const SLOPE_LOOKBACK = 25;       // MA25傾きを測る基準（25本=約50分前）
const SLOPE_THRESHOLD = 0.0003;  // トレンド方向と認定する傾きの最小値
const FLOW_LOOKBACK = 10;        // 売買圧力を集計する直近本数
const RANGE_EFFICIENCY_THRESHOLD = 0.30; // 市場全体の方向効率（純変化÷値幅）がこれ未満の日は往復レンジと見なし取引停止

// 定数をテストから参照できるようエクスポート
export const REGIME_CONSTANTS = {
  HIGH_VOL_SYMBOLS,
  LOT_NORMAL,
  LOT_SMALL,
  CIRCUIT_BREAKER,
  MAX_TRADES_PER_DAY,
  HIGH_VOL_DAY_THRESHOLD,
  WARMUP_BARS,
  MARKET_REGIME_THRESHOLD,
  SHORT_RSI_MIN,
  SHORT_NEAR_MA,
  SHORT_BREAKDOWN_RSI_MIN,
  SHORT_GC_COVER_RSI_MIN,
  SHORT_GC_COOLDOWN_BARS,
  SHORT_MAX_HOLD_BARS,
  SHORT_STOP_LOSS_PERCENT,
  LONG_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
  SUPPRESS_AFTERNOON_ENTRY,
  SUPPRESS_ENTRY_HOURS,
  SLOPE_THRESHOLD,
  RANGE_EFFICIENCY_THRESHOLD,
  BREAKEVEN_TRIGGER,
  TRAIL_TRIGGER,
  TRAIL_GAP,
  PULLBACK_RSI,
  PULLBACK_NEAR_MA,
};

/**
 * 市場全体の「方向効率」を計算する純粋関数。
 * efficiency = 平均純変化(|引け-寄り|/寄り) ÷ 平均値幅((高-安)/寄り)
 * 1に近い=一方向にトレンド、0に近い=往復だけ（レンジ）。
 * dayStats: 各銘柄の {open, high, low, close}
 */
export function computeMarketEfficiency(
  dayStats: Array<{ open: number; high: number; low: number; close: number }>
): number {
  const ranges: number[] = [];
  const nets: number[] = [];
  for (const s of dayStats) {
    if (s.open > 0) {
      ranges.push((s.high - s.low) / s.open);
      nets.push(Math.abs(s.close - s.open) / s.open);
    }
  }
  if (ranges.length === 0) return 1;
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const avgNet = nets.reduce((a, b) => a + b, 0) / nets.length;
  return avgRange > 0 ? avgNet / avgRange : 1;
}

/**
 * 当日が往復レンジ相場（取引を避けるべき日）かを判定する純粋関数。
 * efficiency が閾値未満ならレンジと見なす。
 */
export function isRangeBoundDay(marketEfficiency: number): boolean {
  return marketEfficiency < RANGE_EFFICIENCY_THRESHOLD;
}

/** 銘柄に応じた建玉比率を返す（超ボラ銘柄は極小ロット） */
export function getLotRatio(symbol: string): number {
  return HIGH_VOL_SYMBOLS.has(symbol) ? LOT_SMALL : LOT_NORMAL;
}

/**
 * レジーム方向ゲート：「その時の相場の雰囲気」に合った方向だけを許可する
 * 二段流れ判定（中期トレンド + 直近の勢い）と市場全体の地合いを組み合わせる。
 */
export function evaluateRegimeGates(params: {
  slope: number;        // MA25傾き
  flow: number;         // 売買圧力
  mktBias: number;      // 市場全体の地合い
  inWarmup: boolean;    // 寄り後様子見中か
  halted: boolean;      // サーキットブレーカー発動中か
  isHighVolDay: boolean;// 超高ボラ日か
}): { allowLong: boolean; allowShort: boolean } {
  const { slope, flow, mktBias, inWarmup, halted, isHighVolDay } = params;
  const stockTrendUp = slope > SLOPE_THRESHOLD;
  const stockTrendDown = slope < -SLOPE_THRESHOLD;
  const flowUp = flow > 0;
  const flowDown = flow < 0;
  const mktUp = mktBias > MARKET_REGIME_THRESHOLD;
  const mktDown = mktBias < -MARKET_REGIME_THRESHOLD;
  const allowLong = stockTrendUp && flowUp && !mktDown && !inWarmup && !halted;
  const allowShort = stockTrendDown && flowDown && !mktUp && !inWarmup && !halted && !isHighVolDay;
  return { allowLong, allowShort };
}

/**
 * J-Quants から1分足データを取得してローソク足配列を返す
 * 失敗した場合は null を返す
 * 最大3回リトライする
 * @param targetDateStr YYYY-MM-DD 形式の対象日付（省略時は当日JST）
 */
async function fetchRealCandles(ticker: string, maxRetries = 3, targetDateStr?: string): Promise<RealCandle[] | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchRealCandlesOnce(ticker, targetDateStr);
      if (result !== null) return result;
      // nullの場合はデータなしなのでリトライしない
      return null;
    } catch (err) {
      if (attempt < maxRetries) {
        console.warn(`[realSimulation] Retry ${attempt}/${maxRetries} for ${ticker}:`, err);
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      } else {
        console.warn(`[realSimulation] All retries failed for ${ticker}:`, err);
      }
    }
  }
  return null;
}

async function fetchRealCandlesOnce(ticker: string, targetDateStr?: string): Promise<RealCandle[] | null> {
  try {
    // J-Quants API: ticker形式 "3436.T" → コード "34360"
    const symbol = ticker.replace(/\.T$/, "");
    const jqCode = `${symbol}0`;
    const apiKey = ENV.jquantsApiKey;
    if (!apiKey) {
      throw new Error("JQUANTS_API_KEY is not configured");
    }
    // 対象日付: 引数で指定された場合はそれを使用、省略時は当日JST
    let dateStr: string;
    if (targetDateStr) {
      dateStr = targetDateStr;
    } else {
      const now = new Date();
      const jstOffset = 9 * 60 * 60 * 1000;
      const jstNow = new Date(now.getTime() + jstOffset);
      dateStr = jstNow.toISOString().slice(0, 10);
    }
    const url = `https://api.jquants.com/v2/equities/bars/minute?code=${jqCode}&from=${dateStr}&to=${dateStr}`;
    const resp = await fetch(url, {
      headers: { "x-api-key": apiKey },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`J-Quants API HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    interface JqBar {
      Date: string;
      Time: string;
      Code: string;
      O: number;
      H: number;
      L: number;
      C: number;
      Vo: number;
      Va: number;
    }
    const json = (await resp.json()) as { data?: JqBar[]; pagination_key?: string | null };
    const bars: JqBar[] = json.data ?? [];
    if (bars.length === 0) return null;
    const rawCandles: RealCandle[] = [];
    for (const bar of bars) {
      const timeStr = bar.Time; // "HH:mm" 形式（JST）
      const [hh, mm] = timeStr.split(":").map(Number);
      // 9:00〜15:30のみ対象（前場・後場）
      const totalMin = hh * 60 + mm;
      if (totalMin < 9 * 60 || totalMin > 15 * 60 + 30) continue;
      // J-Quantsのタイムスタンプ: Date + Time → UTC Unix ms
      const jstDate = new Date(`${bar.Date}T${timeStr}:00+09:00`);
      rawCandles.push({
        time: timeStr,
        timestamp: jstDate.getTime(),
        open: bar.O,
        high: bar.H,
        low: bar.L,
        close: bar.C,
        volume: bar.Vo,
        ma5: null,
        ma25: null,
        rsi: null,
        bbUpper: null,
        bbLower: null,
        flow: null,
        slope: null,
      });
    }

    if (rawCandles.length < 30) return null; // データが少なすぎる場合はスキップ

    // テクニカル指標を計算
    const closes = rawCandles.map(c => c.close);
    const ma5 = calcMA(closes, 5);
    const ma25 = calcMA(closes, 25);
    const rsi = calcRSI(closes, 14);
    const bb = calcBollinger(closes, 20, 2);

    rawCandles.forEach((c, i) => {
      c.ma5 = ma5[i];
      c.ma25 = ma25[i];
      c.rsi = rsi[i];
      c.bbUpper = bb.upper[i];
      c.bbLower = bb.lower[i];
    });

    // 売買圧力（flow）: 各足の (終値位置 x 出来高) を直近FLOW_LOOKBACK本で合計
    // 終値位置 = ((close-low)-(high-close))/(high-low) ∈ [-1,1]
    // 価格が上げながら出来高が多い=買い圧力(プラス)、下げながら多い=売り圧力(マイナス)
    const signedVol: number[] = rawCandles.map(c => {
      const range = (c.high - c.low) || 1;
      const clv = ((c.close - c.low) - (c.high - c.close)) / range;
      return clv * c.volume;
    });
    rawCandles.forEach((c, i) => {
      if (i >= FLOW_LOOKBACK - 1) {
        let s = 0;
        for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += signedVol[k];
        c.flow = s;
      }
      // MA25傾き（中期トレンド方向）
      if (i >= SLOPE_LOOKBACK && c.ma25 !== null) {
        const prevMa = rawCandles[i - SLOPE_LOOKBACK].ma25;
        if (prevMa !== null && prevMa !== 0) {
          c.slope = (c.ma25 - prevMa) / prevMa;
        }
      }
    });

    return rawCandles;
  } catch (err) {
    console.warn(`[realSimulation] Failed to fetch ${ticker}:`, err);
    return null;
  }
}

/**
 * 実際の株価データを使ってシミュレーションを実行する（レジーム適応型）
 * @param candles 事前取得済みのローソク足（地合い計算のため呼び出し側で全銘柄を先に取得）
 * @param marketBiasAt 進行率(0〜1)を渡すとその時点の市場全体の地合い（始値比平均）を返す関数
 */

/**
 * A/B/C 改善パラメータのオーバーライド（バックテスト用）
 * 省略した場合はモジュールレベルの定数を使用する
 */
export interface SimOverrides {
  /** 改善A: ショートエントリー厳格化 - MA25乖離率の上限（これ以上離れたらショート禁止） */
  shortMaxMaDeviation?: number;
  /** 改善B: 下落相場限定ショート - 戻り売りも mktDown の場合のみ許可 */
  shortRequiresMktDown?: boolean;
  /** 改善C: ショート損切り縮小 - 損切り幅（%）を上書き */
  shortStopLossPercent?: number;
  /** 改善D: 昕休み前ロング手仕まい - この時刻（HH:MM）以降はロングを強制決済 */
  lunchExitLongMinute?: string;
  /** 改善D': 昕休み前全ポジション手仕まい - この時刻（HH:MM）以降はロング+ショートを強制決済 */
  lunchExitAllMinute?: string;
  /** 銘柄ロット比率の上書き - 指定した場合はHIGH_VOL_SYMBOLSの判定を無視してこの値を使用 */
  lotRatio?: number;
  /** ② ショート損切り後N本はショートエントリー禁止（損切り連発対策） */
  shortStopCooldownBars?: number;
  /** ロング専用損切り幅（%）。省略時は stopLossPercent（DB設定値）を使用 */
  longStopLossPercent?: number;
  /** 午後セッション再参入を許可する（trueの場合は12:30以降もエントリー可能） */
  afternoonReentryEnabled?: boolean;
  /** この時刻（時）以降のショートエントリーを禁止する（例: 10 → 10時台以降ショート禁止） */
  noShortAfterHour?: number;
  /** この時刻（時）以降のロングエントリーを禁止する（例: 11 → 11時台以降ロング禁止） */
  noLongAfterHour?: number;
  /** ショートの最大保有時間（本数）。省略時は SHORT_MAX_HOLD_BARS（45本=約90分）を使用 */
  maxShortHoldBars?: number;
  /** ショートエントリー時の最小RSI閾値。RSIがこの値未満の場合はショート禁止（売られすぎ局面でのショート防止） */
  shortMinRsi?: number;
  /** ショートエントリー時の最大出来高比閾値。直近20本平均に対してこの倍率以上の出来高ならショート禁止 */
  shortMaxVolRatio?: number;
  /** 超高ボラ日の閾値（%）。当日値幅がこの値以上の日はショート禁止。省略時は HIGH_VOL_DAY_THRESHOLD(8%) を使用 */
  highVolDayThreshold?: number;
  /** ギャップアップ時のショート禁止閾値（%）。当日始値が前日終値よりこの値以上高い場合はショート禁止。省略時は無効 */
  gapUpShortBlockPercent?: number;
  /** 前日終値（ギャップアップ判定用）。バックテストスクリプトから渡す */
  prevDayClose?: number;
}

export function simulateStockReal(
  symbol: string,
  ticker: string,
  name: string,
  candles: RealCandle[],
  marketBiasAt: (progress: number) => number,
  initialCapital = 3_000_000,
  rsiUpper = 70,
  rsiLower = 30,
  stopLossPercent = 2.0,
  skipTradingRangeDay = false,
  lotMultiplier = 1.0, // 【動的資金配分】調子の良い銘柄はロットを厚く(>1)、悪い銘柄は薄く(<1)。既定1.0で従来と同一挙動。
  overrides: SimOverrides = {} // A/B/Cパラメータオーバーライド（バックテスト用）
): (StockSimResult & { isRealData: boolean }) | null {
  // シミュレーション実行
  const trades: TradeRecord[] = [];
  const signals: SignalRecord[] = [];
  let capital = initialCapital;
  // ロングポジション
  let longShares = 0;
  let longEntryPrice = 0;
  let longHighWater = 0;  // ロング保有中の最高値（トレイリング利確用）
  // ショートポジション（空売り）
  let shortShares = 0;
  let shortEntryPrice = 0;
  let shortLowWater = 0;  // ショート保有中の最安値（トレイリング利確用）

  let winCount = 0;
  let lossCount = 0;
  let realizedPnl = 0;        // 確定損益（サーキットブレーカー判定用）
  let tradeCount = 0;         // 取引回数（決済ベース）
  let halted = false;         // サーキットブレーカー発動フラグ
  let gcCooldownRemaining = 0; // GC直後のショート禁止カウントダウン
  let shortEntryBar = -1;       // ショートエントリー時のインデックス（最大保有時間管理用）
  let shortStopCooldownRemaining = 0; // ② ショート損切り後のエントリー禁止カウントダウン

  // A/B/C オーバーライドを定数から取得（省略時はモジュール定数を使用）
  const effectiveShortStopLoss = overrides.shortStopLossPercent ?? stopLossPercent;
  const effectiveShortStopRatio = effectiveShortStopLoss / 100;
  const effectiveShortMaxMaDev = overrides.shortMaxMaDeviation ?? Infinity; // 改善A: 省略時は無制限
  const effectiveShortRequiresMktDown = overrides.shortRequiresMktDown ?? false; // 改善B: 省略時は制限なし
  const effectiveLongStopLoss = overrides.longStopLossPercent ?? stopLossPercent; // ロング専用損切り幅

  const stopLossRatio = effectiveLongStopLoss / 100; // ロング損切り幅をオーバーライド対応に変更

  // 建玉比率（超ボラ銘柄は極小ロット）。
  // 【動的資金配分】調子スコアに応じた倍率を掛ける。暴走防止に0.5〜1.5倍へクランプし、
  //  建玉比率の上限も0.6（資金の6割）までに制限してリスク量が膨らみすぎないようにする。
  const safeMultiplier = Math.max(0.5, Math.min(1.5, lotMultiplier));
  const baseLot = overrides.lotRatio !== undefined ? overrides.lotRatio : (HIGH_VOL_SYMBOLS.has(symbol) ? LOT_SMALL : LOT_NORMAL);
  const lotRatio = Math.min(0.6, baseLot * safeMultiplier);

  // 出来高配列（出来高裏付けゲート用）
  const volumes = candles.map(c => c.volume);

  // 当日値幅（超高ボラ日判定）
  const dayOpen = candles[0]?.open ?? 0;
  const dayHigh = Math.max(...candles.map(c => c.high));
  const dayLow = Math.min(...candles.map(c => c.low));
  const dayRange = dayOpen > 0 ? (dayHigh - dayLow) / dayOpen : 0;
  const effectiveHighVolThreshold = overrides.highVolDayThreshold !== undefined ? overrides.highVolDayThreshold / 100 : HIGH_VOL_DAY_THRESHOLD;
  const isHighVolDay = dayRange >= effectiveHighVolThreshold;

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    if (
      curr.rsi === null || curr.ma5 === null || curr.ma25 === null ||
      curr.bbLower === null || curr.bbUpper === null ||
      prev.ma5 === null || prev.ma25 === null
    ) continue;

    const isGoldenCross = prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25;
    const isDeadCross = prev.ma5 >= prev.ma25 && curr.ma5 < curr.ma25;
    const isRsiOversold = curr.rsi <= rsiLower;
    const isRsiOverbought = curr.rsi >= rsiUpper;
    const isBbLower = curr.close <= curr.bbLower;
    const isBbUpper = curr.close >= curr.bbUpper;
    const isStrongDown = curr.ma5 < curr.ma25 && curr.close < curr.ma5;
    const isStrongUp = curr.ma5 > curr.ma25 * 1.003 && curr.close >= curr.ma5;

    // ============================================================
    // 【レジーム適応】その時点の「相場の雰囲気」を掴む
    // ============================================================
    // (1) 個別銘柄の中期トレンド方向（MA25傾き）
    const slope = curr.slope ?? 0;
    const stockTrendUp = slope > SLOPE_THRESHOLD;     // 上昇トレンド
    const stockTrendDown = slope < -SLOPE_THRESHOLD;  // 下落トレンド

    // (2) 直近の勢い（売買圧力 flow）。プラス=買い優勢、マイナス=売り優勢
    const flow = curr.flow ?? 0;
    const flowUp = flow > 0;
    const flowDown = flow < 0;

    // (3) 市場全体の地合い（その時点までの始値比平均）。進行率で参照しリアルタイム性を保つ
    const progress = candles.length > 1 ? i / (candles.length - 1) : 1;
    const mktBias = marketBiasAt(progress);
    const mktUp = mktBias > MARKET_REGIME_THRESHOLD;     // 市場全体が上昇ムード
    const mktDown = mktBias < -MARKET_REGIME_THRESHOLD;  // 市場全体が下落ムード

    // 寄り後ウォームアップ中はエントリーしない（レジームが固まるまで様子見）
    const inWarmup = i < WARMUP_BARS;

    // 12時台（昼休み前後）の新規エントリー抑制（薄商いダマシ回避）。決済は妨げない。
    const entryHour = parseInt((curr.time ?? "00:00").split(":")[0], 10);
    const suppressEntryByHour = SUPPRESS_ENTRY_HOURS.has(entryHour);

    // 午後セッション再参入制御:
    // SUPPRESS_AFTERNOON_ENTRY=true（デフォルト）の場合は12:30以降の新規エントリーを禁止。
    // バックテスト用に afternoonReentryEnabled=true で上書き可能。
    const isAfternoonSession = curr.time >= "12:30";
    const suppressAfternoon = isAfternoonSession &&
      (overrides.afternoonReentryEnabled === undefined ? SUPPRESS_AFTERNOON_ENTRY : !overrides.afternoonReentryEnabled);

    // 昼休み前強制決済（改善D）: 指定時刻以降はロング（または全ポジション）を強制決済する
    // 昼休み中のギャップダウンリスクを排除するため
    const lunchExitTime = overrides.lunchExitLongMinute ?? overrides.lunchExitAllMinute;
    if (lunchExitTime && curr.time >= lunchExitTime && curr.time < "12:30") {
      if (longShares > 0) {
        const totalAmount = longShares * curr.close;
        const profit = totalAmount - longShares * longEntryPrice;
        capital += totalAmount;
        if (profit > 0) winCount++; else lossCount++;
        realizedPnl += profit; tradeCount++;
        if (realizedPnl <= -CIRCUIT_BREAKER) halted = true;
        trades.push({ time: curr.time, type: "sell", price: curr.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
        signals.push({ time: curr.time, type: "sell", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: `昼休み前強制決済(ロング) (入荷:${longEntryPrice.toFixed(1)}→${curr.close.toFixed(1)})` });
        longShares = 0; longEntryPrice = 0; longHighWater = 0;
      }
      if (overrides.lunchExitAllMinute && shortShares > 0) {
        const profit = (shortEntryPrice - curr.close) * shortShares;
        const marginReturn = shortShares * shortEntryPrice;
        capital += marginReturn + profit;
        if (profit > 0) winCount++; else lossCount++;
        realizedPnl += profit; tradeCount++;
        if (realizedPnl <= -CIRCUIT_BREAKER) halted = true;
        trades.push({ time: curr.time, type: "cover", price: curr.close, shares: shortShares, totalAmount: shortShares * curr.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
        signals.push({ time: curr.time, type: "cover", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: `昼休み前強制決済(ショート) (入荷:${shortEntryPrice.toFixed(1)}→${curr.close.toFixed(1)})` });
        shortShares = 0; shortEntryPrice = 0; shortLowWater = 0; shortEntryBar = -1;
      }
    }

    // 【二段流れ判定 + レジーム方向ゲート】単体テスト済みの純粋関数を使用
    void stockTrendUp; void stockTrendDown; void flowUp; void flowDown; void mktUp; void mktDown;
    const gates = evaluateRegimeGates({
      slope, flow, mktBias, inWarmup, halted, isHighVolDay,
    });
    // 【レンジ回避】市場全体が往復レンジの日は新規エントリーを一切禁止（決済は許可）
    const regimeAllowLong = gates.allowLong && !skipTradingRangeDay;
    const regimeAllowShort = gates.allowShort && !skipTradingRangeDay;

    // ============================================================
    // ロング（買い）ポジション管理
    // ============================================================

    // ロングエントリー：レジームがロングを許可 かつ シグナル成立
    // 出来高裏付け: エントリー足の出来高が直近平均を上回っているか（薄商いのダマシを回避）
    const volConfirmed = isVolumeConfirmed(curr.volume, trailingAvgVolume(volumes, i, 10));

    // 押し目買い: 上昇トレンド(slope>0)中にRSIが一時的に下がり、価格がMA25近辺まで押した場面を拾う（高値づかみ回避）
    const nearMA25 = curr.ma25 > 0 && Math.abs(curr.close - curr.ma25) / curr.ma25 <= PULLBACK_NEAR_MA;
    const isPullbackBuy = slope > SLOPE_THRESHOLD && curr.rsi <= PULLBACK_RSI && nearMA25 && curr.close >= curr.ma25;

    // noLongAfterHour: 指定時刻以降のロングエントリーを禁止
    const suppressLongByHour = overrides.noLongAfterHour !== undefined && entryHour >= overrides.noLongAfterHour;

    const shouldBuyLong = regimeAllowLong && !isStrongDown && volConfirmed &&
      !suppressEntryByHour && !suppressAfternoon && !suppressLongByHour &&
      tradeCount < MAX_TRADES_PER_DAY &&
      (isGoldenCross || (isRsiOversold && isBbLower) || isPullbackBuy);

    if (longShares === 0 && shortShares === 0 && shouldBuyLong) {
      const maxSpend = capital * lotRatio; // レジーム/銘柄に応じた建玉
      const shares = Math.floor(maxSpend / curr.close / 100) * 100; // 100株単位
      if (shares > 0) {
        const totalAmount = shares * curr.close;
        longShares = shares;
        longEntryPrice = curr.close;
        longHighWater = curr.close;  // トレイリング用の最高値を初期化
        capital -= totalAmount;
        const buyReason = isGoldenCross
          ? `ゴールデンクロス (MA5:${curr.ma5?.toFixed(1)} > MA25:${curr.ma25?.toFixed(1)})`
          : isPullbackBuy
          ? `押し目買い (上昇トレンド中RSI:${curr.rsi?.toFixed(1)}、MA25近辺)`
          : `RSI売られすぎ+BB下限 (RSI:${curr.rsi?.toFixed(1)}, BB下:${curr.bbLower?.toFixed(1)})`;
        trades.push({ time: curr.time, type: "buy", price: curr.close, shares, totalAmount });
        signals.push({ time: curr.time, type: "buy", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: buyReason });
      }
    }

    // ロング損切り＋トレイリング利確（早く損切り・利を伸ばす）
    if (longShares > 0) {
      // 最高値を更新
      if (curr.close > longHighWater) longHighWater = curr.close;
      const gain = (longHighWater - longEntryPrice) / longEntryPrice;  // ピークでの含み益率
      // 動的損切りラインを決定
      let stopPrice = longEntryPrice * (1 - stopLossRatio);  // 初期は固定損切り
      let stopReason = `損切り (${effectiveLongStopLoss}%下落)`;
      if (gain >= TRAIL_TRIGGER) {
        // 含み益+1%超: ピークからTRAIL_GAP下でトレイル
        stopPrice = longHighWater * (1 - TRAIL_GAP);
        stopReason = `トレイリング利確 (ピーク:${longHighWater.toFixed(1)}から${(TRAIL_GAP*100).toFixed(1)}%下落)`;
      } else if (gain >= BREAKEVEN_TRIGGER) {
        // 含み益+0.5%超: 損切りを建値（同値）に引き上げ
        stopPrice = Math.max(stopPrice, longEntryPrice);
        stopReason = `同値損切り (建値ストップ)`;
      }
      if (curr.close <= stopPrice) {
        const totalAmount = longShares * curr.close;
        const profit = totalAmount - longShares * longEntryPrice;
        capital += totalAmount;
        if (profit > 0) winCount++; else lossCount++;
        realizedPnl += profit; tradeCount++;
        if (realizedPnl <= -CIRCUIT_BREAKER) halted = true; // サーキットブレーカー
        trades.push({ time: curr.time, type: "sell", price: curr.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
        signals.push({ time: curr.time, type: "sell", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: `${stopReason} (入荷:${longEntryPrice.toFixed(1)}→現在:${curr.close.toFixed(1)})` });
        longShares = 0;
        longEntryPrice = 0;
        longHighWater = 0;
      }
    }

    // ロング利確・手仕舞い
    // 【重要】デッドクロスでの即手仕舞いは廃止。
    // バックテストでデッドクロス決済は8件全敗(-43,200円)、その多くが-0.1～0.3%の微損。
    // これは横ばいでの往復ビンタであり、デッドクロスで逆るより損切り(0.8%)・同値・トレイリングに任せた方が良い。
    // デッドクロスは「新規エントリーを止める」フィルターとしてのみ機能させる（下記 isStrongDown でカバー）。
    // 手仕舞いはRSI買われすぎ+BB上限（勝率60%）だけに限定。
    const shouldSellLong = isRsiOverbought && isBbUpper && !isStrongUp;

    if (longShares > 0 && shouldSellLong) {
      const totalAmount = longShares * curr.close;
      const profit = totalAmount - longShares * longEntryPrice;
      capital += totalAmount;
      if (profit > 0) winCount++; else lossCount++;
      realizedPnl += profit; tradeCount++;
      if (realizedPnl <= -CIRCUIT_BREAKER) halted = true;
      const sellReason = `RSI買われすぎ+BB上限 (RSI:${curr.rsi?.toFixed(1)}, BB上:${curr.bbUpper?.toFixed(1)})`;
      trades.push({ time: curr.time, type: "sell", price: curr.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
      signals.push({ time: curr.time, type: "sell", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: sellReason });
      longShares = 0;
      longEntryPrice = 0;
      longHighWater = 0;
    }

    // ============================================================
    // ショート（空売り）ポジション管理
    // ============================================================

    // ショートエントリー（精度向上版）
    // 【改善】デッドクロス単独では発火させず、「下落トレンド中の戻り売り」を厳選する。
    //  ・下落トレンド（slope<閾値）が前提
    //  ・RSIがまだ高い（>=SHORT_RSI_MIN）=戻りを売る。売られすぎでの追い空売りを除外
    //  ・価格がMA25近辺まで戻った（戻り売りの好位置）
    const stockTrendDownForShort = slope < -SLOPE_THRESHOLD;
    const nearMA25ForShort = curr.ma25 > 0 && Math.abs(curr.close - curr.ma25) / curr.ma25 <= SHORT_NEAR_MA;
    // 改善A: MA25からの乖離率チェック（乖離しすぎた位置でのショートを禁止）
    const shortMaDeviation = curr.ma25 > 0 ? Math.abs(curr.close - curr.ma25) / curr.ma25 : 0;
    const shortMaDeviationOk = shortMaDeviation <= effectiveShortMaxMaDev;
    // 改善B: 戻り売りも mktDown 限定にするオプション
    const pullbackShortMarketOk = !effectiveShortRequiresMktDown || mktDown;
    const isPullbackShort = stockTrendDownForShort && curr.rsi >= SHORT_RSI_MIN && nearMA25ForShort && curr.close <= curr.ma25 && shortMaDeviationOk && pullbackShortMarketOk;
    // 【追加】ブレイク売り: 下落相場で「戻り」が来ないため戻り売りが発火しない問題に対応する。
    //  ・市場全体が明確に下落ムード（mktDown）の時だけ許可（往復・上昇相場では発火させずダマシ回避）
    //  ・個別銘柄も下落トレンド（slope<閾値）かつ MA5<MA25 の下落継続
    //  ・価格がMA25を下回り、勢い（flow）も売り優勢
    //  ・RSIが売られすぎ(SHORT_BREAKDOWN_RSI_MIN)未満でない=底値圏での飛び乗りは避ける
    const isStrongDownForShort = curr.ma5 < curr.ma25 && curr.close < curr.ma25;
    const isBreakdownShort =
      mktDown &&
      stockTrendDownForShort &&
      isStrongDownForShort &&
      flowDown &&
      curr.rsi > SHORT_BREAKDOWN_RSI_MIN &&
      curr.rsi < rsiUpper;
    // 戻り売り（厳選）／ ブレイク売り（下落相場限定）／ RSI買われすぎ+BB上限の明確な反転サイン。デッドクロス単独は採用しない。
    // GC直後のクールダウン中はショートエントリー禁止（上昇トレンド転換直後の逆行を回避）
    // GCクールダウンをデクリメント（GC検出時にセット）
    if (isGoldenCross) gcCooldownRemaining = SHORT_GC_COOLDOWN_BARS;
    else if (gcCooldownRemaining > 0) gcCooldownRemaining--;
    // ② ショート損切りクールダウンをデクリメント
    if (shortStopCooldownRemaining > 0) shortStopCooldownRemaining--;
    const inGcCooldown = gcCooldownRemaining > 0;
    const inShortStopCooldown = shortStopCooldownRemaining > 0;
    // noShortAfterHour: 指定時刻以降のショートエントリーを禁止
    const suppressShortByHour = overrides.noShortAfterHour !== undefined && entryHour >= overrides.noShortAfterHour;
    // shortMinRsi: RSIが指定値未満の場合はショート禁止（売られすぎ局面でのショート防止）
    const suppressShortByRsi = overrides.shortMinRsi !== undefined && (curr.rsi ?? 50) < overrides.shortMinRsi;
    // shortMaxVolRatio: 出来高急増時のショート禁止
    const volSlice = candles.slice(Math.max(0, i - 20), i);
    const volAvg20 = volSlice.length > 0 ? volSlice.reduce((s, c) => s + c.volume, 0) / volSlice.length : 1;
    const volRatioNow = volAvg20 > 0 ? curr.volume / volAvg20 : 1;
    const suppressShortByVolRatio = overrides.shortMaxVolRatio !== undefined && volRatioNow >= overrides.shortMaxVolRatio;
    // gapUpShortBlockPercent: 当日始値が前日終値より指定%以上高い場合はショート禁止（ギャップアップ日は上昇モメンタム強い）
    const suppressShortByGapUp = (() => {
      if (overrides.gapUpShortBlockPercent === undefined || overrides.prevDayClose === undefined) return false;
      const gapRatio = (dayOpen - overrides.prevDayClose) / overrides.prevDayClose;
      return gapRatio >= overrides.gapUpShortBlockPercent / 100;
    })();

    const shouldEnterShort = regimeAllowShort && !isStrongUp && volConfirmed &&
      !suppressEntryByHour && !suppressAfternoon && !inGcCooldown && !inShortStopCooldown && !suppressShortByHour &&
      !suppressShortByRsi && !suppressShortByVolRatio && !suppressShortByGapUp &&
      tradeCount < MAX_TRADES_PER_DAY &&
      (isPullbackShort || isBreakdownShort || (isRsiOverbought && isBbUpper));

    if (shortShares === 0 && longShares === 0 && shouldEnterShort) {
      const maxSpend = capital * lotRatio;
      const shares = Math.floor(maxSpend / curr.close / 100) * 100; // 100株単位
      if (shares > 0) {
        const marginRequired = shares * curr.close;
        shortShares = shares;
        shortEntryPrice = curr.close;
        shortLowWater = curr.close;  // トレイリング用の最安値を初期化
        shortEntryBar = i;          // 最大保有時間管理用
        capital -= marginRequired; // 証拠金を確保
        const shortReason = isPullbackShort
          ? `空売りエントリー: 下落トレンド中の戻り売り (RSI:${curr.rsi?.toFixed(1)}、MA25近辺)`
          : isBreakdownShort
          ? `空売りエントリー: 下落相場ブレイク売り (市場下落ムード+MA25割れ, RSI:${curr.rsi?.toFixed(1)})`
          : `空売りエントリー: RSI買われすぎ+BB上限 (RSI:${curr.rsi?.toFixed(1)})`;
        trades.push({ time: curr.time, type: "short", price: curr.close, shares, totalAmount: marginRequired });
        signals.push({ time: curr.time, type: "short", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: shortReason });
      }
    }

    // ショート損切り＋トレイリング利確（早く損切り・利を伸ばす）
    if (shortShares > 0) {
      // 最安値を更新
      if (curr.close < shortLowWater) shortLowWater = curr.close;
      const gain = (shortEntryPrice - shortLowWater) / shortEntryPrice;  // ボトムでの含み益率
      // 動的損切りラインを決定（ショートは上昇で損）
      let stopPrice = shortEntryPrice * (1 + effectiveShortStopRatio);  // 初期は固定損切り（改善Cで縮小可能）
      let stopReason = `空売り損切り (${effectiveShortStopLoss}%上昇)`;
      if (gain >= TRAIL_TRIGGER) {
        stopPrice = shortLowWater * (1 + TRAIL_GAP);
        stopReason = `空売りトレイリング利確 (ボトム:${shortLowWater.toFixed(1)}から${(TRAIL_GAP*100).toFixed(1)}%上昇)`;
      } else if (gain >= BREAKEVEN_TRIGGER) {
        stopPrice = Math.min(stopPrice, shortEntryPrice);
        stopReason = `空売り同値損切り (建値ストップ)`;
      }
      if (curr.close >= stopPrice) {
        const profit = (shortEntryPrice - curr.close) * shortShares;
        const marginReturn = shortShares * shortEntryPrice;
        capital += marginReturn + profit;
        if (profit > 0) winCount++; else lossCount++;
        realizedPnl += profit; tradeCount++;
        if (realizedPnl <= -CIRCUIT_BREAKER) halted = true;
        trades.push({ time: curr.time, type: "cover", price: curr.close, shares: shortShares, totalAmount: shortShares * curr.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
        signals.push({ time: curr.time, type: "cover", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: `${stopReason} (エントリー:${shortEntryPrice.toFixed(1)} → ${curr.close.toFixed(1)})` });
        shortShares = 0;
        shortEntryPrice = 0;
        shortLowWater = 0;
        shortEntryBar = -1;
        // ② 損切り発動時にクールダウンをセット（利確はクールダウンなし）
        if (profit < 0 && overrides.shortStopCooldownBars) {
          shortStopCooldownRemaining = overrides.shortStopCooldownBars;
        }
      }
    }

    // ショート利確・買い戻し
    // 【改善】ゴールデンクロスでの買い戻しは「含み益あり かつ RSI>=40（底打ち反転の信頼度が高い）」の場合のみ実行。
    // バックテストでゴールデンクロス単独カバーは333回中250回負け(-491,700円)。
    // 含み損のままゴールデンクロスが来た場合は損切りライン（同値/固定）に任せる。
    const shortCurrentProfit = shortShares > 0 ? (shortEntryPrice - curr.close) * shortShares : 0;
    const shortInProfit = shortCurrentProfit > 0;
    // ゴールデンクロスカバー: 含み益あり かつ RSI>=40（底打ち反転シグナルの信頼度確認）
    const gcCoverAllowed = isGoldenCross && shortInProfit && (curr.rsi ?? 50) >= SHORT_GC_COVER_RSI_MIN;
    // RSI売られすぎ+BB下限カバー: 従来通り（勝率が高い経路は維持）
    const rsiBbCover = isRsiOversold && isBbLower && !isStrongDown;
    // 【改善】最大保有時間超過: 引けまで持ち越しになるショートの大半が損失。時間切れで手仕まい
    const shortHoldBars = shortEntryBar >= 0 ? i - shortEntryBar : 0;
    const effectiveMaxShortHoldBars = overrides.maxShortHoldBars ?? SHORT_MAX_HOLD_BARS;
    const shortTimeExpired = shortShares > 0 && shortHoldBars >= effectiveMaxShortHoldBars;
    const shouldCoverShort = gcCoverAllowed || rsiBbCover || shortTimeExpired;

    if (shortShares > 0 && shouldCoverShort) {
      const profit = (shortEntryPrice - curr.close) * shortShares;
      const marginReturn = shortShares * shortEntryPrice;
      capital += marginReturn + profit;
      if (profit > 0) winCount++; else lossCount++;
      realizedPnl += profit; tradeCount++;
      if (realizedPnl <= -CIRCUIT_BREAKER) halted = true;
      const coverReason = shortTimeExpired
        ? `空売り買い戻し: 最大保有時間超過 (${shortHoldBars}本保有, エントリー:${shortEntryPrice.toFixed(1)}→${curr.close.toFixed(1)})`
        : gcCoverAllowed
        ? `空売り買い戻し: ゴールデンクロス (MA5:${curr.ma5?.toFixed(1)} > MA25:${curr.ma25?.toFixed(1)})`
        : `空売り買い戻し: RSI売られすぎ+BB下限 (RSI:${curr.rsi?.toFixed(1)})`;
      trades.push({ time: curr.time, type: "cover", price: curr.close, shares: shortShares, totalAmount: shortShares * curr.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
      signals.push({ time: curr.time, type: "cover", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: coverReason });
      shortShares = 0;
      shortEntryPrice = 0;
      shortLowWater = 0;
      shortEntryBar = -1;
    }
  }

  // 残ロングポジションを引け値で強制決済
  if (longShares > 0 && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const totalAmount = longShares * lastCandle.close;
    const profit = totalAmount - longShares * longEntryPrice;
    capital += totalAmount;
    if (profit > 0) winCount++; else lossCount++;
    trades.push({ time: lastCandle.time, type: "sell", price: lastCandle.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
    signals.push({ time: lastCandle.time, type: "sell", price: lastCandle.close, ma5: lastCandle.ma5, ma25: lastCandle.ma25, rsi: lastCandle.rsi, reason: `引け値強制決済(ロング) (入荷:${longEntryPrice.toFixed(1)}→引け:${lastCandle.close.toFixed(1)})` });
  }

  // 残ショートポジションを引け値で強制決済
  if (shortShares > 0 && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const profit = (shortEntryPrice - lastCandle.close) * shortShares;
    const marginReturn = shortShares * shortEntryPrice;
    capital += marginReturn + profit;
    if (profit > 0) winCount++; else lossCount++;
    trades.push({ time: lastCandle.time, type: "cover", price: lastCandle.close, shares: shortShares, totalAmount: shortShares * lastCandle.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
    signals.push({ time: lastCandle.time, type: "cover", price: lastCandle.close, ma5: lastCandle.ma5, ma25: lastCandle.ma25, rsi: lastCandle.rsi, reason: `引け値強制決済(ショート) (入荷:${shortEntryPrice.toFixed(1)}→引け:${lastCandle.close.toFixed(1)})` });
  }

  const finalBalance = capital;
  const profitAmount = finalBalance - initialCapital;
  const profitRate = profitAmount / initialCapital;
  const tradesCount = trades.filter(t => t.type === "sell" || t.type === "cover").length;
  const winRate = tradesCount > 0 ? winCount / tradesCount : 0;

  // 損失原因と対策の動的生成
  const lossCauses: string[] = [];
  const countermeasures: string[] = [];

  if (profitAmount < 0) {
    if (lossCount > winCount) {
      lossCauses.push("📉 レンジ相場（もみ合い）での細かな損切りの連続（往復ビンタ）。");
      countermeasures.push("🛡️ レンジ相場を検知した場合は、MAクロスによるトレンドフォロー取引を一時停止し、RSI逆張りに切り替える。");
    }
    lossCauses.push("📈 急激なトレンド転換に対して、1分足の移動平均線の反応が遅れ、高値掴み・安値売りとなった。");
    countermeasures.push("⚙️ 移動平均線の期間を5MAから3MAなど、より短期に設定して反応速度を上げる。");
  } else {
    lossCauses.push("✅ 本日は利益を確保できましたが、トレンドの終盤でエントリーする微小な高値掴みが発生していました。");
    countermeasures.push("🎯 トレンド発生から時間が経過している場合は、エントリーのロット数を半分にするなどの資金管理を徹底する。");
  }

  return {
    symbol,
    name,
    initialCapital,
    finalBalance,
    profitAmount,
    profitRate,
    tradesCount,
    winCount,
    lossCount,
    winRate,
    trades,
    lossCauses,
    countermeasures,
    signals,
    isRealData: true,
  };
}

/**
 * 全対象銘柄の実データシミュレーションを実行する
 */
export async function generateRealDailyReport(
  dateStr: string,
  rsiUpper = 70,
  rsiLower = 30,
  stopLossPercent = 2.0
) {
  console.log(`[realSimulation] Starting real data simulation for ${dateStr}`);

  // ステップ1: 全銘柄のローソク足を先に取得（市場全体の地合い計算のため）
  // APIレート制限を避けるため、並列ではなく順次取得する
  const candleMap = new Map<string, RealCandle[]>();
  for (const stock of SIMULATION_STOCKS) {
    const candles = await fetchRealCandles(stock.ticker, 3, dateStr);
    if (candles) candleMap.set(stock.symbol, candles);
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // ステップ2: 市場全体の地合い関数を作る
  // 「ある銘柄が始値比 r の時点」の市場全体の平均始値比を返す。
  // 各銘柄の始値比系列を個数で揃え、同じ進行位置の平均を使う。
  // リアルタイム性を保つため、「その銘柄の現在進行率」を代理変数として
  // 他銘柄の同時刻帯の始値比を参照する。簡易化のため「全銘柄の最新始値比の平均」を
  // 経過割合で補間して返す関数を生成する。
  const symbols = Array.from(candleMap.keys());
  // 各銘柄の「進行位置(0〜1) → 始値比」を引けるようにしておく
  const ratioSeries: number[][] = symbols.map(sym => {
    const cs = candleMap.get(sym)!;
    const open = cs[0]?.open ?? 0;
    return cs.map(c => (open > 0 ? (c.close - open) / open : 0));
  });
  // 進行率 p(0〜1) における市場平均始値比
  const marketBiasByProgress = (p: number): number => {
    let sum = 0; let cnt = 0;
    for (const series of ratioSeries) {
      if (series.length === 0) continue;
      const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1))));
      sum += series[idx]; cnt++;
    }
    return cnt > 0 ? sum / cnt : 0;
  };

  // 【レンジ回避】市場全体の方向効率を計算し、往復レンジの日は全銘柄で新規エントリーを停止する
  const dayStats = symbols.map(sym => {
    const cs = candleMap.get(sym)!;
    return {
      open: cs[0]?.open ?? 0,
      high: Math.max(...cs.map(c => c.high)),
      low: Math.min(...cs.map(c => c.low)),
      close: cs[cs.length - 1]?.close ?? 0,
    };
  });
  const marketEfficiency = computeMarketEfficiency(dayStats);
  const rangeBoundDay = isRangeBoundDay(marketEfficiency);
  if (rangeBoundDay) {
    console.log(`[realSimulation] Range-bound day detected (efficiency=${marketEfficiency.toFixed(2)} < ${REGIME_CONSTANTS.RANGE_EFFICIENCY_THRESHOLD}). New entries disabled for all stocks.`);
  }

  // ステップ3: 各銘柄をレジーム適応型でシミュレーション
  const allResults: ((StockSimResult & { isRealData: boolean }) | null)[] = [];
  for (const stock of SIMULATION_STOCKS) {
    const candles = candleMap.get(stock.symbol);
    if (!candles) {
      console.warn(`[realSimulation] Real data unavailable for ${stock.ticker} - skipping (NO FALLBACK)`);
      allResults.push(null);
      continue;
    }
    const result = simulateStockReal(
      stock.symbol,
      stock.ticker,
      stock.name,
      candles,
      marketBiasByProgress,
      3_000_000,
      rsiUpper,
      rsiLower,
      stopLossPercent,
      rangeBoundDay,
      1.0,
      { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE } // ショート0.55%・昼休み前11:20全決済・午後エントリー禁止(SUPPRESS_AFTERNOON_ENTRY=true)を適用
    );
    allResults.push(result);
  }

  // 実データを取得できた銘柄のみを使用（nullは除外）
  const stockReports = allResults.filter((r): r is StockSimResult & { isRealData: boolean } => r !== null);
  const realDataCount = stockReports.length;

  // 実データが1銘柄も取得できなかった場合はエラーをスロー（架空データでのレポート保官は絶対に行わない）
  if (realDataCount === 0) {
    throw new Error(`[realSimulation] FATAL: No real data available for any stock on ${dateStr}. Yahoo Finance API may be rate-limited or unavailable. Aborting - no report will be saved.`);
  }

  console.log(`[realSimulation] Completed: ${realDataCount}/${SIMULATION_STOCKS.length} stocks used real data`);

  const totalInitialCapital = 3_000_000 * realDataCount;
  const totalFinalBalance = stockReports.reduce((sum, r) => sum + r.finalBalance, 0);
  const totalProfitAmount = totalFinalBalance - totalInitialCapital;
  const totalProfitRate = totalProfitAmount / totalInitialCapital;
  const totalWinCount = stockReports.reduce((sum, r) => sum + r.winCount, 0);
  const totalLossCount = stockReports.reduce((sum, r) => sum + r.lossCount, 0);
  const totalTrades = totalWinCount + totalLossCount;
  const overallWinRate = totalTrades > 0 ? totalWinCount / totalTrades : 0;

  // ============================================================
  // 【ハイブリッド運用】同時保有3銘柄・同業種2銘柄の上限を適用
  // ============================================================
  // 各銘柄の取引履歴を時刻順に統合し、ポートフォリオ全体で枠を管理する。
  const perStock: PerStockTrades[] = stockReports.map((r) => ({ symbol: r.symbol, trades: r.trades }));
  const portfolio = applyPortfolioRules(perStock);

  // 【本日の推奨銘柄】実績スコア順（損益主体・業種分散を考慮）でトップ3を選ぶ
  const scoreInputs: SymbolScoreInput[] = stockReports.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    profit: r.profitAmount,
    winCount: r.winCount,
    lossCount: r.lossCount,
  }));
  const recommendedSymbols = rankRecommendedSymbols(scoreInputs, 3);

  return {
    date: dateStr,
    totalInitialCapital,
    totalFinalBalance,
    totalProfitAmount,
    totalProfitRate,
    totalWinCount,
    totalLossCount,
    overallWinRate,
    rsiUpper,
    rsiLower,
    stopLossPercent,
    stockReports,
    realDataCount,
    isRealData: true, // 常にtrue（実データのみ使用）
    // ハイブリッド運用の追加情報
    portfolio,
    recommendedSymbols,
  };
}
