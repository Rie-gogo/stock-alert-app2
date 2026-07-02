/**
 * sim_current_10days.ts
 * 
 * 現行エンジン（パターンC+10銘柄方式）の7/1 単日シミュレーション
 * 
 * 現行ロジック:
 *   - 10銘柄限定
 *   - B2方式（9:30時点でbullish判定→前場SHORT mediumブロック、後場は無条件許可）
 *   - BUY medium全ブロック
 *   - SHORT medium: B2方式で条件付き許可
 *   - VWAPクロス上抜け無効化
 *   - 後場全SHORT BPR>=0.65ブロック
 *   - VWAP急落フィルター（5本-0.8%/3本-0.6%）
 *   - 固定0.5%BEストップ / SL 0.5% / TP 1.5%
 *   - エントリー時間: 09:30-15:15（昼休み前11:00-11:30, 後場序盤12:30-13:00除外）
 *   - 大引け強制決済: 15:30
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_current_10days.ts
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { and, gte, lte, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";

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

const TEN_SYMBOLS = ["6920", "6857", "5803", "6976", "6981", "6526", "9984", "7011", "8035", "8316"];
const SYMBOL_NAMES: Record<string, string> = {
  "6920": "レーザーテック", "6857": "アドバンテスト", "5803": "フジクラ",
  "6976": "太陽誘電", "6981": "村田製作所", "6526": "ソシオネクスト",
  "9984": "ソフトバンクG", "7011": "三菱重工", "8035": "東京エレクトロン", "8316": "三井住友FG"
};

const SL_PERCENT = 0.005;
const TP_PERCENT = 0.015;
const BE_TRIGGER = 0.005;
const VWAP_DROP_5BAR = -0.008;
const VWAP_DROP_3BAR = -0.006;
const PM_BPR_THRESHOLD = 0.65;
const B2_THRESHOLD = 0.2; // ±0.2%
const LOT_AMOUNT = 2_700_000; // 270万円/銘柄

interface Trade {
  date: string; symbol: string; side: "long" | "short";
  entryTime: string; entryPrice: number; exitTime: string; exitPrice: number;
  pnl: number; exitReason: string; signalReason: string; confidence: string;
  beTriggered: boolean; session: "am" | "pm";
}

/**
 * B2方式: 9:30時点の市場方向性判定
 */
function getB2Direction(
  candleCache: Map<string, any[]>,
  date: string
): "bullish" | "bearish" | "neutral" {
  let totalChange = 0, count = 0;
  for (const symbol of TEN_SYMBOLS) {
    const key = `${date}_${symbol}`;
    const candles = candleCache.get(key);
    if (!candles || candles.length < 2) continue;
    const firstOpen = candles[0].open;
    // 9:30時点の足を探す
    let latestClose: number | null = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      const [h, m] = (candles[i].time as string).split(":").map(Number);
      const tMin = h * 60 + m;
      if (tMin <= 9 * 60 + 30) {
        latestClose = candles[i].close;
        break;
      }
    }
    if (latestClose === null) continue;
    const changeRate = (latestClose - firstOpen) / firstOpen * 100;
    totalChange += changeRate;
    count++;
  }
  if (count === 0) return "neutral";
  const avg = totalChange / count;
  if (avg >= B2_THRESHOLD) return "bullish";
  if (avg <= -B2_THRESHOLD) return "bearish";
  return "neutral";
}

function runSimulation(
  dates: string[],
  signalCache: Map<string, any[]>,
  candleCache: Map<string, any[]>,
  b2DirectionCache: Map<string, string>,
  bprCache: Map<string, number[]>
): Trade[] {
  const trades: Trade[] = [];

  for (const date of dates) {
    const b2Dir = b2DirectionCache.get(date) || "neutral";

    for (const symbol of TEN_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const signals = signalCache.get(key);
      const candles = candleCache.get(key);
      if (!signals || !candles || candles.length < 30) continue;

      const closes = candles.map((c: any) => c.close);
      const highs = candles.map((c: any) => c.high);
      const lows = candles.map((c: any) => c.low);
      const bprs = bprCache.get(key) || [];

      let inLongPosition = false, inShortPosition = false;
      let longEntry: any = null, shortEntry: any = null;

      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i].signal;
        const time = candles[i].time as string;
        const [h, m] = time.split(":").map(Number);
        const timeMin = h * 60 + m;
        const isAM = timeMin < 11 * 60 + 30;
        const session: "am" | "pm" = timeMin < 12 * 60 + 30 ? "am" : "pm";

        // === Manage existing LONG position ===
        if (inLongPosition && longEntry) {
          const loss = (lows[i] - longEntry.price) / longEntry.price;
          const highGain = (highs[i] - longEntry.price) / longEntry.price;
          if (!longEntry.beActive && highGain >= BE_TRIGGER) longEntry.beActive = true;
          
          const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
          if (loss <= slLevel) {
            const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / longEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((exitPrice - longEntry.price) * lots), exitReason: longEntry.beActive ? "BE" : "SL",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
          } else if (highGain >= TP_PERCENT) {
            const exitPrice = longEntry.price * (1 + TP_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / longEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((exitPrice - longEntry.price) * lots), exitReason: "TP",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
          } else if (timeMin >= 15 * 60 + 30) {
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / longEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
              pnl: Math.round((closes[i] - longEntry.price) * lots), exitReason: "TIME",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
          }
        }

        // === Manage existing SHORT position ===
        if (inShortPosition && shortEntry) {
          const lossHigh = (highs[i] - shortEntry.price) / shortEntry.price;
          const lowGain = (shortEntry.price - lows[i]) / shortEntry.price;
          if (!shortEntry.beActive && lowGain >= BE_TRIGGER) shortEntry.beActive = true;
          
          const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
          if (lossHigh >= slLevel) {
            const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / shortEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((shortEntry.price - exitPrice) * lots), exitReason: shortEntry.beActive ? "BE" : "SL",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
          } else if (lowGain >= TP_PERCENT) {
            const exitPrice = shortEntry.price * (1 - TP_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / shortEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((shortEntry.price - exitPrice) * lots), exitReason: "TP",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
          } else if (timeMin >= 15 * 60 + 30) {
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / shortEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
              pnl: Math.round((shortEntry.price - closes[i]) * lots), exitReason: "TIME",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
          }
        }

        // === New entry check ===
        if (!sig) continue;
        if (timeMin < 9 * 60 + 30 || timeMin >= 15 * 60 + 15) continue;
        if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;

        // VWAPクロス上抜け無効化
        if (sig.type === "buy" && sig.reason && sig.reason.includes("VWAPクロス上抜け")) continue;

        // VWAP急落フィルター
        if (sig.type === "sell" && sig.reason.includes("VWAPクロス下抜け")) {
          const drop5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0;
          const drop3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : 0;
          if (drop5 <= VWAP_DROP_5BAR || drop3 <= VWAP_DROP_3BAR) continue;
        }

        const confidence = sig.confidence || "strong";
        if (confidence === "weak") continue;

        // BUY medium全ブロック
        if (confidence === "medium" && sig.type === "buy") continue;

        // SHORT medium: B2方式による方向性ブロック
        if (confidence === "medium" && sig.type === "sell") {
          // 前場 + bullish判定時のみブロック、それ以外は許可
          if (isAM && b2Dir === "bullish") continue;
          // 後場は無条件許可
        }

        // 後場全SHORT BPR>=0.65ブロック
        if (sig.type === "sell" && timeMin >= 13 * 60) {
          const bpr = bprs[i] ?? 0.5;
          if (bpr >= PM_BPR_THRESHOLD) continue;
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

      // Close remaining positions at end of day
      if (inLongPosition && longEntry) {
        const lastClose = closes[closes.length - 1];
        const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / longEntry.price) / 100) * 100);
        trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
          entryPrice: longEntry.price, exitTime: candles[candles.length - 1].time, exitPrice: lastClose,
          pnl: Math.round((lastClose - longEntry.price) * lots), exitReason: "EOD",
          signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
          session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
      }
      if (inShortPosition && shortEntry) {
        const lastClose = closes[closes.length - 1];
        const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / shortEntry.price) / 100) * 100);
        trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
          entryPrice: shortEntry.price, exitTime: candles[candles.length - 1].time, exitPrice: lastClose,
          pnl: Math.round((shortEntry.price - lastClose) * lots), exitReason: "EOD",
          signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
          session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
      }
    }
  }
  return trades;
}

async function main() {
  const db = await getDb();

  // 直近10営業日のデータを取得
  const rows = await db.select().from(rtCandles)
    .where(and(
      inArray(rtCandles.symbol, TEN_SYMBOLS),
      gte(rtCandles.tradeDate, "2026-07-01"),
      lte(rtCandles.tradeDate, "2026-07-01")
    ));

  const dates = [...new Set(rows.map(r => r.tradeDate))].sort();

  console.log("╔══════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  現行エンジン 7/1 単日シミュレーション                                           ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════╝");
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象: 10銘柄 | ロット: 270万円/銘柄 | SL:0.5% TP:1.5% BE:0.5%`);
  console.log(`B2方式: 9:30固定判定（bullish→前場SHORT mediumブロック、後場は無条件許可）`);
  console.log(`BUY medium: 全ブロック | VWAPクロス上抜け: 無効化`);
  console.log(`後場BPR>=0.65: 全SHORTブロック | VWAP急落フィルター: 5本-0.8%/3本-0.6%\n`);

  // Load candles
  const candleCache = new Map<string, any[]>();
  const signalCache = new Map<string, any[]>();
  const bprCache = new Map<string, number[]>();

  for (const date of dates) {
    const dateRows = rows.filter(r => r.tradeDate === date);
    const bySymbol = new Map<string, typeof dateRows>();
    for (const r of dateRows) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
      bySymbol.get(r.symbol)!.push(r);
    }

    for (const [symbol, symbolRows] of Array.from(bySymbol.entries())) {
      symbolRows.sort((a, b) => a.candleTime.localeCompare(b.candleTime));
      const key = `${date}_${symbol}`;
      const closes = symbolRows.map(r => Number(r.close));
      const highs = symbolRows.map(r => Number(r.high));
      const lows = symbolRows.map(r => Number(r.low));
      const volumes = symbolRows.map(r => Number(r.volume));
      const opens = symbolRows.map(r => Number(r.open));
      const vwapCandles = symbolRows.map(r => ({
        open: Number(r.open), high: Number(r.high), low: Number(r.low),
        close: Number(r.close), volume: Number(r.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);
      const bbResult = calcBollinger(closes, 20, 2);
      const rsiArr = calcRSI(closes, 14);
      const ma5: (number | null)[] = closes.map((_, i) => i < 4 ? null : (closes[i] + closes[i - 1] + closes[i - 2] + closes[i - 3] + closes[i - 4]) / 5);
      const ma25: (number | null)[] = closes.map((_, i) => { if (i < 24) return null; let s = 0; for (let j = 0; j < 25; j++) s += closes[i - j]; return s / 25; });
      const enrichedCandles = symbolRows.map((r: any, i: number) => ({
        time: r.candleTime,
        timestamp: 0,
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i],
        vwap: vwapArr[i] ?? closes[i],
        bbUpper: bbResult.upper[i] ?? (closes[i] * 1.02),
        bbMiddle: null,
        bbLower: bbResult.lower[i] ?? (closes[i] * 0.98),
        ma5: ma5[i] ?? closes[i],
        ma25: ma25[i] ?? closes[i],
        rsi: rsiArr[i] ?? 50,
        atr: null as any,
      }));
      const signals = detectSignals(enrichedCandles as any);
      signalCache.set(key, signals);
      candleCache.set(key, enrichedCandles);

      // BPR
      const bprs = symbolRows.map(r => {
        const bs = r.boardSnapshot as any;
        return bs?.buyPressureRatio ?? bs?.bpr ?? 0.5;
      });
      bprCache.set(key, bprs);
    }
  }

  // Pre-compute B2 directions
  const b2DirectionCache = new Map<string, string>();
  for (const date of dates) {
    b2DirectionCache.set(date, getB2Direction(candleCache, date));
  }

  // Print B2 direction summary
  console.log("--- 日別B2地合い判定 ---");
  console.log("| 日付       | B2方向性    |");
  console.log("|------------|-------------|");
  for (const date of dates) {
    const dir = b2DirectionCache.get(date) || "neutral";
    const label = dir === "bullish" ? "↑ bullish" : dir === "bearish" ? "↓ bearish" : "→ neutral";
    console.log(`| ${date} | ${label.padEnd(11)} |`);
  }
  console.log();

  // Run simulation
  const trades = runSimulation(dates, signalCache, candleCache, b2DirectionCache, bprCache);

  // ===== REPORT =====
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const bes = trades.filter(t => t.pnl === 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const expectancy = trades.length > 0 ? totalPnl / trades.length : 0;

  // Max DD
  let peak = 0, maxDD = 0, cum = 0;
  for (const t of trades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  console.log("==========================================================================================");
  console.log("=== 総合パフォーマンス ===");
  console.log("==========================================================================================");
  console.log(`  取引数: ${trades.length}件 | 勝率: ${winRate.toFixed(1)}% (${wins.length}勝${losses.length}敗${bes.length}引分)`);
  console.log(`  総損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`  PF: ${pf.toFixed(2)} | 最大DD: ${maxDD.toLocaleString()}円`);
  console.log(`  期待値: ${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(0)}円/回`);
  console.log(`  平均利益: +${avgWin.toFixed(0)}円 | 平均損失: -${avgLoss.toFixed(0)}円`);
  console.log(`  粗利益: +${grossProfit.toLocaleString()}円 | 粗損失: -${grossLoss.toLocaleString()}円`);

  // LONG/SHORT breakdown
  const longTrades = trades.filter(t => t.side === "long");
  const shortTrades = trades.filter(t => t.side === "short");
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  const longWins = longTrades.filter(t => t.pnl > 0);
  const shortWins = shortTrades.filter(t => t.pnl > 0);
  const longGP = longWins.reduce((s, t) => s + t.pnl, 0);
  const longGL = Math.abs(longTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const shortGP = shortWins.reduce((s, t) => s + t.pnl, 0);
  const shortGL = Math.abs(shortTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const longPF = longGL > 0 ? longGP / longGL : Infinity;
  const shortPF = shortGL > 0 ? shortGP / shortGL : Infinity;

  console.log(`\n--- LONG/SHORT別 ---`);
  console.log(`  LONG:  ${longTrades.length}件 | ${longPnl >= 0 ? "+" : ""}${longPnl.toLocaleString()}円 | PF ${longPF.toFixed(2)} | 勝率 ${longTrades.length > 0 ? (longWins.length / longTrades.length * 100).toFixed(1) : 0}%`);
  console.log(`  SHORT: ${shortTrades.length}件 | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toLocaleString()}円 | PF ${shortPF.toFixed(2)} | 勝率 ${shortTrades.length > 0 ? (shortWins.length / shortTrades.length * 100).toFixed(1) : 0}%`);

  // AM/PM breakdown
  const amTrades = trades.filter(t => t.session === "am");
  const pmTrades = trades.filter(t => t.session === "pm");
  const amPnl = amTrades.reduce((s, t) => s + t.pnl, 0);
  const pmPnl = pmTrades.reduce((s, t) => s + t.pnl, 0);
  const amWins = amTrades.filter(t => t.pnl > 0);
  const pmWins = pmTrades.filter(t => t.pnl > 0);

  console.log(`\n--- 前場/後場別 ---`);
  console.log(`  前場: ${amTrades.length}件 | ${amPnl >= 0 ? "+" : ""}${amPnl.toLocaleString()}円 | 勝率 ${amTrades.length > 0 ? (amWins.length / amTrades.length * 100).toFixed(1) : 0}%`);
  console.log(`  後場: ${pmTrades.length}件 | ${pmPnl >= 0 ? "+" : ""}${pmPnl.toLocaleString()}円 | 勝率 ${pmTrades.length > 0 ? (pmWins.length / pmTrades.length * 100).toFixed(1) : 0}%`);

  // Exit reason breakdown
  const byReason = new Map<string, { count: number; pnl: number }>();
  for (const t of trades) {
    const r = byReason.get(t.exitReason) || { count: 0, pnl: 0 };
    r.count++; r.pnl += t.pnl;
    byReason.set(t.exitReason, r);
  }
  console.log(`\n--- 決済理由別 ---`);
  console.log(`| 理由 | 件数 | 損益 |`);
  console.log(`|------|------|------|`);
  for (const [reason, data] of Array.from(byReason.entries()).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`| ${reason.padEnd(6)} | ${String(data.count).padStart(4)}件 | ${(data.pnl >= 0 ? "+" : "") + data.pnl.toLocaleString()}円 |`);
  }

  // Symbol breakdown
  console.log(`\n--- 銘柄別損益 ---`);
  console.log(`| 銘柄 | 取引数 | 勝率 | 損益 | PF |`);
  console.log(`|------|--------|------|------|-----|`);
  for (const symbol of TEN_SYMBOLS) {
    const symTrades = trades.filter(t => t.symbol === symbol);
    const symPnl = symTrades.reduce((s, t) => s + t.pnl, 0);
    const symWins = symTrades.filter(t => t.pnl > 0);
    const symGP = symWins.reduce((s, t) => s + t.pnl, 0);
    const symGL = Math.abs(symTrades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const symPF = symGL > 0 ? symGP / symGL : Infinity;
    const symWR = symTrades.length > 0 ? (symWins.length / symTrades.length * 100).toFixed(1) : "0.0";
    console.log(`| ${symbol} ${(SYMBOL_NAMES[symbol] || "").padEnd(10)} | ${String(symTrades.length).padStart(4)}件 | ${symWR.padStart(5)}% | ${(symPnl >= 0 ? "+" : "") + symPnl.toLocaleString().padStart(10)}円 | ${symPF.toFixed(2).padStart(5)} |`);
  }

  // Daily breakdown
  console.log(`\n--- 日別損益 ---`);
  console.log(`| 日付       | 取引数 | 損益 | 累計損益 | 勝率 |`);
  console.log(`|------------|--------|------|----------|------|`);
  let cumPnl = 0;
  for (const date of dates) {
    const dayTrades = trades.filter(t => t.date === date);
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    cumPnl += dayPnl;
    const dayWins = dayTrades.filter(t => t.pnl > 0);
    const dayWR = dayTrades.length > 0 ? (dayWins.length / dayTrades.length * 100).toFixed(1) : "0.0";
    console.log(`| ${date} | ${String(dayTrades.length).padStart(4)}件 | ${(dayPnl >= 0 ? "+" : "") + dayPnl.toLocaleString().padStart(10)}円 | ${(cumPnl >= 0 ? "+" : "") + cumPnl.toLocaleString().padStart(10)}円 | ${dayWR.padStart(5)}% |`);
  }

  // Confidence breakdown
  const strongTrades = trades.filter(t => t.confidence === "strong");
  const mediumTrades = trades.filter(t => t.confidence === "medium");
  console.log(`\n--- シグナル品質別 ---`);
  console.log(`  strong: ${strongTrades.length}件 | ${strongTrades.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${strongTrades.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円 | 勝率 ${strongTrades.length > 0 ? (strongTrades.filter(t => t.pnl > 0).length / strongTrades.length * 100).toFixed(1) : 0}%`);
  console.log(`  medium: ${mediumTrades.length}件 | ${mediumTrades.reduce((s, t) => s + t.pnl, 0) >= 0 ? "+" : ""}${mediumTrades.reduce((s, t) => s + t.pnl, 0).toLocaleString()}円 | 勝率 ${mediumTrades.length > 0 ? (mediumTrades.filter(t => t.pnl > 0).length / mediumTrades.length * 100).toFixed(1) : 0}%`);

  // Worst 5 trades
  const sortedByPnl = [...trades].sort((a, b) => a.pnl - b.pnl);
  console.log(`\n--- ワースト5取引 ---`);
  for (let i = 0; i < Math.min(5, sortedByPnl.length); i++) {
    const t = sortedByPnl[i];
    console.log(`  ${i + 1}. ${t.date} ${t.symbol}(${SYMBOL_NAMES[t.symbol]}) ${t.side} ${t.entryTime}→${t.exitTime} | ${t.pnl.toLocaleString()}円 | ${t.exitReason} | ${t.signalReason.substring(0, 40)}`);
  }

  // Best 5 trades
  console.log(`\n--- ベスト5取引 ---`);
  const bestTrades = [...trades].sort((a, b) => b.pnl - a.pnl);
  for (let i = 0; i < Math.min(5, bestTrades.length); i++) {
    const t = bestTrades[i];
    console.log(`  ${i + 1}. ${t.date} ${t.symbol}(${SYMBOL_NAMES[t.symbol]}) ${t.side} ${t.entryTime}→${t.exitTime} | +${t.pnl.toLocaleString()}円 | ${t.exitReason} | ${t.signalReason.substring(0, 40)}`);
  }

  console.log(`\n==========================================================================================`);
  console.log(`  10日間合計: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円 | 1日平均: ${(totalPnl / dates.length) >= 0 ? "+" : ""}${(totalPnl / dates.length).toFixed(0)}円`);
  console.log(`==========================================================================================`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
