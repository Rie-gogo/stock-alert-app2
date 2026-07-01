/**
 * medium品質ブロック妥当性検証シミュレーション v2
 * 
 * 修正: detectSignalsのBB null問題を回避するため、
 * processCandle同様にインクリメンタルにシグナルを生成する代わりに、
 * 本番エンジンのprocessCandleが記録したシグナル履歴を使う。
 * 
 * 方法: rt_signal_historyテーブルからmediumシグナルを取得し、
 *        仮想エントリーした場合の損益を計算
 */
import { getDb } from "../server/db";
import { rtCandles, rtTrades } from "../drizzle/schema";
import { eq, and, gte, lte, inArray, sql } from "drizzle-orm";

const TARGET_SYMBOLS = ["6526", "9984", "6976", "6920", "8035", "6857", "6981"];
const SL_PERCENT = 0.005;
const TP_PERCENT = 0.015;
const BE_TRIGGER = 0.005;

interface GhostTrade {
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
}

async function main() {
  const db = await getDb();

  // Get existing trades for baseline
  const existingTrades = await db.select().from(rtTrades)
    .where(gte(rtTrades.tradeDate, "2026-06-17"));
  
  console.log(`=== 現行トレード (6/17〜6/30) ===`);
  console.log(`件数: ${existingTrades.length}`);
  const existingPnl = existingTrades.reduce((s, t) => s + Number((t as any).pnl || 0), 0);
  console.log(`総損益: ${existingPnl.toFixed(0)}円\n`);

  // Check if signal history table exists
  const tables = await db.execute(sql`SHOW TABLES LIKE 'rt_signal_history'`);
  const hasSignalHistory = (tables as any).rows?.length > 0 || (tables as any).length > 0;
  
  console.log("キャンドルデータから直接シミュレーション（BB/RSI/ATR全指標を計算）");

  // Since signal history may not exist, use candle data directly
  // The key issue is that detectSignals requires non-null BB values
  // Fix: compute BB for ALL candles and fill nulls with 0 (which means they won't trigger BB-based signals)
  // But the real fix is to only check BB null for BB-specific signals, not all signals
  
  // Alternative approach: Use the production engine's logic directly
  // The production engine (processCandle) builds a buffer incrementally and calls detectSignals
  // on the last N candles. We can simulate this by calling detectSignals on sliding windows.
  
  // Actually, the simplest approach: just provide RSI values too (the null check requires RSI)
  // Let's compute RSI manually
  
  const allCandles = await db.select().from(rtCandles)
    .where(and(
      inArray(rtCandles.symbol, TARGET_SYMBOLS),
      gte(rtCandles.tradeDate, "2026-06-17"),
      lte(rtCandles.tradeDate, "2026-06-30")
    ));

  // Group by date and symbol
  const grouped = new Map<string, typeof allCandles>();
  for (const c of allCandles) {
    const key = `${c.tradeDate}_${c.symbol}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(c);
  }

  const dates = [...new Set(allCandles.map(c => c.tradeDate))].sort();
  console.log(`検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象銘柄: ${TARGET_SYMBOLS.join(", ")}\n`);

  // Import detectSignals and compute all indicators properly
  const { detectSignals, calcBollinger } = await import("../server/routers/stockData");
  const { calcVWAP } = await import("../server/vwap");

  function calcRSI(closes: number[], period: number = 14): (number | null)[] {
    const result: (number | null)[] = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return result;
    
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i-1];
      if (change > 0) avgGain += change;
      else avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;
    
    result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i-1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
    return result;
  }

  const ghostTrades: GhostTrade[] = [];

  for (const date of dates) {
    for (const symbol of TARGET_SYMBOLS) {
      const key = `${date}_${symbol}`;
      const candles = grouped.get(key);
      if (!candles || candles.length < 30) continue;
      candles.sort((a: any, b: any) => a.candleTime.localeCompare(b.candleTime));

      const closes = candles.map((c: any) => Number(c.close));
      const highs = candles.map((c: any) => Number(c.high));
      const lows = candles.map((c: any) => Number(c.low));
      const opens = candles.map((c: any) => Number(c.open));
      const volumes = candles.map((c: any) => Number(c.volume));

      // Compute all indicators
      const vwapCandles = candles.map((c: any) => ({
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: Number(c.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);
      const bbResult = calcBollinger(closes, 20, 2);
      const rsiArr = calcRSI(closes, 14);

      // MA
      const ma5: (number | null)[] = closes.map((_, i) => {
        if (i < 4) return null;
        return (closes[i]+closes[i-1]+closes[i-2]+closes[i-3]+closes[i-4])/5;
      });
      const ma25: (number | null)[] = closes.map((_, i) => {
        if (i < 24) return null;
        let sum = 0; for (let j = 0; j < 25; j++) sum += closes[i-j]; return sum/25;
      });

      // ATR (simple approximation)
      const atrArr: (number | null)[] = closes.map((_, i) => {
        if (i < 14) return null;
        let sum = 0;
        for (let j = i - 13; j <= i; j++) {
          const tr = Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j-1]), Math.abs(lows[j] - closes[j-1]));
          sum += tr;
        }
        return sum / 14;
      });

      // Build enriched candles with ALL indicators filled
      const enrichedCandles = candles.map((c: any, i: number) => ({
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i],
        vwap: vwapArr[i] ?? closes[i],  // fallback to close if null
        bbUpper: bbResult.upper[i] ?? (closes[i] * 1.02),  // fallback: +2%
        bbLower: bbResult.lower[i] ?? (closes[i] * 0.98),  // fallback: -2%
        ma5: ma5[i] ?? closes[i],
        ma25: ma25[i] ?? closes[i],
        rsi: rsiArr[i] ?? 50,  // fallback: neutral RSI
        atr: atrArr[i] ?? (closes[i] * 0.01),
        time: candles[i].candleTime,
      }));

      // Run detectSignals
      const signals = detectSignals(enrichedCandles, symbol);

      // Track positions - simulate medium signals only
      let inLongPosition = false;
      let inShortPosition = false;
      let longEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };
      let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };

      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i].signal;
        const time = candles[i]?.candleTime as string;
        if (!time) continue;

        const hour = parseInt(time.split(":")[0]);
        const min = parseInt(time.split(":")[1]);
        const timeMin = hour * 60 + min;

        // Process existing LONG position
        if (inLongPosition) {
          const profitHigh = (highs[i] - longEntry.price) / longEntry.price;
          const profitLow = (lows[i] - longEntry.price) / longEntry.price;
          if (!longEntry.beActive && profitHigh >= BE_TRIGGER) longEntry.beActive = true;
          
          if (profitHigh >= TP_PERCENT) {
            const exitPrice = longEntry.price * (1 + TP_PERCENT);
            const lots = Math.floor(2000000 / longEntry.price) * 100;
            ghostTrades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].candleTime as string,
              entryPrice: longEntry.price, exitTime: time, exitPrice,
              pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: "TP",
              signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive });
            inLongPosition = false;
          } else {
            const slLevel = longEntry.beActive ? 0 : -SL_PERCENT;
            if (profitLow <= slLevel) {
              const exitPrice = longEntry.beActive ? longEntry.price : longEntry.price * (1 - SL_PERCENT);
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              ghostTrades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].candleTime as string,
                entryPrice: longEntry.price, exitTime: time, exitPrice,
                pnl: (exitPrice - longEntry.price) * (lots / 100), exitReason: longEntry.beActive ? "BE" : "SL",
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive });
              inLongPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / longEntry.price) * 100;
              ghostTrades.push({ date, symbol, side: "long", entryTime: candles[longEntry.idx].candleTime as string,
                entryPrice: longEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (closes[i] - longEntry.price) * (lots / 100), exitReason: "TIME",
                signalReason: longEntry.reason, confidence: longEntry.conf, beTriggered: longEntry.beActive });
              inLongPosition = false;
            }
          }
        }

        // Process existing SHORT position
        if (inShortPosition) {
          const profitHigh = (shortEntry.price - lows[i]) / shortEntry.price;
          const lossHigh = (highs[i] - shortEntry.price) / shortEntry.price;
          if (!shortEntry.beActive && profitHigh >= BE_TRIGGER) shortEntry.beActive = true;
          
          if (profitHigh >= TP_PERCENT) {
            const exitPrice = shortEntry.price * (1 - TP_PERCENT);
            const lots = Math.floor(2000000 / shortEntry.price) * 100;
            ghostTrades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].candleTime as string,
              entryPrice: shortEntry.price, exitTime: time, exitPrice,
              pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: "TP",
              signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive });
            inShortPosition = false;
          } else {
            const slLevel = shortEntry.beActive ? 0 : SL_PERCENT;
            if (lossHigh >= slLevel) {
              const exitPrice = shortEntry.beActive ? shortEntry.price : shortEntry.price * (1 + SL_PERCENT);
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              ghostTrades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].candleTime as string,
                entryPrice: shortEntry.price, exitTime: time, exitPrice,
                pnl: (shortEntry.price - exitPrice) * (lots / 100), exitReason: shortEntry.beActive ? "BE" : "SL",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive });
              inShortPosition = false;
            } else if (timeMin >= 15 * 60 + 20) {
              const lots = Math.floor(2000000 / shortEntry.price) * 100;
              ghostTrades.push({ date, symbol, side: "short", entryTime: candles[shortEntry.idx].candleTime as string,
                entryPrice: shortEntry.price, exitTime: time, exitPrice: closes[i],
                pnl: (shortEntry.price - closes[i]) * (lots / 100), exitReason: "TIME",
                signalReason: shortEntry.reason, confidence: shortEntry.conf, beTriggered: shortEntry.beActive });
              inShortPosition = false;
            }
          }
        }

        // Check new entry (medium signals only)
        if (!sig || sig.confidence !== "medium") continue;
        if (timeMin < 9 * 60 + 5 || timeMin >= 14 * 60 + 30) continue;
        if ((timeMin >= 11*60 && timeMin < 11*60+30) || (timeMin >= 12*60+30 && timeMin < 13*60)) continue;

        if (sig.type === "buy" && !inLongPosition) {
          inLongPosition = true;
          longEntry = { idx: i, price: closes[i], reason: sig.reason, conf: "medium", beActive: false };
        } else if (sig.type === "sell" && !inShortPosition) {
          inShortPosition = true;
          shortEntry = { idx: i, price: closes[i], reason: sig.reason, conf: "medium", beActive: false };
        }
      }
    }
  }

  // Results
  console.log(`${"=".repeat(70)}`);
  console.log(`=== medium品質シグナル仮想エントリー結果 ===`);
  console.log(`${"=".repeat(70)}`);

  const longs = ghostTrades.filter(t => t.side === "long");
  const shorts = ghostTrades.filter(t => t.side === "short");
  const totalPnl = ghostTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = ghostTrades.filter(t => t.pnl > 0);
  const losses = ghostTrades.filter(t => t.pnl < 0);
  const bes = ghostTrades.filter(t => t.pnl === 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);

  console.log(`\n--- 全体統計 ---`);
  console.log(`  取引数: ${ghostTrades.length}件 (LONG: ${longs.length}, SHORT: ${shorts.length})`);
  console.log(`  勝ち: ${wins.length}件 (${ghostTrades.length > 0 ? (wins.length/ghostTrades.length*100).toFixed(0) : 0}%)`);
  console.log(`  負け: ${losses.length}件`);
  console.log(`  BE: ${bes.length}件`);
  console.log(`  総利益: +${totalWin.toFixed(0)}円`);
  console.log(`  総損失: ${totalLoss.toFixed(0)}円`);
  console.log(`  純損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);
  console.log(`  PF: ${totalLoss !== 0 ? (totalWin / Math.abs(totalLoss)).toFixed(2) : "∞"}`);
  if (ghostTrades.length > 0) {
    console.log(`  期待値: ${(totalPnl / ghostTrades.length).toFixed(0)}円/回`);
  }

  // By side
  console.log(`\n--- LONG vs SHORT ---`);
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  const longWins = longs.filter(t => t.pnl > 0).length;
  const shortWins = shorts.filter(t => t.pnl > 0).length;
  const longLosses = longs.filter(t => t.pnl < 0).length;
  const shortLosses = shorts.filter(t => t.pnl < 0).length;
  console.log(`  LONG:  ${longs.length}件 | 勝率${longs.length > 0 ? (longWins/longs.length*100).toFixed(0) : 0}% | ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(0)}円 | PF:${longLosses > 0 ? (longs.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0) / Math.abs(longs.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0))).toFixed(2) : "∞"}`);
  console.log(`  SHORT: ${shorts.length}件 | 勝率${shorts.length > 0 ? (shortWins/shorts.length*100).toFixed(0) : 0}% | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(0)}円 | PF:${shortLosses > 0 ? (shorts.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0) / Math.abs(shorts.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0))).toFixed(2) : "∞"}`);

  // By date
  console.log(`\n--- 日別 ---`);
  const byDate = new Map<string, { count: number; pnl: number; longCount: number; shortCount: number }>();
  for (const t of ghostTrades) {
    if (!byDate.has(t.date)) byDate.set(t.date, { count: 0, pnl: 0, longCount: 0, shortCount: 0 });
    const d = byDate.get(t.date)!;
    d.count++; d.pnl += t.pnl;
    if (t.side === "long") d.longCount++; else d.shortCount++;
  }
  for (const [date, v] of [...byDate.entries()].sort()) {
    console.log(`  ${date}: ${v.count}件 (L:${v.longCount} S:${v.shortCount}) | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(0)}円`);
  }

  // By symbol
  console.log(`\n--- 銘柄別 ---`);
  const bySymbol = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of ghostTrades) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, { count: 0, pnl: 0, wins: 0 });
    const s = bySymbol.get(t.symbol)!;
    s.count++; s.pnl += t.pnl; if (t.pnl > 0) s.wins++;
  }
  for (const [sym, v] of [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${v.count}件 | 勝率${(v.wins/v.count*100).toFixed(0)}% | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(0)}円`);
  }

  // By signal reason (truncated)
  console.log(`\n--- シグナル種別 ---`);
  const byReason = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of ghostTrades) {
    const reason = t.signalReason.split("｜")[0].substring(0, 25);
    if (!byReason.has(reason)) byReason.set(reason, { count: 0, pnl: 0, wins: 0 });
    const r = byReason.get(reason)!;
    r.count++; r.pnl += t.pnl; if (t.pnl > 0) r.wins++;
  }
  for (const [reason, v] of [...byReason.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${reason}: ${v.count}件 | 勝率${(v.wins/v.count*100).toFixed(0)}% | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(0)}円`);
  }

  // Compare with existing system
  console.log(`\n${"=".repeat(70)}`);
  console.log(`=== 現行システムとの比較 ===`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  現行(strongのみ):  ${existingTrades.length}件 | +${existingPnl.toFixed(0)}円`);
  console.log(`  medium追加分:      ${ghostTrades.length}件 | ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);
  console.log(`  合計(仮想):        ${existingTrades.length + ghostTrades.length}件 | +${(existingPnl + totalPnl).toFixed(0)}円`);
  console.log(`  改善額:            ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);
  console.log(`  改善率:            ${((totalPnl / existingPnl) * 100).toFixed(1)}%`);

  // Conclusion
  console.log(`\n=== 結論 ===`);
  if (totalPnl > 0) {
    console.log(`  medium品質ブロックを解除すると +${totalPnl.toFixed(0)}円 の追加利益が見込める`);
    console.log(`  PF ${totalLoss !== 0 ? (totalWin / Math.abs(totalLoss)).toFixed(2) : "∞"} → 実装検討の価値あり`);
  } else {
    console.log(`  medium品質ブロックは正しく機能している（解除すると ${totalPnl.toFixed(0)}円 の損失増）`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
