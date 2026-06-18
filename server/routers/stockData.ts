/**
 * stockData.ts
 * Yahoo Finance APIから実際の株価データを取得し、
 * テクニカル指標（MA5/MA25/RSI/BB）を計算してシグナル付きで返す
 */
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { callDataApi } from "../_core/dataApi";
import { TRPCError } from "@trpc/server";
import { TARGET_STOCKS, getStockName, getSector, TICKER_BY_SYMBOL } from "../../shared/stocks";
import {
  evaluateConfirmation,
  trailingAvgVolume,
  priceMomentum,
  type SignalConfidence,
} from "../signalConfirmation";
import {
  ma25Slope,
  dayChangeRatio,
  classifyIntradayRegime,
  isSignalAllowedInRegime,
  calcADX,
  isAdxTrending,
  type IntradayRegime,
} from "../intradayRegime";
import {
  calcVWAP,
  calcDowSwings,
  isLongUpperShadow,
  isLongLowerShadow,
  detectHarami,
  detectRoundLevel,
  detectVwapBounce,
  detectDoubleTopBottom,
  detectHeadAndShoulders,
} from "../vwap";

// ---- データAPI呼び出し（レート制限の自動リトライ付き） ----

const _sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** レスポンスがレート制限エラーかどうかを判定する */
function isRateLimited(resp: unknown): boolean {
  if (resp && typeof resp === "object" && "message" in resp) {
    const msg = String((resp as { message?: unknown }).message ?? "");
    return /rate limit/i.test(msg);
  }
  return false;
}

/**
 * Yahoo Finance のチャートを取得する。
 * データAPIは1秒あたりのレート制限が厳しいため、
 * レート制限エラーを受け取ったら待機して最大2回までリトライする。
 */
async function fetchStockChart(query: Record<string, unknown>): Promise<unknown> {
  let lastResp: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await _sleep(700 * attempt);
    lastResp = await callDataApi("YahooFinance/get_stock_chart", { query });
    if (!isRateLimited(lastResp)) return lastResp;
  }
  return lastResp;
}

// ---- テクニカル指標計算 ----

export function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    result[i] = Math.round((slice.reduce((a, b) => a + b, 0) / period) * 10) / 10;
  }
  return result;
}

export function calcRSI(data: number[], period = 14): (number | null)[] {
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
      result[i] = Math.round((100 - 100 / (1 + rs)) * 10) / 10;
    }
    if (i < data.length - 1) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
  }
  return result;
}

export function calcBollinger(
  data: number[],
  period = 20,
  stdDev = 2
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const middle: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);

  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - avg) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    middle[i] = Math.round(avg * 10) / 10;
    upper[i] = Math.round((avg + stdDev * std) * 10) / 10;
    lower[i] = Math.round((avg - stdDev * std) * 10) / 10;
  }
  return { upper, middle, lower };
}

// ---- シグナル検出（アプリと同じロジック） ----
export interface CandleWithSignal {
  time: string;
  /** 営業日キー（JSTのYYYY-MM-DD）。最新営業日の足だけを抽出する用途で使う */
  dayKey?: string;
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
  bbMiddle: number | null;
  bbLower: number | null;
  /** VWAP（出来高加重平均価格）。当日の累積計算値。 */
  vwap?: number | null;
  signal?: { type: "buy" | "sell" | "warn"; reason: string; confidence?: SignalConfidence; recentSwingLow?: number | null; recentSwingHigh?: number | null };
}

export function detectSignals(candles: CandleWithSignal[], rsiUpper = 70, rsiLower = 30): CandleWithSignal[] {
  const result = candles.map(c => ({ ...c }));
  const closes = result.map(c => c.close);
  const volumes = result.map(c => c.volume);
  const ma25Series = result.map(c => c.ma25);
  const highs = result.map(c => c.high);
  const lows = result.map(c => c.low);

  // ADX（平均方向性指数）を事前計算。ADX < 20の横ばい相場ではMAクロスシグナルを抑制する。
  const adxSeries = calcADX(highs, lows, closes);

  // VWAP（出来高加重平均価格）を事前計算。当日の累積値。
  const vwapSeries = calcVWAP(result);
  result.forEach((c, i) => { c.vwap = vwapSeries[i]; });

  // ダウ理論スイング高値・安値を事前計算
  const dowSwings = calcDowSwings(result, 20);

  // VWAP反発を事前計算
  const vwapBounceSeries = detectVwapBounce(result, vwapSeries);

  // ダブルトップ/ダブルボトムを事前計算
  const doublePatternSeries = detectDoubleTopBottom(result, 40);

  // 三尊/逆三尊を事前計算
  const hsSeries = detectHeadAndShoulders(result, 60);

  // 各足の「当日の寄り値」を、その足と同じ営業日(dayKey)の最初の足の始値として求める。
  // dayKey が無い場合（旧データ等）は系列全体の先頭始値で代用する。
  const dayOpenByKey = new Map<string, number>();
  for (const c of result) {
    const key = c.dayKey ?? "__all__";
    if (!dayOpenByKey.has(key)) dayOpenByKey.set(key, c.open);
  }

  for (let i = 1; i < result.length; i++) {
    const c = result[i];
    const prev = result[i - 1];

    const c5 = c.ma5, c25 = c.ma25, p5 = prev.ma5, p25 = prev.ma25;
    const cRsi = c.rsi, cBbu = c.bbUpper, cBbl = c.bbLower;

    if (c5 === null || c25 === null || p5 === null || p25 === null ||
        cRsi === null || cBbu === null || cBbl === null) continue;

    // --- 当日の大局トレンド（レジーム）を判定 ---
    // 1分足の超短期クロスだけで買い/売りを貼り替えると、明確な下落日の安値圏リバウンドを
    // 「買い」と誤表示してしまう。そこでMA25の傾きと当日寄りからの騰落率で大局を捉え、
    // レジームに逆らうシグナル（下落相場のロング/上昇相場のショート）を抑制する。
    const dayKey = c.dayKey ?? "__all__";
    const dayOpen = dayOpenByKey.get(dayKey) ?? null;
    const slope = ma25Slope(ma25Series, i);
    const dayChange = dayChangeRatio(c.close, dayOpen);
    const regime: IntradayRegime = classifyIntradayRegime({ slope, dayChange });

    const isStrongDown = c5 < c25 && c.close < c5;
    const isStrongUp = c5 > c25 && c.close >= c5;

    // GCプロテクション（直近5本以内にGCがあれば売りシグナル抑制）
    let gcProtection = false;
    for (let j = Math.max(1, i - 4); j <= i; j++) {
      const rj = result[j], rjp = result[j - 1];
      if (rj.ma5 !== null && rj.ma25 !== null && rjp.ma5 !== null && rjp.ma25 !== null) {
        if (rjp.ma5 <= rjp.ma25 && rj.ma5 > rj.ma25) {
          gcProtection = true;
          break;
        }
      }
    }

    let candidate: { type: "buy" | "sell" | "warn"; reason: string; recentSwingLow?: number | null; recentSwingHigh?: number | null } | null = null;

    // ---- VWAPクロス判定 ----
    const vwapCurr = vwapSeries[i];
    const vwapPrev = vwapSeries[i - 1];
    const vwapCrossUp = vwapCurr !== null && vwapPrev !== null &&
      prev.close < vwapPrev && c.close >= vwapCurr; // 前足がVWAP以下→現足がVWAP以上（上抜け）
    const vwapCrossDown = vwapCurr !== null && vwapPrev !== null &&
      prev.close > vwapPrev && c.close <= vwapCurr; // 前足がVWAP以上→現足がVWAP以下（下抜け）

    // ---- ダウ理論スイング判定 ----
    const { swingHighBreak, swingLowBreak, recentSwingLow, recentSwingHigh } = dowSwings[i];

    // ---- ローソク足パターン判定 ----
    const longUpperShadow = isLongUpperShadow(c);
    const longLowerShadow = isLongLowerShadow(c);
    const { isBullishHarami, isBearishHarami } = detectHarami(prev, c);
    const { crossedBelow: roundLevelBreak, crossedAbove: roundLevelBreakUp, level: roundLevel } = detectRoundLevel(prev.close, c.close);
    // ---- VWAP反発 ----
    const { isBullishBounce: vwapBullishBounce, isBearishBounce: vwapBearishBounce } = vwapBounceSeries[i];
    // ---- ダブルトップ/ダブルボトム ----
    const { isDoubleTop, isDoubleBottom, neckline: dtNeckline } = doublePatternSeries[i];
    // ---- 三尊/逆三尊 ----
    const { isHeadAndShoulders: isHS, isInverseHeadAndShoulders: isIHS, neckline: hsNeckline } = hsSeries[i];

    // 買いシグナル
    if (!isStrongDown) {
      if (p5 <= p25 && c5 > c25) {
        candidate = { type: "buy", reason: `ゴールデンクロス (MA5:${c5} > MA25:${c25})` };
      } else if (cRsi <= rsiLower && c.close <= cBbl) {
        candidate = { type: "buy", reason: `RSI売られすぎ(${cRsi}%) + BB下限タッチ` };
      } else if (vwapCrossUp && regime !== "down") {
        // VWAPを上抜け: 買い優勢に転換（下落相場では抑制）
        candidate = { type: "buy", reason: `VWAPクロス上抜け (VWAP:${vwapCurr?.toFixed(1)})` };
      } else if (swingHighBreak && c5 > c25 && regime !== "down") {
        // ダウ理論: 直近高値更新 + 上昇トレンド中 → 上昇継続シグナル（押し目確認のためrecentSwingLowを付加）
        candidate = { type: "buy", reason: `ダウ理論: 直近高値更新 (上昇トレンド継続)`, recentSwingLow };
      } else if (longLowerShadow && cRsi <= 45 && regime !== "down") {
        // 長い下ヒゲ: 売り圧力を跳ね返した底値シグナル（RSI低め=売られすぎ圏）
        candidate = { type: "buy", reason: `長い下ヒゲ (底値反転シグナル, RSI:${cRsi}%)` };
      } else if (isBullishHarami && cRsi <= 45) {
        // 強気はらみ: 前足大陰線の中に陽線が収まる → 底値圏での反転の兆し
        candidate = { type: "buy", reason: `強気はらみ線 (底値反転の兆し, RSI:${cRsi}%)` };
      } else if (roundLevelBreakUp && roundLevel !== null && regime !== "down") {
        // 大台超え: キリ番を上抜け → 上昇加速シグナル
        candidate = { type: "buy", reason: `大台超え (${roundLevel}円突破)` };
      } else if (vwapBullishBounce && regime !== "down") {
        // VWAP反発（押し目買い）: VWAPまで下落後に陽線で反発 → 買い継続シグナル
        candidate = { type: "buy", reason: `VWAP反発（押し目買い）(VWAP:${vwapSeries[i]?.toFixed(1)})` };
      } else if (isDoubleBottom && dtNeckline !== null && regime !== "down") {
        // ダブルボトム: 2つの谷のネックライン突破 → 底値確認・上昇転換シグナル
        candidate = { type: "buy", reason: `ダブルボトム (ネックライン:${dtNeckline.toFixed(1)}円突破)` };
      } else if (isIHS && hsNeckline !== null && regime !== "down") {
        // 逆三尊: ネックライン上抜け → 底値確認・上昇転換シグナル
        candidate = { type: "buy", reason: `逆三尊（インバースH&S）(ネックライン:${hsNeckline.toFixed(1)}円突破)` };
      }
    }

    // 売りシグナル（買い候補がない場合のみ評価）
    if (!candidate) {
      if (p5 >= p25 && c5 < c25) {
        candidate = { type: "sell", reason: `デッドクロス (MA5:${c5} < MA25:${c25})` };
      } else if (cRsi >= rsiUpper && c.close >= cBbu && !isStrongUp && !gcProtection) {
        candidate = { type: "sell", reason: `RSI買われすぎ(${cRsi}%) + BB上限タッチ` };
      } else if (regime === "down" && cRsi >= 50 && c.close <= c25) {
        // 下落相場の「戻り売り」: 大局が下落の中でRSIが中値以上まで戻し、
        // 価格がMA25以下（戻り高が中期線に押さえられた）ところを売り候補とする。
        candidate = { type: "sell", reason: `下落相場の戻り売り (RSI:${cRsi}% · MA25以下)` };
      } else if (vwapCrossDown && regime !== "up") {
        // VWAPを下抜け: 売り優勢に転換（上昇相場では抑制）
        candidate = { type: "sell", reason: `VWAPクロス下抜け (VWAP:${vwapCurr?.toFixed(1)})` };
      } else if (swingLowBreak && c5 < c25 && regime !== "up") {
        // ダウ理論: 直近安値更新 + 下落トレンド中 → 下落継続シグナル
        candidate = { type: "sell", reason: `ダウ理論: 直近安値更新 (下落トレンド継続)` };
      } else if (longUpperShadow && cRsi >= 55 && !gcProtection) {
        // 長い上ヒゲ: 買い圧力を跳ね返した天井シグナル（RSI高め=買われすぎ圏）
        candidate = { type: "sell", reason: `長い上ヒゲ (天井シグナル, RSI:${cRsi}%)` };
      } else if (isBearishHarami && cRsi >= 55 && !gcProtection) {
        // 弱気はらみ: 前足大陽線の中に陰線が収まる → 高値圏での反転の兆し
        candidate = { type: "sell", reason: `弱気はらみ線 (天井反転の兆し, RSI:${cRsi}%)` };
      } else if (roundLevelBreak && roundLevel !== null && regime !== "up") {
        // 大台割れ: キリ番を下抜け → 下落加速シグナル
        candidate = { type: "sell", reason: `大台割れ (${roundLevel}円割り込み)` };
      } else if (vwapBearishBounce && regime !== "up") {
        // VWAP反落（戻り売り）: VWAPまで上昇後に陰線で反落 → 売り継続シグナル
        candidate = { type: "sell", reason: `VWAP反落（戻り売り）(VWAP:${vwapSeries[i]?.toFixed(1)})` };
      } else if (isDoubleTop && dtNeckline !== null && regime !== "up") {
        // ダブルトップ: 2つの山のネックライン割れ → 天井確認・下落転換シグナル
        candidate = { type: "sell", reason: `ダブルトップ (ネックライン:${dtNeckline.toFixed(1)}円割れ)` };
      } else if (isHS && hsNeckline !== null && regime !== "up") {
        // 三尊: ネックライン下抜け → 天井確認・下落転換シグナル
        candidate = { type: "sell", reason: `三尊（ヘッド&ショルダー）(ネックライン:${hsNeckline.toFixed(1)}円割れ)` };
      }
    }

    // 大局トレンドに逆らうシグナルは抑制する（下落相場のロング・上昇相場のショートを出さない）。
    if (candidate && !isSignalAllowedInRegime(candidate.type, regime)) {
      candidate = null;
    }

    // ---- ADXフィルター: 横ばい相場（ADX < 20）ではMAクロスシグナルを抑制 ----
    // ADXがトレンドなしと判定される場合、MAクロスはダマシになりやすい。
    // ただしRSI+BB系シグナルは逆張りのため、横ばい相場でも有効なので通す。
    if (candidate && candidate.type !== "warn") {
      const adxVal = adxSeries[i];
      const isGcDcSignal = candidate.reason.includes("クロス") || candidate.reason.includes("戻り売り");
      if (isGcDcSignal && !isAdxTrending(adxVal)) {
        candidate = null; // 横ばい相場のMAクロスはスキップ
      }
    }

    // ---- 確認バーフィルター: クロス後に価格がMA5方向を維持しているか確認 ----
    // GC後に価格がMA5を下回っている、またはDC後に価格がMA5を上回っている場合はダマシの可能性。
    if (candidate) {
      if (candidate.reason.includes("ゴールデンクロス") && c.close < c5) {
        candidate = null; // GC後に価格がMA5を下回っている → ダマシの可能性
      } else if (candidate.reason.includes("デッドクロス") && c.close > c5) {
        candidate = null; // DC後に価格がMA5を上回っている → ダマシの可能性
      }
    }

    if (candidate) {
      // 確認フィルタで裏付けを評価し、信頼度を付与。弱い（裏付け不足）シグナルは抑制する。
      const conf = evaluateConfirmation({
        type: candidate.type,
        close: c.close,
        volume: c.volume,
        avgVolume: trailingAvgVolume(volumes, i, 10),
        ma5: c5,
        ma25: c25,
        momentum: priceMomentum(closes, i, 3),
        regime,
      });
      if (conf.shouldNotify) {
        c.signal = {
          type: candidate.type,
          reason: `${candidate.reason}｜${conf.summary}`,
          confidence: conf.confidence,
        };
      }
      // weak の場合はシグナルを付与しない（誤シグナル抑制）
    }
  }

  return result;
}

// ---- ローソク足構築（null補完つき） ----

type QuoteArrays = {
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  volume: (number | null)[];
};

/**
 * Yahoo Finance の quote 配列からローソク足を構築する。
 * 寄り付き直後は当日の足の close 等が null のことがあるため、
 * 「open も close も両方 null」の足だけスキップし、
 * 片方だけ欠けている場合は前の足の終値や同じ足の値で補完する。
 * これにより寄り付き直後でも空配列にならず描画を継続できる。
 */
export function buildCandlesFromQuotes(
  timestamps: number[],
  quotes: QuoteArrays
): CandleWithSignal[] {
  const rawCandles: CandleWithSignal[] = [];
  let lastClose: number | null = null;

  for (let i = 0; i < timestamps.length; i++) {
    const o = quotes.open[i];
    const h = quotes.high[i];
    const l = quotes.low[i];
    const c = quotes.close[i];
    const v = quotes.volume[i];

    // open も close も無い足は実体が無いのでスキップ
    if ((o === null || o === undefined) && (c === null || c === undefined)) {
      continue;
    }

    // 欠けている値を補完（close 優先、無ければ open、それも無ければ前足の終値）
    const closeVal: number | null = c ?? o ?? lastClose;
    const openVal: number | null = o ?? lastClose ?? closeVal;
    if (closeVal === null || closeVal === undefined || openVal === null || openVal === undefined) {
      continue;
    }
    const highVal = h ?? Math.max(openVal, closeVal);
    const lowVal = l ?? Math.min(openVal, closeVal);

    // JSTに換算して時刻文字列と「営業日キー（JSTのYYYY-MM-DD）」を作る
    const jstMs = timestamps[i] * 1000 + 9 * 60 * 60 * 1000;
    const d = new Date(jstMs);
    const jstHour = d.getUTCHours();
    const timeStr = `${String(jstHour).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const dayKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

    rawCandles.push({
      time: timeStr,
      dayKey,
      timestamp: timestamps[i] * 1000,
      open: Math.round(openVal * 10) / 10,
      high: Math.round(highVal * 10) / 10,
      low: Math.round(lowVal * 10) / 10,
      close: Math.round(closeVal * 10) / 10,
      volume: Math.round(v ?? 0),
      ma5: null,
      ma25: null,
      rsi: null,
      bbUpper: null,
      bbMiddle: null,
      bbLower: null,
    });
    lastClose = closeVal;
  }

  return rawCandles;
}

// ---- サーバーサイドキャッシュ ----
// 同じ銘柄・同じパラメータのデータを一定時間キャッシュしてAPI呼び出し回数を削減
type CacheEntry = {
  data: unknown;
  cachedAt: number;
  ttlMs: number;
};
const stockCache = new Map<string, CacheEntry>();

/** JST時刻の「午前0時からの経過分」を返す（テスト用に時刻を注入可能） */
export function jstMinutesOfDay(now: Date = new Date()): number {
  const jstHour = (now.getUTCHours() + 9) % 24;
  const jstMin = now.getUTCMinutes();
  return jstHour * 60 + jstMin;
}

/** JST時刻で市場時間中（9:00〜15:30）かどうか判定 */
function isMarketHours(now: Date = new Date()): boolean {
  const totalMin = jstMinutesOfDay(now);
  // 9:00 = 540分, 15:30 = 930分
  return totalMin >= 540 && totalMin <= 930;
}

/**
 * キャッシュの有効期間（ミリ秒）を時間帯から決める。
 * - 寄り付き前後（8:50〜9:15）: 前日終値の古い足を引きずらないよう10秒だけキャッシュ
 * - 市場時間中（9:00〜15:30）: 1分足の更新に追従するため60秒キャッシュ
 * - 市場時間外: 値動きが無いため15分キャッシュ（API負荷削減）
 */
export function cacheTtlFor(now: Date = new Date()): number {
  const totalMin = jstMinutesOfDay(now);
  // 8:50 = 530分, 9:15 = 555分
  if (totalMin >= 530 && totalMin <= 555) return 10 * 1000;
  if (isMarketHours(now)) return 60 * 1000;
  return 15 * 60 * 1000;
}

function getCachedOrFetch(
  cacheKey: string,
  fetcher: () => Promise<unknown>
): Promise<unknown> {
  const entry = stockCache.get(cacheKey);
  const now = Date.now();
  if (entry && now - entry.cachedAt < entry.ttlMs) {
    return Promise.resolve(entry.data);
  }
  return fetcher().then(data => {
    const ttlMs = cacheTtlFor();
    stockCache.set(cacheKey, { data, cachedAt: now, ttlMs });
    return data;
  });
}

// ---- 複数銘柄スキャン用ヘルパー ----

export interface ScannedSignal {
  symbol: string;
  name: string;
  sector: string;
  currentPrice: number;
  priceChange: number;
  priceChangePercent: number;
  rsi: number | null;
  ma5: number | null;
  ma25: number | null;
  /** 最新足で成立しているシグナル（なければ null） */
  latestSignal: { type: "buy" | "sell" | "warn"; reason: string; confidence?: SignalConfidence } | null;
  /** 最新足の時刻文字列（"HH:MM"） */
  latestSignalTime: string | null;
  /** データ取得に失敗した場合 true */
  error: boolean;
}

/**
 * シグナル付きローソク足の配列から「最新の有効なシグナル」を抽出する純粋関数。
 * 直近 lookback 本以内に出たシグナルのうち、最も新しいものを返す。
 * 古いシグナルで誤発火しないよう、既定では直近2本のみを対象にする。
 */
export function extractLatestSignal(
  candles: CandleWithSignal[],
  lookback = 2
): { signal: { type: "buy" | "sell" | "warn"; reason: string; confidence?: SignalConfidence } | null; time: string | null } {
  if (candles.length === 0) return { signal: null, time: null };
  const start = Math.max(0, candles.length - lookback);
  for (let i = candles.length - 1; i >= start; i--) {
    const c = candles[i];
    if (c.signal) {
      return { signal: c.signal, time: c.time };
    }
  }
  return { signal: null, time: null };
}

/**
 * 1銘柄分のチャートを取得し、テクニカル指標とシグナルを計算して
 * スキャン結果（最新シグナル・現在値など）を返す。
 * 取得に失敗しても例外を投げず error:true の結果を返す（一括スキャンを止めないため）。
 */
async function scanSymbol(
  symbol: string,
  rsiUpper: number,
  rsiLower: number
): Promise<ScannedSignal> {
  const ticker = TICKER_BY_SYMBOL[symbol] ?? `${symbol}.T`;
  const name = getStockName(symbol);
  const sector = getSector(symbol);
  const base: ScannedSignal = {
    symbol,
    name,
    sector,
    currentPrice: 0,
    priceChange: 0,
    priceChangePercent: 0,
    rsi: null,
    ma5: null,
    ma25: null,
    latestSignal: null,
    latestSignalTime: null,
    error: false,
  };

  try {
    // 1分足・直近5営業日で取得（指標は連続データで計算、表示は当日分のみ）
    const cacheKey = `${ticker}:5d:1m`;
    const rawData = await getCachedOrFetch(cacheKey, () =>
      fetchStockChart({ symbol: ticker, region: "JP", interval: "1m", range: "5d" })
    );

    const data = rawData as {
      chart?: {
        result?: Array<{
          meta: {
            regularMarketPrice: number;
            previousClose?: number;
          };
          timestamp: number[];
          indicators: {
            quote: Array<{
              open: (number | null)[];
              high: (number | null)[];
              low: (number | null)[];
              close: (number | null)[];
              volume: (number | null)[];
            }>;
          };
        }>;
      };
    };

    const r = data?.chart?.result?.[0];
    if (!r) return { ...base, error: true };

    const meta = r.meta;
    const timestamps = r.timestamp ?? [];
    const quotes = r.indicators.quote[0];

    const rawCandles = buildCandlesFromQuotes(timestamps, quotes);

    if (rawCandles.length === 0) return { ...base, error: true };

    const closes = rawCandles.map(c => c.close);
    const ma5 = calcMA(closes, 5);
    const ma25 = calcMA(closes, 25);
    const rsi = calcRSI(closes, 14);
    const bb = calcBollinger(closes, 20, 2);
    rawCandles.forEach((c, i) => {
      c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i];
      c.bbUpper = bb.upper[i]; c.bbMiddle = bb.middle[i]; c.bbLower = bb.lower[i];
    });

    const withSignals = detectSignals(rawCandles, rsiUpper, rsiLower);
    const last = withSignals[withSignals.length - 1];
    const { signal, time } = extractLatestSignal(withSignals, 2);

    const lastClose = last.close;
    const prevClose = meta.previousClose ?? lastClose;
    const priceChange = Math.round((lastClose - prevClose) * 10) / 10;
    const priceChangePercent = prevClose > 0 ? Math.round((priceChange / prevClose) * 1000) / 10 : 0;

    return {
      symbol,
      name,
      sector,
      currentPrice: meta.regularMarketPrice ?? lastClose,
      priceChange,
      priceChangePercent,
      rsi: last.rsi,
      ma5: last.ma5,
      ma25: last.ma25,
      latestSignal: signal,
      latestSignalTime: time,
      error: false,
    };
  } catch {
    return { ...base, error: true };
  }
}

// ---- tRPCルーター ----
export const stockDataRouter = router({
  /**
   * 実際の株価データを取得（Yahoo Finance経由）
   * symbol: "9984.T" など
   * range: "1d" | "5d" | "1mo"
   * interval: "1m" | "5m" | "15m" | "1d"
   */
  getStockChart: publicProcedure
    .input(
      z.object({
        symbol: z.string().default("9984.T"),
        // 1分足・直近5営業日を既定とする（指標は連続データで計算、表示は当日分のみ）
        range: z.enum(["1d", "5d", "1mo"]).default("5d"),
        interval: z.enum(["1m", "5m", "15m", "1d"]).default("1m"),
        rsiUpper: z.number().min(50).max(90).default(70),
        rsiLower: z.number().min(10).max(50).default(30),
      })
    )
    .query(async ({ input }) => {
      // キャッシュキー: 銘柄コード+期間+間隔で一意に特定
      const cacheKey = `${input.symbol}:${input.range}:${input.interval}`;
      let rawData: unknown;
      try {
        rawData = await getCachedOrFetch(cacheKey, () =>
          fetchStockChart({
            symbol: input.symbol,
            region: "JP",
            interval: input.interval,
            range: input.range,
          })
        );
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Yahoo Finance APIの取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const data = rawData as {
        chart?: {
          result?: Array<{
            meta: {
              symbol: string;
              longName?: string;
              regularMarketPrice: number;
              previousClose?: number;
              regularMarketDayHigh?: number;
              regularMarketDayLow?: number;
              regularMarketVolume?: number;
              currency: string;
              exchangeName: string;
            };
            timestamp: number[];
            indicators: {
              quote: Array<{
                open: (number | null)[];
                high: (number | null)[];
                low: (number | null)[];
                close: (number | null)[];
                volume: (number | null)[];
              }>;
            };
          }>;
          error?: { code: string; description: string };
        };
      };

      if (!data?.chart?.result?.[0]) {
        const errMsg = data?.chart?.error?.description ?? "データが見つかりません";
        throw new TRPCError({ code: "NOT_FOUND", message: errMsg });
      }

      const result = data.chart.result[0];
      const meta = result.meta;
      const timestamps = result.timestamp ?? [];
      const quotes = result.indicators.quote[0];

      // ローソク足データを構築（UTC→JST変換、null補完つき）
      const rawCandles = buildCandlesFromQuotes(timestamps, quotes);

      if (rawCandles.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "有効なローソク足データがありません" });
      }

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
        c.bbMiddle = bb.middle[i];
        c.bbLower = bb.lower[i];
      });

      // シグナル検出（指標は5営業日分の連続データで計算済み）
      const allWithSignals = detectSignals(rawCandles, input.rsiUpper, input.rsiLower);

      // 表示用は「最新営業日の足」だけに絞る（指標は前日からの連続計算済みなので正確）
      const latestDayKey = allWithSignals[allWithSignals.length - 1]?.dayKey;
      const candlesWithSignals = latestDayKey
        ? allWithSignals.filter(c => c.dayKey === latestDayKey)
        : allWithSignals;

      // シグナルのみ抽出（サマリー用・表示対象の最新営業日分のみ）
      const signals = candlesWithSignals
        .filter(c => c.signal)
        .map(c => ({
          time: c.time,
          timestamp: c.timestamp,
          type: c.signal!.type,
          reason: c.signal!.reason,
          price: c.close,
          rsi: c.rsi,
          ma5: c.ma5,
          ma25: c.ma25,
        }));

      // 前日比計算
      const lastClose = candlesWithSignals[candlesWithSignals.length - 1].close;
      const prevClose = meta.previousClose ?? lastClose;
      const priceChange = Math.round((lastClose - prevClose) * 10) / 10;
      const priceChangePercent = Math.round((priceChange / prevClose) * 1000) / 10;

      return {
        symbol: meta.symbol,
        name: meta.longName ?? meta.symbol,
        currency: meta.currency,
        exchange: meta.exchangeName,
        currentPrice: meta.regularMarketPrice,
        previousClose: prevClose,
        priceChange,
        priceChangePercent,
        dayHigh: meta.regularMarketDayHigh ?? 0,
        dayLow: meta.regularMarketDayLow ?? 0,
        volume: meta.regularMarketVolume ?? 0,
        candles: candlesWithSignals,
        signals,
        candleCount: candlesWithSignals.length,
      };
    }),

  /**
   * 銘柄検索（日本株）
   */
  searchSymbol: publicProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      // よく使われる日本株のリスト（検索補助用）
      const popularStocks = [
        { symbol: "9984.T", name: "ソフトバンクグループ" },
        { symbol: "7203.T", name: "トヨタ自動車" },
        { symbol: "6758.T", name: "ソニーグループ" },
        { symbol: "6861.T", name: "キーエンス" },
        { symbol: "9432.T", name: "NTT" },
        { symbol: "8306.T", name: "三菱UFJフィナンシャル" },
        { symbol: "6367.T", name: "ダイキン工業" },
        { symbol: "4063.T", name: "信越化学工業" },
        { symbol: "6954.T", name: "ファナック" },
        { symbol: "7974.T", name: "任天堂" },
        { symbol: "4519.T", name: "中外製薬" },
        { symbol: "9983.T", name: "ファーストリテイリング" },
        { symbol: "6098.T", name: "リクルートホールディングス" },
        { symbol: "7267.T", name: "本田技研工業" },
        { symbol: "8035.T", name: "東京エレクトロン" },
      ];

      const q = input.query.toLowerCase();
      return popularStocks.filter(
        s => s.name.includes(input.query) || s.symbol.toLowerCase().includes(q)
      );
    }),

  /**
   * 【複数銘柄一括シグナルスキャン】
   * 表示中の銘柄に依存せず、指定した複数銘柄の最新シグナル・現在値・RSIを一括で返す。
   * バックグラウンドで定期ポーリングし、売買サインの見逃しを防ぐために使う。
   * symbols 未指定時は監視全銘柄を対象にする。
   */
  getSignalScan: publicProcedure
    .input(
      z.object({
        symbols: z.array(z.string()).max(20).optional(),
        rsiUpper: z.number().min(50).max(90).default(70),
        rsiLower: z.number().min(10).max(50).default(30),
      })
    )
    .query(async ({ input }) => {
      const targets =
        input.symbols && input.symbols.length > 0
          ? input.symbols
          : TARGET_STOCKS.map((s) => s.symbol);

      // データAPIは「1秒あたりのレート制限」が厳しいため、
      // 並列実行せず1銘柄ずつ順次処理し、各呼び出しの間に少し待機する。
      // （キャッシュ済みの銘柄は待機をスキップして高速化）
      const results: ScannedSignal[] = [];
      const DELAY_MS = 350;
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      for (let i = 0; i < targets.length; i++) {
        const scanned = await scanSymbol(targets[i], input.rsiUpper, input.rsiLower);
        results.push(scanned);
        if (i < targets.length - 1) await sleep(DELAY_MS);
      }

      return {
        scannedAt: Date.now(),
        results,
      };
    }),
});
