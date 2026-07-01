/**
 * パターンB（SHORT medium解除）+ 上昇日フィルター 3方式比較バックテスト
 * 
 * ベース: パターンB（SHORT medium全解除、LONG mediumはブロック維持）
 * 
 * 5パターン比較:
 * B0: ベースライン（SHORT medium全解除、フィルターなし）
 * B1: 動的更新方式 — 30分ごとに全銘柄の方向性を再判定し、bullishならSHORT mediumブロック
 * B2: 前場のみブロック方式 — 寄り付き30分で判定、前場のみ適用。後場は無条件で許可
 * B3: 段階的緩和方式 — 寄り付き30分で判定、前場はブロック、13:00以降は再判定して解除可能
 * B4: 閾値引き上げ方式 — bullish時にSHORT mediumを完全禁止ではなく板スコア閾値+2で許可
 * 
 * 反転耐性の検証:
 * - 6/30型（前場上昇→後場反転下落）での各方式の挙動を詳細分析
 * - 上昇日/下落日それぞれでの損益比較
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
  blocked?: boolean;
  blockReason?: string;
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

function calcBoardScoreSimple(boardSnapshot: any, side: "long" | "short"): number {
  if (!boardSnapshot) return 1;
  let score = 0;
  const bpr = boardSnapshot.buyPressureRatio ?? boardSnapshot.bpr ?? 0.5;
  if ((boardSnapshot.marketOrderRatio ?? 0) >= 0.08) {
    if (side === "long" && bpr > 1.0) score += 2;
    else if (side === "long" && bpr < 1.0) score -= 2;
    else if (side === "short" && bpr < 1.0) score += 2;
    else if (side === "short" && bpr > 1.0) score -= 2;
  }
  if (side === "long") {
    if (boardSnapshot.largeSellWall) score += 1;
    if (boardSnapshot.largeBuyWall) score -= 1;
  } else {
    if (boardSnapshot.largeBuyWall) score += 1;
    if (boardSnapshot.largeSellWall) score -= 1;
  }
  if (side === "long" && bpr >= 1.4) score += 1;
  else if (side === "long" && bpr <= 0.65) score -= 1;
  else if (side === "short" && bpr <= 0.65) score += 1;
  else if (side === "short" && bpr >= 1.4) score -= 1;
  return score;
}

/**
 * 市場方向性判定（全銘柄の始値比変化率ベース）
 * 
 * @param allSymbolCandles 全銘柄のキャンドルデータ（date_symbol → candles[]）
 * @param date 対象日
 * @param targetTimeMin 判定時点の分（9:00=540）
 * @returns "bullish" | "bearish" | "neutral"
 */
function getMarketDirection(
  candleCache: Map<string, any[]>,
  date: string,
  targetTimeMin: number
): "bullish" | "bearish" | "neutral" {
  let upCount = 0;
  let downCount = 0;
  let totalSymbols = 0;
  const changes: number[] = [];

  for (const symbol of TARGET_SYMBOLS) {
    const key = `${date}_${symbol}`;
    const candles = candleCache.get(key);
    if (!candles || candles.length === 0) continue;

    // Find candle at or before targetTimeMin
    let currentCandle = null;
    const openPrice = candles[0].close; // 始値
    for (let i = candles.length - 1; i >= 0; i--) {
      const t = candles[i].time as string;
      const h = parseInt(t.split(":")[0]);
      const m = parseInt(t.split(":")[1]);
      const tMin = h * 60 + m;
      if (tMin <= targetTimeMin) {
        currentCandle = candles[i];
        break;
      }
    }
    if (!currentCandle) continue;
    totalSymbols++;
    const changeRate = (currentCandle.close - openPrice) / openPrice;
    changes.push(changeRate);
    if (changeRate >= 0.005) upCount++;
    else if (changeRate <= -0.005) downCount++;
  }

  if (totalSymbols === 0) return "neutral";

  changes.sort((a, b) => a - b);
  const median = changes[Math.floor(changes.length / 2)];

  // bullish判定: 上昇銘柄が下落銘柄の2倍以上 or 中央値+0.5%以上 or 60%以上が上昇
  if (downCount > 0 && upCount / downCount >= 2.0) return "bullish";
  if (upCount > 0 && downCount / upCount >= 2.0) return "bearish";
  if (median >= 0.005) return "bullish";
  if (median <= -0.005) return "bearish";
  if (totalSymbols > 0 && upCount / totalSymbols >= 0.6) return "bullish";
  if (totalSymbols > 0 && downCount / totalSymbols >= 0.6) return "bearish";

  return "neutral";
}

async function main() {
  const db = await getDb();

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
  console.log(`対象銘柄: ${TARGET_SYMBOLS.join(", ")} (${TARGET_SYMBOLS.length}銘柄)\n`);

  // Pre-compute signals and candle data
  const signalCache = new Map<string, any[]>();
  const candleCache = new Map<string, any[]>();

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

  // Classify market days (for reporting)
  const dayClassification = new Map<string, "up" | "down" | "range">();
  for (const date of dates) {
    let upCount = 0, downCount = 0;
    for (const symbol of TARGET_SYMBOLS) {
      const candles = candleCache.get(`${date}_${symbol}`);
      if (!candles || candles.length < 2) continue;
      const openPrice = candles[0].close;
      const closePrice = candles[candles.length - 1].close;
      const change = (closePrice - openPrice) / openPrice;
      if (change > 0.003) upCount++;
      else if (change < -0.003) downCount++;
    }
    if (upCount >= 5) dayClassification.set(date, "up");
    else if (downCount >= 5) dayClassification.set(date, "down");
    else dayClassification.set(date, "range");
  }

  console.log("日別市場分類（終日ベース）:");
  for (const [date, cls] of [...dayClassification.entries()].sort()) {
    console.log(`  ${date}: ${cls === "up" ? "上昇日" : cls === "down" ? "下落日" : "レンジ日"}`);
  }
  console.log();

  // ====================================================================
  // Pre-compute market direction at key time points for each date
  // ====================================================================
  const directionCache = new Map<string, "bullish" | "bearish" | "neutral">();
  for (const date of dates) {
    // 9:30判定（寄り付き30分後）
    directionCache.set(`${date}_930`, getMarketDirection(candleCache, date, 9 * 60 + 30));
    // 30分ごとの動的判定
    for (let tMin = 9 * 60 + 30; tMin <= 15 * 60; tMin += 30) {
      directionCache.set(`${date}_${tMin}`, getMarketDirection(candleCache, date, tMin));
    }
    // 13:00判定（後場開始）
    directionCache.set(`${date}_1300`, getMarketDirection(candleCache, date, 13 * 60));
  }

  // Log direction changes
  console.log("--- 方向性判定ログ ---");
  for (const date of dates) {
    const d930 = directionCache.get(`${date}_930`) || "neutral";
    const d1100 = directionCache.get(`${date}_${11*60}`) || "neutral";
    const d1300 = directionCache.get(`${date}_1300`) || "neutral";
    const d1400 = directionCache.get(`${date}_${14*60}`) || "neutral";
    const dayType = dayClassification.get(date) || "range";
    console.log(`  ${date} [${dayType === "up" ? "↑" : dayType === "down" ? "↓" : "→"}]: 9:30=${d930} → 11:00=${d1100} → 13:00=${d1300} → 14:00=${d1400}`);
  }
  console.log();

  // ====================================================================
  // 5パターン定義
  // ====================================================================
  type PatternKey = "B0" | "B1" | "B2" | "B3" | "B4";
  const patternNames: Record<PatternKey, string> = {
    B0: "B0: ベースライン（SHORT medium全解除）",
    B1: "B1: 動的更新方式（30分ごと再判定）",
    B2: "B2: 前場のみブロック（後場は無条件許可）",
    B3: "B3: 段階的緩和（前場ブロック、13:00再判定）",
    B4: "B4: 閾値引き上げ（bullish時は板スコア+2）",
  };

  const allResults: Record<PatternKey, Trade[]> = { B0: [], B1: [], B2: [], B3: [], B4: [] };
  const blockedTrades: Record<PatternKey, { date: string; time: string; symbol: string; reason: string; wouldHavePnl?: number }[]> = 
    { B0: [], B1: [], B2: [], B3: [], B4: [] };

  // ====================================================================
  // シミュレーション実行
  // ====================================================================
  for (const date of dates) {
    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const signals = signalCache.get(key);
      const candles = candleCache.get(key);
      if (!signals || !candles || candles.length < 30) continue;

      const closes = candles.map((c: any) => c.close);
      const highs = candles.map((c: any) => c.high);
      const lows = candles.map((c: any) => c.low);

      for (const patternKey of ["B0", "B1", "B2", "B3", "B4"] as PatternKey[]) {
        let inLongPosition = false;
        let inShortPosition = false;
        let longEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };
        let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };

        for (let i = 0; i < signals.length; i++) {
          const sig = signals[i].signal;
          const time = candles[i]?.time as string;
          if (!time) continue;

          const hour = parseInt(time.split(":")[0]);
          const min = parseInt(time.split(":")[1]);
          const timeMin = hour * 60 + min;
          const session: "am" | "pm" = timeMin < 11 * 60 + 30 ? "am" : "pm";

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
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session });
              inLongPosition = false;
            } else {
              const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
              if (profitLow <= slLevel) {
                const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
                const lots = Math.floor(2000000 / longEntry.price) * 100;
                allResults[patternKey].push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                  entryPrice: longEntry.price, exitTime: time, exitPrice,
                  pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: longEntry.beActive ? "BE" : "SL",
                  signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session });
                inLongPosition = false;
              } else if (timeMin >= 15 * 60 + 20) {
                const lots = Math.floor(2000000 / longEntry.price) * 100;
                allResults[patternKey].push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
                  entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
                  pnl: (closes[i] - longEntry.price) * (lots / 100), exitReason: "TIME",
                  signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session });
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
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
              inShortPosition = false;
            } else {
              const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
              if (lossHigh >= slLevel) {
                const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
                const lots = Math.floor(2000000 / shortEntry.price) * 100;
                allResults[patternKey].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                  entryPrice: shortEntry.price, exitTime: time, exitPrice,
                  pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: shortEntry.beActive ? "BE" : "SL",
                  signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
                inShortPosition = false;
              } else if (timeMin >= 15 * 60 + 20) {
                const lots = Math.floor(2000000 / shortEntry.price) * 100;
                allResults[patternKey].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
                  entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                  pnl: (shortEntry.price - closes[i]) * (lots / 100), exitReason: "TIME",
                  signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session });
                inShortPosition = false;
              }
            }
          }

          // New entry check
          if (!sig) continue;
          if (timeMin < 9 * 60 + 5 || timeMin >= 14 * 60 + 30) continue;
          if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

          // VWAP急落フィルター
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

          const confidence = sig.confidence || "strong";
          const boardSnapshot = candles[i].boardSnapshot;
          const boardScore = calcBoardScoreSimple(boardSnapshot, sig.type === "buy" ? "long" : "short");

          // 全パターン共通: weakはブロック、BUY mediumはブロック
          if (confidence === "weak") continue;
          if (confidence === "medium" && sig.type === "buy") continue;

          // ====================================================================
          // SHORT medium に対するパターン別フィルタリング
          // ====================================================================
          if (confidence === "medium" && sig.type === "sell") {
            let blocked = false;
            let blockReason = "";

            if (patternKey === "B0") {
              // B0: フィルターなし — 全て通す
              blocked = false;
            } else if (patternKey === "B1") {
              // B1: 動的更新方式 — 30分ごとに再判定
              // 現在時刻に最も近い30分区切りの判定を使用
              const roundedTimeMin = Math.floor(timeMin / 30) * 30;
              const dirKey = `${date}_${roundedTimeMin}`;
              const direction = directionCache.get(dirKey) || "neutral";
              if (direction === "bullish") {
                blocked = true;
                blockReason = `B1:動的bullish(${roundedTimeMin}分時点)`;
              }
            } else if (patternKey === "B2") {
              // B2: 前場のみブロック — 9:30判定で前場のみ適用、後場は無条件許可
              if (timeMin < 11 * 60 + 30) { // 前場
                const direction = directionCache.get(`${date}_930`) || "neutral";
                if (direction === "bullish") {
                  blocked = true;
                  blockReason = `B2:前場bullish(9:30判定)`;
                }
              }
              // 後場は blocked = false のまま
            } else if (patternKey === "B3") {
              // B3: 段階的緩和 — 前場はブロック、13:00以降は再判定
              if (timeMin < 11 * 60 + 30) { // 前場
                const direction = directionCache.get(`${date}_930`) || "neutral";
                if (direction === "bullish") {
                  blocked = true;
                  blockReason = `B3:前場bullish(9:30判定)`;
                }
              } else { // 後場
                const direction = directionCache.get(`${date}_1300`) || "neutral";
                if (direction === "bullish") {
                  blocked = true;
                  blockReason = `B3:後場bullish(13:00再判定)`;
                }
              }
            } else if (patternKey === "B4") {
              // B4: 閾値引き上げ — bullish時は板スコア閾値+2で許可
              const roundedTimeMin = Math.floor(timeMin / 30) * 30;
              const dirKey = `${date}_${roundedTimeMin}`;
              const direction = directionCache.get(dirKey) || "neutral";
              if (direction === "bullish") {
                // 完全禁止ではなく、板スコアが高ければ許可
                if (boardScore < BOARD_SCORE_THRESHOLD + 2) {
                  blocked = true;
                  blockReason = `B4:bullish+板スコア不足(${boardScore}<${BOARD_SCORE_THRESHOLD + 2})`;
                }
              }
            }

            if (blocked) {
              blockedTrades[patternKey].push({ date, time, symbol, reason: blockReason });
              continue;
            }
          }

          // Entry
          if (sig.type === "buy" && !inLongPosition) {
            inLongPosition = true;
            longEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false };
          } else if (sig.type === "sell" && !inShortPosition) {
            inShortPosition = true;
            shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false };
          }
        }

        // Close remaining positions
        if (inLongPosition) {
          const lastIdx = candles.length - 1;
          const lots = Math.floor(2000000 / longEntry.price) * 100;
          allResults[patternKey].push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
            entryPrice: longEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
            pnl: (closes[lastIdx] - longEntry.price) * (lots / 100), exitReason: "EOD",
            signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive, session: "pm" });
        }
        if (inShortPosition) {
          const lastIdx = candles.length - 1;
          const lots = Math.floor(2000000 / shortEntry.price) * 100;
          allResults[patternKey].push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
            entryPrice: shortEntry.price, exitTime: candles[lastIdx].time, exitPrice: closes[lastIdx],
            pnl: (shortEntry.price - closes[lastIdx]) * (lots / 100), exitReason: "TIME",
            signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive, session: "pm" });
        }
      }
    }
  }

  // ====================================================================
  // 結果出力
  // ====================================================================
  console.log("\n" + "=".repeat(110));
  console.log("=== パターンB + 上昇日フィルター 5方式比較結果 ===");
  console.log("=".repeat(110));

  console.log("\n--- 総合比較 ---");
  console.log("パターン | 取引数 | 勝率 | 総損益 | PF | 期待値 | 最大DD | 平均利益 | 平均損失 | ブロック数");
  console.log("-".repeat(130));

  const summaryData: { key: PatternKey; pnl: number; pf: number; maxDD: number; count: number; winRate: number; blocked: number }[] = [];

  for (const patternKey of ["B0", "B1", "B2", "B3", "B4"] as PatternKey[]) {
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
    const blockedCount = blockedTrades[patternKey].length;

    let maxDD = 0, peak = 0, cumPnl = 0;
    const sortedTrades = [...trades].sort((a, b) => `${a.date}${a.entryTime}`.localeCompare(`${b.date}${b.entryTime}`));
    for (const t of sortedTrades) {
      cumPnl += t.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    summaryData.push({ key: patternKey, pnl: totalPnl, pf, maxDD, count: trades.length, winRate, blocked: blockedCount });
    console.log(`${patternNames[patternKey]} | ${trades.length}件 | ${winRate.toFixed(0)}% | ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円 | ${pf.toFixed(2)} | ${expectancy.toFixed(0)}円/回 | -${maxDD.toFixed(0)}円 | +${avgWin.toFixed(0)}円 | ${avgLoss.toFixed(0)}円 | ${blockedCount}件`);
  }

  // Detailed breakdown
  for (const patternKey of ["B0", "B1", "B2", "B3", "B4"] as PatternKey[]) {
    const trades = allResults[patternKey];
    console.log(`\n${"=".repeat(80)}`);
    console.log(`=== ${patternNames[patternKey]} 詳細 ===`);
    console.log(`${"=".repeat(80)}`);

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

    // 上昇日/下落日別
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
  }

  // ====================================================================
  // 6/30型分析（前場下落→後場反転）
  // ====================================================================
  console.log(`\n${"=".repeat(80)}`);
  console.log("=== 6/30型分析（前場上昇→後場反転下落相場での耐性） ===");
  console.log(`${"=".repeat(80)}`);
  
  const june30 = "2026-06-30";
  for (const patternKey of ["B0", "B1", "B2", "B3", "B4"] as PatternKey[]) {
    const trades630 = allResults[patternKey].filter(t => t.date === june30);
    const am = trades630.filter(t => t.session === "am");
    const pm = trades630.filter(t => t.session === "pm");
    const amPnl = am.reduce((s, t) => s + t.pnl, 0);
    const pmPnl = pm.reduce((s, t) => s + t.pnl, 0);
    const totalPnl = trades630.reduce((s, t) => s + t.pnl, 0);
    const amShorts = am.filter(t => t.side === "short");
    const pmShorts = pm.filter(t => t.side === "short");
    const amShortPnl = amShorts.reduce((s, t) => s + t.pnl, 0);
    const pmShortPnl = pmShorts.reduce((s, t) => s + t.pnl, 0);
    const blocked630 = blockedTrades[patternKey].filter(b => b.date === june30);
    console.log(`  ${patternNames[patternKey]}:`);
    console.log(`    前場: ${am.length}件(${amPnl >= 0 ? "+" : ""}${amPnl.toFixed(0)}円) [SHORT:${amShorts.length}件/${amShortPnl >= 0 ? "+" : ""}${amShortPnl.toFixed(0)}円]`);
    console.log(`    後場: ${pm.length}件(${pmPnl >= 0 ? "+" : ""}${pmPnl.toFixed(0)}円) [SHORT:${pmShorts.length}件/${pmShortPnl >= 0 ? "+" : ""}${pmShortPnl.toFixed(0)}円]`);
    console.log(`    合計: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円 | ブロック: ${blocked630.length}件`);
  }

  // ====================================================================
  // 反転耐性スコア
  // ====================================================================
  console.log(`\n${"=".repeat(80)}`);
  console.log("=== 反転耐性評価 ===");
  console.log(`${"=".repeat(80)}`);
  console.log("\n反転耐性 = 上昇日の損失を抑えつつ、下落日の利益を維持できるか\n");

  for (const s of summaryData) {
    const trades = allResults[s.key];
    const upDates = [...dayClassification.entries()].filter(([_, c]) => c === "up").map(([d]) => d);
    const downDates = [...dayClassification.entries()].filter(([_, c]) => c === "down").map(([d]) => d);
    const upPnl = trades.filter(t => upDates.includes(t.date)).reduce((sum, t) => sum + t.pnl, 0);
    const downPnl = trades.filter(t => downDates.includes(t.date)).reduce((sum, t) => sum + t.pnl, 0);
    const ratio = downPnl !== 0 ? Math.abs(upPnl) / downPnl : Infinity;
    console.log(`  ${patternNames[s.key]}:`);
    console.log(`    上昇日損益: ${upPnl >= 0 ? "+" : ""}${upPnl.toFixed(0)}円 | 下落日損益: ${downPnl >= 0 ? "+" : ""}${downPnl.toFixed(0)}円`);
    console.log(`    上昇日損失/下落日利益 比率: ${ratio.toFixed(2)} (低いほど良い、1.0以下が理想)`);
  }

  // ====================================================================
  // 最終判定
  // ====================================================================
  console.log(`\n${"=".repeat(110)}`);
  console.log("=== 最終判定 ===");
  console.log(`${"=".repeat(110)}`);
  console.log("\n判定基準: PF >= 1.15 かつ 最大DD <= 200,000円 かつ 反転耐性（上昇日損失/下落日利益 < 0.5）\n");

  for (const s of summaryData) {
    const trades = allResults[s.key];
    const upDates = [...dayClassification.entries()].filter(([_, c]) => c === "up").map(([d]) => d);
    const downDates = [...dayClassification.entries()].filter(([_, c]) => c === "down").map(([d]) => d);
    const upPnl = trades.filter(t => upDates.includes(t.date)).reduce((sum, t) => sum + t.pnl, 0);
    const downPnl = trades.filter(t => downDates.includes(t.date)).reduce((sum, t) => sum + t.pnl, 0);
    const ratio = downPnl > 0 ? Math.abs(upPnl) / downPnl : Infinity;
    
    const pfOk = s.pf >= 1.15;
    const ddOk = s.maxDD <= 200000;
    const reversalOk = ratio < 0.5;
    let verdict = "";
    if (pfOk && ddOk && reversalOk) verdict = "✅ 採用推奨";
    else if (pfOk && ddOk) verdict = "⚠️ 反転耐性不足";
    else if (pfOk) verdict = "⚠️ DD超過";
    else verdict = "❌ PF不足";
    
    console.log(`${patternNames[s.key]}: PF=${s.pf.toFixed(2)} | DD=-${s.maxDD.toFixed(0)}円 | 損益=${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(0)}円 | 反転比=${ratio.toFixed(2)} → ${verdict}`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
