import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  
  // Get today's date in JST
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const jstNow = new Date(now.getTime() + jstOffset);
  const todayStr = jstNow.toISOString().slice(0, 10);
  
  console.log(`=== ${todayStr} (JST) のシグナル状況 ===`);
  console.log(`現在時刻(JST): ${jstNow.toISOString().slice(11, 19)}`);
  console.log('');

  // Check signals table
  const signals = await db.execute(sql`
    SELECT * FROM signals 
    WHERE DATE(CONVERT_TZ(FROM_UNIXTIME(timestamp/1000), '+00:00', '+09:00')) = ${todayStr}
    ORDER BY timestamp DESC
    LIMIT 20
  `);
  console.log(`シグナル数: ${(signals as any)[0]?.length || signals.length || 0}`);
  const sigRows = (signals as any)[0] || signals;
  if (Array.isArray(sigRows) && sigRows.length > 0) {
    for (const s of sigRows) {
      const ts = new Date(Number(s.timestamp)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      console.log(`  ${ts} | ${s.symbol} | ${s.direction} | ${s.signal_type || ''} | entry=${s.entry_price}`);
    }
  }
  console.log('');

  // Check trades/positions
  const trades = await db.execute(sql`
    SELECT * FROM trades 
    WHERE DATE(CONVERT_TZ(FROM_UNIXTIME(entry_time/1000), '+00:00', '+09:00')) = ${todayStr}
    ORDER BY entry_time DESC
    LIMIT 20
  `);
  const tradeRows = (trades as any)[0] || trades;
  console.log(`本日のトレード数: ${Array.isArray(tradeRows) ? tradeRows.length : 0}`);
  if (Array.isArray(tradeRows) && tradeRows.length > 0) {
    for (const t of tradeRows) {
      const ts = new Date(Number(t.entry_time)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      console.log(`  ${ts} | ${t.symbol} | ${t.direction} | entry=${t.entry_price} | status=${t.status} | pnl=${t.pnl || '-'}`);
    }
  }
  console.log('');

  // Check candle data reception for today
  const candles = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt, 
           MIN(CONVERT_TZ(FROM_UNIXTIME(timestamp/1000), '+00:00', '+09:00')) as first_candle,
           MAX(CONVERT_TZ(FROM_UNIXTIME(timestamp/1000), '+00:00', '+09:00')) as last_candle
    FROM rt_candles 
    WHERE DATE(CONVERT_TZ(FROM_UNIXTIME(timestamp/1000), '+00:00', '+09:00')) = ${todayStr}
    GROUP BY symbol
    ORDER BY symbol
  `);
  const candleRows = (candles as any)[0] || candles;
  console.log(`本日のデータ受信銘柄数: ${Array.isArray(candleRows) ? candleRows.length : 0}`);
  if (Array.isArray(candleRows)) {
    for (const c of candleRows) {
      console.log(`  ${c.symbol}: ${c.cnt}本 (${String(c.first_candle).slice(11,16)} ~ ${String(c.last_candle).slice(11,16)})`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
