import { getDb } from "../server/db";
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const today = '2026-07-31';
  
  // 1. Daily Summary
  const [summaryRows] = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = ${today}
  `);
  
  console.log("=== 7/31 Daily Summary ===\n");
  if ((summaryRows as any[]).length > 0) {
    const s = (summaryRows as any[])[0];
    console.log(`  totalPnl: ${s.totalPnl}`);
    console.log(`  trades: ${s.trades}`);
    console.log(`  wins: ${s.wins}`);
    console.log(`  losses: ${s.losses}`);
    console.log(`  winRate: ${s.winRate}`);
    console.log(`  candlesReceived: ${s.candlesReceived}`);
    console.log(`  reportSentAt: ${s.reportSentAt}`);
  } else {
    console.log("  (まだ生成されていません)");
  }
  
  // 2. All trades
  console.log("\n=== 7/31 全トレード ===\n");
  const [trades] = await db.execute(sql`
    SELECT id, symbol, action, price, shares, pnl, reason, tradeTime, side, exitType
    FROM rt_trades 
    WHERE tradeDate = ${today}
    ORDER BY tradeTime ASC, id ASC
  `);
  
  const tradeArr = trades as any[];
  for (const t of tradeArr) {
    console.log(`  ${t.tradeTime} | ${t.symbol} | ${t.action} | ¥${t.price} | ${t.shares}株 | PnL:${t.pnl || '-'} | side:${t.side} | ${(t.reason || '').substring(0, 80)}`);
  }
  
  // 3. ペアリングして集計
  const entries = tradeArr.filter((t: any) => t.action === 'buy' || t.action === 'short');
  const exits = tradeArr.filter((t: any) => t.action === 'sell' || t.action === 'cover');
  
  console.log(`\n=== 集計 ===`);
  console.log(`  エントリー: ${entries.length}件`);
  console.log(`  決済: ${exits.length}件`);
  
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  const symbolPnl: Record<string, { pnl: number; count: number; wins: number }> = {};
  const signalPnl: Record<string, { pnl: number; count: number; wins: number }> = {};
  
  for (const exit of exits) {
    const pnl = Number(exit.pnl) || 0;
    totalPnl += pnl;
    if (pnl > 0) wins++;
    else losses++;
    
    // 銘柄別
    if (!symbolPnl[exit.symbol]) symbolPnl[exit.symbol] = { pnl: 0, count: 0, wins: 0 };
    symbolPnl[exit.symbol].pnl += pnl;
    symbolPnl[exit.symbol].count++;
    if (pnl > 0) symbolPnl[exit.symbol].wins++;
    
    // シグナル別（対応するエントリーのreasonを使用）
    const entry = entries.find((e: any) => e.symbol === exit.symbol && e.tradeTime <= exit.tradeTime && e.id < exit.id);
    if (entry) {
      // シグナル名を抽出
      let signalName = '不明';
      const reason = entry.reason || '';
      if (reason.includes('大台確認')) signalName = '大台確認';
      else if (reason.includes('VWAPクロス')) signalName = 'VWAPクロス';
      else if (reason.includes('逆三尊')) signalName = '逆三尊';
      else if (reason.includes('三尊天井')) signalName = '三尊天井';
      else if (reason.includes('ブレイクアウト')) signalName = 'ブレイクアウト';
      else if (reason.includes('buy_pressure')) signalName = 'buy_pressure';
      else if (reason.includes('sell_pressure')) signalName = 'sell_pressure';
      else signalName = reason.substring(0, 20);
      
      if (!signalPnl[signalName]) signalPnl[signalName] = { pnl: 0, count: 0, wins: 0 };
      signalPnl[signalName].pnl += pnl;
      signalPnl[signalName].count++;
      if (pnl > 0) signalPnl[signalName].wins++;
    }
  }
  
  console.log(`\n  総損益: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toLocaleString()}円`);
  console.log(`  勝敗: ${wins}勝${losses}敗`);
  console.log(`  勝率: ${exits.length > 0 ? (wins / exits.length * 100).toFixed(1) : 0}%`);
  
  console.log(`\n=== 銘柄別損益 ===`);
  for (const [sym, data] of Object.entries(symbolPnl).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.wins}勝${data.count - data.wins}敗)`);
  }
  
  console.log(`\n=== シグナル別損益 ===`);
  for (const [sig, data] of Object.entries(signalPnl).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sig}: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toLocaleString()}円 (${data.count}件, ${data.wins}勝${data.count - data.wins}敗, 勝率${(data.wins / data.count * 100).toFixed(0)}%)`);
  }
  
  // 4. 受信状況
  console.log(`\n=== データ受信状況 ===`);
  const [candleStats] = await db.execute(sql`
    SELECT symbol, COUNT(*) as cnt, MIN(candleTime) as firstTime, MAX(candleTime) as lastTime
    FROM rt_candles
    WHERE tradeDate = ${today}
    GROUP BY symbol
    ORDER BY cnt DESC
  `);
  
  const candleArr = candleStats as any[];
  let totalCandles = 0;
  for (const c of candleArr) {
    totalCandles += Number(c.cnt);
  }
  console.log(`  受信銘柄: ${candleArr.length}銘柄`);
  console.log(`  総受信足数: ${totalCandles}本`);
  console.log(`  最終受信: ${candleArr.length > 0 ? candleArr[0].lastTime : '-'}`);
  
  const allSymbols = ['285A','3436','3778','4568','5016','5803','6526','6723','6758','6857','6920','6976','6981','7011','7203','8035','8306','8316','9107','9984'];
  const receivedSymbols = candleArr.map((c: any) => c.symbol);
  const missing = allSymbols.filter(s => !receivedSymbols.includes(s));
  if (missing.length > 0) {
    console.log(`  未受信: ${missing.join(', ')}`);
  }
  
  // 5. 直近1週間の累計
  console.log(`\n=== 直近1週間の推移 ===`);
  const [weekRows] = await db.execute(sql`
    SELECT tradeDate, totalPnl, trades, wins, losses, candlesReceived
    FROM rt_daily_summaries
    WHERE tradeDate >= '2026-07-24'
    ORDER BY tradeDate ASC
  `);
  
  let cumPnl = 0;
  for (const r of weekRows as any[]) {
    const pnl = Number(r.totalPnl) || 0;
    cumPnl += pnl;
    console.log(`  ${r.tradeDate} | ${pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}円 | ${r.trades}件(${r.wins}勝${r.losses}敗) | 受信${r.candlesReceived}本`);
  }
  console.log(`  累計: ${cumPnl >= 0 ? '+' : ''}${cumPnl.toLocaleString()}円`);
  
  process.exit(0);
}
main().catch(console.error);
