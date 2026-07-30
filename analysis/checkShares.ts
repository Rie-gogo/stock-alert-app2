import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Check the actual share count for 285A trades
  const trades = await db.execute(sql`
    SELECT tradeDate, symbol, action, tradeTime, price, shares, pnl, reason
    FROM rt_trades 
    WHERE symbol = '285A' AND tradeDate = '2026-07-30'
    ORDER BY tradeTime
  `);
  
  console.log('=== 285A 7/30 実際のトレード詳細 ===\n');
  for (const t of (trades as any)[0]) {
    console.log(`${t.tradeTime} | ${t.action} | ¥${t.price} | ${t.shares}株 | PnL=${t.pnl || '-'} | ${t.reason?.substring(0, 60)}`);
  }
  
  // Check how shares are calculated
  console.log('\n=== 株数計算の確認 ===');
  // entry at 42230, exit at 42019, pnl=-21115
  // pnl = (42019 - 42230) * shares = -211 * shares = -21115
  // shares = 21115 / 211 = 100.07 ≈ 100
  console.log('285A 1回目: (42019-42230) * shares = -21115 → shares = 100');
  console.log('285A 2回目: (44178-44400) * shares = -22200 → shares = 100');
  
  // So with entry at 40600 and TP at 41818:
  // PnL = (41818 - 40600) * 100 = +121,800円
  console.log('\n3本確認エントリー(¥40,600)の場合:');
  console.log('  利確: (41818 - 40600) * 100 = +121,800円');
  console.log('  ※ 10:01にlow=40490で損切りライン(40397)に到達しないことも確認済み');
  console.log('  ※ 10:02にhigh=42530で利確ライン(41818)に到達');
  
  // But wait - 10:01 low=40490 > 40397, so stop is NOT hit
  // And 10:02 high=42530 > 41818, so TP IS hit
  // This is correct!
  
  // However, there's a subtlety: the actual system might not have entered at 10:00
  // because other conditions (board reading, HTF filter, etc.) might block
  // The simulation assumes the same filters pass 2 min earlier
  
  console.log('\n=== 注意点 ===');
  console.log('この結果は「確認バーのみ3本に短縮し、他の条件は同一」の前提');
  console.log('実際には:');
  console.log('  - 板読みスコアが2分前の時点で異なる可能性');
  console.log('  - 3分足HTFフィルターの判定が異なる可能性');
  console.log('  - 信頼度判定が異なる可能性');
  console.log('  - 同時ポジション制限に引っかかる可能性');
  console.log('');
  console.log('ただし285Aの10:00→10:02は急騰中で板読みも強い可能性が高い');

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
