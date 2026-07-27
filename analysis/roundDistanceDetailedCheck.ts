import { getDb } from "../server/db";
import { sql } from "drizzle-orm";
import { calculateRoundDistancePct } from "../server/realtimeSimEngine";

async function main() {
  const db = await getDb();

  // 7/1-7/16の大台超え/割れ経由のエントリーを取得
  const r1 = await db.execute(sql`
    SELECT id, tradeDate, tradeTime, symbol, action, price, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-01' AND tradeDate <= '2026-07-16'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
  `);
  
  console.log("=== 7/1-7/16 大台経由エントリーの0.8%フィルター再評価 ===\n");
  
  let totalEntries = 0;
  let wouldBlock = 0;
  let wouldPass = 0;
  const blockedTrades: any[] = [];
  const passedTrades: any[] = [];
  
  for (const row of (r1 as any)[0]) {
    totalEntries++;
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    
    // キリ番を reason から抽出
    const levelMatch = reason.match(/(\d+(?:\.\d+)?)円/);
    if (!levelMatch) {
      console.log(`  [SKIP] ${row.tradeDate} ${row.symbol} - キリ番抽出失敗: ${reason.substring(0, 60)}`);
      continue;
    }
    const roundLevel = parseFloat(levelMatch[1]);
    const distPct = calculateRoundDistancePct(entryPrice, roundLevel);
    const blocked = distPct > 0.8;
    
    if (blocked) {
      wouldBlock++;
      blockedTrades.push({ ...row, entryPrice, roundLevel, distPct });
    } else {
      wouldPass++;
      passedTrades.push({ ...row, entryPrice, roundLevel, distPct });
    }
  }
  
  console.log(`■ 対象エントリー: ${totalEntries}件（大台超え/割れ経由）`);
  console.log(`  0.8%でブロックされるはず: ${wouldBlock}件 (${(wouldBlock/totalEntries*100).toFixed(1)}%)`);
  console.log(`  通過するはず: ${wouldPass}件 (${(wouldPass/totalEntries*100).toFixed(1)}%)`);
  console.log("");
  
  if (blockedTrades.length > 0) {
    console.log("■ ブロックされるはずのエントリー詳細:");
    for (const t of blockedTrades) {
      console.log(`  ${t.tradeDate} ${t.tradeTime} ${t.symbol} ${t.action} @${t.entryPrice} キリ番=${t.roundLevel} 乖離率=${t.distPct.toFixed(2)}%`);
    }
  }
  console.log("");
  
  console.log("■ 通過するエントリーの乖離率分布:");
  const distBuckets: Record<string, number> = { "0-0.2%": 0, "0.2-0.4%": 0, "0.4-0.6%": 0, "0.6-0.8%": 0 };
  for (const t of passedTrades) {
    if (t.distPct <= 0.2) distBuckets["0-0.2%"]++;
    else if (t.distPct <= 0.4) distBuckets["0.2-0.4%"]++;
    else if (t.distPct <= 0.6) distBuckets["0.4-0.6%"]++;
    else distBuckets["0.6-0.8%"]++;
  }
  for (const [bucket, count] of Object.entries(distBuckets)) {
    console.log(`  ${bucket}: ${count}件`);
  }
  
  // ブロックされた取引の損益を確認
  if (blockedTrades.length > 0) {
    console.log("\n■ ブロックされるはずのエントリーの実際の損益:");
    let blockedTotalPnl = 0;
    for (const t of blockedTrades) {
      const exitResult = await db.execute(sql`
        SELECT pnl, reason as exitReason
        FROM rt_trades 
        WHERE tradeDate = ${t.tradeDate}
        AND symbol = ${t.symbol}
        AND action NOT IN ('buy', 'short')
        AND tradeTime > ${t.tradeTime}
        ORDER BY tradeTime ASC
        LIMIT 1
      `);
      const exit = (exitResult as any)[0][0];
      const pnl = exit ? Number(exit.pnl) : 0;
      const exitReason = exit ? (exit.exitReason as string).substring(0, 40) : "未決済";
      blockedTotalPnl += pnl;
      console.log(`  ${t.tradeDate} ${t.symbol} ${t.action} 乖離${t.distPct.toFixed(2)}% → 損益: ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}円 (${exitReason})`);
    }
    console.log(`  ブロック対象合計損益: ${blockedTotalPnl >= 0 ? "+" : ""}${blockedTotalPnl.toLocaleString()}円`);
  }
  
  // 通過した取引の損益
  console.log("\n■ 通過するエントリーの実際の損益:");
  let passedTotalPnl = 0;
  let passedWins = 0;
  let passedLosses = 0;
  for (const t of passedTrades) {
    const exitResult = await db.execute(sql`
      SELECT pnl
      FROM rt_trades 
      WHERE tradeDate = ${t.tradeDate}
      AND symbol = ${t.symbol}
      AND action NOT IN ('buy', 'short')
      AND tradeTime > ${t.tradeTime}
      ORDER BY tradeTime ASC
      LIMIT 1
    `);
    const exit = (exitResult as any)[0][0];
    const pnl = exit ? Number(exit.pnl) : 0;
    passedTotalPnl += pnl;
    if (pnl > 0) passedWins++;
    else passedLosses++;
  }
  console.log(`  通過エントリー: ${wouldPass}件 (勝${passedWins}/負${passedLosses})`);
  console.log(`  通過エントリー合計損益: ${passedTotalPnl >= 0 ? "+" : ""}${passedTotalPnl.toLocaleString()}円`);

  // 7/17以降の大台経由エントリーも確認
  console.log("\n\n=== 7/17-7/24 大台経由エントリーの乖離率確認 ===\n");
  const r2 = await db.execute(sql`
    SELECT tradeDate, tradeTime, symbol, action, price, reason
    FROM rt_trades 
    WHERE tradeDate >= '2026-07-17'
    AND (action = 'buy' OR action = 'short')
    AND (reason LIKE '%大台超え%' OR reason LIKE '%大台割れ%' OR reason LIKE '%大台確認%')
    ORDER BY tradeDate, tradeTime
  `);
  
  console.log("■ 7/17以降の大台経由エントリー（0.8%フィルター通過済み）:");
  for (const row of (r2 as any)[0]) {
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    const levelMatch = reason.match(/(\d+(?:\.\d+)?)円/);
    const roundLevel = levelMatch ? parseFloat(levelMatch[1]) : 0;
    const distPct = roundLevel > 0 ? calculateRoundDistancePct(entryPrice, roundLevel) : -1;
    console.log(`  ${row.tradeDate} ${row.tradeTime} ${row.symbol} ${row.action} @${entryPrice} キリ番=${roundLevel} 乖離率=${distPct.toFixed(2)}%`);
  }
  if ((r2 as any)[0].length === 0) {
    console.log("  （該当なし）");
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
