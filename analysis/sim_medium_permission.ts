/**
 * medium品質ブロック妥当性検証シミュレーション
 * 
 * 現行: mediumシグナルは直接エントリー禁止（ステートマシントリガー以外）
 * 検証: mediumシグナルを許可した場合の損益を比較
 * 
 * 方法: 6/17〜6/30の全日程で、全銘柄のmediumシグナルを仮想エントリーし、
 *        TP/SL/BEで決済した場合の損益を計算
 */
import { getDb } from "../server/db";
import { rtCandles, rtTrades } from "../drizzle/schema";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP } from "../server/vwap";
import { calcATR, classifyIntradayRegime } from "../server/intradayRegime";
import { evaluateConfirmation } from "../server/signalConfirmation";

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
  console.log(`総損益: ${existingPnl.toFixed(0)}円`);

  // Get all candle data
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
  console.log(`\n検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象銘柄: ${TARGET_SYMBOLS.join(", ")}`);

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

      // Compute indicators
      const vwapCandles = candles.map((c: any) => ({
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: Number(c.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);
      const bbResult = calcBollinger(closes, 20, 2);

      // Build enriched candles for detectSignals
      const enrichedCandles = candles.map((c: any, i: number) => ({
        open: opens[i], high: highs[i], low: lows[i], close: closes[i],
        volume: volumes[i],
        vwap: vwapArr[i] ?? null,
        bbUpper: bbResult.upper[i] ?? null,
        bbLower: bbResult.lower[i] ?? null,
        ma5: i < 4 ? null : (closes[i]+closes[i-1]+closes[i-2]+closes[i-3]+closes[i-4])/5,
        ma25: i < 24 ? null : closes.slice(i-24, i+1).reduce((a: number, b: number) => a+b, 0)/25,
        rsi: null,
        atr: null,
        time: candles[i].candleTime,
      }));

      // Run detectSignals
      const signals = detectSignals(enrichedCandles, symbol);

      // Track positions - simulate medium signals
      let inLongPosition = false;
      let inShortPosition = false;
      let longEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };
      let shortEntry = { idx: 0, price: 0, reason: "", conf: "", beActive: false };

      for (let i = 0; i < signals.length; i++) {
        const sig = signals[i];
        const time = candles[i]?.candleTime as string;
        if (!time) continue;

        const hour = parseInt(time.split(":")[0]);
        const min = parseInt(time.split(":")[1]);
        const timeMin = hour * 60 + min;

        // Process existing positions
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

        if (inShortPosition) {
          const profitHigh = (shortEntry.price - lows[i]) / shortEntry.price;
          const profitLow = (shortEntry.price - highs[i]) / shortEntry.price;
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
            const slLevel = shortEntry.beActive ? 0 : -SL_PERCENT;
            if (profitLow <= slLevel) {
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

        // Check new entry (medium signals only - this is what we're testing)
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
  console.log(`\n${"=".repeat(70)}`);
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
  console.log(`  LONG:  ${longs.length}件 | 勝率${longs.length > 0 ? (longWins/longs.length*100).toFixed(0) : 0}% | ${longPnl >= 0 ? "+" : ""}${longPnl.toFixed(0)}円`);
  console.log(`  SHORT: ${shorts.length}件 | 勝率${shorts.length > 0 ? (shortWins/shorts.length*100).toFixed(0) : 0}% | ${shortPnl >= 0 ? "+" : ""}${shortPnl.toFixed(0)}円`);

  // By date
  console.log(`\n--- 日別 ---`);
  const byDate = new Map<string, { count: number; pnl: number }>();
  for (const t of ghostTrades) {
    if (!byDate.has(t.date)) byDate.set(t.date, { count: 0, pnl: 0 });
    const d = byDate.get(t.date)!;
    d.count++; d.pnl += t.pnl;
  }
  for (const [date, v] of [...byDate.entries()].sort()) {
    console.log(`  ${date}: ${v.count}件 | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(0)}円`);
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

  // By signal reason
  console.log(`\n--- シグナル種別 ---`);
  const byReason = new Map<string, { count: number; pnl: number; wins: number }>();
  for (const t of ghostTrades) {
    // Extract signal type from reason
    const reason = t.signalReason.split("(")[0].split(" ")[0].substring(0, 20);
    if (!byReason.has(reason)) byReason.set(reason, { count: 0, pnl: 0, wins: 0 });
    const r = byReason.get(reason)!;
    r.count++; r.pnl += t.pnl; if (t.pnl > 0) r.wins++;
  }
  for (const [reason, v] of [...byReason.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${reason}: ${v.count}件 | 勝率${(v.wins/v.count*100).toFixed(0)}% | ${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(0)}円`);
  }

  // Top 10 trades
  console.log(`\n--- ベスト10トレード ---`);
  const sorted = [...ghostTrades].sort((a, b) => b.pnl - a.pnl);
  for (const t of sorted.slice(0, 10)) {
    console.log(`  ${t.date} ${t.symbol} ${t.side.toUpperCase()} ${t.entryTime}→${t.exitTime} | ${t.exitReason} | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}円 | ${t.signalReason.substring(0, 30)}`);
  }

  console.log(`\n--- ワースト10トレード ---`);
  for (const t of sorted.slice(-10).reverse()) {
    console.log(`  ${t.date} ${t.symbol} ${t.side.toUpperCase()} ${t.entryTime}→${t.exitTime} | ${t.exitReason} | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}円 | ${t.signalReason.substring(0, 30)}`);
  }

  // Compare with existing system
  console.log(`\n${"=".repeat(70)}`);
  console.log(`=== 現行システムとの比較 ===`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  現行(strongのみ): ${existingTrades.length}件 | ${existingPnl.toFixed(0)}円`);
  console.log(`  medium追加分:     ${ghostTrades.length}件 | ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);
  console.log(`  合計(仮想):       ${existingTrades.length + ghostTrades.length}件 | ${(existingPnl + totalPnl).toFixed(0)}円`);
  console.log(`  改善額:           ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
