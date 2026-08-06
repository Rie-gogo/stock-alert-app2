import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  if (!db) { console.log('DB not available'); process.exit(1); }
  
  const today = '2026-08-05';
  
  // Get trades for today
  const trades = await db.execute(sql.raw(`SELECT * FROM rt_trades WHERE tradeDate = '${today}' ORDER BY tradeTime`));
  const tradeRows = (trades as any)[0] || [];
  console.log('=== RT Trades for', today, '===');
  console.log('Count:', tradeRows.length);
  
  if (tradeRows.length > 0) {
    // Summary stats
    const closedTrades = tradeRows.filter((t: any) => t.pnl !== null);
    const wins = closedTrades.filter((t: any) => Number(t.pnl) > 0);
    const losses = closedTrades.filter((t: any) => Number(t.pnl) < 0);
    const totalPnl = closedTrades.reduce((sum: number, t: any) => sum + Number(t.pnl), 0);
    
    console.log('\n--- Summary ---');
    console.log('Total trades:', tradeRows.length);
    console.log('Closed trades (with PnL):', closedTrades.length);
    console.log('Wins:', wins.length);
    console.log('Losses:', losses.length);
    console.log('Win rate:', closedTrades.length > 0 ? (wins.length / closedTrades.length * 100).toFixed(1) + '%' : 'N/A');
    console.log('Total PnL:', totalPnl.toLocaleString(), '円');
    
    // By symbol
    console.log('\n--- By Symbol ---');
    const bySymbol: Record<string, { count: number; pnl: number; name: string }> = {};
    for (const t of closedTrades) {
      const key = t.symbol;
      if (!bySymbol[key]) bySymbol[key] = { count: 0, pnl: 0, name: t.symbolName };
      bySymbol[key].count++;
      bySymbol[key].pnl += Number(t.pnl);
    }
    for (const [sym, data] of Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl)) {
      console.log(`  ${sym} (${data.name}): ${data.count}件, PnL=${data.pnl.toLocaleString()}円`);
    }
    
    // By signal
    console.log('\n--- By Signal (boardSignal) ---');
    const bySignal: Record<string, { count: number; pnl: number; wins: number }> = {};
    for (const t of closedTrades) {
      const key = t.boardSignal || 'unknown';
      if (!bySignal[key]) bySignal[key] = { count: 0, pnl: 0, wins: 0 };
      bySignal[key].count++;
      bySignal[key].pnl += Number(t.pnl);
      if (Number(t.pnl) > 0) bySignal[key].wins++;
    }
    for (const [sig, data] of Object.entries(bySignal).sort((a, b) => b[1].pnl - a[1].pnl)) {
      const wr = (data.wins / data.count * 100).toFixed(1);
      console.log(`  ${sig}: ${data.count}件, 勝率=${wr}%, PnL=${data.pnl.toLocaleString()}円`);
    }
    
    // By reason (exit reason)
    console.log('\n--- By Exit Reason ---');
    const byReason: Record<string, { count: number; pnl: number }> = {};
    for (const t of closedTrades) {
      const key = t.reason || 'unknown';
      if (!byReason[key]) byReason[key] = { count: 0, pnl: 0 };
      byReason[key].count++;
      byReason[key].pnl += Number(t.pnl);
    }
    for (const [reason, data] of Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${reason}: ${data.count}件, PnL=${data.pnl.toLocaleString()}円`);
    }
    
    // Individual trades
    console.log('\n--- All Trades ---');
    for (const t of tradeRows) {
      console.log(`  ${t.tradeTime} | ${t.symbol} ${t.symbolName} | ${t.action} | ${Number(t.price).toLocaleString()}円 x ${t.shares}株 | PnL=${t.pnl !== null ? Number(t.pnl).toLocaleString() + '円' : '-'} | ${t.reason} | signal=${t.boardSignal}`);
    }
  } else {
    console.log('本日の取引データはありません。');
  }
  
  // Get daily summaries
  const summaries = await db.execute(sql.raw(`SELECT * FROM rt_daily_summaries WHERE date = '${today}'`));
  const summaryRows = (summaries as any)[0] || [];
  console.log('\n=== RT Daily Summaries for', today, '===');
  if (summaryRows.length > 0) {
    console.log(JSON.stringify(summaryRows, null, 2));
  } else {
    console.log('日次サマリーなし');
  }

  // Recent trade dates for context
  const recentTrades = await db.execute(sql.raw(`SELECT tradeDate, COUNT(*) as cnt, SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END) as total_pnl FROM rt_trades GROUP BY tradeDate ORDER BY tradeDate DESC LIMIT 10`));
  const recentRows = (recentTrades as any)[0] || [];
  console.log('\n=== Recent trade dates (for context) ===');
  for (const r of recentRows) {
    console.log(`  ${r.tradeDate}: ${r.cnt}件, PnL=${Number(r.total_pnl).toLocaleString()}円`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
