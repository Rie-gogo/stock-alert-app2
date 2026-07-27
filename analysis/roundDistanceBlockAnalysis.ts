/**
 * 大台乖離率0.8%フィルター ブロック分析
 * 
 * 7/17以降の全取引日で、大台割れ/大台超えシグナルが確認バー(5本)→押し目待ち(5本)を経て
 * エントリー時点で大台乖離率0.8%を超えてブロックされたケースを全て抽出し、
 * もしエントリーしていた場合の損益をシミュレーションする。
 */
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";

const ACTIVE_SYMBOLS = ["8035", "6857", "6976", "6526", "5803", "6981", "285A", "6920", "6758", "8316"];
const SL_PCT = 0.5;
const TP_PCT = 1.5;
const POSITION_SIZE = 3_000_000;
const ROUND_DISTANCE_THRESHOLD = 0.8; // current threshold
const CONFIRM_BARS = 5;
const PULLBACK_WAIT = 5;

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BlockedEntry {
  date: string;
  symbol: string;
  side: "long" | "short";
  signalTime: string;  // 大台割れ検出時刻
  entryTime: string;   // エントリー試行時刻（ブロックされた時刻）
  entryPrice: number;
  roundLevel: number;
  distancePct: number;
  // What-if simulation
  exitPrice: number;
  exitTime: string;
  exitReason: string;
  pnl: number;
}

function detectRoundLevel(prev: number, curr: number): { crossedBelow: boolean; crossedAbove: boolean; level: number | null } {
  const step = 100;
  const prevLevel = Math.floor(prev / step) * step;
  const currLevel = Math.floor(curr / step) * step;
  if (prevLevel === currLevel) return { crossedBelow: false, crossedAbove: false, level: null };
  if (currLevel < prevLevel) return { crossedBelow: true, crossedAbove: false, level: currLevel + step };
  return { crossedBelow: false, crossedAbove: true, level: currLevel };
}

function simulateWhatIf(candles: Candle[], entryIdx: number, side: "long" | "short"): { exitPrice: number; exitTime: string; exitReason: string; pnl: number } {
  const entryPrice = candles[entryIdx].close;
  const lots = Math.floor(POSITION_SIZE / entryPrice);

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    const time = c.time.split("T")[1]?.substring(0, 5) || "";

    if (side === "short") {
      const slPrice = entryPrice * (1 + SL_PCT / 100);
      const tpPrice = entryPrice * (1 - TP_PCT / 100);
      if (c.high >= slPrice) return { exitPrice: slPrice, exitTime: time, exitReason: "SL", pnl: -lots * (slPrice - entryPrice) };
      if (c.low <= tpPrice) return { exitPrice: tpPrice, exitTime: time, exitReason: "TP", pnl: lots * (entryPrice - tpPrice) };
      if (time >= "15:20") return { exitPrice: c.close, exitTime: time, exitReason: "EOD", pnl: lots * (entryPrice - c.close) };
    } else {
      const slPrice = entryPrice * (1 - SL_PCT / 100);
      const tpPrice = entryPrice * (1 + TP_PCT / 100);
      if (c.low <= slPrice) return { exitPrice: slPrice, exitTime: time, exitReason: "SL", pnl: -lots * (entryPrice - slPrice) };
      if (c.high >= tpPrice) return { exitPrice: tpPrice, exitTime: time, exitReason: "TP", pnl: lots * (tpPrice - entryPrice) };
      if (time >= "15:20") return { exitPrice: c.close, exitTime: time, exitReason: "EOD", pnl: lots * (c.close - entryPrice) };
    }
  }
  // End of data
  const last = candles[candles.length - 1];
  const pnl = side === "short" ? Math.floor(POSITION_SIZE / entryPrice) * (entryPrice - last.close) : Math.floor(POSITION_SIZE / entryPrice) * (last.close - entryPrice);
  return { exitPrice: last.close, exitTime: last.time.split("T")[1]?.substring(0, 5) || "15:25", exitReason: "EOD", pnl };
}

async function main() {
  const pool = mysql.createPool({ uri: process.env.DATABASE_URL || "", connectionLimit: 3 });
  const db = drizzle(pool);

  // Get trading days from 7/17 onwards
  const datesResult = await db.execute(
    sql`SELECT DISTINCT tradeDate FROM rt_candles WHERE tradeDate >= '2026-07-17' ORDER BY tradeDate ASC`
  );
  const dates = (datesResult[0] as any[]).map(r => r.tradeDate);
  console.log(`=== 大台乖離率0.8%フィルター ブロック分析 ===`);
  console.log(`期間: ${dates[0]} ～ ${dates[dates.length - 1]} (${dates.length}日間)`);
  console.log(`対象: ${ACTIVE_SYMBOLS.length}銘柄`);
  console.log("");

  const allBlocked: BlockedEntry[] = [];

  for (const date of dates) {
    for (const symbol of ACTIVE_SYMBOLS) {
      const result = await db.execute(
        sql`SELECT tradeDate, candleTime, open, high, low, close, volume FROM rt_candles WHERE symbol = ${symbol} AND tradeDate = ${date} ORDER BY candleTime ASC`
      );
      const rows = result[0] as any[];
      if (rows.length < 30) continue;

      const candles: Candle[] = rows.map(r => ({
        time: `${r.tradeDate}T${r.candleTime}`,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume ?? 0,
      }));

      // Simulate the 大台割れ/超え detection → confirm → pullback → entry flow
      type PendingState = { direction: "sell" | "buy"; level: number; confirmCount: number; startIdx: number };
      type PullbackState = { direction: "sell" | "buy"; level: number; waitCount: number; startIdx: number };
      
      let pending: PendingState | null = null;
      let pullback: PullbackState | null = null;

      for (let i = 1; i < candles.length; i++) {
        const candle = candles[i];
        const prev = candles[i - 1];
        const time = candle.time.split("T")[1]?.substring(0, 5) || "";

        // Skip before entry time
        if (time < "09:30") continue;
        if (time >= "15:00") continue;

        // Process pullback state first
        if (pullback) {
          pullback.waitCount++;
          // Cancel if price crosses back
          if (pullback.direction === "sell" && candle.close > pullback.level) {
            pullback = null;
            continue;
          }
          if (pullback.direction === "buy" && candle.close < pullback.level) {
            pullback = null;
            continue;
          }
          // Timeout → entry attempt
          if (pullback.waitCount > PULLBACK_WAIT) {
            const side: "long" | "short" = pullback.direction === "buy" ? "long" : "short";
            const distPct = Math.abs(candle.close - pullback.level) / pullback.level * 100;
            
            if (distPct > ROUND_DISTANCE_THRESHOLD) {
              // BLOCKED! Simulate what-if
              const whatIf = simulateWhatIf(candles, i, side);
              allBlocked.push({
                date,
                symbol,
                side,
                signalTime: candles[pullback.startIdx]?.time.split("T")[1]?.substring(0, 5) || "",
                entryTime: time,
                entryPrice: candle.close,
                roundLevel: pullback.level,
                distancePct: distPct,
                ...whatIf,
              });
            }
            pullback = null;
            continue;
          }
          // Check for pullback (price retraces toward level)
          if (pullback.direction === "sell") {
            // For short: pullback = price goes back up toward level
            if (candle.close > prev.close && Math.abs(candle.close - pullback.level) / pullback.level * 100 < 0.3) {
              // Pullback confirmed - entry attempt
              const distPct = Math.abs(candle.close - pullback.level) / pullback.level * 100;
              if (distPct > ROUND_DISTANCE_THRESHOLD) {
                const whatIf = simulateWhatIf(candles, i, "short");
                allBlocked.push({
                  date,
                  symbol,
                  side: "short",
                  signalTime: candles[pullback.startIdx]?.time.split("T")[1]?.substring(0, 5) || "",
                  entryTime: time,
                  entryPrice: candle.close,
                  roundLevel: pullback.level,
                  distancePct: distPct,
                  ...whatIf,
                });
              }
              pullback = null;
              continue;
            }
          }
          continue;
        }

        // Process pending confirmation state
        if (pending) {
          // Check if still below/above level
          if (pending.direction === "sell" && candle.close < pending.level) {
            pending.confirmCount++;
          } else if (pending.direction === "buy" && candle.close > pending.level) {
            pending.confirmCount++;
          } else {
            pending = null;
            continue;
          }

          if (pending.confirmCount >= CONFIRM_BARS) {
            // Confirmed! Move to pullback state
            pullback = { direction: pending.direction, level: pending.level, waitCount: 0, startIdx: pending.startIdx };
            pending = null;
          }
          continue;
        }

        // Detect new round level cross
        const roundCheck = detectRoundLevel(prev.close, candle.close);
        if (roundCheck.crossedBelow && roundCheck.level) {
          pending = { direction: "sell", level: roundCheck.level, confirmCount: 0, startIdx: i };
        } else if (roundCheck.crossedAbove && roundCheck.level) {
          pending = { direction: "buy", level: roundCheck.level, confirmCount: 0, startIdx: i };
        }
      }
    }
  }

  // Results
  console.log(`=== ブロックされた取引: ${allBlocked.length}件 ===\n`);
  
  if (allBlocked.length === 0) {
    console.log("ブロックされた取引はありませんでした。");
    await pool.end();
    return;
  }

  // Summary
  const totalPnl = allBlocked.reduce((s, b) => s + b.pnl, 0);
  const wins = allBlocked.filter(b => b.pnl > 0).length;
  const losses = allBlocked.filter(b => b.pnl <= 0).length;
  
  console.log(`=== サマリー ===`);
  console.log(`ブロック件数: ${allBlocked.length}`);
  console.log(`もしエントリーしていたら:`);
  console.log(`  勝敗: ${wins}勝${losses}敗 (勝率${(wins / allBlocked.length * 100).toFixed(1)}%)`);
  console.log(`  合計損益: ${Math.round(totalPnl).toLocaleString()}円`);
  console.log(`  1件平均: ${Math.round(totalPnl / allBlocked.length).toLocaleString()}円`);
  console.log("");

  // By exit reason
  const byReason = new Map<string, { count: number; pnl: number }>();
  for (const b of allBlocked) {
    const r = byReason.get(b.exitReason) || { count: 0, pnl: 0 };
    r.count++;
    r.pnl += b.pnl;
    byReason.set(b.exitReason, r);
  }
  console.log("=== 決済理由別 ===");
  console.log("| 理由 | 件数 | 損益 |");
  console.log("|------|------|------|");
  for (const [reason, data] of byReason) {
    console.log(`| ${reason} | ${data.count} | ${Math.round(data.pnl).toLocaleString()}円 |`);
  }
  console.log("");

  // By side
  const shorts = allBlocked.filter(b => b.side === "short");
  const longs = allBlocked.filter(b => b.side === "long");
  console.log("=== サイド別 ===");
  console.log("| サイド | 件数 | 勝率 | 損益 | 1件平均 |");
  console.log("|--------|------|------|------|---------|");
  if (shorts.length > 0) {
    const shortWins = shorts.filter(b => b.pnl > 0).length;
    const shortPnl = shorts.reduce((s, b) => s + b.pnl, 0);
    console.log(`| SHORT | ${shorts.length} | ${(shortWins / shorts.length * 100).toFixed(1)}% | ${Math.round(shortPnl).toLocaleString()}円 | ${Math.round(shortPnl / shorts.length).toLocaleString()}円 |`);
  }
  if (longs.length > 0) {
    const longWins = longs.filter(b => b.pnl > 0).length;
    const longPnl = longs.reduce((s, b) => s + b.pnl, 0);
    console.log(`| LONG | ${longs.length} | ${(longWins / longs.length * 100).toFixed(1)}% | ${Math.round(longPnl).toLocaleString()}円 | ${Math.round(longPnl / longs.length).toLocaleString()}円 |`);
  }
  console.log("");

  // By symbol
  console.log("=== 銘柄別 ===");
  console.log("| 銘柄 | 件数 | 勝率 | 損益 | 1件平均 |");
  console.log("|------|------|------|------|---------|");
  for (const symbol of ACTIVE_SYMBOLS) {
    const symBlocked = allBlocked.filter(b => b.symbol === symbol);
    if (symBlocked.length === 0) continue;
    const symWins = symBlocked.filter(b => b.pnl > 0).length;
    const symPnl = symBlocked.reduce((s, b) => s + b.pnl, 0);
    console.log(`| ${symbol} | ${symBlocked.length} | ${(symWins / symBlocked.length * 100).toFixed(1)}% | ${Math.round(symPnl).toLocaleString()}円 | ${Math.round(symPnl / symBlocked.length).toLocaleString()}円 |`);
  }
  console.log("");

  // By date
  console.log("=== 日別 ===");
  console.log("| 日付 | 件数 | 勝率 | 損益 |");
  console.log("|------|------|------|------|");
  for (const date of dates) {
    const dayBlocked = allBlocked.filter(b => b.date === date);
    if (dayBlocked.length === 0) continue;
    const dayWins = dayBlocked.filter(b => b.pnl > 0).length;
    const dayPnl = dayBlocked.reduce((s, b) => s + b.pnl, 0);
    console.log(`| ${date} | ${dayBlocked.length} | ${(dayWins / dayBlocked.length * 100).toFixed(1)}% | ${Math.round(dayPnl).toLocaleString()}円 |`);
  }
  console.log("");

  // By distance range
  console.log("=== 乖離率レンジ別 ===");
  const ranges = [
    { min: 0.8, max: 1.0, label: "0.8-1.0%" },
    { min: 1.0, max: 1.5, label: "1.0-1.5%" },
    { min: 1.5, max: 2.0, label: "1.5-2.0%" },
    { min: 2.0, max: 5.0, label: "2.0%+" },
  ];
  console.log("| 乖離率 | 件数 | 勝率 | 損益 | 1件平均 | 判定 |");
  console.log("|--------|------|------|------|---------|------|");
  for (const range of ranges) {
    const rangeBlocked = allBlocked.filter(b => b.distancePct > range.min && b.distancePct <= range.max);
    if (rangeBlocked.length === 0) continue;
    const rangeWins = rangeBlocked.filter(b => b.pnl > 0).length;
    const rangePnl = rangeBlocked.reduce((s, b) => s + b.pnl, 0);
    const avgPnl = rangePnl / rangeBlocked.length;
    const judgment = avgPnl > 0 ? "★解除候補" : "ブロック正解";
    console.log(`| ${range.label} | ${rangeBlocked.length} | ${(rangeWins / rangeBlocked.length * 100).toFixed(1)}% | ${Math.round(rangePnl).toLocaleString()}円 | ${Math.round(avgPnl).toLocaleString()}円 | ${judgment} |`);
  }
  console.log("");

  // Detail list
  console.log("=== 全ブロック詳細 ===");
  console.log("| 日付 | 銘柄 | サイド | シグナル時刻 | エントリー時刻 | 価格 | キリ番 | 乖離率 | 結果 | 損益 |");
  console.log("|------|------|--------|-------------|---------------|------|--------|--------|------|------|");
  for (const b of allBlocked.sort((a, c) => a.date.localeCompare(c.date) || a.entryTime.localeCompare(c.entryTime))) {
    console.log(`| ${b.date} | ${b.symbol} | ${b.side.toUpperCase()} | ${b.signalTime} | ${b.entryTime} | ${b.entryPrice} | ${b.roundLevel} | ${b.distancePct.toFixed(2)}% | ${b.exitReason} | ${Math.round(b.pnl).toLocaleString()}円 |`);
  }

  await pool.end();
}

main().catch(console.error);
