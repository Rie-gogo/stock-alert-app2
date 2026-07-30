import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // The sim says: 285A LONG entry at ¥40,600 (2 min before actual 10:02 entry at ¥42,230)
  // 2 min before 10:02 = 10:00, close=40600 ← this matches the candle data
  // The sim then says exit at ¥42,740 "時間切れ" (60 candles later)
  // 
  // But in reality, the stop loss would have been hit!
  // Actual stop loss was at ¥42,019 (0.5% below ¥42,230)
  // For entry at ¥40,600, stop loss would be at ¥40,600 * 0.995 = ¥40,397
  
  // Let me check the candles after 10:00
  const candles = await db.execute(sql`
    SELECT candleTime, open, high, low, close FROM rt_candles 
    WHERE tradeDate = '2026-07-30' AND symbol = '285A'
      AND candleTime >= '10:00' AND candleTime <= '10:30'
    ORDER BY candleTime
  `);
  
  console.log('=== 285A 7/30 10:00以降の値動き ===\n');
  const entryPrice = 40600;
  const stopLoss = entryPrice * 0.995; // = 40,397
  const takeProfit = entryPrice * 1.03; // = 41,818
  
  console.log(`仮想エントリー: ¥${entryPrice} (10:00)`);
  console.log(`損切りライン: ¥${stopLoss.toFixed(0)} (-0.5%)`);
  console.log(`利確ライン: ¥${takeProfit.toFixed(0)} (+3%)\n`);
  
  let hitStop = false;
  let hitTp = false;
  
  for (const c of (candles as any)[0]) {
    const low = Number(c.low);
    const high = Number(c.high);
    const close = Number(c.close);
    
    let marker = '';
    if (!hitStop && !hitTp) {
      if (low <= stopLoss) {
        marker = ' ← ★損切りヒット';
        hitStop = true;
      } else if (high >= takeProfit) {
        marker = ' ← ★利確ヒット';
        hitTp = true;
      }
    }
    
    console.log(`  ${c.candleTime} | O=${c.open} H=${high} L=${low} C=${close}${marker}`);
  }
  
  console.log('\n=== 結論 ===');
  if (hitTp) {
    console.log(`利確ヒット: ¥${takeProfit.toFixed(0)} → PnL = +${Math.round((takeProfit - entryPrice) * 100)}円 (100株)`);
    console.log('ただし実際のシステムでは損切り幅は銘柄・価格帯で異なる');
  } else if (hitStop) {
    console.log(`損切りヒット: ¥${stopLoss.toFixed(0)} → PnL = -${Math.round((entryPrice - stopLoss) * 100)}円 (100株)`);
  } else {
    console.log('60分以内に損切りも利確もヒットせず');
  }
  
  // Check what the actual system's stop loss % is
  // From the actual trade: entry=42230, stop=42019 → (42230-42019)/42230 = 0.50%
  console.log('\n実際のシステムの損切り幅: (42230-42019)/42230 = 0.50%');
  console.log(`3本確認エントリー(¥40,600)の場合: 損切り = ¥${(40600 * 0.995).toFixed(0)}`);
  
  // Check: did price ever go below 40397 after 10:00?
  console.log('\n10:00以降に¥40,397以下になったか？');
  let wentBelow = false;
  for (const c of (candles as any)[0]) {
    if (Number(c.low) <= 40397) {
      console.log(`  → はい: ${c.candleTime} low=${c.low}`);
      wentBelow = true;
      break;
    }
  }
  if (!wentBelow) {
    console.log('  → いいえ（損切りラインに到達せず）');
    console.log('  → 利確ライン¥41,818に到達したか確認:');
    for (const c of (candles as any)[0]) {
      if (Number(c.high) >= 41818) {
        console.log(`    → はい: ${c.candleTime} high=${c.high} ← ここで利確`);
        const profit = Math.round((41818 - 40600) * 100);
        console.log(`    → PnL = +${profit.toLocaleString()}円 (100株の場合)`);
        break;
      }
    }
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
