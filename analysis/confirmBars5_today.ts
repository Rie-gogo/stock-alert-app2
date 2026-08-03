import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

/**
 * 本日(7/31)のトレードのうち「大台確認」シグナルは CONFIRM_BARS=4 で発動した。
 * もし CONFIRM_BARS=5 だった場合、5本目のバーでも大台を維持していたかを確認する。
 * 
 * VWAPクロスと逆三尊は CONFIRM_BARS に無関係なので、そのまま発動する。
 * 
 * 大台確認の2件:
 *   #2: 6857 BUY 13:48 エントリー (大台32400円突破, 4本維持)
 *   #4: 6857 BUY 14:20 エントリー (大台32500円突破, 4本維持)
 * 
 * 5本目のバーが大台を維持していたかを1分足データで確認する。
 */

async function main() {
  const db = await getDb();
  
  // 6857の1分足データを取得 (13:40〜14:40)
  const [candles] = await db.execute(sql`
    SELECT candleTime, open, high, low, close, volume
    FROM rt_candles
    WHERE tradeDate = '2026-07-31' AND symbol = '6857'
    AND candleTime >= '13:40' AND candleTime <= '14:40'
    ORDER BY candleTime ASC
  `);
  
  const candleArr = candles as any[];
  console.log("=== 6857 アドバンテスト 1分足データ (13:40-14:40) ===\n");
  for (const c of candleArr) {
    console.log(`  ${c.candleTime} | O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`);
  }
  
  // ケース1: 大台32400円突破 → エントリー13:48
  // CONFIRM_BARS=4 → 4本維持でエントリー
  // CONFIRM_BARS=5 → 5本目も維持が必要
  // 大台突破の起点を特定: 32400円を超えた最初のバーから4本後が13:48
  // つまり起点は13:44か13:45あたり
  
  console.log("\n\n=== ケース1: 大台32400円突破 ===");
  console.log("エントリー時刻: 13:48 (CONFIRM_BARS=4で確認完了)");
  console.log("→ 突破起点は13:44頃。4本目=13:48で確認完了してエントリー。");
  console.log("→ CONFIRM_BARS=5の場合、5本目=13:49が必要。");
  
  const bar1349 = candleArr.find((c: any) => c.candleTime === '13:49');
  if (bar1349) {
    console.log(`\n  13:49のバー: L=${bar1349.low}, C=${bar1349.close}`);
    console.log(`  32400円を維持? Low=${bar1349.low} >= 32400? → ${Number(bar1349.low) >= 32400 ? 'YES (5本でもエントリー)' : 'NO (5本ではブロック)'}`);
  }
  
  console.log("\n\n=== ケース2: 大台32500円突破 ===");
  console.log("エントリー時刻: 14:20 (CONFIRM_BARS=4で確認完了)");
  console.log("→ 突破起点は14:16頃。4本目=14:20で確認完了してエントリー。");
  console.log("→ CONFIRM_BARS=5の場合、5本目=14:21が必要。");
  
  const bar1421 = candleArr.find((c: any) => c.candleTime === '14:21');
  if (bar1421) {
    console.log(`\n  14:21のバー: L=${bar1421.low}, C=${bar1421.close}`);
    console.log(`  32500円を維持? Low=${bar1421.low} >= 32500? → ${Number(bar1421.low) >= 32500 ? 'YES (5本でもエントリー)' : 'NO (5本ではブロック)'}`);
  }
  
  // もう少し広い範囲で確認（大台突破の起点を正確に特定）
  console.log("\n\n=== 大台突破の起点特定 ===");
  console.log("\n--- 32400円突破の起点 ---");
  for (const c of candleArr) {
    if (c.candleTime >= '13:43' && c.candleTime <= '13:52') {
      const above = Number(c.low) >= 32400;
      console.log(`  ${c.candleTime} | L:${c.low} C:${c.close} | >=32400: ${above}`);
    }
  }
  
  console.log("\n--- 32500円突破の起点 ---");
  for (const c of candleArr) {
    if (c.candleTime >= '14:14' && c.candleTime <= '14:25') {
      const above = Number(c.low) >= 32500;
      console.log(`  ${c.candleTime} | L:${c.low} C:${c.close} | >=32500: ${above}`);
    }
  }
  
  process.exit(0);
}
main().catch(console.error);
