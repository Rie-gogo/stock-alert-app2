/**
 * 個別銘柄リアルタイムレジーム方式 4パターンバックテスト
 * 
 * 各銘柄ごとに5分足確定タイミングでレジームを判定し、
 * mediumシグナルの許可/禁止を制御する。
 * 
 * レジーム5段階:
 * - STRONG_BULL: price > VWAP AND MA5 > MA25 AND MA25_slope > 0 AND 直近15分高値更新
 * - WEAK_BULL: price > VWAP AND MA5 > MA25
 * - RANGE: abs(price - VWAP)/VWAP < 0.3% AND abs(MA5 - MA25)/MA25 < 0.3%
 * - WEAK_BEAR: price < VWAP AND MA5 < MA25
 * - STRONG_BEAR: price < VWAP AND MA5 < MA25 AND MA25_slope < 0 AND 直近15分安値更新
 * 
 * 4パターン比較:
 * A. 現行（medium全ブロック）
 * B. SHORT medium解除（レジームなし）
 * C. 個別銘柄レジームのみ追加（mediumブロックは維持、レジームで一部解除）
 * D. 個別銘柄レジーム + SHORT medium解除
 * 
 * 既存フィルター維持:
 * - VWAP急落フィルター
 * - 固定0.5% BEストップ
 * - 後場大台割れSHORT BPR>=0.65ブロック
 * - 時間帯フィルター (11:00-11:30, 12:30-13:00)
 * - SL 0.5%, TP 1.5%
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { and, gte, lte, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";

const TARGET_SYMBOLS = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316"];
const SL_PERCENT = 0.005;
const TP_PERCENT = 0.015;
const BE_TRIGGER = 0.005;
const VWAP_DROP_5BAR = -0.008;
const VWAP_DROP_3BAR = -0.006;
const AFTERNOON_BPR_BLOCK = 0.65;
const BOARD_SCORE_THRESHOLD = 1;

// レジーム判定閾値
const REGIME_VWAP_RANGE = 0.003; // 0.3%
const REGIME_MA_RANGE = 0.003;   // 0.3%

type IndividualRegime = "STRONG_BULL" | "WEAK_BULL" | "RANGE" | "WEAK_BEAR" | "STRONG_BEAR";

interface Trade {
  date: string;
  symbol: string;
  side: "long" | "short";
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  exitReason: string;
  signalReason: string;
  confidence: string;
  beTriggered: boolean;
  session: "am" | "pm";
  regime?: IndividualRegime;
}

function calcRSI(closes: number[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period; avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function isRoundLevelBreakdown(reason: string): boolean {
  return reason.includes("大台割れ");
}

/**
 * 個別銘柄レジーム判定
 * 5分足（5本分のキャンドル）確定タイミングで判定
 * 
 * @param price 現在価格（close）
 * @param vwap VWAP値
 * @param ma5 MA5値
 * @param ma25 MA25値
 * @param ma25Slope MA25の傾き（直近5本の変化率）
 * @param recentHighs 直近15本（15分）の高値配列
 * @param recentLows 直近15本（15分）の安値配列
 * @param currentHigh 現在足の高値
 * @param currentLow 現在足の安値
 */
function classifyIndividualRegime(
  price: number,
  vwap: number,
  ma5: number,
  ma25: number,
  ma25Slope: number | null,
  recentHighs: number[],
  recentLows: number[],
  currentHigh: number,
  currentLow: number
): IndividualRegime {
  const aboveVwap = price > vwap;
  const belowVwap = price < vwap;
  const ma5AboveMa25 = ma5 > ma25;
  const ma5BelowMa25 = ma5 < ma25;
  
  // RANGE判定（最優先）
  const vwapDistance = Math.abs(price - vwap) / vwap;
  const maDistance = Math.abs(ma5 - ma25) / ma25;
  if (vwapDistance < REGIME_VWAP_RANGE && maDistance < REGIME_MA_RANGE) {
    return "RANGE";
  }
  
  // 直近15分の高値/安値更新判定
  const maxRecentHigh = recentHighs.length > 0 ? Math.max(...recentHighs) : currentHigh;
  const minRecentLow = recentLows.length > 0 ? Math.min(...recentLows) : currentLow;
  const highBreakout = currentHigh > maxRecentHigh;
  const lowBreakout = currentLow < minRecentLow;
  
  // STRONG_BULL
  if (aboveVwap && ma5AboveMa25 && ma25Slope !== null && ma25Slope > 0 && highBreakout) {
    return "STRONG_BULL";
  }
  
  // STRONG_BEAR
  if (belowVwap && ma5BelowMa25 && ma25Slope !== null && ma25Slope < 0 && lowBreakout) {
    return "STRONG_BEAR";
  }
  
  // WEAK_BULL
  if (aboveVwap && ma5AboveMa25) {
    return "WEAK_BULL";
  }
  
  // WEAK_BEAR
  if (belowVwap && ma5BelowMa25) {
    return "WEAK_BEAR";
  }
  
  // どれにも当てはまらない場合はRANGE
  return "RANGE";
}

/**
 * レジームに基づくmediumシグナル許可判定
 * 
 * SHORT medium:
 *   STRONG_BULL → 禁止
 *   WEAK_BULL → 禁止
 *   RANGE → 板スコア閾値+1（= threshold 2）
 *   WEAK_BEAR → 許可
 *   STRONG_BEAR → 許可
 * 
 * LONG medium:
 *   STRONG_BULL → 許可
 *   WEAK_BULL → 許可
 *   RANGE → 板スコア閾値+1（= threshold 2）
 *   WEAK_BEAR → 禁止
 *   STRONG_BEAR → 禁止
 */
function isMediumAllowedByRegime(
  side: "long" | "short",
  regime: IndividualRegime,
  boardScore: number
): boolean {
  if (side === "short") {
    switch (regime) {
      case "STRONG_BULL": return false;
      case "WEAK_BULL": return false;
      case "RANGE": return boardScore >= BOARD_SCORE_THRESHOLD + 1; // 閾値+1
      case "WEAK_BEAR": return true;
      case "STRONG_BEAR": return true;
    }
  } else { // long
    switch (regime) {
      case "STRONG_BULL": return true;
      case "WEAK_BULL": return true;
      case "RANGE": return boardScore >= BOARD_SCORE_THRESHOLD + 1; // 閾値+1
      case "WEAK_BEAR": return false;
      case "STRONG_BEAR": return false;
    }
  }
}

/**
 * 板読みスコアの簡易計算（バックテスト用）
 * 本番のboardReadingScore()の簡易版（bprHistory等が使えないため）
 */
function calcBoardScoreSimple(boardSnapshot: any, side: "long" | "short"): number {
  if (!boardSnapshot) return 1; // 板情報なし → 中立
  let score = 0;
  const bpr = boardSnapshot.buyPressureRatio ?? boardSnapshot.bpr ?? 0.5;
  
  // 要素A: アグレッシブ注文検出 (±2)
  if ((boardSnapshot.marketOrderRatio ?? 0) >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }
  
  // 要素B: 厚い板のアノマリー (±1)
  if (side === "long") {
    if (boardSnapshot.largeSellWall) score += 1;
    if (boardSnapshot.largeBuyWall) score -= 1;
  } else {
    if (boardSnapshot.largeBuyWall) score += 1;
    if (boardSnapshot.largeSellWall) score -= 1;
  }
  
  // 要素E: 板圧力の強さ (±1)
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  
  return score;
}

async function main() {
  const db = await getDb();

  // Get all candle data for target symbols
  const allCandles = await db.select().from(rtCandles)
    .where(and(
      inArray(rtCandles.symbol, TARGET_SYMBOLS),
      gte(rtCandles.tradeDate, "2026-06-17"),
      lte(rtCandles.tradeDate, "2026-06-30")
    ));

  const grouped = new Map<string, typeof allCandles>();
  for (const c of allCandles) {
    const key = `${c.tradeDate}_${c.symbol}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }

  const dates = [...new Set(allCandles.map(c => c.tradeDate))].sort();
  console.log(`検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象銘柄: ${TARGET_SYMBOLS.join(", ")} (${TARGET_SYMBOLS.length}銘柄)`);
  console.log(`適用フィルター: VWAP急落フィルター, BEストップ(0.5%), 後場大台割れBPR>=0.65ブロック, 時間帯フィルター\n`);

  // Classify market days (for reporting)
  const dayClassification = new Map<string, "up" | "down" | "range">();
  for (const date of dates) {
    let upCount = 0, downCount = 0;
    for (const symbol of TARGET_SYMBOLS) {
      const candles = grouped.get(`${date}_${symbol}`);
      if (!candles || candles.length < 2) continue;
      candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));
      const openPrice = Number(candles[0].open);
      const closePrice = Number(candles[candles.length - 1].close);
      const change = (closePrice - openPrice) / openPrice;
      if (change > 0.003) upCount++;
      else if (change < -0.003) downCount++;
    }
    if (upCount >= 5) dayClassification.set(date, "up");
    else if (downCount >= 5) dayClassification.set(date, "down");
    else dayClassification.set(date, "range");
  }

  console.log("日別市場分類:");
  for (const [date, cls] of [...dayClassification.entries()].sort()) {
    console.log(`  ${date}: ${cls === "up" ? "上昇日" : cls === "down" ? "下落日" : "レンジ日"}`);
  }
  console.log();

  // Pre-compute signals, VWAP, MA for all date/symbol combinations
  const signalCache = new Map<string, any[]>();
  const candleCache = new Map<string, any[]>();
  const vwapCache = new Map<string, number[]>();
  const ma5Cache = new Map<string, (number | null)[]>();
  const ma25Cache = new Map<string, (number | null)[]>();

  for (const date of dates) {
    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const candles = grouped.get(key);
      if (!candles || candles.length < 30) continue;
      candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));

      const opens = candles.map((c: any) => Number(c.open));
      const highs = candles.map((c: any) => Number(c.high));
      const lows = candles.map((c: any) => Number(c.low));
      const closes = candles.map((c: any) => Number(c.close));
      const volumes = candles.map((c: any) => Number(c.volume));

      const vwapCandles = candles.map((c: any) => ({
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: Number(c.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);
      const bbResult = calcBollinger(closes, 20, 2);
      const rsiArr = calcRSI(closes, 14);
      const ma5: (number | null)[] = closes.map((_, i) => i < 4 ? null : (closes[i] + closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4]) / 5);
      const ma25: (number | null)[] = closes.map((_, i) => { if (i < 24) return null; let s = 0; for (let j = 0; j < 25; j++) s += closes[i - j]; return s / 25; });

      const enrichedCandles = candles.map((c: any, i: number) => ({
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i],
        vwap: vwapArr[i] ?? closes[i],
        bbUpper: bbResult.upper[i] ?? (closes[i] * 1.02),
        bbLower: bbResult.lower[i] ?? (closes[i] * 0.98),
        ma5: ma5[i] ?? closes[i],
        ma25: ma25[i] ?? closes[i],
        rsi: rsiArr[i] ?? 50,
        atr: null as any,
        time: candles[i].candleTime,
      }));

      const signals = detectSignals(enrichedCandles as any);
      signalCache.set(key, signals);
      vwapCache.set(key, vwapArr.map(v => v ?? 0));
      ma5Cache.set(key, ma5);
      ma25Cache.set(key, ma25);
      candleCache.set(key, candles.map((c: any, i: number) => ({
        ...c,
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i], vwap: vwapArr[i] ?? closes[i],
        boardSnapshot: c.boardSnapshot ? (typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot) : null,
        bpr: c.boardSnapshot ? (typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot)?.buyPressureRatio ?? 0.5 : 0.5,
        time: c.candleTime,
      })));
    }
  }

  // ====================================================================
  // 4パターン定義
  // ====================================================================
  type PatternKey = "A" | "B" | "C" | "D";
  const patternNames: Record<PatternKey, string> = {
    A: "A: 現行（medium全ブロック）",
    B: "B: SHORT medium解除（レジームなし）",
    C: "C: 個別銘柄レジームのみ追加",
    D: "D: 個別銘柄レジーム + SHORT medium解除",
  };

  const allResults: Record<PatternKey, Trade[]> = { A: [], B: [], C: [], D: [] };
  const regimeLog: { date: string; time: string; symbol: string; regime: IndividualRegime; action: string; pattern: string }[] = [];

  // ====================================================================
  // シミュレーション実行
  // ====================================================================
  for (const date of dates) {
    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const signals = signalCache.get(key);
      const candles = candleCache.get(key);
      const vwapArr = vwapCache.get(key);
      const ma5Arr = ma5Cache.get(key);
      const ma25Arr = ma25Cache.get(key);
      if (!signals || !candles || !vwapArr || !ma5Arr || !ma25Arr || candles.length < 30) continue;

      const closes = candles.map((c: any) => c.close);
      const highs = candles.map((c: any) => c.high);
      const lows = candles.map((c: any) => c.low);

      // レジームキャッシュ（5分足ごとに更新）
      let currentRegime: IndividualRegime = "RANGE";
      let lastRegimeUpdateIdx = -1;

      for (const patternKey of ["A", "B", "C", "D"] as PatternKey[]) {
        let inLongPosition = false;
        let inShortPosition = false;
        let longEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false, regime: "RANGE" as IndividualRegime };
        let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false, regime: "RANGE" as IndividualRegime };

        for (let i = 0; i < signals.length; i++) {
          const sig = signals[i].signal;
          const time = candles[i]?.time as string;
          if (!time) continue;

          const hour = parseInt(time.split(":")[0]);
          const min = parseInt(time.split(":")[1]);
          const timeMin = hour * 60 + min;
          const session: "am" | "pm" = timeMin < 11 * 60 + 30 ? "am" : "pm";

          // レジーム更新（5分足ごと = 5本ごと）
          if (i % 5 === 0 && i >= 25 && (patternKey === "C" || patternKey === "D")) {
            const price = closes[i];
            const vwap = vwapArr[i] || price;
            const m5 = ma5Arr[i] ?? price;
            const m25 = ma25Arr[i] ?? price;
            
            // MA25の傾き（直近5本の変化率）
            let ma25Slope: number | null = null;
            if (i >= 5 && ma25Arr[i] !== null && ma25Arr[i - 5] !== null) {
              ma25Slope = (ma25Arr[i]! - ma25Arr[i - 5]!) / ma25Arr[i - 5]!;
            }
            
            // 直近15本（15分）の高値/安値（現在足を除く）
            const lookback = Math.min(15, i);
            const recentHighs = highs.slice(Math.max(0, i - lookback), i);
            const recentLows = lows.slice(Math.max(0, i - lookback), i);
            
            currentRegime = classifyIndividualRegime(
              price, vwap, m5, m25, ma25Slope,
              recentHighs, recentLows,
              highs[i], lows[i]
            );
            lastRegimeUpdateIdx = i;
          }

          // Process LONG position
          if (inLongPosition) {
            const profitHigh = (highs[i] - longEntry.price) / longEntry.price;
            const profitLow = (lows[i] - longEntry.price) / longEntry.price;
            if (!longEntry.beActive && profitHigh >= BE_TRIGGER) longEntry.beActive = true;
            if (profitHigh >= TP_PERCENT) {
              const exitPrice = longEntry.price * (1 + TP_PERCENT);
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              allResults[patternKey].push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                entryPrice: longEntry.price, exitTime: time, exitPrice,
                pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: "TP",
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session,
                regime: longEntry.regime });
              inLongPosition = false;
            } else {
              const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
              if (profitLow <= slLevel) {
                const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
                const lots = Math.floor(2000000 / longEntry.price) * 100;
                allResults[patternKey].push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                  entryPrice: longEntry.price, exitTime: time, exitPrice,
                  pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: longEntry.beActive ? "BE" : "SL",
                  signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session,
                  regime: longEntry.regime });
                inLongPosition = false;
              } else if (timeMin >= 15 * 60 + 20) {
                const lots = Math.floor(2000000 / longEntry.price) * 100;
                allResults[patternKey].push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                  entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
                  pnl: (closes[i] - longEntry.price) * (lots / 100), exitReason: "TIME",
                  signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session,
                  regime: longEntry.regime });
                inLongPosition = false;
              }
            }
          }

          // Process SHORT position
          if (inShortPosition) {
            const profitHigh = (shortEntry.price - lows[i]) / shortEntry.price;
            const lossHigh = (highs[i] - shortEntry.price) / shortEntry.price;
            if (!shortEntry.beActive && profitHigh >= BE_TRIGGER) shortEntry.beActive = true;
            if (profitHigh >= TP_PERCENT) {
              const exitPrice = shortEntry.price * (1 - TP_PERCENT);
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              allResults[patternKey].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                entryPrice: shortEntry.price, exitTime: time, exitPrice,
                pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: "TP",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session,
                regime: shortEntry.regime });
              inShortPosition = false;
            } else {
              const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
              if (lossHigh >= slLevel) {
                const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
                const lots = Math.floor(2000000 / shortEntry.price) * 100;
                allResults[patternKey].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                  entryPrice: shortEntry.price, exitTime: time, exitPrice,
                  pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: shortEntry.beActive ? "BE" : "SL",
                  signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session,
                  regime: shortEntry.regime });
                inShortPosition = false;
              } else if (timeMin >= 15 * 60 + 20) {
                const lots = Math.floor(2000000 / shortEntry.price) * 100;
                allResults[patternKey].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                  entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                  pnl: (shortEntry.price - closes[i]) * (lots / 100), exitReason: "TIME",
                  signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session,
                  regime: shortEntry.regime });
                inShortPosition = false;
              }
            }
          }

          // New entry check
          if (!sig) continue;
          if (timeMin < 9 * 60 + 5 || timeMin >= 14 * 60 + 30) continue;
          if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

          // VWAP急落フィルター（SHORT VWAPクロス下抜けのみ）
          if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
            const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
            const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
            if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
          }

          // 後場大台割れSHORT BPR>=0.65ブロック
          if (sig.type === "sell" && isRoundLevelBreakdown(sig.reason) && timeMin >= 13 * 60) {
            const bpr = candles[i].bpr ?? 0.5;
            if (bpr >= AFTERNOON_BPR_BLOCK) continue;
          }

          // ====================================================================
          // パターン別フィルタリング
          // ====================================================================
          const confidence = sig.confidence || "strong";
          const boardSnapshot = candles[i].boardSnapshot;
          const boardScore = calcBoardScoreSimple(boardSnapshot, sig.type === "buy" ? "long" : "short");

          if (patternKey === "A") {
            // A: 現行 = strongのみ許可
            if (confidence !== "strong") continue;
          } else if (patternKey === "B") {
            // B: SHORT medium解除（レジームなし）
            if (confidence === "weak") continue;
            if (confidence === "medium" && sig.type === "buy") continue; // BUY mediumはブロック
            // SHORT medium + strong は通す
          } else if (patternKey === "C") {
            // C: 個別銘柄レジームのみ追加（mediumは基本ブロック、レジームで一部解除）
            if (confidence === "weak") continue;
            if (confidence === "medium") {
              const side = sig.type === "buy" ? "long" : "short";
              if (!isMediumAllowedByRegime(side, currentRegime, boardScore)) {
                continue;
              }
              // レジームが許可した場合のみ通す
            }
          } else if (patternKey === "D") {
            // D: 個別銘柄レジーム + SHORT medium解除
            if (confidence === "weak") continue;
            if (confidence === "medium") {
              if (sig.type === "sell") {
                // SHORT medium: レジームでフィルタリング
                const allowed = isMediumAllowedByRegime("short", currentRegime, boardScore);
                if (!allowed) continue;
              } else {
                // BUY medium: レジームでフィルタリング
                const allowed = isMediumAllowedByRegime("long", currentRegime, boardScore);
                if (!allowed) continue;
              }
            }
          }

          // Entry
          if (sig.type === "buy" && !inLongPosition) {
            inLongPosition = true;
            longEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false, regime: currentRegime };
          } else if (sig.type === "sell" && !inShortPosition) {
            inShortPosition = true;
            shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false, regime: currentRegime };
          }
        }

        // Close remaining positions at end of day
        if (inLongPosition) {
          const lastIdx = candles.length - 1;
          const lots = Math.floor(2000000 / longEntry.price) * 100;
          allResults[patternKey].push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
            entryPrice: longEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
            pnl: (closes[lastIdx] - longEntry.price) * (lots / 100), exitReason: "EOD",
            signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
            session: "pm", regime: longEntry.regime });
        }
        if (inShortPosition) {
          const lastIdx = candles.length - 1;
          const lots = Math.floor(2000000 / shortEntry.price) * 100;
          allResults[patternKey].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
            entryPrice: shortEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
            pnl: (shortEntry.price - closes[lastIdx]) * (lots / 100), exitReason: "TIME",
            signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
            session: "pm", regime: shortEntry.regime });
        }
      }
    }
  }

  // ====================================================================
  // 結果出力
  // ====================================================================
  console.log("\n" + "=".repeat(100));
  console.log("=== 個別銘柄リアルタイムレジーム方式 4パターン比較結果 ===");
  console.log("=".repeat(100));

  // Summary table
  console.log("\n--- 総合比較 ---");
  console.log("パターン | 取引数 | 勝率 | 総損益 | PF | 期待値 | 最大DD | 平均利益 | 平均損失");
  console.log("-".repeat(110));

  const summaryData: { key: PatternKey; pnl: number; pf: number; maxDD: number; count: number; winRate: number }[] = [];

  for (const patternKey of ["A", "B", "C", "D"] as PatternKey[]) {
    const trades = allResults[patternKey];
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const pf = totalLoss !== 0 ? totalWin / Math.abs(totalLoss) : Infinity;
    const avgWin = wins.length > 0 ? totalWin / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;
    const winRate = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
    const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;

    // Max drawdown
    let maxDD = 0, peak = 0, cumPnl = 0;
    const sortedTrades = [...trades].sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`));
    for (const t of sortedTrades) {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    summaryData.push({ key: patternKey, pnl: totalPnl, pf, maxDD, count: trades.length, winRate });
    console.log(`${patternNames[patternKey]} | ${trades.length}件 | ${winRate.toFixed(0)}% | ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円 | ${pf.toFixed(2)} | ${expectancy.toFixed(0)}円/回 | -${maxDD.toFixed(0)}円 | +${avgWin.toFixed(0)}円 | ${avgLoss.toFixed(0)}円`);
  }

  // Detailed breakdown for each pattern
  for (const patternKey of ["A", "B", "C", "D"] as PatternKey[]) {
    const trades = allResults[patternKey];
    console.log(`\n${"=".repeat(80)}`);
    console.log(`=== ${patternNames[patternKey]} 詳細 ===`);
    console.log(`${"=".repeat(80)}`);

    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);

    // LONG vs SHORT
    const longs = trades.filter(t => t.side === "long");
    const shorts = trades.filter(t => t.side === "short");
    const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
    const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
    const longWins = longs.filter(t => t.pnl > 0);
    const shortWins = shorts.filter(t => t.pnl > 0);
    const longLoss = longs.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const shortLoss = shorts.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const longWinPnl = longWins.reduce((s, t) => s + t.pnl, 0);
    const shortWinPnl = shortWins.reduce((s, t) => s + t.pnl, 0);

    console.log(`\n--- LONG/SHORT別 ---`);
    console.log(`  LONG:  ${longs.length}件 | 勝率${longs.length > 0 ? (longWins.length / longs.length * 100).toFixed(0) : 0}% | ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(0)}円 | PF:${longLoss !== 0 ? (longWinPnl / Math.abs(longLoss)).toFixed(2) : "∞"}`);
    console.log(`  SHORT: ${shorts.length}件 | 勝率${shorts.length > 0 ? (shortWins.length / shorts.length * 100).toFixed(0) : 0}% | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(0)}円 | PF:${shortLoss !== 0 ? (shortWinPnl / Math.abs(shortLoss)).toFixed(2) : "∞"}`);

    // 前場/後場別
    const amTrades = trades.filter(t => t.session === "am");
    const pmTrades = trades.filter(t => t.session === "pm");
    const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
    const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);
    const amWins = amTrades.filter(t => t.pnl > 0);
    const pmWins = pmTrades.filter(t => t.pnl > 0);
    const amLossPnl = amTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const pmLossPnl = pmTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
    const amWinPnl = amWins.reduce((s, t) => s + t.pnl, 0);
    const pmWinPnl = pmWins.reduce((s, t) => s + t.pnl, 0);

    console.log(`\n--- 前場/後場別 ---`);
    console.log(`  前場: ${amTrades.length}件 | 勝率${amTrades.length > 0 ? (amWins.length / amTrades.length * 100).toFixed(0) : 0}% | ${amPnl >= 0 ? "+" : ""}${amPnl.toFixed(0)}円 | PF:${amLossPnl !== 0 ? (amWinPnl / Math.abs(amLossPnl)).toFixed(2) : "∞"}`);
    console.log(`  後場: ${pmTrades.length}件 | 勝率${pmTrades.length > 0 ? (pmWins.length / pmTrades.length * 100).toFixed(0) : 0}% | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toFixed(0)}円 | PF:${pmLossPnl !== 0 ? (pmWinPnl / Math.abs(pmLossPnl)).toFixed(2) : "∞"}`);

    // 上昇日/下落日/レンジ日別
    console.log(`\n--- 市場環境別 ---`);
    for (const cls of ["up", "down", "range"] as const) {
      const label = cls === "up" ? "上昇日" : cls === "down" ? "下落日" : "レンジ日";
      const clsDates = [...dayClassification.entries()].filter(([_, c]) => c === cls).map(([d]) => d);
      const clsTrades = trades.filter(t => clsDates.includes(t.date));
      const clsPnl = clsTrades.reduce((s, t) => s + t.pnl, 0);
      const clsWins = clsTrades.filter(t => t.pnl > 0).length;
      const clsLossPnl = clsTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
      const clsWinPnl = clsTrades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      console.log(`  ${label}(${clsDates.length}日): ${clsTrades.length}件 | 勝率${clsTrades.length > 0 ? (clsWins / clsTrades.length * 100).toFixed(0) : 0}% | ${clsPnl >= 0 ? "+" : ""}${clsPnl.toFixed(0)}円 | PF:${clsLossPnl !== 0 ? (clsWinPnl / Math.abs(clsLossPnl)).toFixed(2) : "∞"}`);
    }

    // 日別損益
    console.log(`\n--- 日別損益 ---`);
    const byDate = new Map<string, number>();
    for (const t of trades) {
      byDate.set(t.date, (byDate.get(t.date) || 0) + t.pnl);
    }
    for (const [date, pnl] of [...byDate.entries()].sort()) {
      const cls = dayClassification.get(date) || "?";
      const label = cls === "up" ? "↑" : cls === "down" ? "↓" : "→";
      console.log(`  ${date} ${label}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}円`);
    }

    // 銘柄別損益
    console.log(`\n--- 銘柄別損益 ---`);
    const bySymbol = new Map<string, { count: number; pnl: number; wins: number }>();
    for (const t of trades) {
      const entry = bySymbol.get(t.symbol) || { count: 0, pnl: 0, wins: 0 };
      entry.count++;
      entry.pnl += t.pnl;
      if (t.pnl > 0) entry.wins++;
      bySymbol.set(t.symbol, entry);
    }
    for (const [sym, data] of [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
      console.log(`  ${sym}: ${data.count}件 | 勝率${(data.wins / data.count * 100).toFixed(0)}% | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(0)}円`);
    }

    // レジーム別損益（C, Dのみ）
    if (patternKey === "C" || patternKey === "D") {
      console.log(`\n--- レジーム別損益 ---`);
      const byRegime = new Map<string, { count: number; pnl: number; wins: number }>();
      for (const t of trades) {
        const r = t.regime || "UNKNOWN";
        const entry = byRegime.get(r) || { count: 0, pnl: 0, wins: 0 };
        entry.count++;
        entry.pnl += t.pnl;
        if (t.pnl > 0) entry.wins++;
        byRegime.set(r, entry);
      }
      for (const [regime, data] of [...byRegime.entries()].sort()) {
        console.log(`  ${regime}: ${data.count}件 | 勝率${(data.wins / data.count * 100).toFixed(0)}% | ${data.pnl >= 0 ? "+" : ""}${data.pnl.toFixed(0)}円`);
      }
    }
  }

  // ====================================================================
  // 6/30型分析（前場下落→後場反転）
  // ====================================================================
  console.log(`\n${"=".repeat(80)}`);
  console.log("=== 6/30型分析（前場下落→後場反転相場での耐性） ===");
  console.log(`${"=".repeat(80)}`);
  
  // 6/30の前場と後場を分けて分析
  const june30 = "2026-06-30";
  for (const patternKey of ["A", "B", "C", "D"] as PatternKey[]) {
    const trades630 = allResults[patternKey].filter(t => t.date === june30);
    const am = trades630.filter(t => t.session === "am");
    const pm = trades630.filter(t => t.session === "pm");
    const amPnl = am.reduce((s, t) => s + t.pnl, 0);
    const pmPnl = pm.reduce((s, t) => s + t.pnl, 0);
    const totalPnl = trades630.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${patternNames[patternKey]}: 前場${am.length}件(${amPnl >= 0 ? "+" : ""}${amPnl.toFixed(0)}円) + 後場${pm.length}件(${pmPnl >= 0 ? "+" : ""}${pmPnl.toFixed(0)}円) = 合計${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);
  }

  // ====================================================================
  // 最終判定
  // ====================================================================
  console.log(`\n${"=".repeat(100)}`);
  console.log("=== 最終判定 ===");
  console.log(`${"=".repeat(100)}`);
  console.log("\n判定基準: PF >= 1.15 かつ 最大DD <= 200,000円\n");

  for (const s of summaryData) {
    const pfOk = s.pf >= 1.15;
    const ddOk = s.maxDD <= 200000;
    const verdict = pfOk && ddOk ? "✅ 採用可" : pfOk ? "⚠️ DD注意" : ddOk ? "❌ PF不足" : "❌ 不採用";
    console.log(`${patternNames[s.key]}: PF=${s.pf.toFixed(2)} | DD=-${s.maxDD.toFixed(0)}円 | 損益=${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}円 | 勝率=${s.winRate.toFixed(0)}% → ${verdict}`);
  }

  // ベースラインとの比較
  console.log("\n--- ベースライン比較 ---");
  console.log("ベースライン（前回10銘柄テスト）: 257件 | PF 1.10 | 総損益 +119,470円 | 最大DD -179,777円");
  for (const s of summaryData) {
    const pnlDiff = s.pnl - 119470;
    const pfDiff = s.pf - 1.10;
    const ddDiff = s.maxDD - 179777;
    console.log(`  ${patternNames[s.key]}: 損益差${pnlDiff >= 0 ? "+" : ""}${pnlDiff.toFixed(0)}円 | PF差${pfDiff >= 0 ? "+" : ""}${pfDiff.toFixed(2)} | DD差${ddDiff >= 0 ? "+" : ""}${ddDiff.toFixed(0)}円`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
