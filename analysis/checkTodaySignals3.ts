import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const todayStr = '2026-07-29';
  
  console.log(`=== ${todayStr} (JST) のシグナル・トレード状況 ===`);
  console.log(`現在時刻(JST): ${new Date(Date.now() + 9*60*60*1000).toISOString().slice(11, 19)}`);
  console.log('');

  // Check 3peak signals
  const signals = await db.execute(sql`
    SELECT * FROM rt_3peak_signals 
    WHERE DATE(CONVERT_TZ(FROM_UNIXTIME(timestamp/1000), '+00:00', '+09:00')) = ${todayStr}
    ORDER BY timestamp DESC
    LIMIT 30
  `);
  const sigRows = (signals as any)[0] || [];
  console.log(`3Peakシグナル数: ${sigRows.length}`);
  if (sigRows.length > 0) {
    for (const s of sigRows) {
      const ts = new Date(Number(s.timestamp)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      console.log(`  ${ts} | ${s.symbol} | ${s.direction || s.type || ''} | price=${s.price || s.entry_price || ''}`);
    }
  }
  console.log('');

  // Check trades
  const trades = await db.execute(sql`
    SELECT * FROM rt_trades 
    WHERE DATE(CONVERT_TZ(FROM_UNIXTIME(entry_time/1000), '+00:00', '+09:00')) = ${todayStr}
    ORDER BY entry_time DESC
    LIMIT 30
  `);
  const tradeRows = (trades as any)[0] || [];
  console.log(`本日のトレード数: ${tradeRows.length}`);
  if (tradeRows.length > 0) {
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
  const candleRows = (candles as any)[0] || [];
  console.log(`本日のデータ受信銘柄数: ${candleRows.length}`);
  for (const c of candleRows) {
    console.log(`  ${c.symbol}: ${c.cnt}本 (${String(c.first_candle).slice(11,16)} ~ ${String(c.last_candle).slice(11,16)})`);
  }
  console.log('');

  // Check daily summary
  const daily = await db.execute(sql`
    SELECT * FROM rt_daily_summaries 
    WHERE trade_date = ${todayStr}
    LIMIT 5
  `);
  const dailyRows = (daily as any)[0] || [];
  console.log(`デイリーサマリー: ${dailyRows.length}件`);
  if (dailyRows.length > 0) {
    for (const d of dailyRows) {
      console.log(`  ${JSON.stringify(d)}`);
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
