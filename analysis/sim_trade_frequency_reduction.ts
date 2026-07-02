/**
 * sim_trade_frequency_reduction.ts
 * 
 * 取引頻度削減シミュレーション
 * 
 * 比較パターン:
 *   A: 現行（制限なし）
 *   B: 同一銘柄1日最大3回制限
 *   C: 損切り後再エントリー禁止60分
 *   D: 同時ポジション最大3銘柄
 *   E: B+C+D 全部組み合わせ
 * 
 * スリッページ想定:
 *   - 片道1ティック（0.02%）= エントリー+決済で往復0.04%
 *   - 1取引あたり約270万円 × 0.04% = 約1,080円/回
 * 
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/sim_trade_frequency_reduction.ts
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
const B2_THRESHOLD = 0.2;
const LOT_AMOUNT = 2_700_000;

// スリッページ想定
const SLIPPAGE_PER_TRADE = 1080; // 往復1,080円/回（270万×0.04%）

interface Trade {
  date: string; symbol: string; side: "long" | "short";
  entryTime: string; entryPrice: number; exitTime: string; exitPrice: number;
  pnl: number; exitReason: string; signalReason: string; confidence: string;
  beTriggered: boolean; session: "am" | "pm";
}

type Mode = "current" | "maxTrades3" | "cooldown60" | "maxPos3" | "combined";

function getB2Direction(candleCache: Map<string, any[]>, date: string): string {
  let totalChange = 0, count = 0;
  for (const symbol of TEN_SYMBOLS) {
    const key = `${date}_${symbol}`;
    const candles = candleCache.get(key);
    if (!candles || candles.length < 2) continue;
    const firstOpen = candles[0].open;
    let latestClose: number | null = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      const [h, m] = (candles[i].time as string).split(":").map(Number);
      if (h * 60 + m <= 9 * 60 + 30) { latestClose = candles[i].close; break; }
    }
    if (latestClose === null) continue;
    totalChange += (latestClose - firstOpen) / firstOpen * 100;
    count++;
  }
  if (count === 0) return "neutral";
  const avg = totalChange / count;
  return avg >= B2_THRESHOLD ? "bullish" : avg <= -B2_THRESHOLD ? "bearish" : "neutral";
}

function runSimulation(
  mode: Mode,
  dates: string[],
  signalCache: Map<string, any[]>,
  candleCache: Map<string, any[]>,
  b2DirectionCache: Map<string, string>,
  bprCache: Map<string, number[]>
): Trade[] {
  const trades: Trade[] = [];

  for (const date of dates) {
    const b2Dir = b2DirectionCache.get(date) || "neutral";
    
    // Per-day state for frequency limits
    const dailyTradeCount = new Map<string, number>(); // symbol -> count
    const lastExitTime = new Map<string, number>(); // symbol -> timeMin of last SL exit
    const currentOpenPositions = new Set<string>(); // currently open symbols

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

        // === Manage existing LONG position ===
        if (inLongPosition && longEntry) {
          const loss = (lows[i] - longEntry.price) / longEntry.price;
          const highGain = (highs[i] - longEntry.price) / longEntry.price;
          if (!longEntry.beActive && highGain >= BE_TRIGGER) longEntry.beActive = true;
          const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
          if (loss <= slLevel) {
            const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / longEntry.price) / 100) * 100);
            const pnl = Math.round((exitPrice - longEntry.price) * lots);
            const exitReason = longEntry.beActive ? "BE" : "SL";
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice, pnl, exitReason,
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
            currentOpenPositions.delete(symbol);
            if (exitReason === "SL") lastExitTime.set(symbol, timeMin);
          } else if (highGain >= TP_PERCENT) {
            const exitPrice = longEntry.price * (1 + TP_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / longEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((exitPrice - longEntry.price) * lots), exitReason: "TP",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
            currentOpenPositions.delete(symbol);
          } else if (timeMin >= 15 * 60 + 30) {
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / longEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].time,
              entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
              pnl: Math.round((closes[i] - longEntry.price) * lots), exitReason: "TIME",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive,
              session: parseInt(candles[longEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[longEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inLongPosition = false; longEntry = null;
            currentOpenPositions.delete(symbol);
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
            const pnl = Math.round((shortEntry.price - exitPrice) * lots);
            const exitReason = shortEntry.beActive ? "BE" : "SL";
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice, pnl, exitReason,
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
            currentOpenPositions.delete(symbol);
            if (exitReason === "SL") lastExitTime.set(symbol, timeMin);
          } else if (lowGain >= TP_PERCENT) {
            const exitPrice = shortEntry.price * (1 - TP_PERCENT);
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / shortEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: Math.round((shortEntry.price - exitPrice) * lots), exitReason: "TP",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
            currentOpenPositions.delete(symbol);
          } else if (timeMin >= 15 * 60 + 30) {
            const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / shortEntry.price) / 100) * 100);
            trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
              entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
              pnl: Math.round((shortEntry.price - closes[i]) * lots), exitReason: "TIME",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
              session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
            inShortPosition = false; shortEntry = null;
            currentOpenPositions.delete(symbol);
          }
        }

        // === New entry check ===
        if (!sig) continue;
        if (timeMin < 9 * 60 + 30 || timeMin >= 15 * 60 + 15) continue;
        if ((timeMin >= 11 * 60 && timeMin < 11 * 60 + 30) || (timeMin >= 12 * 60 + 30 && timeMin < 13 * 60)) continue;
        if (inLongPosition || inShortPosition) continue;

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

        // SHORT medium: B2方式
        if (confidence === "medium" && sig.type === "sell") {
          if (isAM && b2Dir === "bullish") continue;
        }

        // 後場全SHORT BPR>=0.65ブロック
        if (sig.type === "sell" && timeMin >= 13 * 60) {
          const bpr = bprs[i] ?? 0.5;
          if (bpr >= PM_BPR_THRESHOLD) continue;
        }

        // ======= MODE-SPECIFIC FREQUENCY LIMITS =======
        
        // パターンB: 同一銘柄1日最大3回制限
        if (mode === "maxTrades3" || mode === "combined") {
          const count = dailyTradeCount.get(symbol) || 0;
          if (count >= 3) continue;
        }

        // パターンC: 損切り後60分再エントリー禁止
        if (mode === "cooldown60" || mode === "combined") {
          const lastSL = lastExitTime.get(symbol);
          if (lastSL !== undefined) {
            const elapsed = timeMin - lastSL;
            if (elapsed >= 0 && elapsed < 60) continue;
          }
        }

        // パターンD: 同時ポジション最大3銘柄
        if (mode === "maxPos3" || mode === "combined") {
          if (currentOpenPositions.size >= 3 && !currentOpenPositions.has(symbol)) continue;
        }

        // Entry
        if (sig.type === "buy") {
          inLongPosition = true;
          longEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false };
          currentOpenPositions.add(symbol);
          dailyTradeCount.set(symbol, (dailyTradeCount.get(symbol) || 0) + 1);
        } else if (sig.type === "sell") {
          inShortPosition = true;
          shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: confidence, beActive: false };
          currentOpenPositions.add(symbol);
          dailyTradeCount.set(symbol, (dailyTradeCount.get(symbol) || 0) + 1);
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
        currentOpenPositions.delete(symbol);
      }
      if (inShortPosition && shortEntry) {
        const lastClose = closes[closes.length - 1];
        const lots = Math.max(100, Math.floor(Math.floor(LOT_AMOUNT / shortEntry.price) / 100) * 100);
        trades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].time,
          entryPrice: shortEntry.price, exitTime: candles[candles.length - 1].time, exitPrice: lastClose,
          pnl: Math.round((shortEntry.price - lastClose) * lots), exitReason: "EOD",
          signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive,
          session: parseInt(candles[shortEntry.idx].time.split(":")[0]) * 60 + parseInt(candles[shortEntry.idx].time.split(":")[1]) < 12 * 60 + 30 ? "am" : "pm" });
        currentOpenPositions.delete(symbol);
      }
    }
  }
  return trades;
}

function calcStats(trades: Trade[]) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const slippage = trades.length * SLIPPAGE_PER_TRADE;
  const netPnl = totalPnl - slippage;
  let peak = 0, maxDD = 0, cum = 0;
  for (const t of trades) { cum += t.pnl; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; }
  return { count: trades.length, wins: wins.length, losses: losses.length, winRate, totalPnl, grossProfit, grossLoss, pf, maxDD, slippage, netPnl };
}

async function main() {
  const db = await getDb();
  const rows = await db.select().from(rtCandles).where(and(
    inArray(rtCandles.symbol, TEN_SYMBOLS),
    gte(rtCandles.tradeDate, "2026-06-17"),
    lte(rtCandles.tradeDate, "2026-07-01")
  ));

  const dates = [...new Set(rows.map(r => r.tradeDate))].sort();

  console.log("╔══════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  取引頻度削減シミュレーション（スリッページ込み実質損益比較）                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════════╝");
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`スリッページ想定: 往復${SLIPPAGE_PER_TRADE}円/回（270万×0.04%）\n`);

  // Build caches
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
      const vwapCandles = symbolRows.map(r => ({ open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) }));
      const vwapArr = calcVWAP(vwapCandles);
      const bbResult = calcBollinger(closes, 20, 2);
      const rsiArr = calcRSI(closes, 14);
      const ma5: (number | null)[] = closes.map((_, i) => i < 4 ? null : (closes[i] + closes[i-1] + closes[i-2] + closes[i-3] + closes[i-4]) / 5);
      const ma25: (number | null)[] = closes.map((_, i) => { if (i < 24) return null; let s = 0; for (let j = 0; j < 25; j++) s += closes[i-j]; return s / 25; });
      const enriched = symbolRows.map((r: any, i: number) => ({
        time: r.candleTime, timestamp: 0, open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i], vwap: vwapArr[i] ?? closes[i],
        bbUpper: bbResult.upper[i] ?? (closes[i] * 1.02), bbMiddle: null,
        bbLower: bbResult.lower[i] ?? (closes[i] * 0.98),
        ma5: ma5[i] ?? closes[i], ma25: ma25[i] ?? closes[i], rsi: rsiArr[i] ?? 50, atr: null as any,
      }));
      signalCache.set(key, detectSignals(enriched as any));
      candleCache.set(key, enriched);
      bprCache.set(key, symbolRows.map(r => { const bs = r.boardSnapshot as any; return bs?.buyPressureRatio ?? bs?.bpr ?? 0.5; }));
    }
  }

  const b2DirectionCache = new Map<string, string>();
  for (const date of dates) b2DirectionCache.set(date, getB2Direction(candleCache, date));

  // Run all modes
  const modes: { key: Mode; label: string; desc: string }[] = [
    { key: "current", label: "A: 現行", desc: "制限なし" },
    { key: "maxTrades3", label: "B: 1日3回制限", desc: "同一銘柄1日最大3回" },
    { key: "cooldown60", label: "C: SL後60分禁止", desc: "損切り後60分再エントリー禁止" },
    { key: "maxPos3", label: "D: 同時3銘柄制限", desc: "同時ポジション最大3銘柄" },
    { key: "combined", label: "E: B+C+D組合せ", desc: "3回制限+60分禁止+3銘柄制限" },
  ];

  const results: { mode: string; label: string; desc: string; stats: ReturnType<typeof calcStats>; trades: Trade[] }[] = [];

  for (const m of modes) {
    const trades = runSimulation(m.key, dates, signalCache, candleCache, b2DirectionCache, bprCache);
    const stats = calcStats(trades);
    results.push({ mode: m.key, label: m.label, desc: m.desc, stats, trades });
  }

  // === Print comparison table ===
  console.log("==========================================================================================");
  console.log("=== パターン比較（スリッページ込み） ===");
  console.log("==========================================================================================");
  console.log(`| パターン | 取引数 | 1日平均 | 総損益 | スリッページ | 実質損益 | PF | 勝率 | 最大DD |`);
  console.log(`|----------|--------|---------|--------|-------------|---------|------|------|--------|`);
  for (const r of results) {
    const s = r.stats;
    const dailyAvg = (s.count / dates.length).toFixed(1);
    console.log(
      `| ${r.label.padEnd(14)} | ${String(s.count).padStart(4)}件 | ${dailyAvg.padStart(5)}件 | ` +
      `${(s.totalPnl >= 0 ? "+" : "") + s.totalPnl.toLocaleString().padStart(11)}円 | ` +
      `${("-" + s.slippage.toLocaleString()).padStart(9)}円 | ` +
      `${(s.netPnl >= 0 ? "+" : "") + s.netPnl.toLocaleString().padStart(11)}円 | ` +
      `${s.pf.toFixed(2).padStart(4)} | ${s.winRate.toFixed(1).padStart(5)}% | ` +
      `${s.maxDD.toLocaleString().padStart(8)}円 |`
    );
  }

  // === Efficiency comparison ===
  console.log(`\n--- 効率性比較（1取引あたり実質利益） ---`);
  console.log(`| パターン | 実質期待値/回 | 削減率 | 実質損益比 |`);
  console.log(`|----------|--------------|--------|-----------|`);
  const baseNetPnl = results[0].stats.netPnl;
  for (const r of results) {
    const s = r.stats;
    const netExpectancy = s.count > 0 ? s.netPnl / s.count : 0;
    const reduction = results[0].stats.count > 0 ? ((1 - s.count / results[0].stats.count) * 100).toFixed(1) : "0.0";
    const pnlRatio = baseNetPnl !== 0 ? ((s.netPnl / baseNetPnl) * 100).toFixed(1) : "N/A";
    console.log(
      `| ${r.label.padEnd(14)} | ${(netExpectancy >= 0 ? "+" : "") + netExpectancy.toFixed(0).padStart(7)}円 | ` +
      `${reduction.padStart(5)}% | ${pnlRatio.padStart(6)}% |`
    );
  }

  // === Daily breakdown for each mode ===
  console.log(`\n--- 日別損益比較 ---`);
  console.log(`| 日付       | A:現行 | B:3回制限 | C:60分禁止 | D:3銘柄 | E:組合せ |`);
  console.log(`|------------|--------|-----------|-----------|---------|---------|`);
  for (const date of dates) {
    const row = results.map(r => {
      const dayTrades = r.trades.filter(t => t.date === date);
      const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
      const daySlip = dayTrades.length * SLIPPAGE_PER_TRADE;
      const net = dayPnl - daySlip;
      return `${(net >= 0 ? "+" : "") + (net / 1000).toFixed(0)}k`;
    });
    console.log(`| ${date} | ${row[0].padStart(6)} | ${row[1].padStart(9)} | ${row[2].padStart(9)} | ${row[3].padStart(7)} | ${row[4].padStart(7)} |`);
  }

  // === LONG/SHORT breakdown per mode ===
  console.log(`\n--- LONG/SHORT別（実質損益） ---`);
  console.log(`| パターン | LONG件数 | LONG実質損益 | SHORT件数 | SHORT実質損益 |`);
  console.log(`|----------|----------|-------------|-----------|--------------|`);
  for (const r of results) {
    const longs = r.trades.filter(t => t.side === "long");
    const shorts = r.trades.filter(t => t.side === "short");
    const longPnl = longs.reduce((s, t) => s + t.pnl, 0) - longs.length * SLIPPAGE_PER_TRADE;
    const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0) - shorts.length * SLIPPAGE_PER_TRADE;
    console.log(
      `| ${r.label.padEnd(14)} | ${String(longs.length).padStart(6)}件 | ` +
      `${(longPnl >= 0 ? "+" : "") + longPnl.toLocaleString().padStart(10)}円 | ` +
      `${String(shorts.length).padStart(7)}件 | ` +
      `${(shortPnl >= 0 ? "+" : "") + shortPnl.toLocaleString().padStart(10)}円 |`
    );
  }

  // === Best mode recommendation ===
  const bestByNetPnl = results.reduce((best, r) => r.stats.netPnl > best.stats.netPnl ? r : best);
  const bestByEfficiency = results.reduce((best, r) => {
    const rEff = r.stats.count > 0 ? r.stats.netPnl / r.stats.count : 0;
    const bEff = best.stats.count > 0 ? best.stats.netPnl / best.stats.count : 0;
    return rEff > bEff ? r : best;
  });

  console.log(`\n==========================================================================================`);
  console.log(`=== 推奨 ===`);
  console.log(`  最大実質利益: ${bestByNetPnl.label} (${bestByNetPnl.desc}) → ${bestByNetPnl.stats.netPnl >= 0 ? "+" : ""}${bestByNetPnl.stats.netPnl.toLocaleString()}円`);
  console.log(`  最高効率: ${bestByEfficiency.label} (${bestByEfficiency.desc}) → ${bestByEfficiency.stats.count > 0 ? (bestByEfficiency.stats.netPnl / bestByEfficiency.stats.count).toFixed(0) : 0}円/回`);
  console.log(`==========================================================================================`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
