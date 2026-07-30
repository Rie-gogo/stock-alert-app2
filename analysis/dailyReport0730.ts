import { getDb } from '../server/db';
import { sql } from 'drizzle-orm';

async function main() {
  const db = await getDb();
  const todayStr = '2026-07-30';
  
  console.log(`=== ${todayStr} リアルタイムシミュレーション結果 ===\n`);

  // Daily summary
  const dailySummary = await db.execute(sql`
    SELECT * FROM rt_daily_summaries WHERE tradeDate = ${todayStr}
  `);
  const summaryRows = (dailySummary as any)[0] || [];
  if (summaryRows.length > 0) {
    const s = summaryRows[0];
    console.log(`--- デイリーサマリー ---`);
    console.log(`  初期資金: ${Number(s.initialCapital).toLocaleString()}円`);
    console.log(`  総損益: ${Number(s.totalPnl).toLocaleString()}円`);
    console.log(`  取引数: ${s.tradesCount}件 (勝${s.winCount} / 負${s.lossCount})`);
    console.log(`  勝率: ${s.tradesCount > 0 ? ((s.winCount / s.tradesCount) * 100).toFixed(1) : '-'}%`);
    console.log(`  受信足数: ${s.candlesReceived}`);
    console.log(`  レポート送信: ${s.reportSent ? '済' : '未'}`);
  }

  // All trades for today
  const trades = await db.execute(sql`
    SELECT symbol, symbolName, action, tradeTime, price, shares, amount, pnl, reason, side, boardSignal
    FROM rt_trades 
    WHERE tradeDate = ${todayStr}
    ORDER BY tradeTime
  `);
  const tradeRows = (trades as any)[0] || [];
  
  console.log(`\n--- 全トレード詳細 (${tradeRows.length}件) ---`);
  for (const t of tradeRows) {
    console.log(`  ${t.tradeTime} | ${t.symbol}(${t.symbolName}) | ${t.action} | ${t.side} | ¥${t.price} | ${t.shares}株 | PnL=${t.pnl || '-'} | ${t.boardSignal || ''}`);
    if (t.reason) console.log(`         理由: ${t.reason}`);
  }
  
  // Group by symbol for summary
  console.log(`\n--- 銘柄別損益 ---`);
  const symbolPnl: Record<string, { name: string, trades: number, wins: number, losses: number, pnl: number, signals: string[] }> = {};
  
  for (const t of tradeRows) {
    if (!symbolPnl[t.symbol]) {
      symbolPnl[t.symbol] = { name: t.symbolName, trades: 0, wins: 0, losses: 0, pnl: 0, signals: [] };
    }
    if (t.action === 'buy' || t.action === 'short') {
      symbolPnl[t.symbol].trades++;
      if (t.boardSignal) symbolPnl[t.symbol].signals.push(t.boardSignal);
    }
    if (t.pnl) {
      const pnlNum = Number(t.pnl);
      symbolPnl[t.symbol].pnl += pnlNum;
      if (pnlNum > 0) symbolPnl[t.symbol].wins++;
      else symbolPnl[t.symbol].losses++;
    }
  }
  
  for (const [sym, data] of Object.entries(symbolPnl)) {
    console.log(`  ${sym}(${data.name}): ${data.trades}回 | 勝${data.wins}/負${data.losses} | PnL=${data.pnl.toLocaleString()}円 | シグナル: ${data.signals.join(', ')}`);
  }
  
  // Signal type breakdown
  console.log(`\n--- シグナル別成績 ---`);
  const signalPnl: Record<string, { count: number, wins: number, losses: number, pnl: number }> = {};
  
  for (let i = 0; i < tradeRows.length; i++) {
    const t = tradeRows[i];
    if (t.action === 'buy' || t.action === 'short') {
      const signal = t.boardSignal || 'unknown';
      if (!signalPnl[signal]) signalPnl[signal] = { count: 0, wins: 0, losses: 0, pnl: 0 };
      signalPnl[signal].count++;
      // Find the corresponding exit
      const exit = tradeRows.find((x: any, j: number) => 
        j > i && x.symbol === t.symbol && (x.action === 'sell' || x.action === 'cover')
      );
      if (exit && exit.pnl) {
        const pnlNum = Number(exit.pnl);
        signalPnl[signal].pnl += pnlNum;
        if (pnlNum > 0) signalPnl[signal].wins++;
        else signalPnl[signal].losses++;
      }
    }
  }
  
  for (const [signal, data] of Object.entries(signalPnl)) {
    const winRate = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(0) : '-';
    console.log(`  ${signal}: ${data.count}回 | 勝${data.wins}/負${data.losses} | 勝率${winRate}% | PnL=${data.pnl.toLocaleString()}円`);
  }
  
  // Exit reasons breakdown
  console.log(`\n--- 決済理由別 ---`);
  const exitReasons: Record<string, { count: number, pnl: number }> = {};
  for (const t of tradeRows) {
    if ((t.action === 'sell' || t.action === 'cover') && t.pnl) {
      // Extract exit reason from the reason field
      let exitType = 'その他';
      if (t.reason?.includes('損切り')) exitType = '損切り';
      else if (t.reason?.includes('利確')) exitType = '利確';
      else if (t.reason?.includes('大引け')) exitType = '大引け強制決済';
      else if (t.reason?.includes('板読み')) exitType = '板読み早期利確/損切り';
      
      if (!exitReasons[exitType]) exitReasons[exitType] = { count: 0, pnl: 0 };
      exitReasons[exitType].count++;
      exitReasons[exitType].pnl += Number(t.pnl);
    }
  }
  
  for (const [reason, data] of Object.entries(exitReasons)) {
    console.log(`  ${reason}: ${data.count}回 | PnL=${data.pnl.toLocaleString()}円`);
  }

  // Recent 2 weeks trend
  console.log(`\n\n--- 直近2週間の推移 ---`);
  const recentSummaries = await db.execute(sql`
    SELECT tradeDate, totalPnl, tradesCount, winCount, lossCount, candlesReceived
    FROM rt_daily_summaries 
    WHERE tradeDate >= '2026-07-14'
    ORDER BY tradeDate
  `);
  let cumPnl = 0;
  for (const r of (recentSummaries as any)[0]) {
    cumPnl += Number(r.totalPnl);
    console.log(`  ${r.tradeDate} | PnL=${String(Number(r.totalPnl).toLocaleString()).padStart(10)} | 累計=${String(cumPnl.toLocaleString()).padStart(10)} | ${r.tradesCount}件(${r.winCount}勝${r.lossCount}敗) | 足${r.candlesReceived}`);
  }

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
