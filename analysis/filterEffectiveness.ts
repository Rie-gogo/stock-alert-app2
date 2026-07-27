import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { calculateRoundDistancePct } from "../server/realtimeSimEngine";

async function main() {
  const db = await getDb();

  const r1 = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
  `);
  
  // Group by distance range and calculate PnL for each group
  const groups: Record<string, { count: number, wins: number, losses: number, totalPnl: number }> = {
    "0.0-0.8% (通過)": { count: 0, wins: 0, losses: 0, totalPnl: 0 },
    "0.8-1.5% (ブロック)": { count: 0, wins: 0, losses: 0, totalPnl: 0 },
    "1.5-2.5% (ブロック)": { count: 0, wins: 0, losses: 0, totalPnl: 0 },
    "2.5%+ (ブロック)": { count: 0, wins: 0, losses: 0, totalPnl: 0 },
  };
  
  for (const row of (r1 as any)[0]) {
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    const levelMatch = reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
    if (!levelMatch) continue;
    const roundLevel = parseFloat(levelMatch[1]);
    const distPct = calculateRoundDistancePct(entryPrice, roundLevel);
    
    let group: string;
    if (distPct <= 0.8) group = "0.0-0.8% (通過)";
    else if (distPct <= 1.5) group = "0.8-1.5% (ブロック)";
    else if (distPct <= 2.5) group = "1.5-2.5% (ブロック)";
    else group = "2.5%+ (ブロック)";
    
    const exitResult = await db.execute(sql`
      SELECT pnl FROM rt_trades 
      WHERE tradeDate = ${row.tradeDate} AND symbol = ${row.symbol}
      AND action NOT IN ('buy', 'short') AND tradeTime > ${row.tradeTime}
      ORDER BY tradeTime ASC LIMIT 1
    `);
    const pnl = (exitResult as any)[0][0] ? Number((exitResult as any)[0][0].pnl) : 0;
    
    groups[group].count++;
    groups[group].totalPnl += pnl;
    if (pnl > 0) groups[group].wins++;
    else groups[group].losses++;
  }
  
  console.log("■ 乖離率帯別パフォーマンス（7/1-7/16 大台エントリー61件）\n");
  console.log(`${"乖離率帯".padEnd(22)} ${"件数".padStart(4)} ${"勝率".padStart(6)} ${"合計損益".padStart(12)} ${"1件平均".padStart(10)}`);
  console.log("-".repeat(60));
  
  for (const [range, data] of Object.entries(groups)) {
    if (data.count === 0) continue;
    const winRate = (data.wins / data.count * 100).toFixed(0);
    const avgPnl = Math.round(data.totalPnl / data.count);
    const pnlSign = data.totalPnl >= 0 ? "+" : "";
    const avgSign = avgPnl >= 0 ? "+" : "";
    console.log(
      `${range.padEnd(22)} ${String(data.count).padStart(4)} ${(winRate + "%").padStart(6)} ${(pnlSign + data.totalPnl.toLocaleString() + "円").padStart(12)} ${(avgSign + avgPnl.toLocaleString() + "円").padStart(10)}`
    );
  }
  
  console.log("\n■ フィルター効果の判定:");
  const passGroup = groups["0.0-0.8% (通過)"];
  const blockGroups = [groups["0.8-1.5% (ブロック)"], groups["1.5-2.5% (ブロック)"], groups["2.5%+ (ブロック)"]];
  const blockTotal = blockGroups.reduce((sum, g) => sum + g.count, 0);
  const blockPnl = blockGroups.reduce((sum, g) => sum + g.totalPnl, 0);
  const blockWins = blockGroups.reduce((sum, g) => sum + g.wins, 0);
  
  console.log(`  通過グループ: ${passGroup.count}件, 勝率${(passGroup.wins/passGroup.count*100).toFixed(0)}%, 合計${passGroup.totalPnl >= 0 ? "+" : ""}${passGroup.totalPnl.toLocaleString()}円`);
  console.log(`  ブロックグループ: ${blockTotal}件, 勝率${(blockWins/blockTotal*100).toFixed(0)}%, 合計${blockPnl >= 0 ? "+" : ""}${blockPnl.toLocaleString()}円`);
  
  if (blockPnl < 0) {
    console.log("\n  → フィルターは損失トレードを正しくブロックしている（ブロック対象は損失）");
  } else {
    console.log("\n  → ★問題: フィルターは利益トレードもブロックしている（ブロック対象に利益あり）");
    console.log(`    ブロックにより失われた利益: ${blockPnl.toLocaleString()}円`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
