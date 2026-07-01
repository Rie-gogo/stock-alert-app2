/**
 * sell_pressure時LONG許可シミュレーション v2
 * 対象: 6981 (村田製作所), 6920 (レーザーテック)
 * 条件: strong OR medium + 大台超え + close > VWAP + 直近3本陽線優勢
 * 
 * 6/17〜6/30の全日程で検証
 */
import { getDb } from "../server/db";
import { rtCandles } from "../drizzle/schema";
import { eq, and, inArray, gte, lte } from "drizzle-orm";
import { detectSignals, calcBollinger } from "../server/routers/stockData";
import { calcVWAP, detectRoundLevel } from "../server/vwap";
import { calcATR, classifyIntradayRegime } from "../server/intradayRegime";
import { evaluateConfirmation } from "../server/signalConfirmation";

const TARGET_SYMBOLS = ["6981", "6920"];
const SL_PERCENT = 0.005; // 0.5%
const TP_PERCENT = 0.015; // 1.5%
const BE_TRIGGER = 0.005; // 0.5% → BE移動

interface Trade {
  date: string;
  symbol: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  exitReason: string;
  signalReason: string;
  confidence: string;
  beTriggered: boolean;
  maxProfit: number;
}

function trailingAvgVolume(volumes: number[], idx: number, window: number): number {
  let sum = 0, count = 0;
  for (let j = Math.max(0, idx - window); j < idx; j++) { sum += volumes[j]; count++; }
  return count > 0 ? sum / count : volumes[idx];
}

function ma25Slope(ma25Series: (number | null)[], i: number): number | null {
  if (i < 5) return null;
  const curr = ma25Series[i], prev = ma25Series[i - 5];
  if (curr === null || prev === null || prev === 0) return null;
  return (curr - prev) / prev * 100;
}

async function main() {
  const db = await getDb();
  
  // Get all dates
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

  const allTrades: Trade[] = [];
  const dailySummary: { date: string; trades: number; pnl: number }[] = [];

  // Get unique dates
  const dates = [...new Set(allCandles.map(c => c.tradeDate))].sort();
  console.log(`検証期間: ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象銘柄: ${TARGET_SYMBOLS.join(", ")}`);
  console.log(`条件: 大台超え + (strong OR medium) + close > VWAP + 直近3本陽線優勢`);
  console.log(`SL: ${SL_PERCENT * 100}%, TP: ${TP_PERCENT * 100}%, BE: +${BE_TRIGGER * 100}%でSL→建値\n`);

  for (const date of dates) {
    let dayPnl = 0;
    let dayTrades = 0;

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
      const dayOpen = opens[0];

      // VWAP
      const vwapCandles = candles.map((c: any) => ({
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: Number(c.volume),
      }));
      const vwapArr = calcVWAP(vwapCandles);

      // MA
      const ma5: (number | null)[] = closes.map((_, i) => {
        if (i < 4) return null;
        return (closes[i]+closes[i-1]+closes[i-2]+closes[i-3]+closes[i-4])/5;
      });
      const ma25: (number | null)[] = closes.map((_, i) => {
        if (i < 24) return null;
        let sum = 0; for (let j = 0; j < 25; j++) sum += closes[i-j]; return sum/25;
      });

      // Board signal from candle data
      const boardSignals = candles.map((c: any) => {
        try {
          const bs = typeof c.boardSnapshot === 'string' ? JSON.parse(c.boardSnapshot) : c.boardSnapshot;
          return bs?.signal || 'neutral';
        } catch { return 'neutral'; }
      });

      // Track positions - only 1 position per symbol at a time
      let inPosition = false;
      let entryIdx = -1;
      let entryPrice = 0;
      let beActive = false;
      let entryReason = "";
      let entryConf = "";

      for (let i = 25; i < candles.length; i++) {
        const time = candles[i].candleTime as string;
        
        // Skip time filters (same as production)
        const hour = parseInt(time.split(":")[0]);
        const min = parseInt(time.split(":")[1]);
        const timeMin = hour * 60 + min;
        if (timeMin < 9 * 60 + 5) continue; // 09:05前スキップ
        if (timeMin >= 15 * 60 + 20) continue; // 15:20以降スキップ

        if (inPosition) {
          // Check exit conditions
          const high = highs[i];
          const low = lows[i];
          const close = closes[i];
          const profitHigh = (high - entryPrice) / entryPrice;
          const profitLow = (low - entryPrice) / entryPrice;
          const profitClose = (close - entryPrice) / entryPrice;

          // Check BE trigger
          if (!beActive && profitHigh >= BE_TRIGGER) {
            beActive = true;
          }

          // Check TP
          if (profitHigh >= TP_PERCENT) {
            const exitPrice = entryPrice * (1 + TP_PERCENT);
            const lots = Math.floor(2000000 / entryPrice) * 100; // 200万円分
            const pnl = (exitPrice - entryPrice) * (lots / 100);
            allTrades.push({
              date, symbol, entryTime: candles[entryIdx].candleTime as string,
              entryPrice, exitTime: time, exitPrice,
              pnl, pnlPercent: TP_PERCENT * 100,
              exitReason: "TP(+1.5%)", signalReason: entryReason,
              confidence: entryConf, beTriggered: beActive,
              maxProfit: profitHigh * 100,
            });
            dayPnl += pnl; dayTrades++;
            inPosition = false;
            continue;
          }

          // Check SL
          const slLevel = beActive ? 0 : -SL_PERCENT;
          if (profitLow <= slLevel) {
            const exitPrice = beActive ? entryPrice : entryPrice * (1 - SL_PERCENT);
            const lots = Math.floor(2000000 / entryPrice) * 100;
            const pnl = (exitPrice - entryPrice) * (lots / 100);
            allTrades.push({
              date, symbol, entryTime: candles[entryIdx].candleTime as string,
              entryPrice, exitTime: time, exitPrice,
              pnl, pnlPercent: beActive ? 0 : -SL_PERCENT * 100,
              exitReason: beActive ? "BE(建値決済)" : "SL(-0.5%)",
              signalReason: entryReason, confidence: entryConf,
              beTriggered: beActive, maxProfit: profitHigh * 100,
            });
            dayPnl += pnl; dayTrades++;
            inPosition = false;
            continue;
          }

          // Time exit at 15:20
          if (timeMin >= 15 * 60 + 20) {
            const lots = Math.floor(2000000 / entryPrice) * 100;
            const pnl = (close - entryPrice) * (lots / 100);
            allTrades.push({
              date, symbol, entryTime: candles[entryIdx].candleTime as string,
              entryPrice, exitTime: time, exitPrice: close,
              pnl, pnlPercent: profitClose * 100,
              exitReason: "時間切れ", signalReason: entryReason,
              confidence: entryConf, beTriggered: beActive,
              maxProfit: profitHigh * 100,
            });
            dayPnl += pnl; dayTrades++;
            inPosition = false;
            continue;
          }
        } else {
          // Check entry conditions
          const time = candles[i].candleTime as string;
          const hour = parseInt(time.split(":")[0]);
          const min = parseInt(time.split(":")[1]);
          const timeMin = hour * 60 + min;
          
          // Time filter: 11:00-11:30, 12:30-13:00 blocked
          if ((timeMin >= 11*60 && timeMin < 11*60+30) || (timeMin >= 12*60+30 && timeMin < 13*60)) continue;
          // No entry after 14:30
          if (timeMin >= 14*60+30) continue;

          // Check if sell_pressure (this is the condition we're testing)
          const boardSig = boardSignals[i];
          const isSellPressure = boardSig === "sell_pressure";

          // 大台超え check
          if (i < 1) continue;
          const { crossedAbove, level } = detectRoundLevel(closes[i-1], closes[i]);
          if (!crossedAbove || level === null) continue;

          // close > VWAP
          const vwap = vwapArr[i];
          if (vwap === null || closes[i] <= vwap) continue;

          // 直近3本陽線優勢
          if (i < 3) continue;
          const recent3 = [
            { o: opens[i-2], c: closes[i-2] },
            { o: opens[i-1], c: closes[i-1] },
            { o: opens[i], c: closes[i] },
          ];
          const bullishCount = recent3.filter(x => x.c > x.o).length;
          if (bullishCount < 2) continue;

          // Confidence check (strong or medium)
          const slope = ma25Slope(ma25, i);
          const dayChange = (closes[i] - dayOpen) / dayOpen * 100;
          const regime = classifyIntradayRegime({ slope, dayChange: dayChange });
          
          const conf = evaluateConfirmation({
            type: "buy",
            close: closes[i],
            volume: volumes[i],
            avgVolume: trailingAvgVolume(volumes, i, 10),
            ma5: ma5[i] ?? closes[i],
            ma25: ma25[i] ?? closes[i],
            momentum: 0,
            regime,
          });

          if (conf.confidence === "weak") continue;

          // ENTRY!
          inPosition = true;
          entryIdx = i;
          entryPrice = closes[i];
          beActive = false;
          entryReason = `大台超え(${level}円) sell_pressure=${isSellPressure}`;
          entryConf = conf.confidence;

          console.log(`  ENTRY: ${date} ${symbol} ${time} ${level}円突破 close=${closes[i]} vwap=${vwap.toFixed(0)} conf=${conf.confidence} board=${boardSig}`);
        }
      }
    }

    dailySummary.push({ date, trades: dayTrades, pnl: dayPnl });
  }

  // Results
  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== シミュレーション結果 ===`);
  console.log(`${"=".repeat(60)}`);

  console.log(`\n--- 日別サマリー ---`);
  let totalPnl = 0;
  for (const d of dailySummary) {
    if (d.trades > 0) {
      console.log(`  ${d.date}: ${d.trades}件 | ${d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(0)}円`);
    }
    totalPnl += d.pnl;
  }

  console.log(`\n--- 全トレード詳細 ---`);
  for (const t of allTrades) {
    console.log(`  ${t.date} ${t.symbol} ${t.entryTime}→${t.exitTime} | entry=${t.entryPrice} | ${t.exitReason} | ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}円 | ${t.signalReason} | conf=${t.confidence} | BE=${t.beTriggered}`);
  }

  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl < 0);
  const bes = allTrades.filter(t => t.pnl === 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = losses.reduce((s, t) => s + t.pnl, 0);

  console.log(`\n--- 統計 ---`);
  console.log(`  取引数: ${allTrades.length}件`);
  console.log(`  勝ち: ${wins.length}件 (${(wins.length / allTrades.length * 100).toFixed(0)}%)`);
  console.log(`  負け: ${losses.length}件`);
  console.log(`  BE: ${bes.length}件`);
  console.log(`  総利益: +${totalWin.toFixed(0)}円`);
  console.log(`  総損失: ${totalLoss.toFixed(0)}円`);
  console.log(`  純損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(0)}円`);
  console.log(`  PF: ${totalLoss !== 0 ? (totalWin / Math.abs(totalLoss)).toFixed(2) : "∞"}`);
  if (allTrades.length > 0) {
    console.log(`  平均利益: +${wins.length > 0 ? (totalWin / wins.length).toFixed(0) : 0}円`);
    console.log(`  平均損失: ${losses.length > 0 ? (totalLoss / losses.length).toFixed(0) : 0}円`);
    console.log(`  期待値: ${(totalPnl / allTrades.length).toFixed(0)}円/回`);
  }

  // sell_pressure vs non-sell_pressure breakdown
  const spTrades = allTrades.filter(t => t.signalReason.includes("sell_pressure=true"));
  const nonSpTrades = allTrades.filter(t => t.signalReason.includes("sell_pressure=false"));
  console.log(`\n--- sell_pressure別 ---`);
  console.log(`  sell_pressure中: ${spTrades.length}件 | ${spTrades.reduce((s,t) => s+t.pnl, 0).toFixed(0)}円`);
  console.log(`  non-sell_pressure: ${nonSpTrades.length}件 | ${nonSpTrades.reduce((s,t) => s+t.pnl, 0).toFixed(0)}円`);

  // BE analysis
  console.log(`\n--- BEストップ分析 ---`);
  const beTriggered = allTrades.filter(t => t.beTriggered);
  console.log(`  BE発動: ${beTriggered.length}件`);
  for (const t of beTriggered) {
    console.log(`    ${t.date} ${t.symbol} ${t.entryTime} | ${t.exitReason} | maxProfit=${t.maxProfit.toFixed(2)}%`);
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
