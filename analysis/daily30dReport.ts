import { getDb } from "../server/db";
import { sql } from "drizzle-orm";

async function main() {
  const db = await getDb();

  // Get all closed trades (exits) for the last 30 days
  const result = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, pnl, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-06-16' AND tradeDate <= '2026-07-24'
    ORDER BY tradeDate, tradeTime
  `);

  const rows = (result as any)[0];

  // Group by date
  interface DayData {
    entries: number;
    exits: number;
    wins: number;
    losses: number;
    totalPnl: number;
    trades: { symbol: string; action: string; pnl: number; reason: string }[];
  }

  const dailyMap = new Map<string, DayData>();

  for (const row of rows) {
    const date = row.tradeDate as string;
    if (!dailyMap.has(date)) {
      dailyMap.set(date, { entries: 0, exits: 0, wins: 0, losses: 0, totalPnl: 0, trades: [] });
    }
    const day = dailyMap.get(date)!;

    const action = row.action as string;
    if (action === "buy" || action === "short") {
      day.entries++;
    } else {
      // Exit trade
      day.exits++;
      const pnl = Number(row.pnl) || 0;
      day.totalPnl += pnl;
      if (pnl > 0) day.wins++;
      else day.losses++;
      day.trades.push({
        symbol: row.symbol as string,
        action,
        pnl,
        reason: row.reason as string,
      });
    }
  }

  // Sort by date
  const sortedDays = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Print daily report
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  リアルタイムシミュレーション 日別損益レポート（直近30営業日）");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  let cumulativePnl = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalTrades = 0;
  let totalPnl = 0;
  let maxDrawdown = 0;
  let peak = 0;
  let winStreak = 0;
  let loseStreak = 0;
  let maxWinStreak = 0;
  let maxLoseStreak = 0;
  let tradingDays = 0;
  let profitDays = 0;
  let lossDays = 0;

  console.log(`  ${"日付".padEnd(12)} ${"取引数".padStart(5)} ${"勝敗".padStart(6)} ${"勝率".padStart(5)} ${"日次損益".padStart(12)} ${"累計損益".padStart(12)} ${"備考"}`);
  console.log("  " + "─".repeat(80));

  for (const [date, day] of sortedDays) {
    if (day.exits === 0) continue; // Skip days with no closed trades

    tradingDays++;
    const winRate = day.exits > 0 ? (day.wins / day.exits * 100).toFixed(0) : "0";
    cumulativePnl += day.totalPnl;
    totalWins += day.wins;
    totalLosses += day.losses;
    totalTrades += day.exits;
    totalPnl += day.totalPnl;

    if (cumulativePnl > peak) peak = cumulativePnl;
    const dd = peak - cumulativePnl;
    if (dd > maxDrawdown) maxDrawdown = dd;

    if (day.totalPnl > 0) {
      profitDays++;
      winStreak = 0;
      loseStreak++;
      // Actually swap: profit day = win streak
      // Let me fix: track day-level streaks
    } else {
      lossDays++;
    }

    const pnlSign = day.totalPnl >= 0 ? "+" : "";
    const cumSign = cumulativePnl >= 0 ? "+" : "";

    // Note for special days
    let note = "";
    if (day.exits >= 5) note = `★多取引`;
    if (day.totalPnl > 50000) note = `★大勝`;
    if (day.totalPnl < -50000) note = `★大敗`;

    console.log(
      `  ${date.padEnd(12)} ${String(day.exits).padStart(5)} ${(day.wins + "勝" + day.losses + "敗").padStart(6)} ${(winRate + "%").padStart(5)} ${(pnlSign + day.totalPnl.toLocaleString() + "円").padStart(12)} ${(cumSign + cumulativePnl.toLocaleString() + "円").padStart(12)} ${note}`
    );
  }

  console.log("  " + "─".repeat(80));

  // Summary
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : "0";
  const avgPnlPerTrade = totalTrades > 0 ? Math.round(totalPnl / totalTrades) : 0;
  const avgPnlPerDay = tradingDays > 0 ? Math.round(totalPnl / tradingDays) : 0;

  // Calculate day-level win/loss streaks properly
  let currentDayStreak = 0;
  let maxDayWinStreak = 0;
  let maxDayLoseStreak = 0;
  for (const [, day] of sortedDays) {
    if (day.exits === 0) continue;
    if (day.totalPnl > 0) {
      if (currentDayStreak > 0) currentDayStreak++;
      else currentDayStreak = 1;
      if (currentDayStreak > maxDayWinStreak) maxDayWinStreak = currentDayStreak;
    } else {
      if (currentDayStreak < 0) currentDayStreak--;
      else currentDayStreak = -1;
      if (-currentDayStreak > maxDayLoseStreak) maxDayLoseStreak = -currentDayStreak;
    }
  }

  console.log("\n■ 30日間サマリー\n");
  console.log(`  取引日数: ${tradingDays}日`);
  console.log(`  総取引数: ${totalTrades}件（勝${totalWins} / 負${totalLosses}）`);
  console.log(`  勝率: ${overallWinRate}%`);
  console.log(`  合計損益: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toLocaleString()}円`);
  console.log(`  1取引平均: ${avgPnlPerTrade >= 0 ? "+" : ""}${avgPnlPerTrade.toLocaleString()}円`);
  console.log(`  1日平均: ${avgPnlPerDay >= 0 ? "+" : ""}${avgPnlPerDay.toLocaleString()}円`);
  console.log(`  勝ち日: ${profitDays}日 / 負け日: ${lossDays}日（日勝率: ${(profitDays / tradingDays * 100).toFixed(0)}%）`);
  console.log(`  最大連勝日: ${maxDayWinStreak}日`);
  console.log(`  最大連敗日: ${maxDayLoseStreak}日`);
  console.log(`  最大ドローダウン: -${maxDrawdown.toLocaleString()}円`);
  console.log(`  ピーク損益: +${peak.toLocaleString()}円`);

  // Weekly breakdown
  console.log("\n■ 週別損益\n");
  const weekMap = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const [date, day] of sortedDays) {
    if (day.exits === 0) continue;
    // Get week start (Monday)
    const d = new Date(date);
    const dayOfWeek = d.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(d);
    monday.setDate(d.getDate() - diff);
    const weekKey = monday.toISOString().split("T")[0];
    if (!weekMap.has(weekKey)) weekMap.set(weekKey, { pnl: 0, trades: 0, wins: 0 });
    const w = weekMap.get(weekKey)!;
    w.pnl += day.totalPnl;
    w.trades += day.exits;
    w.wins += day.wins;
  }

  console.log(`  ${"週（月曜始）".padEnd(14)} ${"取引数".padStart(5)} ${"勝率".padStart(5)} ${"週損益".padStart(12)}`);
  console.log("  " + "─".repeat(40));
  for (const [week, data] of [...weekMap.entries()].sort()) {
    const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(0) : "0";
    const sign = data.pnl >= 0 ? "+" : "";
    console.log(`  ${week.padEnd(14)} ${String(data.trades).padStart(5)} ${(wr + "%").padStart(5)} ${(sign + data.pnl.toLocaleString() + "円").padStart(12)}`);
  }

  // PF calculation
  const grossProfit = rows
    .filter((r: any) => r.action !== "buy" && r.action !== "short" && Number(r.pnl) > 0)
    .reduce((sum: number, r: any) => sum + Number(r.pnl), 0);
  const grossLoss = Math.abs(rows
    .filter((r: any) => r.action !== "buy" && r.action !== "short" && Number(r.pnl) < 0)
    .reduce((sum: number, r: any) => sum + Number(r.pnl), 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";

  console.log(`\n■ リスク指標`);
  console.log(`  プロフィットファクター: ${pf}`);
  console.log(`  総利益: +${grossProfit.toLocaleString()}円`);
  console.log(`  総損失: -${grossLoss.toLocaleString()}円`);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
