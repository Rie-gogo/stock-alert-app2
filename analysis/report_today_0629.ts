import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const today = '2026-06-29';
  
  // Get all trades
  const result = await db.execute(
    sql`SELECT tradeDate, tradeTime, symbol, symbolName, action, price, shares, pnl, reason, side, boardSignal
        FROM rt_trades WHERE tradeDate = ${today} ORDER BY tradeTime`
  ) as any;
  const trades = result[0] ?? result;
  
  console.log(`=== ${today} リアルタイムシミュレーション結果 ===\n`);
  console.log(`全取引数: ${trades.length}件\n`);
  
  // Separate entries and exits
  const entries = trades.filter((t: any) => t.pnl === null || t.pnl === 0);
  const exits = trades.filter((t: any) => t.pnl !== null && t.pnl !== 0);
  
  // Actually let's look at pnl field more carefully
  const withPnl = trades.filter((t: any) => t.pnl !== null);
  const withoutPnl = trades.filter((t: any) => t.pnl === null);
  
  console.log(`エントリー(pnl=null): ${withoutPnl.length}件`);
  console.log(`決済(pnl有): ${withPnl.length}件\n`);
  
  // Total P&L
  const totalPnl = withPnl.reduce((s: number, t: any) => s + Number(t.pnl), 0);
  const wins = withPnl.filter((t: any) => Number(t.pnl) > 0);
  const losses = withPnl.filter((t: any) => Number(t.pnl) < 0);
  const even = withPnl.filter((t: any) => Number(t.pnl) === 0);
  
  console.log('--- 総合成績 ---');
  console.log(`取引回数（決済ベース）: ${withPnl.length}件`);
  console.log(`勝敗: ${wins.length}勝 ${losses.length}敗 ${even.length > 0 ? even.length + '分' : ''}`);
  console.log(`勝率: ${withPnl.length > 0 ? (wins.length / withPnl.length * 100).toFixed(1) : 0}%`);
  console.log(`総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  
  if (wins.length > 0) {
    const avgWin = Math.round(wins.reduce((s: number, t: any) => s + Number(t.pnl), 0) / wins.length);
    console.log(`平均利益: +${avgWin.toLocaleString()}円`);
  }
  if (losses.length > 0) {
    const avgLoss = Math.round(losses.reduce((s: number, t: any) => s + Number(t.pnl), 0) / losses.length);
    console.log(`平均損失: ${avgLoss.toLocaleString()}円`);
  }
  if (wins.length > 0 && losses.length > 0) {
    const grossProfit = wins.reduce((s: number, t: any) => s + Number(t.pnl), 0);
    const grossLoss = Math.abs(losses.reduce((s: number, t: any) => s + Number(t.pnl), 0));
    console.log(`PF: ${(grossProfit / grossLoss).toFixed(2)}`);
    const avgWin = grossProfit / wins.length;
    const avgLoss2 = grossLoss / losses.length;
    console.log(`リスクリワード比: ${(avgWin / avgLoss2).toFixed(2)}:1`);
  }
  
  // By symbol
  console.log('\n--- 銘柄別損益 ---');
  const symbolMap = new Map<string, { name: string, pnl: number, wins: number, losses: number }>();
  for (const t of withPnl) {
    const key = t.symbol;
    if (!symbolMap.has(key)) symbolMap.set(key, { name: t.symbolName || key, pnl: 0, wins: 0, losses: 0 });
    const entry = symbolMap.get(key)!;
    const p = Number(t.pnl);
    entry.pnl += p;
    if (p > 0) entry.wins++;
    else entry.losses++;
  }
  const symbolArr = [...symbolMap.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [sym, data] of symbolArr) {
    console.log(`  ${sym} ${data.name}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.wins}勝${data.losses}敗)`);
  }
  
  // By signal (from reason field of entries)
  console.log('\n--- シグナル別成績 ---');
  // Match entry to exit by symbol and time
  const signalMap = new Map<string, { pnl: number, wins: number, losses: number, count: number }>();
  
  for (const exit of withPnl) {
    // Find the corresponding entry
    const matchingEntry = withoutPnl.find((e: any) => 
      e.symbol === exit.symbol && e.tradeTime < exit.tradeTime
    );
    let signal = '不明';
    if (matchingEntry) {
      const reason = matchingEntry.reason || '';
      if (reason.includes('大台割れ')) signal = '大台割れ';
      else if (reason.includes('VWAP') && reason.includes('反落')) signal = 'VWAP反落';
      else if (reason.includes('VWAP') && reason.includes('クロス')) signal = 'VWAPクロス';
      else if (reason.includes('戻り売り')) signal = '戻り売り';
      else if (reason.includes('ダウ理論')) signal = 'ダウ理論';
      else if (reason.includes('大台超え')) signal = '大台超え';
      else if (reason.includes('VWAP') && reason.includes('上抜け')) signal = 'VWAP上抜け';
      else signal = reason.substring(0, 20);
    }
    
    if (!signalMap.has(signal)) signalMap.set(signal, { pnl: 0, wins: 0, losses: 0, count: 0 });
    const entry = signalMap.get(signal)!;
    const p = Number(exit.pnl);
    entry.pnl += p;
    entry.count++;
    if (p > 0) entry.wins++;
    else entry.losses++;
  }
  
  const signalArr = [...signalMap.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [sig, data] of signalArr) {
    console.log(`  ${sig}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.count}件, ${data.wins}勝${data.losses}敗, 勝率${(data.wins/data.count*100).toFixed(0)}%)`);
  }
  
  // Exit reasons
  console.log('\n--- 決済理由別 ---');
  const exitReasonMap = new Map<string, { pnl: number, count: number }>();
  for (const t of withPnl) {
    let reason = t.reason || '不明';
    if (reason.includes('損切り')) reason = '損切り';
    else if (reason.includes('利確')) reason = '利確';
    else if (reason.includes('大引け')) reason = '大引け強制決済';
    else if (reason.includes('反転')) reason = 'シグナル反転';
    else if (reason.includes('板読み')) reason = '板読み早期利確';
    else reason = reason.substring(0, 15);
    
    if (!exitReasonMap.has(reason)) exitReasonMap.set(reason, { pnl: 0, count: 0 });
    const entry = exitReasonMap.get(reason)!;
    entry.pnl += Number(t.pnl);
    entry.count++;
  }
  
  for (const [reason, data] of exitReasonMap.entries()) {
    console.log(`  ${reason}: ${data.count}件, ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円`);
  }
  
  // All trades detail
  console.log('\n--- 全取引詳細 ---');
  for (const t of trades) {
    const p = t.pnl !== null ? `P&L=${Number(t.pnl).toLocaleString()}円` : 'ENTRY';
    const side = t.side || t.action;
    console.log(`${t.tradeTime} ${side} ${t.symbol}(${t.symbolName || ''}) @${Number(t.price).toLocaleString()} ${t.reason || ''} ${p} [${t.boardSignal || ''}]`);
  }
  
  // Check daily summary
  const summaryResult = await db.execute(
    sql`SELECT * FROM rt_daily_summaries WHERE tradeDate = ${today}`
  ) as any;
  const summaries = summaryResult[0] ?? summaryResult;
  if (summaries.length > 0) {
    console.log('\n--- rt_daily_summaries ---');
    console.log(JSON.stringify(summaries[0], null, 2));
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
