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
  
  // Collect all entries with their distance and PnL
  const entries: { distPct: number, pnl: number }[] = [];
  
  for (const row of (r1 as any)[0]) {
    const reason = row.reason as string;
    const entryPrice = Number(row.price);
    const levelMatch = reason.match(/大台(?:超え|割れ)\s*\((\d+)円/);
    if (!levelMatch) continue;
    const roundLevel = parseFloat(levelMatch[1]);
    const distPct = calculateRoundDistancePct(entryPrice, roundLevel);
    
    const exitResult = await db.execute(sql`
      SELECT pnl FROM rt_trades 
      WHERE tradeDate = ${row.tradeDate} AND symbol = ${row.symbol}
      AND action NOT IN ('buy', 'short') AND tradeTime > ${row.tradeTime}
      ORDER BY tradeTime ASC LIMIT 1
    `);
    const pnl = (exitResult as any)[0][0] ? Number((exitResult as any)[0][0].pnl) : 0;
    entries.push({ distPct, pnl });
  }
  
  // Sweep thresholds from 0.5% to 5.0%
  console.log("■ 閾値スイープ: 各閾値での通過エントリーのパフォーマンス\n");
  console.log(`${"閾値".padEnd(8)} ${"通過件数".padStart(6)} ${"ブロック".padStart(6)} ${"通過勝率".padStart(8)} ${"通過損益".padStart(12)} ${"通過平均".padStart(10)} ${"ブロック損益".padStart(12)}`);
  console.log("-".repeat(75));
  
  for (const threshold of [0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 999]) {
    const passed = entries.filter(e => e.distPct <= threshold);
    const blocked = entries.filter(e => e.distPct > threshold);
    const passedPnl = passed.reduce((sum, e) => sum + e.pnl, 0);
    const blockedPnl = blocked.reduce((sum, e) => sum + e.pnl, 0);
    const passedWins = passed.filter(e => e.pnl > 0).length;
    const passedWinRate = passed.length > 0 ? (passedWins / passed.length * 100).toFixed(0) : "0";
    const avgPnl = passed.length > 0 ? Math.round(passedPnl / passed.length) : 0;
    const label = threshold === 999 ? "なし" : threshold.toFixed(1) + "%";
    console.log(
      `${label.padEnd(8)} ${String(passed.length).padStart(6)} ${String(blocked.length).padStart(6)} ${(passedWinRate + "%").padStart(8)} ${(passedPnl >= 0 ? "+" : "") + passedPnl.toLocaleString() + "円".padStart(12)} ${(avgPnl >= 0 ? "+" : "") + avgPnl.toLocaleString() + "円".padStart(10)} ${(blockedPnl >= 0 ? "+" : "") + blockedPnl.toLocaleString() + "円"}`
    );
  }
  
  console.log("\n■ 分析:");
  console.log("  0.8%閾値: 10件通過(+265,720円) / 51件ブロック(-90,353円)");
  console.log("  → フィルターとしては「正しい方向」に機能している");
  console.log("  → しかし通過率が16%と極端に低く、取引機会を大幅に失っている");
  console.log("  → 0.8-1.5%帯は勝率19%で確かに悪いが、2.5%+帯は勝率57%で良い");
  console.log("  → 一律の閾値ではなく、他の条件との組み合わせが必要かもしれない");

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
